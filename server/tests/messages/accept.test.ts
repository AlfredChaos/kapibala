// T-P3-01 c)：操作员 send 受理端点（DES/05 §2.1.1 + §6 错误码表、REQ §2.3 send 行、
// QR §1 TEXT_MAX_LENGTH、解读 #15/#16、A2 受理规则）。
// 真 DB + 真 app.inject + 真 token（viewer 403 归权限矩阵——写操作 auth:'write'）。
// 覆盖（卡片 b 逐项）：text 空/空白/超 2000 → 400；群不存在 → 404；群 left → 409；
// 账号非成员/成员已 left → 409 ACCOUNT_NOT_IN_GROUP；idle/disconnected/终态 → 409
// ACCOUNT_UNAVAILABLE；rate_limited / unreachable 照常受理（queued 入库 + ws_event 先落 → 202
// {clientMsgId}）；先持久化后 202（响应落地前查库必有行）；写操作 viewer → 403。
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { withTestDb } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';

// —— 夹具 ——

async function startApp(pool: Pool): Promise<{ app: App; token: string; viewerToken: string }> {
  await seed(pool);
  const app = await buildApp({
    pool,
    logger: pino({ enabled: false }),
    verifyAccessToken: createVerifyAccessToken(pool),
  });
  const login = async (u: string, p: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
    return (res.json() as { accessToken: string }).accessToken;
  };
  return { app, token: await login('admin', 'admin'), viewerToken: await login('viewer', 'viewer') };
}

async function makeGroup(pool: Pool, opts: { status?: string } = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id)
     VALUES (gen_random_uuid(), $1, $2, 'acc-01') RETURNING id`,
    [`gw-${Math.random().toString(36).slice(2, 10)}`, opts.status ?? 'active'],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('group insert failed');
  return row.id;
}

async function addMember(
  pool: Pool,
  groupId: string,
  accountId: string,
  opts: { puid?: string; left?: boolean } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at)
     VALUES ($1,$2,$3,'member',now(),$4)`,
    [groupId, accountId, opts.puid ?? `puid-${accountId}`, opts.left === true ? new Date() : null],
  );
}

async function setAccountStatus(pool: Pool, accountId: string, status: string, puid?: string): Promise<void> {
  await pool.query(
    `UPDATE account SET status=$2${puid !== undefined ? ', platform_user_id=$3' : ''} WHERE id=$1`,
    puid !== undefined ? [accountId, status, puid] : [accountId, status],
  );
}

async function send(
  app: App,
  token: string,
  groupId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/groups/${groupId}/send`,
    payload: body,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

interface MsgRow {
  client_msg_id: string;
  msg_id: string | null;
  delivery_status: string;
  is_own: boolean;
  source: string;
  account_id: string;
  text: string;
  sent_at: Date;
  first_attempt_at: Date | null;
}

async function readRow(pool: Pool, clientMsgId: string): Promise<MsgRow | undefined> {
  const res = await pool.query<MsgRow>(
    'SELECT client_msg_id, msg_id, delivery_status, is_own, source, account_id, text, sent_at, first_attempt_at FROM message WHERE client_msg_id=$1',
    [clientMsgId],
  );
  return res.rows[0];
}

// —— 用例 ——

describe('POST /api/groups/:id/send accept validation (T-P3-01)', () => {
  it('happy path: member online account → 202 {clientMsgId}; row persisted BEFORE response (queued, sent_at=受理时刻, is_own, source=operator); ws_event(message) committed too (先持久化后 202)', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await addMember(pool, g, 'acc-01');
      await setAccountStatus(pool, 'acc-01', 'online', 'puid-a1');
      const before = Date.now();

      const res = await send(app, token, g, { accountId: 'acc-01', text: 'hello ops' });

      expect(res.status).toBe(202);
      const clientMsgId = (res.body as { clientMsgId?: string }).clientMsgId;
      expect(typeof clientMsgId).toBe('string');
      expect(clientMsgId).not.toBe('');
      const row = await readRow(pool, clientMsgId ?? '');
      if (row === undefined) throw new Error('row must exist by the time 202 returns');
      expect(row).toMatchObject({
        msg_id: null, delivery_status: 'queued', is_own: true,
        source: 'operator', account_id: 'acc-01', text: 'hello ops', first_attempt_at: null,
      });
      expect(row.sent_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const ws = await pool.query(
        "SELECT payload FROM ws_event WHERE type='message' AND payload->>'clientMsgId' = $1",
        [clientMsgId],
      );
      expect(ws.rows).toHaveLength(1);
      expect(ws.rows[0]?.payload).toMatchObject({
        groupId: g, msgId: null, isOwn: true, clientMsgId, deliveryStatus: 'queued',
      });
      await app.close();
    });
  });

  it('rejects empty/whitespace/>2000-char text → 400 VALIDATION_ERROR and zero rows', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await addMember(pool, g, 'acc-01');
      await setAccountStatus(pool, 'acc-01', 'online', 'puid-a1');

      for (const text of ['', '   ', 'x'.repeat(2001)]) {
        const res = await send(app, token, g, { accountId: 'acc-01', text });
        expect(res.status, `text=${JSON.stringify(text.slice(0, 20))}`).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }
      expect((await send(app, token, g, { accountId: 'acc-01' })).status).toBe(400); // 缺字段
      const n = await pool.query('SELECT count(*)::int AS n FROM message');
      expect(n.rows[0]?.n).toBe(0);
      // 边界合法值必须能过：恰好 2000 字
      const ok = await send(app, token, g, { accountId: 'acc-01', text: 'x'.repeat(2000) });
      expect(ok.status).toBe(202);
      await app.close();
    });
  });

  it('group missing → 404 GROUP_NOT_FOUND; group status=left → 409 (成员关系已终结); unreachable 群照常受理（解读 #16：网关为准）', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      await addMember(pool, await makeGroup(pool), 'acc-01');
      await setAccountStatus(pool, 'acc-01', 'online', 'puid-a1');

      const missing = await send(app, token, '00000000-0000-0000-0000-000000000000', { accountId: 'acc-01', text: 'x' });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: { code: 'GROUP_NOT_FOUND' } });

      const left = await makeGroup(pool, { status: 'left' });
      await addMember(pool, left, 'acc-01', { left: true }); // 群已 left → 成员行必然已终结
      const res = await send(app, token, left, { accountId: 'acc-01', text: 'x' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_IN_GROUP' } });

      const unreachable = await makeGroup(pool, { status: 'unreachable' });
      await addMember(pool, unreachable, 'acc-01'); // unreachable ≠ left：成员行仍活跃，受理有效
      const ok = await send(app, token, unreachable, { accountId: 'acc-01', text: 'x' });
      expect(ok.status).toBe(202); // 解读 #16：受理后由 dispatcher 撞 GROUP_WRITE_FORBIDDEN
      await app.close();
    });
  });

  it('non-member / left member → 409 ACCOUNT_NOT_IN_GROUP; unknown account → 404 ACCOUNT_NOT_FOUND', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await addMember(pool, g, 'acc-02', { left: true }); // 曾在群但已退出
      await setAccountStatus(pool, 'acc-01', 'online', 'puid-a1');
      await setAccountStatus(pool, 'acc-02', 'online', 'puid-a2');

      expect((await send(app, token, g, { accountId: 'acc-01', text: 'x' })).status).toBe(409);
      const notIn = await send(app, token, g, { accountId: 'acc-01', text: 'x' });
      expect(notIn.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_IN_GROUP' } });
      const leftMem = await send(app, token, g, { accountId: 'acc-02', text: 'x' });
      expect(leftMem.status).toBe(409);
      expect(leftMem.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_IN_GROUP' } });
      const ghost = await send(app, token, g, { accountId: 'ghost', text: 'x' });
      expect(ghost.status).toBe(404);
      expect(ghost.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
      await app.close();
    });
  });

  it('idle / disconnected / terminal accounts → 409 ACCOUNT_UNAVAILABLE; rate_limited accepts (queued until expiry, REQ §2.3)', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      const cases: Array<[string, string]> = [
        ['acc-01', 'idle'],
        ['acc-02', 'disconnected'],
        ['acc-03', 'suspended'],
        ['acc-04', 'session_expired'],
      ];
      for (const [acc, status] of cases) {
        await addMember(pool, g, acc);
        await setAccountStatus(pool, acc, status, `puid-${acc}`);
        const res = await send(app, token, g, { accountId: acc, text: 'x' });
        expect(res.status, `status=${status}`).toBe(409);
        expect(res.body).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
      }
      // rate_limited：照常受理，消息 queued（到期由 dispatcher 按序发出）——acc-01 已是成员
      await pool.query(
        "UPDATE account SET status='rate_limited', rate_limited_until=now()+interval '60 seconds', platform_user_id='puid-a1' WHERE id='acc-01'",
      );
      const rl = await send(app, token, g, { accountId: 'acc-01', text: 'during-limit' });
      expect(rl.status).toBe(202);
      const row = await readRow(pool, (rl.body as { clientMsgId: string }).clientMsgId);
      expect(row?.delivery_status).toBe('queued');
      await app.close();
    });
  });

  it('auth matrix: viewer → 403 FORBIDDEN (write op), unauthenticated → 401', async () => {
    await withTestDb(async (pool) => {
      const { app, token, viewerToken } = await startApp(pool);
      const g = await makeGroup(pool);
      await addMember(pool, g, 'acc-01');
      await setAccountStatus(pool, 'acc-01', 'online', 'puid-a1');

      const viewer = await send(app, viewerToken, g, { accountId: 'acc-01', text: 'x' });
      expect(viewer.status).toBe(403);
      const anon = await app.inject({ method: 'POST', url: `/api/groups/${g}/send`, payload: { accountId: 'acc-01', text: 'x' } });
      expect(anon.statusCode).toBe(401);
      expect((await send(app, token, g, { accountId: 'acc-01', text: 'x' })).status).toBe(202);
      await app.close();
    });
  });
});
