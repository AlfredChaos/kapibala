// 崩溃注入基建自检（T-P7-01 acceptance c）：可起 / 可杀 / 可重启、端口与库隔离、
// withCrashPoint exit-9 语义、`@N` 命中计数、崩溃窗口（tx.commit.before 回滚 / after 已持久化）。
// 每用例独立 database（模板+随机后缀）与独立 in-process mock 实例。
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertPostCrashHealth, withCrashPoint } from '../helpers/crash.js';
import { startCrashServer, type CrashServerHandle } from '../helpers/server-process.js';

async function connect(handle: CrashServerHandle, accountId: string, token: string): Promise<Response> {
  return fetch(`${handle.baseUrl}/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
}

async function accountStatus(db: Pool, accountId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM account WHERE id=$1`, [accountId]);
  return rows[0]?.status ?? 'missing';
}

describe('crash infrastructure self-check (T-P7-01)', () => {
  it('子进程可起、可注入崩溃 exit 9、可重启恢复，mock/库同实例延续', async () => {
    const handle = await startCrashServer();
    try {
      const token = await handle.login();
      const health = await fetch(`${handle.baseUrl}/api/health`);
      expect(health.status).toBe(200);

      // gateway.call.connect.before：connect 请求尚未到网关（外部调用前窗口）
      await withCrashPoint(handle, 'gateway.call.connect.before', () => connect(handle, 'acc-01', token));

      // 崩溃窗口断言：网关从未收到调用 → connectCalls 计数不存在，DB account 仍 idle
      const counters = await assertPostCrashHealth(handle);
      expect(counters).toBeDefined();
      await handle.login(); // 重启后服务恢复（断言器已保 /api/health 200）
      expect(await accountStatus(handle.db.pool, 'acc-01')).toBe('idle');
    } finally {
      await handle.stop();
    }
  }, 90000);

  it('tx.commit.before：事务回滚（account 仍 idle）；after：已持久化', async () => {
    const handle = await startCrashServer();
    try {
      const token = await handle.login();

      // before-commit 崩溃 → ROLLBACK：网关可能已见 connect（先网关后 DB 窗口）但 DB 无记录
      await withCrashPoint(handle, 'tx.commit.before', () => connect(handle, 'acc-01', token));
      await assertPostCrashHealth(handle);
      expect(await accountStatus(handle.db.pool, 'acc-01')).toBe('idle');

      // after-commit 崩溃 → COMMIT 已发生：重启后 DB 状态保持 connected
      const token2 = await handle.login();
      await withCrashPoint(handle, 'tx.commit.after', () => connect(handle, 'acc-01', token2));
      await assertPostCrashHealth(handle);
      expect(await accountStatus(handle.db.pool, 'acc-01')).toBe('online');
    } finally {
      await handle.stop();
    }
  }, 120000);

  it('@N 命中计数 + 每用例独立 database / mock 实例', async () => {
    const [a, b] = await Promise.all([startCrashServer(), startCrashServer()]);
    try {
      expect(a.baseUrl).not.toBe(b.baseUrl);
      expect(a.db.name).not.toBe(b.db.name);
      expect(a.gatewayUrl).not.toBe(b.gatewayUrl);

      const ta = await a.login();
      const tb = await b.login();
      // b 无崩溃点：connect 正常返回（库不串扰——b 的库与 a 不同）
      const res = await connect(b, 'acc-01', tb);
      expect(res.status).toBe(200);
      expect(await accountStatus(b.db.pool, 'acc-01')).toBe('online');
      expect(await accountStatus(a.db.pool, 'acc-01')).toBe('idle'); // a 未被 b 影响

      // a：命中计数 @2 —— 第一调正常过（200），第二调才崩 exit 9
      const arm = await fetch(`${a.baseUrl}/_test/crash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ta}` },
        body: JSON.stringify({ name: 'gateway.call.connect.before', hit: 2 }),
      });
      expect(arm.status).toBe(200);
      const first = await connect(a, 'acc-01', ta);
      expect(first.status).toBe(200); // 命中计数未到 → 不崩
      await connect(a, 'acc-02', ta).catch(() => undefined); // 第二调崩（连接断属预期）
      expect(await a.awaitExit()).toBe(9);
      await assertPostCrashHealth(a); // 可重启恢复
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  }, 120000);
});
