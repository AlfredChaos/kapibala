// T-P2-03 c)：消费循环集成——首部署不带 since / 停机补拉（A2-6）/ 重连游标恒读库 /
// 断流退避重连 / 全局单飞（advisory lock）。
// 假网关 = 裸 node:http SSE 账本（gateway-client.test.ts 同法）：记录请求 URL、可主动断连、
// 可前 N 次连接直接回错、保留全量历史（REQ §2.1「网关保留全部历史事件」）且 eventId 任意指定——
// 停机窗口与重连语义必须精确可控，进程内 mock-gateway 的单调账本表达不了「断开期间产事件」。
// 真实 DB 不 mock（根 AGENTS.md §4）。退避节奏用测试缝注入小值（5/20ms）保持用例毫秒级；
// 500ms→5s 的契约递进本身由 nextBackoffMs 纯函数断言（零墙钟）。
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  SSE_RECONNECT_BACKOFF_MAX_MS,
  SSE_RECONNECT_BACKOFF_START_MS,
} from '../../src/constants.js';
import {
  nextBackoffMs,
  startEventConsumer,
  type ConsumerLogger,
  type EventConsumer,
} from '../../src/events/consumer.js';
import { readCursor } from '../../src/events/cursor.js';
import { withTestDb } from '../helpers/db.js';

// —— 夹具 ——

/**
 * 轮询等待（10ms 真实节拍）——真实墙钟例外（ts-no-test-timers）：断言对象是真实 socket/DB I/O
 * 的收敛，DB 游标没有可 await 的完成事件；fake timers 会破坏 pg/undici 内部时序（boot-order.test.ts 同注）。
 */
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureLogger(): {
  logger: ConsumerLogger;
  entries: Array<{ level: 'info' | 'warn' | 'error'; obj: unknown; msg: string }>;
} {
  const entries: Array<{ level: 'info' | 'warn' | 'error'; obj: unknown; msg: string }> = [];
  const record =
    (level: 'info' | 'warn' | 'error') =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj, msg: msg ?? '' });
    };
  return { logger: { info: record('info'), warn: record('warn'), error: record('error') }, entries };
}

interface FakeEvent {
  eventId: number;
  type: string;
  data: Record<string, unknown>;
}

interface FakeGateway {
  readonly baseUrl: string;
  /** /events 请求到达顺序的原样 URL（含 query——since 语义的断言真值） */
  readonly urls: string[];
  /** 追加账本并推给全部在连 SSE（data 自动补 eventId/type，契约 REQ §2.1） */
  emit(eventId: number, type?: string, data?: Record<string, unknown>): void;
  /** 服务端主动断开全部在连 SSE（模拟网关断流 → 'ended' 路径） */
  dropConnections(): void;
  /** 接下来 count 个 /events 请求直接回 status 并结束（模拟网关故障 → reject 路径） */
  failConnections(count: number, status?: number): void;
  close(): Promise<void>;
}

function encodeFrame(event: FakeEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

async function startFakeGateway(): Promise<FakeGateway> {
  const ledger: FakeEvent[] = [];
  const open = new Set<ServerResponse>();
  const urls: string[] = [];
  let failRemaining = 0;
  let failStatus = 500;
  const server: Server = createServer((req, res) => {
    urls.push(req.url ?? '');
    if (failRemaining > 0) {
      failRemaining -= 1;
      res.writeHead(failStatus, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/events') {
      res.writeHead(404);
      res.end();
      return;
    }
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null ? 0 : Number(sinceRaw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 全量历史保留：since 独占语义补发 eventId > since（REQ §2.1）
    for (const event of ledger) {
      if (event.eventId > since) res.write(encodeFrame(event));
    }
    open.add(res);
    req.on('close', () => open.delete(res));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    urls,
    emit(eventId, type = 'message', data = {}) {
      const event: FakeEvent = { eventId, type, data: { ...data, eventId, type } };
      ledger.push(event);
      for (const res of open) res.write(encodeFrame(event));
    },
    dropConnections() {
      for (const res of open) res.end();
      open.clear();
    },
    failConnections(count, status = 500) {
      failRemaining = count;
      failStatus = status;
    },
    async close() {
      for (const res of open) res.end();
      open.clear();
      server.close();
      await once(server, 'close');
    },
  };
}

async function ledgerIds(pool: Pool): Promise<number[]> {
  const res = await pool.query<{ event_id: string }>(
    'SELECT event_id FROM gateway_event ORDER BY event_id',
  );
  return res.rows.map((row) => Number(row.event_id));
}

/** 消费循环测试统一注入小退避（5/20ms）：断言的是重连行为，不是 500ms 墙钟本身 */
function startConsumer(pool: Pool, gatewayUrl: string, logger: ConsumerLogger): EventConsumer {
  return startEventConsumer({ pool, gatewayUrl, logger, backoffStartMs: 5, backoffMaxMs: 20 });
}

describe('SSE consumer loop resume (T-P2-03)', () => {
  it('first run (cursor=0): connects WITHOUT since; live frames land in ledger and cursor (card b / DES/08 §1.1 解读 #11)', async () => {
    await withTestDb(async (pool) => {
      const gw = await startFakeGateway();
      const { logger } = captureLogger();
      const consumer = startConsumer(pool, gw.baseUrl, logger);
      try {
        await waitFor(() => gw.urls.length >= 1);
        expect(gw.urls[0]).toBe('/events'); // 游标=0 → 不带 since（首次部署前的历史与我方无关）
        gw.emit(1);
        gw.emit(2);
        await waitFor(async () => (await readCursor(pool)) === 2);
        expect(await ledgerIds(pool)).toEqual([1, 2]);
      } finally {
        await consumer.stop();
        await gw.close();
      }
    });
  });

  it('restart resume: events produced during downtime are pulled via since=<persisted cursor> and all processed (card b / A2-6)', async () => {
    await withTestDb(async (pool) => {
      const gw = await startFakeGateway();
      const { logger } = captureLogger();
      const first = startConsumer(pool, gw.baseUrl, logger);
      await waitFor(() => gw.urls.length >= 1);
      gw.emit(1);
      gw.emit(2);
      gw.emit(3);
      await waitFor(async () => (await readCursor(pool)) === 3);
      await first.stop(); // —— 停机开始：无消费进程 ——

      gw.emit(4); // 停机期间网关继续产生事件并保留历史（REQ §2.1）
      gw.emit(5);
      expect(await readCursor(pool)).toBe(3); // 停机中：游标当然是持久化时的值

      const second = startConsumer(pool, gw.baseUrl, logger); // —— 重启 ——
      try {
        await waitFor(() => gw.urls.length >= 2);
        expect(gw.urls[1]).toBe('/events?since=3'); // 独占语义：补拉 eventId > 3 的全部
        await waitFor(async () => (await readCursor(pool)) === 5);
        expect(await ledgerIds(pool)).toEqual([1, 2, 3, 4, 5]); // 停机事件全部处理到（A2）
      } finally {
        await second.stop();
        await gw.close();
      }
    });
  });

  it('reconnect since ALWAYS read from DB: external cursor advance wins over memory, and cursor never regresses (card b/d)', async () => {
    await withTestDb(async (pool) => {
      const gw = await startFakeGateway();
      const { logger } = captureLogger();
      // 前一轮运行已入账 1..6（种子）：本轮从 since=6 起步，7 一到前缀即闭合
      for (const eventId of [1, 2, 3, 4, 5, 6]) {
        await pool.query(
          'INSERT INTO gateway_event (event_id, type, payload) VALUES ($1, $2, $3::jsonb)',
          [eventId, 'message', JSON.stringify({ eventId, type: 'message' })],
        );
      }
      await pool.query('UPDATE event_cursor SET last_event_id = 6 WHERE id = 1');
      const consumer = startConsumer(pool, gw.baseUrl, logger);
      try {
        await waitFor(() => gw.urls.length >= 1);
        expect(gw.urls[0]).toBe('/events?since=6'); // 连接即读库取 since
        gw.emit(7);
        await waitFor(async () => (await readCursor(pool)) === 7);

        // 外部真值把库推前（内存镜像只知道 7）：重连必须带 DB 的 9，而不是内存的 7
        await pool.query('UPDATE event_cursor SET last_event_id = 9 WHERE id = 1');
        gw.dropConnections(); // 断流 → 'ended' → 退避重连
        await waitFor(() => gw.urls.length >= 2);
        expect(gw.urls[1]).toBe('/events?since=9');

        // 单调守卫：补账期间游标绝不回退到外部真值以下，缺口闭合后收敛到 10
        gw.emit(8);
        gw.emit(9);
        gw.emit(10);
        await waitFor(async () => (await readCursor(pool)) === 10);
        expect(await ledgerIds(pool)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } finally {
        await consumer.stop();
        await gw.close();
      }
    });
  });

  it('stream error: typed error logged, backoff reconnect, loop never dies; contract progression 500→1000→2000→4000→5000 capped (DES/08 §1.1)', async () => {
    await withTestDb(async (pool) => {
      const gw = await startFakeGateway();
      gw.failConnections(2); // 前两次连接：500 → subscribeEvents reject
      const { logger, entries } = captureLogger();
      const consumer = startConsumer(pool, gw.baseUrl, logger);
      try {
        await waitFor(() => gw.urls.length >= 3); // 第三次连接成功——循环没死
        expect(
          entries.filter((e) => e.level === 'error' && /events stream failed/.test(e.msg)).length,
        ).toBeGreaterThanOrEqual(2); // 错误不静默（宪法 §3-7）
        gw.emit(1);
        await waitFor(async () => (await readCursor(pool)) === 1); // 重连后功能完好
      } finally {
        await consumer.stop();
        await gw.close();
      }

      // 契约递进纯函数断言（零墙钟）：500ms 起 ×2，5s 封顶（DES/08 §1.1 逐字）
      let backoff = SSE_RECONNECT_BACKOFF_START_MS;
      const progression = [backoff];
      for (let i = 0; i < 5; i += 1) {
        backoff = nextBackoffMs(backoff, SSE_RECONNECT_BACKOFF_MAX_MS);
        progression.push(backoff);
      }
      expect(progression).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    });
  });

  it('global single-flight: second consumer cannot grab the advisory lock and opens no SSE; takes over after graceful stop (card goal / §1.1)', async () => {
    await withTestDb(async (pool) => {
      const gw = await startFakeGateway();
      const holder = captureLogger();
      const standby = captureLogger();
      const a = startConsumer(pool, gw.baseUrl, holder.logger);
      try {
        await waitFor(() => gw.urls.length >= 1);
        const b = startConsumer(pool, gw.baseUrl, standby.logger);
        try {
          // B 拿不到 'events:consumer' 会话锁 → 待命（warn 不静默），绝不开第二条 SSE
          await waitFor(() => standby.entries.some((e) => e.level === 'warn' && /standing by/.test(e.msg)));
          expect(gw.urls.length).toBe(1);

          await a.stop(); // A 优雅关停：解锁
          await waitFor(() => gw.urls.length >= 2); // B 接管消费
          gw.emit(1);
          await waitFor(async () => (await readCursor(pool)) === 1);
        } finally {
          await b.stop();
        }
      } finally {
        await a.stop(); // 幂等：已 stop 的实例再 stop 无害
        await gw.close();
      }
    });
  });
});
