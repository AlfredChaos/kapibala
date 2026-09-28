// 消息活动聚合（dashboard「近 30 分钟」柱图）：整库一次桶化，替代前端逐群拉时间线。
// 口径与 web/src/dashboard/metrics.ts bucketize 完全一致：
//   buckets 个连续分钟桶，末桶右端点 = 当前分钟左端点 + bucketMs（含「正在进行的这一分钟」）。
// 返回 endMinute（末桶左端点 epoch ms）——前端以它为锚重对齐，live ws 帧 > 此值的补在右侧。
import type { Pool, PoolClient } from 'pg';

export interface ActivityWindow {
  /** 末桶左端点 epoch ms（= floor(now/bucketMs)*bucketMs） */
  readonly endMinute: number;
  readonly bucketMs: number;
  /** 旧→新；长度恒 = buckets */
  readonly buckets: readonly number[];
}

export async function listMessageActivity(
  deps: { pool: Pool | PoolClient },
  options: { nowMs?: number; buckets?: number; bucketMs?: number } = {},
): Promise<ActivityWindow> {
  const nowMs = options.nowMs ?? Date.now();
  const buckets = options.buckets ?? 30;
  const bucketMs = options.bucketMs ?? 60_000;
  if (!Number.isInteger(buckets) || buckets <= 0 || buckets > 240) {
    throw new Error('buckets must be an integer in 1..240');
  }
  if (!Number.isInteger(bucketMs) || bucketMs <= 0) {
    throw new Error('bucketMs must be a positive integer');
  }
  const last = Math.floor(nowMs / bucketMs);
  const first = last - buckets + 1;
  const windowStartMs = first * bucketMs;

  const { rows } = await deps.pool.query<{ bucket: string; n: string }>(
    `SELECT floor(extract(epoch from sent_at) * 1000 / $2)::bigint AS bucket, count(*) AS n
       FROM message
      WHERE sent_at >= to_timestamp($1::numeric / 1000)
      GROUP BY bucket`,
    [windowStartMs, bucketMs],
  );
  const out = new Array<number>(buckets).fill(0);
  for (const r of rows) {
    const b = Number(r.bucket);
    const i = b - first;
    if (i >= 0 && i < buckets) out[i] = Number(r.n);
  }
  return { endMinute: last * bucketMs, bucketMs, buckets: out };
}
