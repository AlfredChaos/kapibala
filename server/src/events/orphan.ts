// 孤儿事件分流（T-P2-04；DES/08 §1.2 孤儿规则段、D3-1；QR/A2）。
// 路由判据（DES/08 §1.2 逐字）：
// - message / member_joined / member_left：payload.groupId 无法映射到任何
//   group.gateway_group_id → 群维度孤儿；
//   - 且不存在 running create_group job 处于 phase='create'（网关建群结果未知、
//     gateway_group_id 映射待回填的窗口，DES/04 §2）→ 永久孤儿：仅入账本 +
//     推一次 inconsistency(unknown_group_event)，**不进死信**（映射永不会出现，
//     死信重试只会空转 20 次制造 dead_letter_stuck 噪音）；
//   - 若处于建群窗口 → 窗口态：走死信路径短重试（映射很快出现，next_retry_at=now()
//     的缺省让首个 5s 节拍即重试——无独立短重试节奏是设计有意裁剪）。
// - account_status：payload.accountId 非我方预置账号（E1 崩溃窗口的孤儿网关账号同理）
//   → 永久孤儿：入账本 + inconsistency，不进死信。
// 窗口判定必须是**单次原子快照**：映射缺失与窗口存在分两次查询有竞态（job 恰在两查之间
// 完成会误判永久孤儿、漏掉本可分发的补投）——合并为一条 SELECT 保证一致读。
// 边界：payload 无对应字段（契约外 payload 形态）→ 不做孤儿判定，照常分发——
// 宁缺勿滥：误判孤儿会吞掉本该领域处理的正常事件。
import type { PoolClient } from 'pg';
import { isRecord } from '../gateway/client.js';
import type { GatewayEventEnvelope } from './dispatch.js';

/** 分流判定结果：dispatch = 走 §1.2 b) 正常分发；windowed = 死信短重试；orphan = 账本+告警收口 */
export type OrphanVerdict =
  | { readonly route: 'dispatch' }
  | { readonly route: 'windowed'; readonly message: string }
  | { readonly route: 'orphan'; readonly message: string };
/** 群引用字段的载体（三元组按 payload 形状取；缺字段 → dispatch 边界规则） */
const GROUP_EVENT_TYPES: Record<string, true> = {
  message: true,
  member_joined: true,
  member_left: true,
};

/**
 * 建群窗口内的孤儿引用（windowed）：事件指向的网关群尚无映射，但存在 running
 * create_group job 且 phase='create'——网关建群调用结果未知，映射即将回填。
 * 主事务回滚后由死信路径重试；与领域写失败的死信共用同一路径（错误语义见消息原文）。
 */
export class OrphanWindowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrphanWindowedError';
  }
}

/**
 * 事件事务内的孤儿判定（§1.2 账本写入之后、分发之前调用；client 即事务载体）。
 * 单条 SELECT 同时取「映射存在？」+「建群窗口存在？」——原子快照，见文件头竞态注。
 */
export async function classifyOrphan(
  client: PoolClient,
  event: GatewayEventEnvelope,
): Promise<OrphanVerdict> {
  if (!isRecord(event.payload)) return { route: 'dispatch' };

  if (GROUP_EVENT_TYPES[event.type] === true) {
    const groupId = event.payload['groupId'];
    if (typeof groupId !== 'string') return { route: 'dispatch' };
    const res = await client.query<{ mapped: boolean; windowed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "group" WHERE gateway_group_id = $1) AS mapped,
              EXISTS (SELECT 1 FROM job
                      WHERE type = 'create_group' AND status = 'running' AND phase = 'create')
                 AS windowed`,
      [groupId],
    );
    const row = res.rows[0];
    if (row === undefined || row.mapped) return { route: 'dispatch' };
    if (row.windowed) {
      return {
        route: 'windowed',
        message: `gateway group '${groupId}' unmapped while a create_group job is in phase=create; mapping expected soon`,
      };
    }
    return {
      route: 'orphan',
      message: `gateway group '${groupId}' has no local mapping and no create_group job is in its creation window`,
    };
  }

  if (event.type === 'account_status') {
    const accountId = event.payload['accountId'];
    if (typeof accountId !== 'string') return { route: 'dispatch' };
    const res = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM account WHERE id = $1) AS exists',
      [accountId],
    );
    if (res.rows[0]?.exists === true) return { route: 'dispatch' };
    return {
      route: 'orphan',
      message: `account '${accountId}' is not one of our provisioned accounts`,
    };
  }

  return { route: 'dispatch' };
}
