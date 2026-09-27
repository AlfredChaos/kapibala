// T-P0-07 c)：认证与会话全链路（B3 后端全量 + viewer 403 + I13 三断言 + 并发轮换恰一成功）。
// 依据 DES/09 全文；REQ §2.3 auth 行 / §3 B3；QR §4；DES/02 §2（表结构）。
// 探针路由（__whoami / __write-probe）只为本测试验证 guard 矩阵——真实写路由归后续任务（各自标 auth:'write'）。
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';

interface LoginBody {
  accessToken: string;
  expiresAt: string;
  user: { id: string; username: string; role: string };
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractRt(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
  const match = /(?:^|;\s*)rt=([^;]+)/.exec(raw);
  return match?.[1] ?? '';
}

describe('auth: login / refresh rotation / reuse detection / logout / role gate', () => {
  let db: TestDbHandle;
  let app: App;

  async function loginAs(username: string, password: string): Promise<{ body: LoginBody; rt: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    expect(res.statusCode).toBe(200);
    return { body: res.json() as LoginBody, rt: extractRt(res.headers['set-cookie']) };
  }

  function authed(accessToken: string): { authorization: string } {
    return { authorization: `Bearer ${accessToken}` };
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
    });
    app.get('/api/__whoami', { config: { auth: 'required' } }, async (request) => ({
      ok: true,
      role: request.auth?.role ?? null,
    }));
    app.post('/api/__write-probe', { config: { auth: 'write' } }, async () => ({ ok: true }));
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('login: 200 {accessToken} + Set-Cookie rt (HttpOnly; Path=/api/auth; SameSite=Lax), 15min TTL', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin' },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as LoginBody;
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(typeof body.user.id).toBe('string');
    // access 有效期 15 分钟（QR §1；允许与 DB now() 的微小钟差）
    const deltaMs = Date.parse(body.expiresAt) - Date.now();
    expect(deltaMs).toBeGreaterThan(14 * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(15 * 60_000);
    // cookie 属性逐字（卡片 b）；localhost 下不加 Secure（DES/09 §2「Secure(生产)」）
    const cookieHeader = first.headers['set-cookie'];
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join('\n') : (cookieHeader ?? '');
    expect(cookieStr).toContain('rt=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Path=/api/auth');
    expect(cookieStr).toContain('SameSite=Lax');
    expect(cookieStr).not.toContain('Secure');
    expect(extractRt(cookieHeader).length).toBeGreaterThan(0);
  });

  it('login: wrong password and unknown user → identical 401 UNAUTHORIZED (no user-existence leak)', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'nope' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'nope' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    const bodyA = wrongPassword.json() as ErrorBody;
    const bodyB = unknownUser.json() as ErrorBody;
    expect(bodyA.error.code).toBe('UNAUTHORIZED');
    expect(bodyB.error.code).toBe('UNAUTHORIZED');
    expect(bodyA.error.message).toBe(bodyB.error.message); // 不区分用户存在性（DES/09 §5）
  });

  it('login: invalid body → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('refresh rotates: new accessToken + new rt cookie; old access stays valid until expiry', async () => {
    const first = await loginAs('admin', 'admin');
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${first.rt}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; expiresAt: string };
    expect(body.accessToken).not.toBe(first.body.accessToken);
    expect(typeof body.expiresAt).toBe('string');
    const rt2 = extractRt(res.headers['set-cookie']);
    expect(rt2).not.toBe(first.rt);
    // 正常轮换不吊销旧 access（DES/09 §3.1：access 只随 session 作废/登出/过期失效）
    const whoami = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed(first.body.accessToken) });
    expect(whoami.statusCode).toBe(200);
  });

  it('reuse of rotated-out refresh → 401 + entire session dead: new refresh AND new access (B3/I13)', async () => {
    const first = await loginAs('admin', 'admin');
    const rotated = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${first.rt}` } });
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = rotated.json() as { accessToken: string };
    const rt2 = extractRt(rotated.headers['set-cookie']);

    // 旧 refresh 再现 → 401（B3）
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${first.rt}` } });
    expect(reuse.statusCode).toBe(401);
    expect((reuse.json() as ErrorBody).error.code).toBe('UNAUTHORIZED');

    // I13 断言 1：之前换出的新 refresh 立即失效
    const rt2Again = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${rt2}` } });
    expect(rt2Again.statusCode).toBe(401);
    // I13 断言 2：之前换出的新 access 立即失效
    const whoami = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed(rotatedBody.accessToken) });
    expect(whoami.statusCode).toBe(401);
  });

  it('concurrent refresh with same cookie: exactly one 200, session revoked afterwards (DES/09 §3.2)', async () => {
    const { rt } = await loginAs('admin', 'admin');
    const shot = { method: 'POST' as const, url: '/api/auth/refresh', headers: { cookie: `rt=${rt}` } };
    const [a, b] = await Promise.all([app.inject(shot), app.inject({ ...shot })]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 401]); // 恰一成功（卡片 c）
    // 败者走复用检测 → 会话整体作废：胜者换出的新 rt 也死
    const winner = a.statusCode === 200 ? a : b;
    const winnerRt = extractRt(winner.headers['set-cookie']);
    const after = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${winnerRt}` } });
    expect(after.statusCode).toBe(401);
  });

  it('logout → 204; same access token immediately 401; refresh also dead (B3)', async () => {
    const { body, rt } = await loginAs('admin', 'admin');
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authed(body.accessToken) });
    expect(logout.statusCode).toBe(204);
    const whoami = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed(body.accessToken) });
    expect(whoami.statusCode).toBe(401);
    const refreshAfter = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `rt=${rt}` } });
    expect(refreshAfter.statusCode).toBe(401);
  });

  it('role gate: viewer reads OK, write → 403 FORBIDDEN; unauthenticated write → 401 first (A0)', async () => {
    const { body } = await loginAs('viewer', 'viewer');
    const read = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed(body.accessToken) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { role: string }).role).toBe('viewer');

    const write = await app.inject({ method: 'POST', url: '/api/__write-probe', headers: authed(body.accessToken) });
    expect(write.statusCode).toBe(403);
    expect((write.json() as ErrorBody).error.code).toBe('FORBIDDEN');

    // 判定顺序：401 先于 403（A0）
    const anonWrite = await app.inject({ method: 'POST', url: '/api/__write-probe' });
    expect(anonWrite.statusCode).toBe(401);
    expect((anonWrite.json() as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('expired access token → 401 (DB 真值判定)', async () => {
    const { body } = await loginAs('admin', 'admin');
    await db.pool.query("UPDATE auth_token SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [
      sha256(body.accessToken),
    ]);
    const whoami = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed(body.accessToken) });
    expect(whoami.statusCode).toBe(401);
  });

  it('garbage bearer token → 401 unified error shape with requestId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/__whoami', headers: authed('not-a-real-token') });
    expect(res.statusCode).toBe(401);
    const err = (res.json() as ErrorBody).error;
    expect(err.code).toBe('UNAUTHORIZED');
    expect(typeof err.requestId).toBe('string');
  });

  it('refresh without cookie → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });
});
