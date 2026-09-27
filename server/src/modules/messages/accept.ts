// 操作员 send 受理（T-P3-01；DES/05 §2.1.1 校验表 + §6 错误码、REQ §2.3 send 行、QR §1、
// 解读 #15 TEXT_MAX_LENGTH / #16 unreachable 照常受理）。
// 受理纪律（先持久化后 202，DES/05 §2.3-1）：
//   校验全过后单事务 { INSERT message(delivery_status='queued', sent_at=受理时刻,
//   client_msg_id 服务端生成, source='operator', is_own=true) + ws_event(message) }
//   ——ws_event 与消息行同事务：响应前的失败不会留下「说了但没记」的窗口。
//   事务返回 202 {clientMsgId}；COMMIT 成功后 notifyWsEventCommitted + onAccepted 唤醒。
// 判序逐字按 §2.1.1 表：text → 群(存在且非 left) → 账号存在 → 成员活跃行 → 账号状态。
//   left 群归 ACCOUNT_NOT_IN_GROUP【解读】：REQ §2.3 错误列只列两个 409，群域唯一码
//   GROUP_NOT_FOUND 专指「群不存在」；leave 后成员行终结，故 left ≡ 成员不存在。
//   unreachable 不拦：群里仍受理，网关 GROUP_WRITE_FORBIDDEN 由 dispatcher 收口（网关为准）。
//   rate_limited 照常受理：queued 保持，到期由 §5.2 闸门放行——S4 的「期内恒零试探」根基。
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../http/plugins/errors.js';
import { TEXT_MAX_LENGTH } from '../../constants.js';
import { tx } from '../../db/tx.js';
import { notifyWsEventCommitted } from '../../ws/notify.js';

export interface AcceptDeps {
  readonly pool: Pool;
  /** dispatcher 唤醒缝（T-P3-02 接线；缺省 = 只落库，dispatcher 轮询拾取——DB 为真值） */
  readonly onAccepted?: (accountId: string) => void;
}

interface AccountRow {
  status: string;
  platform_user_id: string | null;
}

/** 受理成功返回 202 {clientMsgId}；拒绝条件全部 AppError（错误码由 errors.ts 映射） */
export async function acceptOperatorMessage(
  deps: AcceptDeps,
  groupId: string,
  input: { accountId: string; text: string },
): Promise<{ clientMsgId: string }> {
  // 1) text：非空（trim 后）且 ≤ TEXT_MAX_LENGTH（#15；三入口共用同一常量）
  const text = input.text.trim();
  if (text.length === 0 || text.length > TEXT_MAX_LENGTH) {
    throw new AppError('VALIDATION_ERROR', 'text must be non-empty and at most 2000 characters');
  }

  const clientMsgId = `cm-${randomUUID()}`;
  const groupRow = await deps.pool.query<{ status: string }>(
    'SELECT status FROM "group" WHERE id = $1',
    [groupId],
  ).catch((err: unknown) => {
    // 路径参数非 uuid → 22P02：群不存在等价语义（与 timeline.ts 同处置）
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '22P02') {
      throw new AppError('GROUP_NOT_FOUND', `group not found: ${groupId}`);
    }
    throw err;
  });
  const group = groupRow.rows[0];
  if (group === undefined) {
    throw new AppError('GROUP_NOT_FOUND', `group not found: ${groupId}`);
  }
  if (group.status === 'left') {
    // 群已 left → 所有成员行已终结；按「非成员」码返回（见文件头解读）
    throw new AppError('ACCOUNT_NOT_IN_GROUP', `group ${groupId} has been left`);
  }

  const accRes = await deps.pool.query<AccountRow>(
    'SELECT status, platform_user_id FROM account WHERE id = $1',
    [input.accountId],
  );
  const account = accRes.rows[0];
  if (account === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${input.accountId}`);
  }
  const member = await deps.pool.query(
    'SELECT 1 FROM group_member WHERE group_id = $1 AND account_id = $2 AND left_at IS NULL',
    [groupId, input.accountId],
  );
  if (member.rowCount === 0) {
    throw new AppError('ACCOUNT_NOT_IN_GROUP', `account ${input.accountId} is not an active member of group ${groupId}`);
  }
  if (account.status !== 'online' && account.status !== 'rate_limited') {
    throw new AppError('ACCOUNT_UNAVAILABLE', `account ${input.accountId} is ${account.status}`);
  }
  const senderPuid = account.platform_user_id;
  if (senderPuid === null) {
    // online/rate_limited 恒有 puid；兜底分支防脏数据（membership 与 puid 由 connect 同事务写入）
    throw new AppError('ACCOUNT_UNAVAILABLE', `account ${input.accountId} has no platform_user_id`);
  }

  await tx(deps.pool, async (client: PoolClient) => {
    await client.query(
      `INSERT INTO message
         (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source, text,
          sent_at, delivery_status, account_id)
       VALUES ($1, NULL, $2, $3, true, 'operator', $4, now(), 'queued', $5)`,
      [groupId, clientMsgId, senderPuid, text, input.accountId],
    );
    await client.query(
      "INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)",
      [JSON.stringify({
        groupId,
        msgId: null,
        isOwn: true,
        clientMsgId,
        deliveryStatus: 'queued',
      })],
    );
  });
  notifyWsEventCommitted(); // 先持久化后推送：COMMIT 成功才唤醒投递（T-P2-10 缝）
  deps.onAccepted?.(input.accountId); // dispatcher 唤醒（T-P3-02 接线前 = no-op）
  return { clientMsgId };
}
