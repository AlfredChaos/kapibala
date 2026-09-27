// T-P2-03 c)：连续前缀游标（DES/08 §1.3，I8 / G-19）+ 事件处理事务（§1.2）+ dispatch 骨架。
// 真实 DB 不 mock（根 AGENTS.md §4）：账本行与 event_cursor 一律直查数据库断言。
// 事件帧直接喂给 handleEventFrame（consumer.ts 导出的单帧事务入口）——SSE 传输层
// （重连 / since / 单飞）归 resume.test.ts，此处只钉「事务内三写 + 前缀语义」。
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { GATEWAY_EVENT_TYPES } from '@kapibala/contract';
import {
  handleEventFrame,
  type ConsumerLogger,
  type DeadLetterHandler,
  type EventFrameDeps,
} from '../../src/events/consumer.js';
import { loadCursorTracker, readCursor } from '../../src/events/cursor.js';
import { createDispatchRegistry, type DispatchRegistry } from '../../src/events/dispatch.js';
import type { SseFrame } from '../../src/gateway/sse.js';
import { withTestDb } from '../helpers/db.js';

/** 构造 SSE 帧（契约形状：data 里同时带 eventId 与 type，REQ §2.1） */
function frame(eventId: number, type = 'message', data?: Record<string, unknown>): SseFrame {
  const payload = data ?? { eventId, type };
  return { eventId, event: type, data: payload, rawData: JSON.stringify(payload) };
}

/** 模拟前一轮运行的账本状态：gateway_event 行 + 游标位置（boot 重建的种子） */
async function seedLedger(pool: Pool, eventIds: readonly number[], cursor: number): Promise<void> {
  for (const eventId of eventIds) {
    await pool.query('INSERT INTO gateway_event (event_id, type, payload) VALUES ($1, $2, $3::jsonb)', [
      eventId,
      'message',
      JSON.stringify({ eventId, type: 'message' }),
    ]);
  }
  await pool.query('UPDATE event_cursor SET last_event_id = $1 WHERE id = 1', [cursor]);
}

async function ledgerIds(pool: Pool): Promise<number[]> {
  const res = await pool.query<{ event_id: string }>(
    'SELECT event_id FROM gateway_event ORDER BY event_id',
  );
  return res.rows.map((row) => Number(row.event_id));
}

/** 六类已知 type 全部换成记录 handler（domain 处理器 T-P2-06/08/09 才落地——此处观测分发） */
function recordingRegistry(): {
  registry: DispatchRegistry;
  calls: Array<{ eventId: number; type: string }>;
} {
  const registry = createDispatchRegistry();
  const calls: Array<{ eventId: number; type: string }> = [];
  for (const type of GATEWAY_EVENT_TYPES) {
    registry.register(type, async (ctx) => {
      calls.push({ eventId: ctx.event.eventId, type: ctx.event.type });
    });
  }
  return { registry, calls };
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

describe('continuous-prefix cursor (T-P2-03)', () => {
  it('event 5 first → cursor stays at 3; event 4 arrives → cursor advances to 5 (card b / I8: prefix, not max)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1, 2, 3], 3);
      const tracker = await loadCursorTracker(pool);
      expect(tracker.cursor).toBe(3);
      const { registry, calls } = recordingRegistry();
      const { logger } = captureLogger();
      const deps: EventFrameDeps = { pool, tracker, registry, logger };

      // 乱序窗口（QR §1 ≤1s）：5 先到、4 未到
      await handleEventFrame(deps, frame(5));
      expect(await readCursor(pool)).toBe(3); // gap=4 → 游标不动（取 max 会错跳 5，重连即永久丢 4）
      expect(tracker.cursor).toBe(3); // 内存镜像同样不动

      await handleEventFrame(deps, frame(4));
      expect(await readCursor(pool)).toBe(5); // 前缀闭合 → 一次推进到 5
      expect(tracker.cursor).toBe(5);

      // 两个事件都被分发过（乱序只影响游标，不影响入账；处理器幂等是分发的前提，§1.2 b）
      expect(calls).toEqual([
        { eventId: 5, type: 'message' },
        { eventId: 4, type: 'message' },
      ]);
      expect(await ledgerIds(pool)).toEqual([1, 2, 3, 4, 5]);
      const payloadRow = await pool.query<{ payload: unknown }>(
        'SELECT payload FROM gateway_event WHERE event_id = 5',
      );
      expect(payloadRow.rows[0]?.payload).toMatchObject({ eventId: 5, type: 'message' }); // payload = 帧 data 原样
    });
  });

  it('boot rebuild: seen restored from gateway_event — gap-filler snaps prefix to end of continuous run (card: rebuilt at boot)', async () => {
    await withTestDb(async (pool) => {
      // 前一轮运行崩溃时的形态：4/5 已入账，但前缀停在 2（3 从未到达）
      await seedLedger(pool, [1, 2, 4, 5], 2);
      const tracker = await loadCursorTracker(pool);
      expect(tracker.cursor).toBe(2);
      const { registry } = recordingRegistry();
      const { logger } = captureLogger();

      await handleEventFrame({ pool, tracker, registry, logger }, frame(3));
      // 重建的 seen={4,5} 生效：3 一入账，前缀直接跳到 5（而不是只推进到 3）
      expect(await readCursor(pool)).toBe(5);
      expect(tracker.cursor).toBe(5);
    });
  });

  it('duplicate push of same eventId: ledger PK absorbs (ON CONFLICT DO NOTHING), cursor still advances, dispatch replays (card b / S2)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1], 1);
      const tracker = await loadCursorTracker(pool);
      const { registry, calls } = recordingRegistry();
      const { logger } = captureLogger();
      const deps: EventFrameDeps = { pool, tracker, registry, logger };

      await handleEventFrame(deps, frame(2));
      await handleEventFrame(deps, frame(2)); // at-least-once 重复推送（gw-3 同 eventId 投两次）

      expect(await ledgerIds(pool)).toEqual([1, 2]); // 账本只有一行：PK 吸收
      expect(await readCursor(pool)).toBe(2); // 游标照常推进（重复事件计为已入账）
      expect(calls).toHaveLength(2); // 分发重放——幂等由 handler 负责（§1.2 b）
    });
  });

  it('unknown event type: log + skip — no handler exists, yet ledger row and cursor advance normally (card b)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1], 1);
      const tracker = await loadCursorTracker(pool);
      const { registry, calls } = recordingRegistry();
      const { logger, entries } = captureLogger();

      await handleEventFrame({ pool, tracker, registry, logger }, frame(2, 'mystery'));

      expect(calls).toEqual([]); // 无 handler 可调——skip
      expect(entries.some((e) => e.level === 'warn' && /unknown/i.test(e.msg))).toBe(true); // 但不静默：log
      expect(await ledgerIds(pool)).toEqual([1, 2]); // 账本照记（内容不丢，A2）
      expect(await readCursor(pool)).toBe(2); // 游标照推（否则 gap 永久卡死前缀）
      const typeRow = await pool.query<{ type: string }>(
        'SELECT type FROM gateway_event WHERE event_id = 2',
      );
      expect(typeRow.rows[0]?.type).toBe('mystery');
    });
  });

  it('event transaction failure: full rollback (no ledger row, cursor unmoved), deadLetter seam receives error, consumption continues (A2 / §1.2)', async () => {
    await withTestDb(async (pool) => {
      await seedLedger(pool, [1], 1);
      const tracker = await loadCursorTracker(pool);
      const registry = createDispatchRegistry();
      let failNext = true;
      registry.register('message', async () => {
        if (failNext) {
          failNext = false;
          throw new Error('db write exploded');
        }
      });
      const deadLetters: Array<{ eventId: number; message: string }> = [];
      const deadLetter: DeadLetterHandler = async (event, err) => {
        // 死信三写事务（D1-1）归 T-P2-04——此处只验证接线点收到事件与错误
        deadLetters.push({
          eventId: event.eventId,
          message: err instanceof Error ? err.message : String(err),
        });
      };
      const { logger, entries } = captureLogger();
      const deps: EventFrameDeps = { pool, tracker, registry, logger, deadLetter };

      await handleEventFrame(deps, frame(2));
      // 整个事务回滚：账本无行、游标不动（重连后 since=1 必重拉——事件不丢）
      expect(await ledgerIds(pool)).toEqual([1]);
      expect(await readCursor(pool)).toBe(1);
      expect(tracker.cursor).toBe(1); // 内存镜像绝不能在回滚后前进（否则前缀越过未入库的 2）
      expect(deadLetters).toEqual([{ eventId: 2, message: 'db write exploded' }]);
      expect(entries.some((e) => e.level === 'error')).toBe(true); // 不静默吞（宪法 §3-7）

      // 消费不中断（A2）：下一事件照常入账，但前缀被 2 的 gap 挡住
      await handleEventFrame(deps, frame(3));
      expect(await ledgerIds(pool)).toEqual([1, 3]);
      expect(await readCursor(pool)).toBe(1);

      // 故障修复后事件重投（模拟重连补拉）：前缀 2→3 一次闭合
      await handleEventFrame(deps, frame(2));
      expect(await ledgerIds(pool)).toEqual([1, 2, 3]);
      expect(await readCursor(pool)).toBe(3);
      expect(deadLetters).toHaveLength(1); // 成功路径不再触碰死信缝
    });
  });

  it('frames without eventId (heartbeats) never touch ledger or cursor', async () => {
    await withTestDb(async (pool) => {
      const tracker = await loadCursorTracker(pool);
      const { registry, calls } = recordingRegistry();
      const { logger } = captureLogger();

      await handleEventFrame({ pool, tracker, registry, logger }, {
        eventId: null,
        event: null,
        data: null,
        rawData: '',
      });

      expect(await ledgerIds(pool)).toEqual([]);
      expect(await readCursor(pool)).toBe(0);
      expect(calls).toEqual([]);
    });
  });
});
