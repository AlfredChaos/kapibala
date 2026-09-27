// 限流：429 登记 / 硬闸门 / 到期恢复（T-P2-07；DES/03 §5.1–5.3、REQ A1/A2、QR §2、D2-5）。
// 三段契约：
// - 登记（唯一入口：出站 dispatcher 拿到网关 429）：单事务状态守卫 UPDATE
//   WHERE status IN ('online','rate_limited')——竞态下账号已被置 disconnected/终态时
//   rowcount=0，记 warn 不写字段（D2-5：「非 rate_limited 态恒 NULL」表级不变量
//   靠守卫保住，否则 CASE 保 status 却写出 until，重连后 GET /accounts 输出陈旧值）。
//   until = greatest(now(), rate_limited_until) + retryAfterSeconds——期内再 429
//   从旧 until 末尾顺延（「一次试探重置计时」的语义由闸门侧绝对不试探保证，公式是最后防线）；
//   仍处 rate_limited 只顺延不转移（A1-3：rateLimitedUntil 刷新不算转移）→ 无 ws_event。
// - 闸门（宪法 §3-4：挡在出站最外层）：每次 send 前逐条 SELECT，绝不缓存
//   （S4 零试探根基：限流期内该账号到达网关的 send 数恒为 0）；disconnect/leave 不走本闸门。
// - 到期恢复（调度器兜底）：条件 UPDATE 回 online + until=NULL + ws_event 同事务 +
//   唤醒 dispatcher 补发 queued（原顺序）；到期时已非 rate_limited → 条件命中 0 行不转移。
import type { Pool, PoolClient } from 'pg';
import { tx } from '../../db/tx.js';
import { AppError } from '../../http/plugins/errors.js';

/** 最小日志面（与 scheduler/consumer 同模式；测试可用普通对象 fake） */
export interface RateLimitLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** 登记结果：transitioned=首次进限流（发了 ws_event）；extended=期内顺延（不算转移）；skipped=竞态守卫拦下 */
export type RateLimitOutcome = 'transitioned' | 'extended' | 'skipped';

/**
 * 429 登记（DES/03 §5.1 逐字单事务）。
 * SELECT FOR UPDATE 先读转移前值（判定 transition 还是 extend + 锁行等并发转移落定），
 * 再条件 UPDATE——行锁保证两次读到的 status 一致，守卫永远和写入同一快照。
 */
export async function registerRateLimit(
  deps: { pool: Pool; logger: RateLimitLogger },
  accountId: string,
  retryAfterSeconds: number,
): Promise<RateLimitOutcome> {
  return tx(deps.pool, async (client: PoolClient) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM account WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    const current = rows[0]?.status;
    if (current !== 'online' && current !== 'rate_limited') {
      // 429 到达时账号已不在 online/rate_limited（disconnected/终态/不存在）：
      // 守门不写字段——记 warn 供排查（§5.1 rowcount=0 分支的等价实现）
      deps.logger.warn(
        { accountId, status: current ?? null },
        '429 rate-limit registration skipped: account not in online/rate_limited',
      );
      return 'skipped';
    }
    await client.query(
      `UPDATE account SET
         rate_limited_until = greatest(now(), rate_limited_until) + make_interval(secs => $2),
         status = 'rate_limited',
         updated_at = now()
       WHERE id = $1 AND status IN ('online','rate_limited')`,
      [accountId, retryAfterSeconds],
    );
    if (current === 'online') {
      await client.query(
        "INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)",
        [JSON.stringify({ accountId, from: 'online', to: 'rate_limited' })],
      );
      return 'transitioned';
    }
    return 'extended'; // until 刷新不算转移（A1-3）→ 无 ws_event
  });
}

/** 闸门判定结果；blocked=true 时 until 即重试时刻（持久化真值，调度器兜底到期转移） */
export interface RateLimitGateResult {
  readonly blocked: boolean;
  readonly rateLimitedUntil?: Date;
}

/**
 * 硬闸门（DES/03 §5.2）：出站 dispatcher 每次 send 前逐条调用。
 * 不缓存进程内判定——每轮 SELECT 读提交真值；到期未转移的行放行
 * （until<=now() 即不拦，恢复转移由调度器兜底，闸门不越权改状态）。
 * 不存在的账号抛 ACCOUNT_NOT_FOUND（调用方 bug/外键缺失，不能静默放行）。
 */
export async function checkRateLimit(pool: Pool, accountId: string): Promise<RateLimitGateResult> {
  const { rows } = await pool.query<{ status: string; rate_limited_until: Date | null }>(
    'SELECT status, rate_limited_until FROM account WHERE id = $1',
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${accountId}`);
  }
  if (row.status === 'rate_limited' && row.rate_limited_until !== null && row.rate_limited_until.getTime() > Date.now()) {
    return { blocked: true, rateLimitedUntil: row.rate_limited_until };
  }
  return { blocked: false };
}

// ---------- 到期恢复扫描（DES/03 §5.3；注册行进 scheduler/ratelimit-scan.ts） ----------

export const RATE_LIMIT_SCAN_NAME = 'rate-limit-expiry';

export interface RateLimitExpiryDeps {
  readonly pool: Pool;
  readonly logger: RateLimitLogger;
  /** 唤醒出站 dispatcher 重发该账号 queued（T-P3-02 接线；缺省 = 无唤醒，DB 恢复照样发生） */
  readonly wakeDispatcher?: (accountId: string) => void;
}

/**
 * 周期扫描体：条件 UPDATE 收拢全部到期行（同事务逐行补 ws_event）→ 事务外逐账号唤醒。
 * 「到期时已不是 rate_limited 则不转移」由 WHERE status='rate_limited' 条件天然满足。
 * 幂等可重复触发（宪法 §3-5）：第二轮命中空集。
 */
export function createRateLimitExpiryScan(deps: RateLimitExpiryDeps): () => Promise<number> {
  return async () => {
    const recovered = await tx(deps.pool, async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE account SET status='online', rate_limited_until=NULL, updated_at=now()
         WHERE status='rate_limited' AND rate_limited_until <= now()
         RETURNING id`,
      );
      for (const row of rows) {
        await client.query(
          "INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)",
          [JSON.stringify({ accountId: row.id, from: 'rate_limited', to: 'online' })],
        );
      }
      return rows.map((r) => r.id);
    });
    for (const id of recovered) {
      deps.logger.info({ accountId: id }, 'rate limit expired: account back online');
      deps.wakeDispatcher?.(id);
    }
    return recovered.length;
  };
}

