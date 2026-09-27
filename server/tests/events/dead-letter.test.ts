// T-P2-04 c)：死信三写事务（D1-1，DES/08 §1.2）+ 孤儿事件分流（D3-1）+ 调度器 5s 重试（§1.4）
//   + 恢复扫描 6 立即重试接线（DES/10 §3）+ 消费循环默认死信收口（run() 接线验证）。
// 真实 DB 不 mock（根 AGENTS.md §4）：账本 / pending_event / 游标 / ws_event 一律直查库断言。
// 测试驱动层与 cursor-prefix.test.ts 相同——handleEventFrame / createDeadLetterHandler /
// retryDeadLettersOnce 直调；SSE 传输语义已由 resume.test.ts 钉死，本文件钉「事务边界 + 分流路由
// + 重试账本」。「事务中途回滚注入」由 handler 内影子写 + 抛错实现：影子行随回滚消失 = 回滚证据。
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  handleEventFrame,
  startEventConsumer,
  type ConsumerLogger,
  type EventFrameDeps,
} from '../../src/events/consumer.js';
import { loadCursorTracker, readCursor, type CursorTracker } from '../../src/events/cursor.js';
import {
  createDeadLetterHandler,
  createDeadLetterScan,
  nextDeadLetterBackoffMs,
  retryDeadLettersOnce,
  type DeadLetterLogger,
} from '../../src/events/deadletter.js';
import { createDispatchRegistry, type DispatchRegistry } from '../../src/events/dispatch.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import type { SseFrame } from '../../src/gateway/sse.js';
import { RECOVERY_SCANS } from '../../src/recovery/scans.js';
import {
  DEADLETTER_BACKOFF_MAX_MS,
  DEADLETTER_SCAN_INTERVAL_MS,
  DEADLETTER_STUCK_THRESHOLD,
} from '../../src/constants.js';
import { withTestDb } from '../helpers/db.js';

/** 测试内显式收窄（no-non-null-assertion 规约）：缺行直接炸，不让 undefined 静默走断言 */
function raise(message: string): never {
  throw new Error(message);
}

// —— 夹具 ——

/** 构造 SSE 帧（契约形状：data 里同时带 eventId 与 type，REQ §2.1） */
function frame(eventId: number, type: string, data?: Record<string, unknown>): SseFrame {
  const payload = data ?? { eventId, type };
  return { eventId, event: type, data: payload, rawData: JSON.stringify(payload) };
}

/** 契约 message 事件 payload（DES/08 §1.2 分流只看 payload.groupId 字段） */
function messageFrame(eventId: number, groupId: string): SseFrame {
  return frame(eventId, 'message', {
    eventId,
    type: 'message',
    groupId,
    msgId: `m${eventId}`,
    senderPlatformUserId: 'ext-1',
    text: 'hello',
    sentAt: '2026-09-27T00:00:00.000Z',
  });
}

/** 模拟前一轮运行的账本状态：gateway_event 行 + 游标位置 */
async function seedLedger(pool: Pool, eventIds: readonly number[], cursor: number): Promise<void> {
  for (const eventId of eventIds) {
    await pool.query(
      'INSERT INTO gateway_event (event_id, type, payload) VALUES ($1, $2, $3::jsonb)',
      [eventId, 'message_sent', JSON.stringify({ eventId, type: 'message_sent' })],
    );
  }
  await pool.query('UPDATE event_cursor SET last_event_id = $1 WHERE id = 1', [cursor]);
}

async function ledgerIds(pool: Pool): Promise<number[]> {
  const res = await pool.query<{ event_id: string }>(
    'SELECT event_id FROM gateway_event ORDER BY event_id',
  );
  return res.rows.map((row) => Number(row.event_id));
}

interface PendingRow {
  id: string;
  event_id: string;
  type: string;
  payload: unknown;
  error: string;
  status: string;
  attempts: number;
  next_retry_at: Date;
}

async function pendingRows(pool: Pool): Promise<PendingRow[]> {
  const res = await pool.query<PendingRow>('SELECT * FROM pending_event ORDER BY id');
  return res.rows;
}

interface WsRow {
  seq: string;
  type: string;
  payload: { kind?: string; ref?: string; message?: string } & Record<string, unknown>;
}

async function wsRows(pool: Pool): Promise<WsRow[]> {
  const res = await pool.query<WsRow>('SELECT * FROM ws_event ORDER BY seq');
  return res.rows;
}

function captureLogger(): {
  logger: ConsumerLogger & DeadLetterLogger;
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

/** 记录分发调用次数的注册表（领域 handler 未落地——T-P2-06/08/09；此处只观测分发行为） */
function recordingRegistry(): {
  registry: DispatchRegistry;
  calls: Array<{ eventId: number; type: string }>;
} {
  const registry = createDispatchRegistry();
  const calls: Array<{ eventId: number; type: string }> = [];
  for (const type of ['message', 'message_sent', 'message_failed', 'member_joined'] as const) {
    registry.register(type, async (ctx) => {
      calls.push({ eventId: ctx.event.eventId, type: ctx.event.type });
    });
  }
  return { registry, calls };
}

/** EventFrameDeps 工厂（少样板；死信缝显式走真实三写实现） */
function deps(
  pool: Pool,
  tracker: CursorTracker,
  registry: DispatchRegistry,
  logger: ConsumerLogger,
): EventFrameDeps {
  return { pool, tracker, registry, logger, deadLetter: createDeadLetterHandler() };
}

// —— 用例 ——

describe('dead-letter triple-write + orphan routing (T-P2-04)', () => {
  it('main tx failure → dead-letter tx triple-write: ledger refilled + pending_event + cursor advanced + inconsistency(db_write_failed); consumption continues (D1-1 / card b)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1, 2, 3], 3);
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      // 4 号事件的业务写必炸（事务中途回滚注入）：handler 先写一行影子 ws_event 再抛——
      // 影子行消失 = 整个主事务回滚的证据；随后 5 号事件成功 = 消费不中断（A2）。
      registry.register('message_sent', async (ctx) => {
        if (ctx.event.eventId === 4) {
          await ctx.client.query(
            "INSERT INTO ws_event (type, payload) VALUES ('probe_shadow', '{}'::jsonb)",
          );
          throw new Error('permanent business write exploded');
        }
      });
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };

      await handleEventFrame(deps, frame(4, 'message_sent'));

      // —— 三写同事务（D1-1）：只写死信会 FK 违例（pending_event.event_id → gateway_event）——
      expect(await ledgerIds(pool)).toEqual([1, 2, 3, 4]); // a') 账本补回（主事务已回滚）
      const pending = await pendingRows(pool); // b') 死信行
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        event_id: '4',
        type: 'message_sent',
        status: 'pending',
        attempts: 0,
      });
      expect(pending[0]?.error).toContain('permanent business write exploded');
      expect(pending[0]?.payload).toMatchObject({ eventId: 4 });
      expect(await readCursor(pool)).toBe(4); // c') 游标推进（死信事件计为已入账）
      expect(tracker.cursor).toBe(4);
      const ws = await wsRows(pool); // inconsistency 推送；影子行随主事务回滚 = 不在表里
      expect(ws).toHaveLength(1);
      expect(ws[0]).toMatchObject({
        type: 'inconsistency',
        payload: { kind: 'db_write_failed', ref: 'message_sent:4' },
      });

      // 消费不中断（A2）：后续事件照常入账/分发/推游标
      await handleEventFrame(deps, frame(5, 'message_sent'));
      expect(await ledgerIds(pool)).toEqual([1, 2, 3, 4, 5]);
      expect(await readCursor(pool)).toBe(5);
      expect(await pendingRows(pool)).toHaveLength(1); // 死信行不扩散
    });
  });

  it('orphan group event with no create_group window: ledger + inconsistency(unknown_group_event), dispatch skipped, NO pending_event (D3-1)', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const { registry, calls } = recordingRegistry();
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };

      // 无 create_group job、无群映射：E1 崩溃窗口孤儿网关群的典型形态
      await handleEventFrame(deps, messageFrame(1, 'gw-orphan'));

      expect(await ledgerIds(pool)).toEqual([1]); // 仅入账本（内容不丢）
      expect(calls).toEqual([]); // 分发被分流拦截（message handler 记过数——没到过）
      expect(await pendingRows(pool)).toEqual([]); // 不进死信（D3-1：重试只会空转）
      expect(await readCursor(pool)).toBe(1); // 游标照常推进（孤儿事件已妥善处理）
      const ws = await wsRows(pool);
      expect(ws).toEqual([
        expect.objectContaining({
          type: 'inconsistency',
          payload: expect.objectContaining({ kind: 'unknown_group_event', ref: 'message:1' }),
        }),
      ]);
    });
  });

  it('orphan account_status (non-provisioned accountId): same orphan routing — inconsistency, no dead-letter (D3-1 account arm)', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const { registry, calls } = recordingRegistry();
      const { logger } = captureLogger();

      await handleEventFrame(deps(pool, tracker, registry, logger), frame(1, 'account_status', {
        eventId: 1,
        type: 'account_status',
        accountId: 'acc-ghost',
        status: 'suspended',
      }));

      expect(await ledgerIds(pool)).toEqual([1]);
      expect(calls).toEqual([]);
      expect(await pendingRows(pool)).toEqual([]);
      const ws = await wsRows(pool);
      expect(ws[0]).toMatchObject({
        type: 'inconsistency',
        payload: { kind: 'unknown_group_event', ref: 'account_status:1' },
      });
    });
  });

  it('orphan event inside a create_group window: dead-lettered for short retry; retry succeeds once mapping lands → done + domain ws_event replayed (card b)', async () => {
    await withTestDb(async (pool) => {
      // 建群窗口：running create_group job 处于 phase='create'（网关建群结果未知，映射未回填）
      await pool.query(
        "INSERT INTO job (id, type, status, phase, payload) VALUES ('00000000-0000-4000-8000-0000000000aa', 'create_group', 'running', 'create', '{}'::jsonb)",
      );
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      // 领域 handler 到位时写自己的 ws_event（E14：与业务写同事务）——重试成功即「补推」
      registry.register('message', async (ctx) => {
        await ctx.client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
          JSON.stringify({ groupId: 'internal-g', msgId: 'm1', isOwn: false }),
        ]);
      });
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };

      await handleEventFrame(deps, messageFrame(1, 'gw-pending'));
      // 窗口内孤儿 ≠ 永久孤儿：走死信短重试（映射很快出现），不产生 unknown_group_event
      const pending = await pendingRows(pool);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ event_id: '1', status: 'pending' });
      expect(await wsRows(pool)).toEqual([
        expect.objectContaining({
          type: 'inconsistency',
          payload: expect.objectContaining({ kind: 'db_write_failed', ref: 'message:1' }),
        }),
      ]);
      expect(await readCursor(pool)).toBe(1); // 死信事件计为已入账

      // —— 映射落库（建群 job 完成网关调用）——
      await pool.query("INSERT INTO account (id) VALUES ('acc-01')");
      await pool.query(
        "INSERT INTO \"group\" (id, gateway_group_id, creator_account_id) VALUES ('00000000-0000-4000-8000-0000000000bb', 'gw-pending', 'acc-01')",
      );

      const handled = await retryDeadLettersOnce({ pool, registry, logger });
      expect(handled).toBe(1);
      const after = await pendingRows(pool);
      expect(after[0]).toMatchObject({ status: 'done', attempts: 0 });
      // 补推 WS 事件：重试成功事务内 handler 写出的 message 事件（§1.4 重放 b) 的语义）
      const ws = await wsRows(pool);
      expect(ws).toHaveLength(2);
      expect(ws[1]).toMatchObject({ type: 'message', payload: { msgId: 'm1' } });
    });
  });

  it('retry failure: attempts+1 with exponential backoff capped at 5min; crossing 20 pushes inconsistency(dead_letter_stuck) once; row never dropped (§1.4)', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      registry.register('message_sent', async () => {
        throw new Error('still broken');
      });
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };
      await handleEventFrame(deps, frame(1, 'message_sent'));

      // —— 第一次重试失败：attempts=1，next_retry_at ≈ now + 5s（退避基数 = 扫描节拍）——
      const before = Date.now();
      const handled = await retryDeadLettersOnce({ pool, registry, logger });
      expect(handled).toBe(1);
      const pending = await pendingRows(pool);
      expect(pending).toHaveLength(1);
      const row = pending[0] ?? raise('pending row missing');
      expect(row).toMatchObject({ status: 'pending', attempts: 1 });
      const delay = row.next_retry_at.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(DEADLETTER_SCAN_INTERVAL_MS - 500);
      expect(delay).toBeLessThanOrEqual(DEADLETTER_SCAN_INTERVAL_MS + 5000);

      // 未到期不再处理（到期语义 = next_retry_at<=now()）
      expect(await retryDeadLettersOnce({ pool, registry, logger })).toBe(0);

      // —— 阈值跨越：attempts 19 → 20 时推 dead_letter_stuck，且只推一次 ——
      await pool.query(
        'UPDATE pending_event SET attempts = $1, next_retry_at = now() WHERE event_id = 1',
        [DEADLETTER_STUCK_THRESHOLD - 1],
      );
      expect(await retryDeadLettersOnce({ pool, registry, logger })).toBe(1);
      const afterStuck = (await pendingRows(pool))[0] ?? raise('pending row missing');
      expect(afterStuck.attempts).toBe(DEADLETTER_STUCK_THRESHOLD);
      let stuckEvents = (await wsRows(pool)).filter(
        (w) => w.type === 'inconsistency' && w.payload.kind === 'dead_letter_stuck',
      );
      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0]?.payload.ref).toBe('message_sent:1');

      // 永不丢弃（A2）：阈值后仍可重试，stuck 告警不重复推
      await pool.query('UPDATE pending_event SET next_retry_at = now() WHERE event_id = 1');
      expect(await retryDeadLettersOnce({ pool, registry, logger })).toBe(1);
      const afterStuck2 = (await pendingRows(pool))[0] ?? raise('pending row missing');
      expect(afterStuck2).toMatchObject({ status: 'pending', attempts: DEADLETTER_STUCK_THRESHOLD + 1 });
      stuckEvents = (await wsRows(pool)).filter(
        (w) => w.type === 'inconsistency' && w.payload.kind === 'dead_letter_stuck',
      );
      expect(stuckEvents).toHaveLength(1);

      // 契约递进（纯函数，零墙钟）：5s 起 ×2，5min 封顶（§1.4 / constants）
      expect(nextDeadLetterBackoffMs(1)).toBe(5000);
      expect(nextDeadLetterBackoffMs(2)).toBe(10000);
      expect(nextDeadLetterBackoffMs(3)).toBe(20000);
      expect(nextDeadLetterBackoffMs(7)).toBe(DEADLETTER_BACKOFF_MAX_MS);
      expect(nextDeadLetterBackoffMs(20)).toBe(DEADLETTER_BACKOFF_MAX_MS);
    });
  });

  it('retry success clears the dead-letter row (status=done) and replays dispatch inside one tx', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      let fail = true;
      const registry = createDispatchRegistry();
      registry.register('message_sent', async (ctx) => {
        if (fail) throw new Error('first attempt fails');
        await ctx.client.query(
          "INSERT INTO ws_event (type, payload) VALUES ('probe_done', '{}'::jsonb)",
        );
      });
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };
      await handleEventFrame(deps, frame(1, 'message_sent'));
      expect(await pendingRows(pool)).toHaveLength(1);

      fail = false;
      expect(await retryDeadLettersOnce({ pool, registry, logger })).toBe(1);
      const row = (await pendingRows(pool))[0];
      expect(row?.status).toBe('done');
      expect((await wsRows(pool)).some((w) => w.type === 'probe_done')).toBe(true);
    });
  });

  it('scheduler scan gates to the 5s cadence (§1.4): back-to-back ticks are skipped even with due rows', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      let firstAttemptFailed = false;
      registry.register('message_sent', async () => {
        if (!firstAttemptFailed) {
          firstAttemptFailed = true;
          throw new Error('first pass dead-letters');
        }
      });
      const { logger } = captureLogger();
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: createDeadLetterHandler(),
      };
      await handleEventFrame(deps, frame(1, 'message_sent'));
      expect((await pendingRows(pool))[0]?.status).toBe('pending');

      const scan = createDeadLetterScan({ pool, registry, logger });
      expect(await scan()).toBe(1); // 首 tick：到期死信处理掉
      expect((await pendingRows(pool))[0]?.status).toBe('done');
      // 造一行「已到期」死信（账本行手动补——三写语义里死信行必须有账本 FK 前件）
      await pool.query(
        "INSERT INTO gateway_event (event_id, type, payload) VALUES (9, 'message_sent', '{}'::jsonb)",
      );
      await pool.query(
        "INSERT INTO pending_event (event_id, type, payload, error) VALUES (9, 'message_sent', '{}'::jsonb, 'manual')",
      );
      expect(await scan()).toBe(0); // 节流窗口内：即使存在到期行也不处理
      expect((await pendingRows(pool)).filter((r) => r.status === 'pending')).toHaveLength(1);
    });
  });

  it('dead-letter tx failure keeps the event uncommitted: no ledger row, cursor unmoved → redelivery-safe (D1-1 BACKOFF branch)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1], 1);
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      registry.register('message_sent', async () => {
        throw new Error('handler always fails');
      });
      const { logger } = captureLogger();
      const real = createDeadLetterHandler();
      let dlFail = true;
      const deps: EventFrameDeps = {
        pool,
        tracker,
        registry,
        logger,
        deadLetter: async (ctx) => {
          if (dlFail) throw new Error('dead-letter tx exploded');
          await real(ctx); // 第二次进死信走真实三写事务
        },
      };

      await handleEventFrame(deps, frame(2, 'message_sent'));
      // 死信事务失败 = 整个事件仍未入库：游标不动，重连 since 补拉必重投（不丢）
      expect(await ledgerIds(pool)).toEqual([1]);
      expect(await pendingRows(pool)).toEqual([]);
      expect(await readCursor(pool)).toBe(1);

      dlFail = false;
      await handleEventFrame(deps, frame(2, 'message_sent')); // 重投：账本由死信事务补上
      expect(await ledgerIds(pool)).toEqual([1, 2]);
      expect(await readCursor(pool)).toBe(2);
      expect(await pendingRows(pool)).toHaveLength(1);
    });
  });

  it('recovery scan 6 (pending-events) is wired to an immediate retry round (DES/10 §3)', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      registry.register('message_sent', async () => {});
      const { logger } = captureLogger();
      await handleEventFrame(
        { pool, tracker, registry, logger, deadLetter: createDeadLetterHandler() },
        frame(1, 'message_sent'),
      );
      // 上面 handler 是 no-op 成功——这条不会死信；手动造到期死信行
      await pool.query('INSERT INTO gateway_event (event_id, type, payload) VALUES (9, $1, $2::jsonb)', [
        'message_sent',
        JSON.stringify({ eventId: 9, type: 'message_sent' }),
      ]);
      await pool.query(
        "INSERT INTO pending_event (event_id, type, payload, error) VALUES (9, 'message_sent', '{}'::jsonb, 'seed')",
      );

      const scan = RECOVERY_SCANS.find((s) => s.name === 'pending-events');
      if (scan === undefined) throw new Error('pending-events scan missing');
      const handled = await scan.run({
        pool,
        logger,
        gateway: createGatewayClient({ baseUrl: 'http://127.0.0.1:1' }),
        dispatch: registry,
      });
      expect(handled).toBe(1);
      expect((await pendingRows(pool)).find((r) => r.event_id === '9')?.status).toBe('done');
    });
  });

  it('consumer loop default dead-letter seam: failing frame via real SSE → real triple-write lands (run() wiring, no injection)', async () => {
    await withTestDb(async (pool) => {
      // 极简 SSE 端点（resume.test.ts 同法）：记录连接、推送注入帧
      const open = new Set<ServerResponse>();
      const server: Server = createServer((req, res) => {
        if (req.url !== '/events') {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        open.add(res);
        req.on('close', () => open.delete(res));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const emit = (eventId: number, type = 'message_sent'): void => {
        const data = JSON.stringify({ eventId, type });
        for (const res of open) res.write(`id: ${eventId}\nevent: ${type}\ndata: ${data}\n\n`);
      };

      // 领域 handler 未落地：注册一个恒失败的 message_sent——模拟永久性业务写失败
      const registry = createDispatchRegistry();
      registry.register('message_sent', async () => {
        throw new Error('permanent write failure over SSE');
      });
      const { logger } = captureLogger();
      // 不传 deadLetter —— 验证 run() 的缺省接线就是 deadletter.ts 的三写事务
      const consumer = startEventConsumer({
        pool,
        gatewayUrl: `http://127.0.0.1:${port}`,
        logger,
        registry,
        backoffStartMs: 5,
        backoffMaxMs: 20,
      });
      // 轮询等待（10ms 真实节拍）——真实墙钟例外（ts-no-test-timers）：断言对象是真实
      // socket/DB I/O 的收敛，没有可 await 的完成事件；fake timers 会破坏 pg/undici 时序。
      const deadline = Date.now() + 3500;
      const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
        for (;;) {
          if (await check()) return;
          if (Date.now() >= deadline) throw new Error('waitFor: timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      try {
        await waitFor(async () => open.size >= 1);
        emit(1); // 失败 → 死信三写（账本+pending+游标）
        emit(2); // 同样失败 → 消费不中断的证明是第二个死信行也出现
        await waitFor(async () => (await pendingRows(pool)).length === 2);
        expect(await ledgerIds(pool)).toEqual([1, 2]);
        expect(await readCursor(pool)).toBe(2); // 死信事件计为已入账——游标不再卡 0
        const ws = await wsRows(pool);
        expect(ws.filter((w) => w.type === 'inconsistency').map((w) => w.payload.kind)).toEqual([
          'db_write_failed',
          'db_write_failed',
        ]);
      } finally {
        await consumer.stop();
        for (const res of open) res.end();
        open.clear();
        server.close();
        await once(server, 'close');
      }
    });
  });
});
