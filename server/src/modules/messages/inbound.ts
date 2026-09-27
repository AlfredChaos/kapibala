// SSE `message` 入站投影（T-P2-08；DES/05 §3 管线 + §4.1/§4.2 一行原则、REQ §2.1 S2/S3、A2）。
// 判序逐字对应 §3 mermaid：
//   own 检测：senderPlatformUserId ∈ account.platform_user_id 非空集合（ownPlatformUserIds 的 DB 真值，
//   每次事件现查不缓存——宪法 §3-5；账号集合极少，一行 EXISTS 足够）；
//   外部消息 → INSERT is_own=false, delivery_status=NULL（NULL 语义 = 入站无投递状态，§5.3 逐字）
//             ON CONFLICT (group_id,msg_id) 部分唯一索引吸收补投/重推（S2：冲突不重复触发 agent）；
//   自己回流 → (group_id,msg_id) 已有行（message_sent 先到已回填）→ 幂等跳过；
//             无行 → 插占位行 is_own=true, delivery_status='sent', client_msg_id=NULL（等 §4.3
//             finalizeSent 合并——先删占位再补双侧身份，D1-3 由 T-P2-09 前的 message_sent 路径接管）；
//   自己回流永不触发 agent（A2 明文）。
// 每次成功新插（外部或回流占位）→ ws_event(message)（DES/08 §2.3：新消息插入属三类来源之一；
// clientMsgId/deliveryStatus 仅 own 携带）。agent 触发判定收口在 modules/agent/trigger-entry.ts。
// 幂等性：本函数只在事件事务内被调用（ctx.client），全部写入都是条件/冲突吸收式——
// at-least-once 重推与 since 补拉的重放天然安全。
import type { PoolClient } from 'pg';
import type { GatewayMessageEvent } from '@kapibala/contract';
import { tryTriggerAgentRun } from '../agent/trigger-entry.js';
import type { DispatchLogger } from '../../events/dispatch.js';

/** 投影结果（测试断言 + 调用方日志用） */
export type InboundOutcome =
  | 'inserted' // 外部新消息落行（可能已触发 agent）
  | 'own_inserted' // 回流无既有行 → 占位行
  | 'merged' // 回流命中回填行 → 幂等跳过
  | 'duplicate' // (groupId,msgId) 冲突吸收（S2）
  | 'skipped'; // 群映射缺失（orphan.ts 已分流，此处为防御兜底）

interface GroupRow {
  id: string;
  status: string;
  agent_enabled: boolean;
  auto_kick_enabled: boolean;
}

/**
 * 入站投影主函数。client = 事件处理事务载体（DES/08 §1.2 b）；绝不自带事务/连接。
 * payload 形状由 handlers/message.ts 收窄；本函数只做投影与触发判定。
 */
export async function projectInboundMessage(
  client: PoolClient,
  msg: GatewayMessageEvent,
  logger: DispatchLogger,
): Promise<InboundOutcome> {
  // 1) 群映射：payload.groupId 是网关群 id → 本地 group.gateway_group_id（orphan.ts 已分流
  //    未知群；此处再兜底一次防竞态——映射恰在两步之间被移除）
  const groupRes = await client.query<GroupRow>(
    `SELECT id, status, agent_enabled, auto_kick_enabled FROM "group" WHERE gateway_group_id = $1`,
    [msg.groupId],
  );
  const group = groupRes.rows[0];
  if (group === undefined) {
    logger.warn(
      { groupId: msg.groupId, msgId: msg.msgId },
      'inbound message for unmapped gateway group; skipped (defensive — orphan routing should have caught it)',
    );
    return 'skipped';
  }

  // 2) own 检测：senderPlatformUserId 命中服务账号集合 → 该账号 id（回流占位行的 account_id 也用它）
  const ownRes = await client.query<{ id: string }>(
    'SELECT id FROM account WHERE platform_user_id = $1',
    [msg.senderPlatformUserId],
  );
  const ownAccountId = ownRes.rows[0]?.id;

  // 3) 已存在判定（回流 merge 分支需要先区分「冲突吸收」与「插入成功」——ON CONFLICT
  //    RETURNING 的 rowcount 即真值，无需预检）
  if (ownAccountId !== undefined) {
    const exists = await client.query(
      'SELECT 1 FROM message WHERE group_id = $1 AND msg_id = $2',
      [group.id, msg.msgId],
    );
    if ((exists.rowCount ?? 0) > 0) {
      // 幂等合并且补齐 media_url：出站行 INSERT 时本无 mediaUrl（§4.3 只回填确认字段），
      // 回流事件是唯一载体——不补则 own 媒体消息永远丢 media_url，C1 下载无从发生。
      // 条件更新 media_url IS NULL：重复回流/双推吸收（幂等，已带值不覆写）
      if (msg.mediaUrl !== undefined && msg.mediaUrl !== null) {
        await client.query(
          `UPDATE message SET media_url=$3, updated_at=now()
            WHERE group_id=$1 AND msg_id=$2 AND media_url IS NULL`,
          [group.id, msg.msgId, msg.mediaUrl],
        );
      }
      return 'merged'; // message_sent 先到已回填 → 幂等跳过（§4.1 表第 4 行）
    }
    // 乱序窗口内回流先到：插占位行，client_msg_id=NULL 等 finalizeSent 补关联（§4.3）
    await client.query(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id, media_url)
       VALUES ($1,$2,$3,true,'inbound',$4,$5,'sent',$6,$7)
       ON CONFLICT (group_id, msg_id) WHERE msg_id IS NOT NULL DO NOTHING`,
      [group.id, msg.msgId, msg.senderPlatformUserId, msg.text, msg.sentAt, ownAccountId, msg.mediaUrl ?? null],
    );
    await insertWsMessage(client, { groupId: group.id, msgId: msg.msgId, isOwn: true, deliveryStatus: 'sent' });
    return 'own_inserted';
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id, media_url)
     VALUES ($1,$2,$3,false,'inbound',$4,$5,NULL,NULL,$6)
     ON CONFLICT (group_id, msg_id) WHERE msg_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [group.id, msg.msgId, msg.senderPlatformUserId, msg.text, msg.sentAt, msg.mediaUrl ?? null],
  );
  const inserted = ins.rows[0];
  if (inserted === undefined) {
    return 'duplicate'; // 补投/重推吸收——不重复触发 agent（S2）
  }
  await insertWsMessage(client, { groupId: group.id, msgId: msg.msgId, isOwn: false });

  // 4) agent 触发（§4.4 判定收口在 trigger-entry；本层只给「插入成功的新外部消息」）
  await tryTriggerAgentRun(client, {
    group: {
      id: group.id,
      status: group.status,
      agentEnabled: group.agent_enabled,
      autoKickEnabled: group.auto_kick_enabled,
    },
    message: {
      id: inserted.id,
      msgId: msg.msgId,
      senderPlatformUserId: msg.senderPlatformUserId,
      text: msg.text,
      sentAt: msg.sentAt,
    },
  });
  return 'inserted';
}

/** ws_event(message) 的 DES/08 §2.3 形状：clientMsgId/deliveryStatus 仅 own 携带 */
async function insertWsMessage(
  client: PoolClient,
  payload: {
    groupId: string;
    msgId: string;
    isOwn: boolean;
    clientMsgId?: string;
    deliveryStatus?: string;
  },
): Promise<void> {
  const body: Record<string, unknown> = {
    groupId: payload.groupId,
    msgId: payload.msgId,
    isOwn: payload.isOwn,
  };
  if (payload.clientMsgId !== undefined) body['clientMsgId'] = payload.clientMsgId;
  if (payload.deliveryStatus !== undefined) body['deliveryStatus'] = payload.deliveryStatus;
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
    JSON.stringify(body),
  ]);
}
