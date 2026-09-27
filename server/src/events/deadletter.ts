// 死信收口与重试（T-P2-04；DES/08 §1.2 死信分支 / §1.4、DES/02 §1.4、D1-1）。
// 为什么死信事务必须三写同事务（D1-1，DES/08 §1.2 逐字）：主事务 a+b+c 是一个事务，
// b/c 失败时**整个回滚，账本行也消失**——pending_event.event_id 是
// NOT NULL REFERENCES gateway_event(event_id)，只写死信必 FK 违例。
// 故死信事务 = a') 补账本 ON CONFLICT + b') INSERT pending_event + c') 推进游标（同一事务）；
// inconsistency ws_event 也随同事务——告警与死信行同生同死，通知永不落空（宪法 §3-1）。
// 死信事务自身失败 → 全部回滚、游标不动：事件从未入账，重连 since 补拉必重投（不丢，A2）。
// 重试（§1.4）：调度器每 5s 扫到期 pending 行重放分发步骤 b)（a 天然冲突跳过——
// 账本行已由死信事务写入）；成功 → status='done'（与 handler 的 ws_event 同事务）；
// 失败 → attempts+1 + 指数退避（基数 = 扫描节拍 5s，上限 5min）；累计 ≥20 次 →
// 推一次 inconsistency(dead_letter_stuck) 提示操作员；行永不删除（内容不丢）。
import type { Pool, PoolClient } from 'pg';
import {
  DEADLETTER_BACKOFF_MAX_MS,
  DEADLETTER_SCAN_INTERVAL_MS,
  DEADLETTER_STUCK_THRESHOLD,
} from '../constants.js';
import { tx } from '../db/tx.js';
import type { CursorTracker } from './cursor.js';
import { dispatchEvent, type DispatchRegistry, type GatewayEventEnvelope } from './dispatch.js';
import type { SchedulerScan } from '../scheduler/registry.js';

/** 调度器注册名（boot 接线处；测试据此断言接线键稳定） */
export const DEAD_LETTER_SCAN_NAME = 'dead-letter';

/** 最小日志面（warn+error；pino / ConsumerLogger 结构兼容） */
export interface DeadLetterLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * T-P2-03 死信接线点（EventConsumerOptions.deadLetter 的类型）：
 * 主事件事务失败后的收口钩子。生产实现 = createDeadLetterHandler()；
 * 测试可注入 stub（收到事件与错误即可观测；不实现时事件靠 since 重投，不丢）。
 * tracker 必须随上下文传入——死信事务要推进持久化游标并在 COMMIT 后跟进内存镜像，
 * 否则前缀停在未入账事件上、断流补拉会在同一行反复打转。
 */
export interface DeadLetterContext {
  readonly event: GatewayEventEnvelope;
  readonly error: unknown;
  readonly pool: Pool;
  readonly tracker: CursorTracker;
  readonly logger: DeadLetterLogger;
}

export type DeadLetterHandler = (ctx: DeadLetterContext) => Promise<void>;
/**
 * ws_event(inconsistency) 落库（§1.2/§2.3 kind 闭集；ref 形状 = '<type>:<eventId>'，§1.2 逐字）。
 * 调用方的事务语境由 client 承载——本函数只负责一行 INSERT：
 * 死信事务 / 孤儿分流事务 / 重试更新事务各自内嵌。
 */
export async function insertInconsistency(
  client: PoolClient,
  event: GatewayEventEnvelope,
  kind: string,
  message: string,
): Promise<void> {
  await client.query('INSERT INTO ws_event (type, payload) VALUES ($1, $2::jsonb)', [
    'inconsistency',
    JSON.stringify({ kind, ref: `${event.type}:${event.eventId}`, message }),
  ]);
}

/**
 * 生产死信收口（消费循环 options.deadLetter 的缺省实现）：
 * 三写同事务（账本补行 → pending_event → 游标推进）+ 同事务 inconsistency(db_write_failed)。
 * 任意一步失败 → 整个死信事务回滚（游标与内存镜像都不动）——事件重回「未入账」，
 * 由断流补拉重投主事务，永不丢弃（DES/08 §1.2 BACKOFF 分支）。
 */
export function createDeadLetterHandler(): DeadLetterHandler {
  return async (ctx) => {
    const { event, error, pool, tracker, logger } = ctx;
    // 审计文本：错误名+消息（死信行与告警共用同一原文，不静默吞上下文）
    const errorSummary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await tx(pool, async (client) => {
      // a') 补账本：主事务回滚后此行不存在（存在 = 补投路径，ON CONFLICT 吸收）
      await client.query(
        'INSERT INTO gateway_event (event_id, type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING',
        [event.eventId, event.type, JSON.stringify(event.payload)],
      );
      // b') 死信行：UNIQUE(event_id) 兜底重复收口（重投再败二次进死信 → 冲突跳过，
      //    原行带着既有 attempts 继续走调度器重试，不重置）
      await client.query(
        `INSERT INTO pending_event (event_id, type, payload, error)
         VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, event.type, JSON.stringify(event.payload), errorSummary],
      );
      // c') 推进游标：死信事件计为「已入账」（内容已持久化于 pending_event，前缀语义不变）
      await tracker.advanceInTx(event.eventId, client);
      // 同事务告警（§1.2）：死信落库与操作员通知原子生效
      await insertInconsistency(
        client,
        event,
        'db_write_failed',
        `event transaction failed and was dead-lettered: ${errorSummary}`,
      );
    });
    tracker.commit(event.eventId); // 内存镜像推进的唯一合法时机：死信事务 COMMIT 之后
    logger.warn(
      { eventId: event.eventId, type: event.type },
      'event dead-lettered (ledger + pending_event + cursor committed; inconsistency pushed)',
    );
  };
}

// ---------- 重试（§1.4） ----------

export interface DeadLetterRetryDeps {
  readonly pool: Pool;
  readonly registry: DispatchRegistry;
  readonly logger: DeadLetterLogger;
}

/**
 * 退避递进（§1.4：指数退避、上限 5min）。基数 = 5s 扫描节拍（next_retry_at 的创建缺省
 * 即 now()——首次重试天然在最近节拍内，「建群窗口短重试」由同一节奏天然满足，D3-1）。
 * 纯函数——递进契约由测试直接断言，零墙钟。
 */
export function nextDeadLetterBackoffMs(attempts: number, maxMs = DEADLETTER_BACKOFF_MAX_MS): number {
  return Math.min(DEADLETTER_SCAN_INTERVAL_MS * 2 ** (attempts - 1), maxMs);
}

interface PendingDueRow {
  readonly id: string;
  readonly event_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/**
 * 一轮到期死信重试（调度器扫描体 / 恢复扫描 6 共用，DES/10 §3「立即重试一轮」）：
 * 每行独立事务——单行失败不污染其余到期行。
 * 并发形态：boot 恢复扫描 6 与调度器扫描可短暂并存；handler 幂等 + 失败路径的
 * status='pending' 条件更新（宪法 §3-5）兜住双发——最坏是同一 handler 重放两次
 * （领域 handler 本来就必须幂等：重复推送/补拉都会重放）。
 * 重试 = 只重放分发 b)（账本行已由死信事务写入，a 步骤天然冲突跳过，§1.4 前提）；
 * 重试不再走孤儿分类/死信缝——死信行已是「需要重试」的判定本身。
 * 返回处理条数（成功 done + 失败重排都算处理过；未到期行不计）。
 */
export async function retryDeadLettersOnce(deps: DeadLetterRetryDeps): Promise<number> {
  const { pool, registry, logger } = deps;
  const due = await pool.query<PendingDueRow>(
    `SELECT id, event_id, type, payload, attempts FROM pending_event
     WHERE status = 'pending' AND next_retry_at <= now() ORDER BY event_id`,
  );
  let handled = 0;
  for (const row of due.rows) {
    handled += 1;
    const eventId = Number(row.event_id);
    const event: GatewayEventEnvelope = { eventId, type: row.type, payload: row.payload };
    try {
      // 成功路径单事务：重放分发（handler 幂等）+ status='done' 原子提交——
      // 「done」只在业务写落地后落库（宪法 §3-1）；handler 的 ws_event 在同一事务内补推。
      await tx(pool, async (client) => {
        await dispatchEvent(registry, { client, event, logger });
        await client.query(
          "UPDATE pending_event SET status = 'done', updated_at = now() WHERE id = $1",
          [row.id],
        );
      });
      logger.warn(
        { eventId, type: row.type },
        'dead-letter retry succeeded; pending_event done',
      );
    } catch (err) {
      // 失败路径单事务：attempts+1 + 退避 next_retry_at；跨越阈值时同事务推
      // dead_letter_stuck（告警与计数原子——崩溃不会留下「已 stuck 但未告警」的形态）。
      const nextAttempts = row.attempts + 1;
      const stuck = nextAttempts >= DEADLETTER_STUCK_THRESHOLD;
      try {
        await tx(pool, async (client) => {
          const res = await client.query(
            `UPDATE pending_event
             SET attempts = attempts + 1,
                 next_retry_at = now() + ($1 || ' milliseconds')::interval,
                 updated_at = now()
             WHERE id = $2 AND status = 'pending'`,
            [nextDeadLetterBackoffMs(nextAttempts), row.id],
          );
          if (res.rowCount === 0) return; // 并发已被别处处理（done）——不重复告警
          if (stuck && nextAttempts === DEADLETTER_STUCK_THRESHOLD) {
            await insertInconsistency(
              client,
              event,
              'dead_letter_stuck',
              `dead-letter reached ${DEADLETTER_STUCK_THRESHOLD} attempts; operator attention required (event retained, retries continue)`,
            );
          }
        });
      } catch (updateErr) {
        logger.error(
          { err: updateErr, eventId },
          'dead-letter failure bookkeeping failed; row remains pending (retried when due)',
        );
        continue;
      }
      logger.error(
        { err, eventId, type: row.type, attempts: nextAttempts, stuck },
        'dead-letter retry failed; rescheduled with exponential backoff',
      );
    }
  }
  return handled;
}

/**
 * 调度器扫描工厂（boot 经 registry.register(DEAD_LETTER_SCAN_NAME, …) 接线）：
 * 调度器逐 tick 调用，本扫描内部按 DEADLETTER_SCAN_INTERVAL_MS（5s，§1.4）节流——
 * 语义归属本模块而非调度器通用机制（调度器只管「每 tick 跑一遍注册表」）。
 * 节流起点自首次调用起算（创建即到期：boot 后第一个 tick 立即扫一轮）。
 */
export function createDeadLetterScan(
  deps: DeadLetterRetryDeps,
  options: { intervalMs?: number } = {},
): SchedulerScan {
  const intervalMs = options.intervalMs ?? DEADLETTER_SCAN_INTERVAL_MS;
  let nextDue = 0; // 0 = 立即到期（首次 tick 即扫）
  return async () => {
    const now = Date.now();
    if (now < nextDue) return 0;
    nextDue = now + intervalMs; // 先占位：本趟扫描自身耗时不压缩下一趟的等待
    return retryDeadLettersOnce(deps);
  };
}
