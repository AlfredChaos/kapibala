// T-P2-10 c)：sinceSeq 补发语义（DES/08 §2.2、B4 服务端半边、A4）——
// seq>S 独占升序回放、与实时帧交叠零重复（seq 去重由 lastSentSeq 水位兜底）、
// 断线 ≤3s 补齐形态（重连 auth+sinceSeq 纯 DB 读毫秒级）、保留窗口过期 →
// ws_backlog_expired + 从现存最小 seq 回放、BIGSERIAL 单调分配非内存计数、
// 保留窗口清理扫描。
// 同 hub.test.ts：真 DB + 真 socket，轮询等待真实 I/O 收敛（ts-no-test-timers 例外）。
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Pool } from 'pg';
import pino from 'pino';
import { attachWsHub, type WsHub } from '../../src/ws/hub.js';
import { createWsEventRetentionScan } from '../../src/ws/retention.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { seed } from '../../src/db/seed.js';
import { withTestDb } from '../helpers/db.js';

// —— 夹具（hub.test.ts 同形，本文件独立持有以保持测试文件自足） ——

interface Frame {
  seq?: number;
  type: string;
  payload?: Record<string, unknown>;
  success?: boolean;
}

interface TestServer {
  readonly app: App;
  readonly hub: WsHub;
  readonly wsUrl: string;
  readonly accessToken: string;
  close(): Promise<void>;
}

async function startServer(pool: Pool): Promise<TestServer> {
  await seed(pool);
  const app = await buildApp({
    pool,
    logger: pino({ enabled: false }),
    verifyAccessToken: createVerifyAccessToken(pool),
  });
  const hub = attachWsHub(app.server, {
    pool,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pollMs: 15,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'admin' },
  });
  const accessToken = (login.json() as { accessToken: string }).accessToken;
  return {
    app,
    hub,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    accessToken,
    async close() {
      await hub.close();
      await app.close();
    },
  };
}

interface ClientHandle {
  readonly ws: WebSocket;
  readonly frames: Frame[];
  readonly closed: Promise<void>;
}

function connectClient(url: string): ClientHandle {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const closed = new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
  });
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Frame);
  });
  return { ws, frames, closed };
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** auth + sinceSeq 一次到位，等待 auth:true 回执 */
async function authedSince(
  url: string,
  accessToken: string,
  sinceSeq?: number,
): Promise<ClientHandle> {
  const client = connectClient(url);
  await once(client.ws, 'open');
  const frame: Record<string, unknown> = { type: 'auth', accessToken };
  if (sinceSeq !== undefined) frame['sinceSeq'] = sinceSeq;
  client.ws.send(JSON.stringify(frame));
  await waitFor(() => client.frames.some((f) => f.type === 'auth'));
  expect(client.frames[0]).toMatchObject({ type: 'auth', success: true });
  return client;
}

async function insertEvent(
  pool: Pool,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const res = await pool.query<{ seq: string }>(
    'INSERT INTO ws_event (type, payload) VALUES ($1, $2::jsonb) RETURNING seq',
    [type, JSON.stringify(payload)],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('ws_event insert returned no seq');
  return Number(row.seq);
}

/** 事件帧的 seq 列表（auth 帧无 seq） */
function eventSeqs(client: ClientHandle): number[] {
  return client.frames.filter((f) => f.type !== 'auth').map((f) => f.seq ?? -1);
}

// —— 用例 ——

describe('ws sinceSeq replay (T-P2-10)', () => {
  it('sinceSeq=S replays seq>S ascending; sinceSeq omitted → live only; concurrent insert during auth replays without overlap/dup (A4/B4)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const s1 = await insertEvent(pool, 'message', { groupId: 'g1', msgId: 'm1', isOwn: false });
        const s2 = await insertEvent(pool, 'message', { groupId: 'g2', msgId: 'm2', isOwn: true, clientMsgId: 'cm2', deliveryStatus: 'sent' });
        const s3 = await insertEvent(pool, 'account_terminal', { accountId: 'acc-01', status: 'suspended' });

        // sinceSeq=s1 → 只补 s2、s3（独占语义），升序
        const client = await authedSince(server.wsUrl, server.accessToken, s1);
        await waitFor(() => eventSeqs(client).length >= 2);
        expect(eventSeqs(client)).toEqual([s2, s3]);

        // 无 sinceSeq → 不补历史，auth 后只有实时
        const live = await authedSince(server.wsUrl, server.accessToken);
        const s4 = await insertEvent(pool, 'inconsistency', { kind: 'probe', ref: 'live', message: 'x' });
        await waitFor(() => eventSeqs(live).length >= 1);
        expect(eventSeqs(live)).toEqual([s4]);
        live.ws.close();
        await live.closed;

        // —— 交叠：auth 处理期间提交的新行必须进补发、且不与实时通知重复 ——
        // （auth→sync 与轮询可能并发触发；水位去重是唯一收口，§4 风险点）
        const c2 = await authedSince(server.wsUrl, server.accessToken, s1);
        const s5 = await insertEvent(pool, 'inconsistency', { kind: 'probe', ref: 'racing', message: 'x' });
        await waitFor(() => eventSeqs(c2).length >= 4);
        const seqs = eventSeqs(c2);
        expect(new Set(seqs).size).toBe(seqs.length); // 零重复（B4）
        // s4 在 c2 的 auth 之前已提交 → 属于合法回放成员；s5 是 auth 期间并发插入
        expect(seqs).toEqual([s2, s3, s4, s5]); // 升序（补发与实时混合后仍全局有序）
        c2.ws.close();
        await c2.closed;
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('reconnect within window: sinceSeq=<last seen> resumes with only missed rows, millisecond read (B4 3s 补齐的服务端半边)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const first = await authedSince(server.wsUrl, server.accessToken);
        const s1 = await insertEvent(pool, 'message', { groupId: 'g1', msgId: 'm1', isOwn: false });
        await waitFor(() => eventSeqs(first).length >= 1);
        first.ws.close();
        await first.closed;

        // 断线期间的事件在表里，重连带 sinceSeq 补齐
        const s2 = await insertEvent(pool, 'message', { groupId: 'g1', msgId: 'm2', isOwn: false });
        const s3 = await insertEvent(pool, 'agent_run', { runId: 'r1', groupId: 'g1', status: 'running', endReason: null });
        const second = await authedSince(server.wsUrl, server.accessToken, s1);
        await waitFor(() => eventSeqs(second).length >= 2);
        expect(eventSeqs(second)).toEqual([s2, s3]);
        second.ws.close();
        await second.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('expired backlog: sinceSeq below min existing seq → inconsistency(ws_backlog_expired) first, then replay from min seq (解读 #20)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const s1 = await insertEvent(pool, 'inconsistency', { kind: 'a', ref: 'a', message: 'a' });
        const s2 = await insertEvent(pool, 'inconsistency', { kind: 'b', ref: 'b', message: 'b' });
        const s3 = await insertEvent(pool, 'inconsistency', { kind: 'c', ref: 'c', message: 'c' });
        // 模拟保留窗口清掉 s1（minSeq 变成 s2）；客户端的水位还是 s1——「表里已无该行」
        await pool.query('DELETE FROM ws_event WHERE seq = $1', [s1]);

        const client = await authedSince(server.wsUrl, server.accessToken, s1);
        await waitFor(() => eventSeqs(client).length >= 3); // 告警 + 2 条回放
        const [alert, ...rest] = client.frames.filter((f) => f.type !== 'auth');
        expect(alert).toMatchObject({
          type: 'inconsistency',
          payload: { kind: 'ws_backlog_expired' },
        });
        expect(rest.map((f) => f.seq)).toEqual([s2, s3]); // 从现存最小 seq 开始升序
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('six event types carry DES/08 §2.3 payload shapes verbatim (message msgId nullable; own carries clientMsgId/deliveryStatus)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const payloads: Array<{ type: string; payload: Record<string, unknown> }> = [
          { type: 'account_status_changed', payload: { accountId: 'a1', from: 'idle', to: 'online' } },
          { type: 'account_terminal', payload: { accountId: 'a1', status: 'suspended' } },
          { type: 'inconsistency', payload: { kind: 'db_write_failed', ref: 'message:7', message: 'x' } },
          { type: 'message', payload: { groupId: 'g1', msgId: null, isOwn: true, clientMsgId: 'cm1', deliveryStatus: 'queued' } },
          { type: 'agent_run', payload: { runId: 'r1', groupId: 'g1', status: 'done', endReason: null } },
          { type: 'sequence_run', payload: { runId: 's1', groupId: 'g1', status: 'running', currentStepIndex: 2 } },
        ];
        for (const { type, payload } of payloads) await insertEvent(pool, type, payload);

        const client = await authedSince(server.wsUrl, server.accessToken, 0); // 0 = 全量回放（不告警：0 是哨兵不是被清行）
        await waitFor(() => eventSeqs(client).length >= 6);
        const events = client.frames.filter((f) => f.type !== 'auth');
        for (let i = 0; i < payloads.length; i += 1) {
          const expected = payloads[i];
          if (expected === undefined) throw new Error(`payloads[${i}] missing`);
          expect(events[i]).toMatchObject({ type: expected.type, payload: expected.payload });
        }
        const seqs = events.map((f) => f.seq);
        expect(new Set(seqs).size).toBe(6);
        expect(seqs.every((s, i) => i === 0 || (s ?? 0) > (seqs[i - 1] ?? 0))).toBe(true); // BIGSERIAL 全局单调
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('retention scan deletes rows past the window, idempotent (DES/02 §1.5)', async () => {
    await withTestDb(async (pool) => {
      const old = await insertEvent(pool, 'inconsistency', { kind: 'old', ref: 'o', message: 'o' });
      const fresh = await insertEvent(pool, 'inconsistency', { kind: 'new', ref: 'n', message: 'n' });
      await pool.query("UPDATE ws_event SET created_at = now() - interval '40 minutes' WHERE seq = $1", [old]);
      const scan = createWsEventRetentionScan({ pool });
      expect(await scan()).toBe(1); // 30min 窗口外只有旧行
      const remaining = await pool.query<{ seq: string }>('SELECT seq FROM ws_event ORDER BY seq');
      expect(remaining.rows.map((r) => Number(r.seq))).toEqual([fresh]);
      expect(await scan()).toBe(0); // 幂等吸收（条件删除，无行即空转）
    });
  });

  it('sinceSeq beyond current max → auth ok, no replay, then live rows still flow', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        await insertEvent(pool, 'inconsistency', { kind: 'p', ref: 'p', message: 'p' });
        const client = await authedSince(server.wsUrl, server.accessToken, 99999);
        const s2 = await insertEvent(pool, 'inconsistency', { kind: 'q', ref: 'q', message: 'q' });
        await waitFor(() => eventSeqs(client).length >= 1);
        expect(eventSeqs(client)).toEqual([s2]); // 只有水位之后的新行
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });
});
