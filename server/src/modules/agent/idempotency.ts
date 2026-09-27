// agent send_message 幂等 key 域（T-P4-09；REQ A5-7 + DES/06 §8.2 key 生命周期逐条 + DES/10 E13）。
// 契约钉死：
// - 命中 = (run_id, key) 行存在 → 不发送、**不再审计**、按该消息当前状态回 tool_result；
// - 消耗时机 = 审计 pass 且创建出站消息的**同一事务**（E13；审计 fail/被拒不落行——不消耗）；
// - 二次创建被 (run_id, idempotency_key) PK 唯一约束天然阻止；恢复路径按消息现状生成结果、
//   绝不二次创建（dispatch_payload 快照重发时本查表先行）。
import type { PoolClient } from 'pg';

export interface IdempotencyHit {
  readonly clientMsgId: string;
}

/** 查 (run_id, key) 是否已消耗；命中返回关联的 client_msg_id（按它查消息现状） */
export async function lookupIdempotencyKey(
  client: PoolClient,
  runId: string,
  key: string,
): Promise<IdempotencyHit | undefined> {
  const { rows } = await client.query<{ client_msg_id: string }>(
    'SELECT client_msg_id FROM agent_idempotency_key WHERE run_id=$1 AND idempotency_key=$2',
    [runId, key],
  );
  const row = rows[0];
  return row === undefined ? undefined : { clientMsgId: row.client_msg_id };
}

/** 消耗 key（E13：与出站消息行同事务落；PK 冲突=并发/重放，调用方决定语义） */
export async function consumeIdempotencyKey(
  client: PoolClient,
  args: { runId: string; key: string; clientMsgId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_idempotency_key (run_id, idempotency_key, client_msg_id)
     VALUES ($1, $2, $3)`,
    [args.runId, args.key, args.clientMsgId],
  );
}
