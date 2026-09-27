// finalizeSent —— 出站确认的唯一收口（DES/05 §4.3 逐字；D1-3）。
// 归属注记：本文件由 T-P3-03 先行落库（判定器 200 分支需要它；卡片 owned 列在 T-P3-04，
// 实现按 §4.3 全文写齐——预检/两分支/审计字段迁移/序列联动/ws_event——T-P3-04 只需
// 在此函数上接 message_sent/message_failed 事件入口，不改写语义）。
//
// finalizeSent(clientMsgId=X, msgId=M, sentAt=网关值, tx) 同事务：
//   1) 预检 (group_id, msg_id=M)（显式预检比「撞唯一违例再回退」可读）；
//   2a) 无行 → 常规回填占位行（queued/accepted/unknown → sent）；
//   2b) 有行 M（乱序回流先到）→ 先 DELETE 占位行（让出 uq_message_client_msg 键）
//        → 再 UPDATE M 行 SET client_msg_id=X + 审计字段随行迁移（D1-3 次序不可换）；
//   3) 序列联动：sequence_run_step status='sent'（pending/accepted 守卫）；
//   4) ws_event(message {deliveryStatus:'sent'})。
// 幂等：两条分支的谓词都收窄——重复调用（S2 重复推送、事件晚于探测）天然吸收为 noop。
import type { PoolClient } from 'pg';

export type FinalizeOutcome =
  | 'regular' // 2a：占位行直接回填
  | 'merged' // 2b：占位行删除 + M 行继承身份（乱序合并）
  | 'noop'; // 幂等吸收（重复确认 / 行已终态）

interface PlaceholderRow {
  readonly id: string; // bigserial → pg 返回字符串
  readonly group_id: string;
  readonly account_id: string | null;
  readonly source: string;
  readonly first_attempt_at: Date | null;
  readonly last_attempt_at: Date | null;
  readonly resend_count: number;
}

const PLACEHOLDER_STATUSES = `('queued','accepted','unknown')`;

/**
 * 出站确认唯一写路径。`client` 是调用方的事务载体（判定器/事件 handler 各自的事务边界
 * 由调用方决定；本函数不开事务）。
 * groupId 内部解析：占位行（client_msg_id=X）恒携带 group_id——X 行不在则没有可确认的对象。
 * sentAt 取网关值（ISO 字符串或 Date）——时间线排序语义以网关时刻为准（DES/02 §5.1）。
 */
export async function finalizeSent(
  client: PoolClient,
  clientMsgId: string,
  msgId: string,
  sentAt: string | Date,
): Promise<FinalizeOutcome> {
  // 0. 定位占位行（X 键是出站身份的载体；缺失 = 无确认对象）
  const ph = await client.query<PlaceholderRow>(
    `SELECT id, group_id, account_id, source, first_attempt_at, last_attempt_at, resend_count
     FROM message WHERE client_msg_id=$1`,
    [clientMsgId],
  );
  const placeholder = ph.rows[0];
  const groupId = placeholder?.group_id;
  if (groupId === undefined) return 'noop';

  // 1. 预检：乱序回流行 M 是否已存在（§4.3 步骤 1 逐字）
  const existing = await client.query<{ id: string; client_msg_id: string | null }>(
    'SELECT id, client_msg_id FROM message WHERE group_id = $1 AND msg_id = $2',
    [groupId, msgId],
  );
  const mRow = existing.rows[0];

  let outcome: FinalizeOutcome;
  if (mRow === undefined) {
    // 2a. 常规路径：占位行（client_msg_id=X, msg_id IS NULL）回填
    const upd = await client.query(
      `UPDATE message SET delivery_status='sent', msg_id=$2, sent_at=$3, updated_at=now()
       WHERE client_msg_id=$1 AND delivery_status IN ${PLACEHOLDER_STATUSES}`,
      [clientMsgId, msgId, sentAt],
    );
    outcome = upd.rowCount === 1 ? 'regular' : 'noop';
  } else if (mRow.client_msg_id === clientMsgId) {
    outcome = 'noop'; // M 行已是双侧身份（重复确认，S2）——吸收
  } else {
    // 2b. 乱序合并（D1-3）：先 DELETE 占位行（让出 uq_message_client_msg 的 X 键）
    //     → 再 UPDATE M 行补出站身份 + 审计字段随行迁移。
    //     守卫「占位行仍在非终态」：已落定（sent/failed）的占位不删（幂等吸收的另一半）。
    if (placeholder !== undefined) {
      const del = await client.query(
        `DELETE FROM message WHERE id=$1 AND msg_id IS NULL
           AND delivery_status IN ${PLACEHOLDER_STATUSES}`,
        [placeholder.id],
      );
      if (del.rowCount !== 1) return 'noop'; // 占位行已被并发落定——合并窗口关闭
    }
    const upd = await client.query(
      `UPDATE message SET client_msg_id=$1, delivery_status='sent', sent_at=$2,
                          is_own=true,
                          account_id=COALESCE($3, account_id),
                          source=COALESCE($4, source),
                          first_attempt_at=COALESCE($5, first_attempt_at),
                          last_attempt_at=COALESCE($6, last_attempt_at),
                          resend_count=GREATEST(resend_count, $7),
                          updated_at=now()
       WHERE group_id=$8 AND msg_id=$9 AND client_msg_id IS NULL`,
      [
        clientMsgId,
        sentAt,
        placeholder?.account_id ?? null,
        placeholder?.source ?? null,
        placeholder?.first_attempt_at ?? null,
        placeholder?.last_attempt_at ?? null,
        placeholder?.resend_count ?? 0,
        groupId,
        msgId,
      ],
    );
    outcome = upd.rowCount === 1 ? 'merged' : 'noop';
  }

  if (outcome === 'noop') return outcome;

  // 3. 序列联动（2a/2b 统一执行）：pending/accepted 步 → sent（下一步排期由 T-P6-04
  //    调度器补——当前任务只落定状态字段，§4.3 原文的排期钩子随序列引擎落地）。
  await client.query(
    `UPDATE sequence_run_step SET status='sent', sent_at=$2, updated_at=now()
     WHERE client_msg_id=$1 AND status IN ('pending','accepted')`,
    [clientMsgId, sentAt],
  );

  // 4. ws_event(message)：与行变更同事务（先持久化后推送，DES/08 §2.3）
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
    JSON.stringify({
      groupId,
      msgId,
      isOwn: true,
      clientMsgId,
      deliveryStatus: 'sent',
    }),
  ]);
  return outcome;
}
