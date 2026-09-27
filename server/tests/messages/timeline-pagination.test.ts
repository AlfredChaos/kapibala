// T-P2-11 c)：时间线 keyset 游标分页（DES/05 §5.1–§5.3、REQ §2.3 messages 行、QR §1 50 行、A4）。
// 断言重点（卡片 b 逐项）：
// - 默认 limit 恰 50；nextCursor 语义（不足 limit → null；满页 → 末行游标）
// - 排序 sent_at DESC + sort_key DESC（同毫秒多行以 sort_key 定序，不以到达顺序）
// - 游标期间并发写入（含补投的任意早 sentAt）→ 后页不重复不遗漏（keyset 唯一边界）
// - own 消息 sentAt 上移（受理→网关时刻）→ 不在后页重复出现（§5.2(a)）
// - items 字段 null 语义 + 404 GROUP_NOT_FOUND + 401/校验边界
// 真 DB + 真 app（inject）+ 真登录 token；消息行直接 INSERT（写路径归各自任务，本卡只测读）。
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { withTestDb } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { decodeCursor, encodeCursor } from '../../src/modules/messages/timeline.js';

// —— 夹具 ——

const EPOCH = new Date('2026-01-01T00:00:00.000Z').getTime();

async function makeGroup(pool: Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id)
     VALUES (gen_random_uuid(), $1, 'active', 'acc-01') RETURNING id`,
    [`gw-${Math.random().toString(36).slice(2, 10)}`],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('group insert failed');
  return row.id;
}

/** 造一条消息行；sentAtMs 相对 EPOCH 的毫秒偏移，key 驱动 sort_key（msg_id 或 client_msg_id） */
async function insertMessage(
  pool: Pool,
  groupId: string,
  opts: {
    msgId?: string;
    clientMsgId?: string;
    senderPuid?: string;
    isOwn?: boolean;
    text?: string;
    sentAtMs?: number;
    deliveryStatus?: string | null;
    failCode?: string | null;
    accountId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, fail_code, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::numeric/1000),$9,$10,$11)`,
    [
      groupId,
      opts.msgId ?? null,
      opts.clientMsgId ?? null,
      opts.senderPuid ?? 'ext-user',
      opts.isOwn ?? false,
      opts.isOwn === true ? 'operator' : 'inbound',
      opts.text ?? `text-${opts.msgId ?? opts.clientMsgId ?? 'x'}`,
      EPOCH + (opts.sentAtMs ?? 0),
      opts.deliveryStatus ?? null,
      opts.failCode ?? null,
      opts.accountId ?? null,
    ],
  );
}

interface TimelineResponse {
  items: Array<{
    msgId: string | null;
    clientMsgId: string | null;
    senderPlatformUserId: string;
    isOwn: boolean;
    text: string;
    sentAt: string;
    deliveryStatus: string | null;
    failCode: string | null;
  }>;
  nextCursor: string | null;
}

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

async function getPage(
  app: App,
  token: string,
  groupId: string,
  params: { before?: string; limit?: number | string } = {},
): Promise<{ status: number; body: TimelineResponse }> {
  const qs = new URLSearchParams();
  if (params.before !== undefined) qs.set('before', params.before);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const url = `/api/groups/${groupId}/messages${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() as TimelineResponse };
}

/** 每行一条 msgId=row-<i>、sentAt=EPOCH+i（升序插入 → 页面应 DESC 返回） */
async function seedTimeline(pool: Pool, groupId: string, count: number, startMs = 0): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await insertMessage(pool, groupId, { msgId: `row-${String(startMs + i).padStart(4, '0')}`, sentAtMs: startMs + i });
  }
}

function ids(body: TimelineResponse): Array<string | null> {
  return body.items.map((i) => i.msgId);
}

// —— 用例 ——

describe('timeline keyset pagination (T-P2-11, A4)', () => {
  it('default limit is exactly 50 (QR §1); nextCursor chains through pages, null on short page; DESC order by sent_at then sort_key', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await seedTimeline(pool, g, 55);

      const p1 = await getPage(app, token, g);
      expect(p1.status).toBe(200);
      expect(p1.body.items).toHaveLength(50); // 恰 50
      expect(ids(p1.body)[0]).toBe('row-0054'); // DESC：最新在前
      expect(ids(p1.body)[49]).toBe('row-0005');
      expect(p1.body.nextCursor).not.toBeNull();

      const p2 = await getPage(app, token, g, { before: p1.body.nextCursor ?? '' });
      expect(ids(p2.body)).toEqual(['row-0004', 'row-0003', 'row-0002', 'row-0001', 'row-0000']);
      expect(p2.body.nextCursor).toBeNull(); // 不足 limit → null
      await app.close();
    });
  });

  it('same-millisecond rows order by sort_key DESC — tie-broken, never by arrival order', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      // 同一毫秒三行 + 两侧各一行；sort_key = msgId
      await insertMessage(pool, g, { msgId: 'zz-same', sentAtMs: 100 });
      await insertMessage(pool, g, { msgId: 'aa-same', sentAtMs: 100 });
      await insertMessage(pool, g, { msgId: 'mm-same', sentAtMs: 100 });
      await insertMessage(pool, g, { msgId: 'newer', sentAtMs: 200 });
      await insertMessage(pool, g, { msgId: 'older', sentAtMs: 50 });

      const page = await getPage(app, token, g);
      expect(ids(page.body)).toEqual(['newer', 'zz-same', 'mm-same', 'aa-same', 'older']);
      await app.close();
    });
  });

  it('item fields + null semantics: inbound external (clientMsgId/deliveryStatus/failCode null), own queued (msgId null, deliveryStatus set), failed row carries failCode', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await insertMessage(pool, g, { msgId: 'ext-1', sentAtMs: 10, text: 'in' });
      await insertMessage(pool, g, {
        clientMsgId: 'cm-9', isOwn: true, senderPuid: 'puid-a1', sentAtMs: 20,
        deliveryStatus: 'queued', accountId: 'acc-01', text: 'out',
      });
      await insertMessage(pool, g, {
        msgId: 'ext-f', sentAtMs: 30, deliveryStatus: 'failed', failCode: 'NETWORK_TIMEOUT', isOwn: true,
        senderPuid: 'puid-a1', clientMsgId: 'cm-8', accountId: 'acc-01',
      });

      const page = await getPage(app, token, g);
      expect(page.body.items).toHaveLength(3);
      const ext = page.body.items[2];
      expect(ext).toEqual({
        msgId: 'ext-1', clientMsgId: null, senderPlatformUserId: 'ext-user',
        isOwn: false, text: 'in', sentAt: expect.any(String), deliveryStatus: null, failCode: null,
      });
      const own = page.body.items[1];
      expect(own).toMatchObject({ msgId: null, clientMsgId: 'cm-9', isOwn: true, deliveryStatus: 'queued', failCode: null });
      const failed = page.body.items[0];
      expect(failed).toMatchObject({ msgId: 'ext-f', deliveryStatus: 'failed', failCode: 'NETWORK_TIMEOUT' });
      // sentAt 必须 ISO 8601 UTC 毫秒
      expect(new Date(ext?.sentAt ?? '').getTime()).toBe(EPOCH + 10);
      await app.close();
    });
  });

  it('keyset boundary: no dup / no miss when concurrent inserts happen between pages — incl. backlog row with arbitrarily-early sentAt (§5.2 b)', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await seedTimeline(pool, g, 7); // row-0000..row-0006
      const p1 = await getPage(app, token, g, { limit: 3 });
      expect(ids(p1.body)).toEqual(['row-0006', 'row-0005', 'row-0004']);
      const cursor = p1.body.nextCursor ?? '';

      // 翻页期间并发写入：一条全新最新行 + 一条落在 page2 区间的补投行（gw-5 形态）
      await insertMessage(pool, g, { msgId: 'fresh-new', sentAtMs: 999 });
      await insertMessage(pool, g, { msgId: 'backfill', sentAtMs: 3 }); // 与 row-0003 同毫秒段

      const p2 = await getPage(app, token, g, { before: cursor, limit: 3 });
      // backfill(sentAt=3ms)与 row-0003 同毫秒 → sort_key 'row-0003' > 'backfill' 排在先
      expect(ids(p2.body)).toEqual(['row-0003', 'backfill', 'row-0002']);
      const p3 = await getPage(app, token, g, { before: p2.body.nextCursor ?? '', limit: 10 });
      expect(ids(p3.body)).toEqual(['row-0001', 'row-0000']);
      const seen = [...ids(p1.body), ...ids(p2.body), ...ids(p3.body)];
      expect(new Set(seen).size).toBe(seen.length); // 零重复
      expect(seen).not.toContain('fresh-new'); // 新行在游标之上 → 不在后页（由 WS 通道送达）
      await app.close();
    });
  });

  it('own message sentAt revision (accepted→sent moves row up) never reappears on later pages (§5.2 a)', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await seedTimeline(pool, g, 6); // row-0000..0005
      await insertMessage(pool, g, {
        clientMsgId: 'cm-1', isOwn: true, senderPuid: 'puid-a1', sentAtMs: 4, // 受理时刻落在第 4 位段
        deliveryStatus: 'accepted', text: 'mine',
      });
      const p1 = await getPage(app, token, g, { limit: 3 });
      // ms4 并列两行：sort_key 'row-0004' > 'cm-1' → own 行（msgId=null）排第三
      expect(ids(p1.body)).toEqual(['row-0005', 'row-0004', null]);
      const cursor = p1.body.nextCursor ?? '';

      // message_sent 到达 → sent_at 改为网关时刻（更晚），行位置上移
      await pool.query(
        "UPDATE message SET msg_id='m-own', sent_at=to_timestamp($1::numeric/1000), delivery_status='sent' WHERE client_msg_id='cm-1'",
        [EPOCH + 500],
      );

      const p2 = await getPage(app, token, g, { before: cursor, limit: 10 });
      // 上移到游标之上 → 后页不再出现（前端已有该行 + WS 原地更新）
      expect(p2.body.items.map((i) => i.clientMsgId)).not.toContain('cm-1');
      expect(ids(p2.body)).toEqual(['row-0003', 'row-0002', 'row-0001', 'row-0000']);
      await app.close();
    });
  });

  it('before=<last item cursor> → empty page, nextCursor null; cursor round-trips encode/decode', async () => {
    await withTestDb(async (pool) => {
      const { app, token } = await startApp(pool);
      const g = await makeGroup(pool);
      await insertMessage(pool, g, { msgId: 'only', sentAtMs: 42 });
      const p1 = await getPage(app, token, g);
      expect(ids(p1.body)).toEqual(['only']);
      expect(p1.body.nextCursor).toBeNull(); // 不足 limit → 无下一页

      // 用唯一行的游标再翻：应为空页（游标是独占边界）
      const manual = encodeCursor(EPOCH + 42, 'only');
      const p2 = await getPage(app, token, g, { before: manual });
      expect(p2.status).toBe(200);
      expect(p2.body.items).toHaveLength(0);
      expect(p2.body.nextCursor).toBeNull();

      const decoded = decodeCursor(manual);
      expect(decoded).toEqual({ sentAtMs: EPOCH + 42, sortKey: 'only' });
      // sort_key 含 '.' 的 msgId 也可往返（base64 串整体解码后只在首个 '.' 切）
      expect(decodeCursor(encodeCursor(123, 'm.1.2'))).toEqual({ sentAtMs: 123, sortKey: 'm.1.2' });
      await app.close();
    });
  });

  it('errors: missing group → 404 GROUP_NOT_FOUND; bad cursor/limit → 400 VALIDATION_ERROR; unauthenticated → 401; viewer can read', async () => {
    await withTestDb(async (pool) => {
      const { app, token, viewerToken } = await startApp(pool);
      const g = await makeGroup(pool);
      await insertMessage(pool, g, { msgId: 'x', sentAtMs: 1 });

      expect((await getPage(app, token, 'no-such-group')).status).toBe(404);
      const notFound = await getPage(app, token, 'no-such-group');
      expect((notFound.body as unknown as { error: { code: string } }).error.code).toBe('GROUP_NOT_FOUND');

      expect((await getPage(app, token, g, { before: 'not-base64!!' })).status).toBe(400);
      expect((await getPage(app, token, g, { before: Buffer.from('abc').toString('base64') })).status).toBe(400); // 无 '.'
      expect((await getPage(app, token, g, { before: Buffer.from('x.9').toString('base64') })).status).toBe(400); // 非数字 epoch
      expect((await getPage(app, token, g, { limit: 'abc' })).status).toBe(400);
      expect((await getPage(app, token, g, { limit: '-3' })).status).toBe(400);

      const noAuth = await app.inject({ method: 'GET', url: `/api/groups/${g}/messages` });
      expect(noAuth.statusCode).toBe(401);
      expect((await getPage(app, viewerToken, g)).status).toBe(200); // GET 只需登录（viewer 可读）
      await app.close();
    });
  });
});
