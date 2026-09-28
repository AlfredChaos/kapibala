// 状态机转移表 + connect 判定测试（T-P2-05 c 项，先红后绿）。
// 契约出处：REQ §2.3 账号端点行（transition {to,expectedFrom} / connect）、A1 转移表逐格
// （16 条合法边；含同态→同态一律 ILLEGAL_TRANSITION；expectedFrom ≠ 当前 → CAS_CONFLICT）；
// DES/03 §1–§3（connect 前置 {idle,disconnected} → 先调网关后落库；to=disconnected/idle
// 先落库后补调网关 disconnect）；QR §4 错误码。真实 PG + 进程内 mock-gateway（不 mock DB/网关）。
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import {
  isLegalTransition,
  isTerminal,
  LEGAL_TRANSITIONS,
  TERMINAL_STATUSES,
  type AccountStatusValue,
} from '../../src/modules/accounts/transitions.js';

// A1 转移表（REQ 网格 16 ✔ 逐格，含 disconnected→online——transition 是纯标记操作，
// 不调网关 connect；真实重连仍走 POST /connect。REQ 未给「connect 专属边」豁免，按字面对齐）
const A1_LEGAL: ReadonlyArray<readonly [AccountStatusValue, AccountStatusValue]> = [
  ['idle', 'online'],
  ['idle', 'suspended'],
  ['idle', 'session_expired'],
  ['online', 'idle'],
  ['online', 'rate_limited'],
  ['online', 'disconnected'],
  ['online', 'suspended'],
  ['online', 'session_expired'],
  ['rate_limited', 'online'],
  ['rate_limited', 'disconnected'],
  ['rate_limited', 'suspended'],
  ['rate_limited', 'session_expired'],
  ['disconnected', 'idle'],
  ['disconnected', 'online'],
  ['disconnected', 'suspended'],
  ['disconnected', 'session_expired'],
];

describe('转移表 transitions.ts（A1 逐格；同态→同态非法）', () => {
  it('合法边集合 = 16 条（REQ 网格逐格，含 disconnected→online）', () => {
    for (const [from, to] of A1_LEGAL) {
      expect(isLegalTransition(from, to), `${from}→${to}`).toBe(true);
    }
    expect(LEGAL_TRANSITIONS.size).toBe(A1_LEGAL.length);
    // disconnected→online 现在是合法标记转移（REQ A1 网格 ✔；此前收窄已回拨）
    expect(isLegalTransition('disconnected', 'online')).toBe(true);
  });

  it('同态→同态与其余组合全非法（6×6 − 16 = 20 条）', () => {
    const all: AccountStatusValue[] = [
      'idle',
      'online',
      'rate_limited',
      'disconnected',
      'suspended',
      'session_expired',
    ];
    for (const from of all) {
      for (const to of all) {
        const legal = A1_LEGAL.some(([f, t]) => f === from && t === to);
        expect(isLegalTransition(from, to), `${from}→${to}`).toBe(legal);
      }
    }
    expect(isTerminal('suspended')).toBe(true);
    expect(isTerminal('session_expired')).toBe(true);
    expect(isTerminal('online')).toBe(false);
    expect(TERMINAL_STATUSES).toEqual(['suspended', 'session_expired']);
  });
});

describe('POST /api/accounts/:id/connect（DES/03 §2：前置 {idle,disconnected} → 先调网关后落库）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockBaseUrl: string;
  let mockApp: GatewayApp;

  async function loginAdmin(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function setStatus(id: string, status: AccountStatusValue, extra?: { rateLimitedUntil?: string | null }) {
    await db.pool.query('UPDATE account SET status=$2, rate_limited_until=$3 WHERE id=$1', [
      id,
      status,
      extra?.rateLimitedUntil ?? null,
    ]);
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    mockBaseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway: createGatewayClient({ baseUrl: mockBaseUrl }),
    });
  });
  afterAll(async () => {
    await app.close();
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    // 每用例回到种子面（幂等）：status/平台位/限流位全复位
    await db.pool.query(
      "UPDATE account SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, terminal_at=NULL",
    );
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
  });

  it('idle 账号 connect → 200 {status:"online", platformUserId} 且库内一致；事件已落库（先持久化）', async () => {
    const token = await loginAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-01/connect',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; platformUserId: string };
    expect(body.status).toBe('online');
    expect(body.platformUserId).toBeTruthy();

    const { rows } = await db.pool.query(
      'SELECT status, platform_user_id AS puid FROM account WHERE id=$1',
      ['acc-01'],
    );
    expect(rows[0]).toEqual({ status: 'online', puid: body.platformUserId });
    // ws_event 与状态同事务（A1：推给前端的事件必须对应已保存的状态）
    const { rows: events } = await db.pool.query(
      "SELECT type, payload FROM ws_event WHERE payload->>'accountId'='acc-01'",
    );
    expect(events.map((e) => e.type)).toEqual(['account_status_changed']);
    expect(events[0]?.payload).toMatchObject({ accountId: 'acc-01', from: 'idle', to: 'online' });
  });

  it('rate_limited 时 connect → 409 ILLEGAL_TRANSITION（从严前置 #1）；online/终态同样 409', async () => {
    const token = await loginAdmin();
    await setStatus('acc-01', 'rate_limited', {
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-01/connect',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'ILLEGAL_TRANSITION' } });

    await setStatus('acc-02', 'suspended');
    const term = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-02/connect',
      headers: authed(token),
    });
    expect(term.statusCode).toBe(409); // 终态同样不在前置集合
  });

  it('disconnected → connect 恢复 online（复用同一 platformUserId——网关幂等，DES/03 §2）', async () => {
    const token = await loginAdmin();
    // 先真连一次取网关的确定性 puid，再人工置回 disconnected 重连——同一 accountId 必须返回同 puid
    const first = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-01/connect',
      headers: authed(token),
    });
    const puid = (first.json() as { platformUserId: string }).platformUserId;
    await setStatus('acc-01', 'disconnected');
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-01/connect',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { platformUserId: string }).platformUserId).toBe(puid);
    // 落库也须是网关给的 puid（§2：UPDATE ... platform_user_id=$puid，覆盖为权威值）
    const { rows } = await db.pool.query('SELECT platform_user_id, status FROM account WHERE id=$1', ['acc-01']);
    expect(rows[0]).toMatchObject({ platform_user_id: puid, status: 'online' });
  });

  it('不存在的账号 → 404 ACCOUNT_NOT_FOUND', async () => {
    const token = await loginAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-99/connect',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('viewer → 403 FORBIDDEN（写操作权限矩阵）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'viewer', password: 'viewer' },
    });
    const viewerToken = (res.json() as { accessToken: string }).accessToken;
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/accounts/acc-01/connect',
      headers: authed(viewerToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('GET /api/accounts（REQ §2.3 行；DES/03 §6 形状）', () => {
  let db: TestDbHandle;
  let app: App;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway: createGatewayClient({ baseUrl: 'http://127.0.0.1:1' }), // 本文件不打网关
    });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('返回 4 个种子账号；未认证 401；viewer 可读', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(anon.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'viewer', password: 'viewer' },
    });
    const token = (login.json() as { accessToken: string }).accessToken;
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r['id'])).toEqual(['acc-01', 'acc-02', 'acc-03', 'acc-04']);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'idle', platformUserId: null, rateLimitedUntil: null });
    }
  });
});
