// T-P2-07 c)：限流登记单事务 / 硬闸门 / 到期自动恢复（DES/03 §5.1–5.3、REQ A1/A2、
// VITEST_PLAN §5 D2-5、QR §2）。模块级真 DB 断言（不 mock DB；gateway 不参与——
// 429 是网关已经返回过的事实，本卡测的是登记/闸门/恢复三段的服务端语义）。
// 覆盖：
// - 429 登记：online → rate_limited + until=greatest(now(),旧until)+N + ws_event；
// - 期内再 429 → until 从旧 until 末尾顺延（期外重置语义的 DB 兜底），不算转移（无新事件）；
// - 429 × 非 online/rate_limited 竞态 → rowcount=0 → until 恒 NULL + warn（D2-5）；
// - 硬闸门逐条查询：rate_limited 且未到期 → 拦；其它态/到期/不存在 → 行为分明；
// - 到期扫描：条件更新回 online + until=NULL + ws_event + 唤醒 dispatcher 缝；
//   已非 rate_limited 不转移（A1 明文）；幂等可重复触发。
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTestDb } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import {
  checkRateLimit,
  createRateLimitExpiryScan,
  registerRateLimit,
  type RateLimitLogger,
} from '../../src/modules/accounts/rate-limit.js';
import { AppError } from '../../src/http/plugins/errors.js';

// —— 夹具 ——

function captureLogger(): { logger: RateLimitLogger; entries: Array<{ level: string; msg: string; obj: unknown }> } {
  const entries: Array<{ level: string; msg: string; obj: unknown }> = [];
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj, msg: msg ?? '' });
    };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

async function setStatus(
  pool: Pool,
  accountId: string,
  status: string,
  untilSeconds?: number,
): Promise<void> {
  if (untilSeconds === undefined) {
    await pool.query('UPDATE account SET status=$1, rate_limited_until=NULL WHERE id=$2', [
      status,
      accountId,
    ]);
  } else {
    await pool.query(
      "UPDATE account SET status=$1, rate_limited_until=now() + ($2 || ' seconds')::interval WHERE id=$3",
      [status, untilSeconds, accountId],
    );
  }
}

interface AccountRow {
  status: string;
  rate_limited_until: Date | null;
}

async function readAccount(pool: Pool, accountId: string): Promise<AccountRow> {
  const res = await pool.query<AccountRow>(
    'SELECT status, rate_limited_until FROM account WHERE id=$1',
    [accountId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`account ${accountId} missing`);
  return row;
}

async function wsEvents(pool: Pool, accountId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const res = await pool.query<{ type: string; payload: Record<string, unknown> }>(
    "SELECT type, payload FROM ws_event WHERE payload->>'accountId' = $1 ORDER BY seq",
    [accountId],
  );
  return res.rows;
}

const SEC = 1000;

// —— 用例 ——

describe('rate-limit register / gate / expiry recovery (T-P2-07, D2-5)', () => {
  it('429 on online account → rate_limited, until≈now+retryAfterSeconds, account_status_changed ws_event (DES/03 §5.1)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'online');
      const { logger } = captureLogger();
      const before = Date.now();

      const result = await registerRateLimit({ pool, logger }, 'acc-01', 30);

      expect(result).toBe('transitioned');
      const row = await readAccount(pool, 'acc-01');
      expect(row.status).toBe('rate_limited');
      const until = row.rate_limited_until;
      if (until === null) throw new Error('rate_limited_until must be set');
      const delta = until.getTime() - before;
      expect(delta).toBeGreaterThan(28 * SEC); // now+30s 的下沿容忍 2s 时钟差
      expect(delta).toBeLessThan(35 * SEC);
      const events = await wsEvents(pool, 'acc-01');
      expect(events).toEqual([
        { type: 'account_status_changed', payload: { accountId: 'acc-01', from: 'online', to: 'rate_limited' } },
      ]);
    });
  });

  it('second 429 while rate_limited extends until from OLD until end (greatest formula), not a transition — no new ws_event (A1-3)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'online');
      const { logger } = captureLogger();
      await registerRateLimit({ pool, logger }, 'acc-01', 60);
      const first = (await readAccount(pool, 'acc-01')).rate_limited_until;
      if (first === null) throw new Error('until must be set');

      const result = await registerRateLimit({ pool, logger }, 'acc-01', 10);

      expect(result).toBe('extended');
      const second = (await readAccount(pool, 'acc-01')).rate_limited_until;
      if (second === null) throw new Error('until must be set');
      // 顺延基点必须是旧 until（而非 now）：new ≈ old + 10s——若错写成 now()+10s 会少 ~60s
      const fromOld = second.getTime() - (first.getTime() + 10 * SEC);
      expect(Math.abs(fromOld)).toBeLessThan(3 * SEC);
      const events = await wsEvents(pool, 'acc-01');
      expect(events).toHaveLength(1); // 刷新不算转移：仍只有首次那一帧
    });
  });

  it('429 racing disconnected/suspended/unknown → rowcount=0, warn logged, until stays NULL (D2-5 invariant: non-rate_limited ⇒ until NULL)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'disconnected');
      await setStatus(pool, 'acc-02', 'suspended');
      const { logger, entries } = captureLogger();

      expect(await registerRateLimit({ pool, logger }, 'acc-01', 30)).toBe('skipped');
      expect(await registerRateLimit({ pool, logger }, 'acc-02', 30)).toBe('skipped');
      expect(await registerRateLimit({ pool, logger }, 'ghost', 30)).toBe('skipped');

      for (const id of ['acc-01', 'acc-02']) {
        const row = await readAccount(pool, id);
        expect(row.rate_limited_until).toBeNull(); // 表级不变量不被竞态破坏
      }
      expect((await readAccount(pool, 'acc-01')).status).toBe('disconnected');
      expect((await readAccount(pool, 'acc-02')).status).toBe('suspended');
      expect(entries.filter((e) => e.level === 'warn')).toHaveLength(3); // 每次竞态都有可观测日志
      expect(await wsEvents(pool, 'acc-01')).toHaveLength(0); // 无转移无事件
    });
  });

  it('hard gate: rate_limited+unexpired → blocked with until; online/expired/other statuses pass; unknown id → ACCOUNT_NOT_FOUND (§5.2 per-row, no cache)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'rate_limited', 60);
      await setStatus(pool, 'acc-02', 'rate_limited', -5); // 已到期但扫描未跑：闸门按 until>now() 判定
      await setStatus(pool, 'acc-03', 'online');
      await setStatus(pool, 'acc-04', 'disconnected'); // disconnect/leave 不受限（A2）

      const blocked = await checkRateLimit(pool, 'acc-01');
      expect(blocked.blocked).toBe(true);
      if (blocked.rateLimitedUntil === undefined) throw new Error('blocked verdict must carry until');
      expect(blocked.rateLimitedUntil.getTime()).toBeGreaterThan(Date.now());

      expect((await checkRateLimit(pool, 'acc-02')).blocked).toBe(false); // 到期即放行（扫描只管转移，闸门不管它）
      expect((await checkRateLimit(pool, 'acc-03')).blocked).toBe(false);
      expect((await checkRateLimit(pool, 'acc-04')).blocked).toBe(false);

      let thrown: unknown;
      try {
        await checkRateLimit(pool, 'ghost');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('ACCOUNT_NOT_FOUND');
    });
  });

  it('gate queries the row every call — post-commit status change takes effect immediately (S4 zero-probe foundation)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'online');
      expect((await checkRateLimit(pool, 'acc-01')).blocked).toBe(false);
      const { logger } = captureLogger();
      await registerRateLimit({ pool, logger }, 'acc-01', 30);
      // 无缓存：同一连接下一轮查询必须看到刚提交的状态
      expect((await checkRateLimit(pool, 'acc-01')).blocked).toBe(true);
    });
  });

  it('expiry scan: expired rate_limited → online + until=NULL + ws_event + dispatcher wake; future/non-rate_limited untouched; idempotent (§5.3)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setStatus(pool, 'acc-01', 'rate_limited', -1); // 到期
      await setStatus(pool, 'acc-02', 'rate_limited', 600); // 未到期
      await setStatus(pool, 'acc-03', 'online');
      await setStatus(pool, 'acc-04', 'disconnected');
      const { logger } = captureLogger();
      const woken: string[] = [];
      const scan = createRateLimitExpiryScan({
        pool,
        logger,
        wakeDispatcher: (accountId) => {
          woken.push(accountId);
        },
      });

      expect(await scan()).toBe(1);

      const recovered = await readAccount(pool, 'acc-01');
      expect(recovered.status).toBe('online');
      expect(recovered.rate_limited_until).toBeNull();
      expect(await wsEvents(pool, 'acc-01')).toEqual([
        { type: 'account_status_changed', payload: { accountId: 'acc-01', from: 'rate_limited', to: 'online' } },
      ]);
      expect(woken).toEqual(['acc-01']); // 唤醒出站 dispatcher 补发 queued 消息

      expect((await readAccount(pool, 'acc-02')).status).toBe('rate_limited'); // 未到期不动
      expect((await readAccount(pool, 'acc-03')).status).toBe('online');
      expect((await readAccount(pool, 'acc-04')).status).toBe('disconnected');

      expect(await scan()).toBe(0); // 条件更新幂等：第二轮零处理、零事件
      expect(await wsEvents(pool, 'acc-01')).toHaveLength(1);
    });
  });

  it('expiry scan does NOT resurrect an account moved off rate_limited before expiry (A1: 已非 rate_limited 不转移)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      // 到期时刻账号已被操作员标为 disconnected——条件更新 rowcount=0，不做转移
      await setStatus(pool, 'acc-01', 'disconnected');
      const { logger } = captureLogger();
      const woken: string[] = [];
      const scan = createRateLimitExpiryScan({
        pool,
        logger,
        wakeDispatcher: (accountId) => {
          woken.push(accountId);
        },
      });

      expect(await scan()).toBe(0);
      expect((await readAccount(pool, 'acc-01')).status).toBe('disconnected');
      expect(await wsEvents(pool, 'acc-01')).toHaveLength(0);
      expect(woken).toHaveLength(0);
    });
  });
});
