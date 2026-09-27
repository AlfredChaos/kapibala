// T-P2-10 c)：WS hub 连接协议（DES/08 §2.1/§2.4、REQ §2.3 WS 行）——
// auth 门槛（未认证零事件、无效 token 拒绝+关闭、非 auth 首帧拒绝）、
// 只投已提交行（I7：未提交事务内的 ws_event 行对在线连接不可见）、
// 广播扇出、心跳僵死清理、慢连接背压断开。
// 真实 DB + 真实 HTTP/WS socket（根 AGENTS.md §4；无依赖注入——auth 走真登录拿真 token）。
// 时序断言复用 resume.test.ts 的轮询模式：断言对象是真实 socket/DB I/O 的收敛，
// fake timers 会破坏 pg/ws 内部时序（ts-no-test-timers 例外，同注）。
import { once } from 'node:events';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Pool } from 'pg';
import pino from 'pino';
import { attachWsHub, type WsHub } from '../../src/ws/hub.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { seed } from '../../src/db/seed.js';
import { withTestDb } from '../helpers/db.js';

// —— 夹具 ——

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

/** 起真服务器：buildApp + attachWsHub + listen(0) + 真登录拿 access token */
async function startServer(
  pool: Pool,
  hubOptions: { pollMs?: number; heartbeatMs?: number; queueLimit?: number } = {},
): Promise<TestServer> {
  await seed(pool); // admin/admin 预置（幂等）
  const app = await buildApp({
    pool,
    logger: pino({ enabled: false }),
    verifyAccessToken: createVerifyAccessToken(pool),
  });
  const hub = attachWsHub(app.server, {
    pool,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pollMs: hubOptions.pollMs ?? 15,
    heartbeatMs: hubOptions.heartbeatMs ?? 30000,
    queueLimit: hubOptions.queueLimit ?? 1000,
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
      await hub.close(); // 先断升级连接（fastify 不管 WS 生命周期）
      await app.close();
    },
  };
}

/** 客户端帧收集器：message 事件 JSON.parse 入数组；close 记一次 */
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
    ws.on('error', () => resolve()); // 升级被拒（401 等）→ error+close 只记一次
  });
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Frame);
  });
  return { ws, frames, closed };
}

/** 轮询等待（10ms 真实节拍）——真实墙钟例外（ts-no-test-timers）：socket/DB I/O 无完成事件 */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 等待条件成立，然后额外宽限一小段时间确认「不再发生」——用于反向断言（未 auth 不推） */
async function waitStable(stayFalse: () => boolean, quietMs = 300): Promise<void> {
  const deadline = Date.now() + quietMs;
  while (Date.now() < deadline) {
    expect(stayFalse()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sendAuth(ws: WebSocket, accessToken: string, sinceSeq?: number): void {
  const frame: Record<string, unknown> = { type: 'auth', accessToken };
  if (sinceSeq !== undefined) frame['sinceSeq'] = sinceSeq;
  ws.send(JSON.stringify(frame));
}

/** 等待连接 open 后发送 auth 帧 */
async function authedClient(
  url: string,
  accessToken: string,
  sinceSeq?: number,
): Promise<ClientHandle> {
  const client = connectClient(url);
  await once(client.ws, 'open');
  sendAuth(client.ws, accessToken, sinceSeq);
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

// —— 用例 ——

describe('ws hub connection protocol (T-P2-10)', () => {
  it('pre-auth silence: connected-but-unauthenticated socket receives nothing, even as ws_event rows commit (§2.3)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const client = connectClient(server.wsUrl);
        await once(client.ws, 'open');
        await insertEvent(pool, 'inconsistency', { kind: 'probe', ref: 'x', message: 'm' });
        // 轮询节拍内跑两轮多：行已提交、连接已开，仍一帧不得
        await waitStable(() => client.frames.length === 0, 250);
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('invalid token → {type:auth,success:false} then server closes; malformed first frame same (§2.1)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const bad = connectClient(server.wsUrl);
        await once(bad.ws, 'open');
        bad.ws.send(JSON.stringify({ type: 'auth', accessToken: 'bogus' }));
        await waitFor(() => bad.frames.length >= 1);
        expect(bad.frames[0]).toEqual({ type: 'auth', success: false });
        await bad.closed; // success:false → 服务端随即关闭
        expect(bad.ws.readyState).not.toBe(WebSocket.OPEN);

        const junk = connectClient(server.wsUrl);
        await once(junk.ws, 'open');
        junk.ws.send('{"type":"not-auth"}');
        await waitFor(() => junk.frames.length >= 1);
        expect(junk.frames[0]).toEqual({ type: 'auth', success: false });
        await junk.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('auth success reply precedes all event frames; live committed rows flow to every authed connection (§2.1/§2.2)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const a = await authedClient(server.wsUrl, server.accessToken);
        const b = await authedClient(server.wsUrl, server.accessToken);
        expect(server.hub.size).toBe(2);

        const seq = await insertEvent(pool, 'inconsistency', {
          kind: 'db_write_failed',
          ref: 'message:1',
          message: 'probe',
        });
        await waitFor(() => a.frames.length >= 2 && b.frames.length >= 2);
        for (const client of [a, b]) {
          expect(client.frames[0]).toMatchObject({ type: 'auth', success: true }); // 回执先行
          expect(client.frames[1]).toMatchObject({
            seq,
            type: 'inconsistency',
            payload: { kind: 'db_write_failed', ref: 'message:1' },
          });
        }
        a.ws.close();
        b.ws.close();
        await waitFor(() => server.hub.size === 0); // close 清理连接注册
      } finally {
        await server.close();
      }
    });
  });

  it('only committed rows are pushed: a row inside an open transaction is invisible until COMMIT (I7 / §2.2)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const client = await authedClient(server.wsUrl, server.accessToken);
        const txClient = await pool.connect();
        try {
          await txClient.query('BEGIN');
          await txClient.query(
            "INSERT INTO ws_event (type, payload) VALUES ('inconsistency', $1::jsonb)",
            [JSON.stringify({ kind: 'probe', ref: 'open-tx', message: 'uncommitted' })],
          );
          // 行已 INSERT 但未 COMMIT——轮询已跑多轮，连接仍只有 auth 帧（先持久化后推送）
          await waitStable(() => client.frames.length === 1, 250);
          await txClient.query('COMMIT');
        } finally {
          txClient.release();
        }
        await waitFor(() => client.frames.length >= 2);
        expect(client.frames[1]).toMatchObject({ type: 'inconsistency' });
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('token expiry mid-connection does NOT disconnect: events still delivered after the token lapses (解读 #21)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool);
      try {
        const client = await authedClient(server.wsUrl, server.accessToken);
        // 连接期间 token 过期：把这条 access token 的 expires_at 拨到过去——连接不验第二次
        await pool.query(
          "UPDATE auth_token SET expires_at = now() - interval '1 second' WHERE kind = 'access'",
        );
        await insertEvent(pool, 'inconsistency', { kind: 'probe', ref: 'after-expiry', message: 'x' });
        await waitFor(() => client.frames.length >= 2);
        expect(client.frames[1]).toMatchObject({ type: 'inconsistency' });
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
        client.ws.close();
        await client.closed;
      } finally {
        await server.close();
      }
    });
  });

  it('heartbeat: connection that never pongs is terminated within ~2 beats (§2.4)', async () => {
    await withTestDb(async (pool) => {
      const heartbeatMs = 40;
      const server = await startServer(pool, { heartbeatMs });
      try {
        // 手动完成 WS 握手后装死（不回 pong）：ws 客户端的 receiver 自动 pong，关不掉——
        // 用裸 socket 发 upgrade 头拿到 101，然后静默。
        const address = server.app.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const socket = new Socket();
        const handshaken = new Promise<void>((resolve, reject) => {
          let buffer = '';
          socket.connect(port, '127.0.0.1', () => {
            socket.write(
              'GET /ws HTTP/1.1\r\n' +
                `Host: 127.0.0.1:${port}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n',
            );
          });
          socket.on('data', (chunk) => {
            buffer += String(chunk);
            if (buffer.includes('101')) resolve();
          });
          socket.on('error', reject);
        });
        await handshaken;
        // 连接已进入 hub（未认证也算注册成员——心跳清理同样适用）
        await waitFor(() => server.hub.size >= 1);
        const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
        await waitFor(() => server.hub.size === 0, heartbeatMs * 10);
        await closed; // 服务端 terminate → socket 被 RST/FIN
      } finally {
        await server.close();
      }
    });
  });

  it('backpressure: send queue over limit closes the connection; rows stay in table for sinceSeq recovery (§2.4)', async () => {
    await withTestDb(async (pool) => {
      const server = await startServer(pool, { queueLimit: 3 });
      try {
        const client = await authedClient(server.wsUrl, server.accessToken);
        // 一次同步取回 5 行 > 队列上限 3 → enqueue 直接断开（水位已落 DB：行还在表里）
        for (let i = 0; i < 5; i += 1) {
          await insertEvent(pool, 'inconsistency', { kind: 'probe', ref: `q${i}`, message: 'x' });
        }
        await client.closed;
        expect(client.ws.readyState).not.toBe(WebSocket.OPEN);
        expect(
          (await pool.query('SELECT count(*)::int AS n FROM ws_event')).rows[0]?.n,
        ).toBe(5); // 投递真值在表——队列丢弃不影响重连补齐
      } finally {
        await server.close();
      }
    });
  });
});
