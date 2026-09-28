// transition 端点测试（T-P2-05 c 项，先红后绿）。
// 契约出处：REQ §2.3（transition {to,expectedFrom} 三段式错误码）；DES/03 §3（判定顺序：
// 400 → 404 → ILLEGAL_TRANSITION → CAS_CONFLICT；to=disconnected/idle 先落库后补调网关
// disconnect）；A1 并发语义（I5：两请求恰一成功，后写不覆盖先写）；D3-4（to=rate_limited
// 必须带未来时刻的 rateLimitedUntil）。真实 PG + 进程内 mock-gateway。
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import { runAccountsRecoveryScan } from '../../src/modules/accounts/transitions.js';

describe('POST /api/accounts/:id/transition（DES/03 §3 三段式 + disconnect 补调）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let adminToken: string;

  function authed() {
    return { authorization: `Bearer ${adminToken}` };
  }

  function transition(id: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/accounts/${id}/transition`, headers: authed(), payload });
  }

  async function connectAccount(id: string): Promise<void> {
    const res = await app.inject({ method: 'POST', url: `/api/accounts/${id}/connect`, headers: authed() });
    expect(res.statusCode).toBe(200);
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM account WHERE id=$1', [id]);
    return rows[0]?.status ?? '';
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway: createGatewayClient({ baseUrl }),
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin' },
    });
    adminToken = (login.json() as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      "UPDATE account SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, terminal_at=NULL",
    );
    await db.pool.query('DELETE FROM ws_event');
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
  });

  it('非法转移 → 409 ILLEGAL_TRANSITION（含同态→同态；先于任何 DB 判定）', async () => {
    const res = await transition('acc-01', { to: 'rate_limited', expectedFrom: 'idle' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'ILLEGAL_TRANSITION' } });

    const same = await transition('acc-01', { to: 'idle', expectedFrom: 'idle' });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: { code: 'ILLEGAL_TRANSITION' } });
  });

  it('账号不存在 → 404 ACCOUNT_NOT_FOUND（先于 ILLEGAL 判定：要判「当前状态」先得有行）', async () => {
    const res = await transition('acc-99', { to: 'online', expectedFrom: 'idle' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
    // 非法边 + 不存在 → 仍 404（DES/03 §3：SELECT 先于转移表判定）
    const illegalMissing = await transition('acc-99', { to: 'rate_limited', expectedFrom: 'idle' });
    expect(illegalMissing.statusCode).toBe(404);
  });

  it('参数校验：缺 to/expectedFrom、非法枚举 → 400 VALIDATION_ERROR', async () => {
    expect((await transition('acc-01', { to: 'online' })).statusCode).toBe(400);
    expect((await transition('acc-01', { expectedFrom: 'idle' })).statusCode).toBe(400);
    const badEnum = await transition('acc-01', { to: 'on_fire', expectedFrom: 'idle' });
    expect(badEnum.statusCode).toBe(400);
    expect(badEnum.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('to=rate_limited 必须带未来 rateLimitedUntil，缺/非未来 → 400（D3-4）', async () => {
    await connectAccount('acc-01'); // online
    const missing = await transition('acc-01', { to: 'rate_limited', expectedFrom: 'online' });
    expect(missing.statusCode).toBe(400);
    const past = await transition('acc-01', {
      to: 'rate_limited',
      expectedFrom: 'online',
      rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await statusOf('acc-01')).toBe('online'); // 校验失败不产生任何写
  });

  it('online → rate_limited 带未来时刻 → 200 且库内 rate_limited_until 生效', async () => {
    await connectAccount('acc-01');
    const until = new Date(Date.now() + 60_000).toISOString();
    const res = await transition('acc-01', {
      to: 'rate_limited',
      expectedFrom: 'online',
      rateLimitedUntil: until,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('rate_limited');
    const { rows } = await db.pool.query(
      'SELECT status, rate_limited_until AS until FROM account WHERE id=$1',
      ['acc-01'],
    );
    expect(rows[0]?.status).toBe('rate_limited');
    const untilVal = rows[0]?.until;
    expect(new Date(untilVal instanceof Date ? untilVal.toISOString() : String(untilVal)).toISOString()).toBe(until);
  });

  it('disconnected → online 标记转移 → 200（REQ A1 网格 ✔；纯标记，不调网关 connect）', async () => {
    await connectAccount('acc-01'); // online（有 platformUserId）
    const off = await transition('acc-01', { to: 'disconnected', expectedFrom: 'online' });
    expect(off.statusCode).toBe(200);
    const res = await transition('acc-01', { to: 'online', expectedFrom: 'disconnected' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('online');
    expect(await statusOf('acc-01')).toBe('online');
    // ws_event 有帧（先持久化后推送）
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ws_event WHERE type='account_status_changed' ORDER BY seq`);
    const last = rows[rows.length - 1]?.payload;
    expect(last).toMatchObject({ accountId: 'acc-01', from: 'disconnected', to: 'online' });
  });
  it('expectedFrom ≠ 当前状态 → 409 CAS_CONFLICT（后写不覆盖先写）', async () => {
    const res = await transition('acc-01', { to: 'disconnected', expectedFrom: 'online' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'CAS_CONFLICT' } });
    expect(await statusOf('acc-01')).toBe('idle'); // 未变
  });

  it('并发同一转移 → 恰一成功（I5：rowcount 判定，另一请求 CAS_CONFLICT）', async () => {
    await connectAccount('acc-01'); // online
    const [a, b] = await Promise.all([
      transition('acc-01', { to: 'idle', expectedFrom: 'online' }),
      transition('acc-01', { to: 'idle', expectedFrom: 'online' }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(await statusOf('acc-01')).toBe('idle');
  });

  it('online → disconnected：落库后补调网关 disconnect（响应在补偿调用之后返回）', async () => {
    await connectAccount('acc-01');
    const res = await transition('acc-01', { to: 'disconnected', expectedFrom: 'online' });
    expect(res.statusCode).toBe(200);
    expect(await statusOf('acc-01')).toBe('disconnected');
    const { rows: events } = await db.pool.query(
      "SELECT type, payload FROM ws_event WHERE payload->>'accountId'='acc-01' ORDER BY seq",
    );
    // 末帧即本次状态事件：online→disconnected（同事务落库，A1 事件对应已保存状态）
    expect(events.at(-1)?.type).toBe('account_status_changed');
    expect(events.at(-1)?.payload).toMatchObject({ accountId: 'acc-01', from: 'online', to: 'disconnected' });
  });

  it('to=disconnected 的补偿调用在响应前完成（网关侧 5 操作应判离线）', async () => {
    await connectAccount('acc-01');
    await mockApp.inject({ method: 'POST', url: '/accounts/acc-02/connect' });
    // 网关侧建群+邀请，随后服务端 transition → 网关应已判离线（离线 join → 409）
    const group = (await (
      await mockApp.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-02' } })
    ).json()) as { groupId: string };
    await mockApp.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'invite_not_ready', params: { readyAfterMs: 0 }, target: { groupId: group.groupId } },
    });
    const invite = (await (
      await mockApp.inject({ method: 'POST', url: `/groups/${group.groupId}/invite` })
    ).json()) as { inviteLink: string };

    const res = await transition('acc-01', { to: 'disconnected', expectedFrom: 'online' });
    expect(res.statusCode).toBe(200);
    const join = await mockApp.inject({
      method: 'POST',
      url: `/groups/${group.groupId}/join`,
      payload: { accountId: 'acc-01', inviteLink: invite.inviteLink },
    });
    expect(join.statusCode).toBe(409); // ACCOUNT_OFFLINE —— 网关侧确已离线
  });

  it('终态转移（expectedFrom 条件 CAS）：200 + terminal_at 落库 + account_terminal 事件', async () => {
    await connectAccount('acc-01');
    const res = await transition('acc-01', { to: 'suspended', expectedFrom: 'online' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('suspended');
    const { rows } = await db.pool.query(
      'SELECT status, terminal_at FROM account WHERE id=$1',
      ['acc-01'],
    );
    expect(rows[0]?.status).toBe('suspended');
    expect(rows[0]?.terminal_at).not.toBeNull();
    const { rows: events } = await db.pool.query(
      "SELECT type FROM ws_event WHERE payload->>'accountId'='acc-01' ORDER BY seq",
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['account_status_changed', 'account_terminal']),
    );
  });

  it('重复进入同一终态 → CAS_CONFLICT（status≠expectedFrom）；账号仍终态', async () => {
    await connectAccount('acc-01');
    await transition('acc-01', { to: 'suspended', expectedFrom: 'online' });
    const again = await transition('acc-01', { to: 'suspended', expectedFrom: 'online' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'CAS_CONFLICT' } });
    expect(await statusOf('acc-01')).toBe('suspended');
  });
});

async function statusOfQuery(db: TestDbHandle, id: string): Promise<string> {
  const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM account WHERE id=$1', [id]);
  return rows[0]?.status ?? '';
}

describe('accounts 恢复扫描（DES/03 §5.3 + E10：两段式收敛）', () => {
  let db: TestDbHandle;
  let mockApp: GatewayApp;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query("DELETE FROM account WHERE id LIKE 'acc-%'");
    await seed(db.pool);
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
  });

  it('a) 过期 rate_limited → 补转移 online + ws_event；未到期不动（§5.3 条件更新）', async () => {
    await db.pool.query(
      "UPDATE account SET status='rate_limited', rate_limited_until=now()-interval '1s' WHERE id='acc-01'",
    );
    await db.pool.query(
      "UPDATE account SET status='rate_limited', rate_limited_until=now()+interval '1h' WHERE id='acc-02'",
    );
    const disconnects: string[] = [];
    const n = await runAccountsRecoveryScan(db.pool, { disconnect: async (id) => { disconnects.push(id); } });
    expect(await statusOfQuery(db, 'acc-01')).toBe('online');
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='account_status_changed' AND payload->>'accountId'='acc-01'",
    );
    expect(ev[0]?.payload).toMatchObject({ from: 'rate_limited', to: 'online' });
    // acc-02 未到期：不动；acc-01 恢复 online 后不在 disconnect 补偿集合
    const { rows: r2 } = await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-02']);
    expect(r2[0]?.status).toBe('rate_limited');
    expect(disconnects).not.toContain('acc-01');
    expect(disconnects).not.toContain('acc-02');
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('b) status ∈ idle/disconnected → 补调网关 disconnect（E10；幂等，可重复跑）', async () => {
    await db.pool.query("UPDATE account SET status='disconnected' WHERE id='acc-02'");
    const disconnects: string[] = [];
    const deps = { disconnect: async (id: string) => { disconnects.push(id); } };
    const first = await runAccountsRecoveryScan(db.pool, deps);
    // seed 的四个账号默认 idle → 全部补调；acc-02 显式 disconnected 同样命中
    expect(new Set(disconnects)).toEqual(new Set(['acc-01', 'acc-02', 'acc-03', 'acc-04']));
    // 幂等：第二跑不改变结果集（重复调 disconnect 无害）
    disconnects.length = 0;
    const second = await runAccountsRecoveryScan(db.pool, deps);
    expect(second).toBe(first);
    expect(new Set(disconnects)).toEqual(new Set(['acc-01', 'acc-02', 'acc-03', 'acc-04']));
  });
});
