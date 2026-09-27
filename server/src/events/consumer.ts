// SSE 消费循环（T-P2-03；DES/08 §1.1–§1.3、REQ §2.1 事件流、QR §1 ≤1s 乱序窗口）。
// 形态：全局单飞（pg 会话级 advisory lock 'events:consumer'——唯一性靠数据库，宪法 §3-5）
//   → 游标读库（since 恒取 event_cursor，从不用内存值）→ GET /events(?since=) 消费帧
//   → 每帧一个事件处理事务（§1.2：账本 ON CONFLICT + 分发 + 连续前缀游标）→ 断线退避重连。
// 纪律：
// - cursor=0（首次部署）→ 不带 since 从当前时刻开始（§1.1 解读 #11：此前历史与我方无关）；
// - 退避 500ms 起 ×2 上限 5s（DES/08 §1.1，常量出处 constants.ts）；收到任何帧即重置；
// - 消费循环绝不因单事件失败中断（A2）：事务失败 → 账本/游标都没动，重连后 since 补拉必重投；
//   死信三写事务（D1-1，§1.2 DL 分支）已落地于 deadletter.ts——deadLetter 缝缺省接线该实现；
// - boot 不等就绪（D3-2）：startEventConsumer 同步返回句柄，循环在后台跑。
import type { Pool, PoolClient } from 'pg';
import { SSE_RECONNECT_BACKOFF_MAX_MS, SSE_RECONNECT_BACKOFF_START_MS } from '../constants.js';
import { tx } from '../db/tx.js';
import { isRecord } from '../gateway/client.js';
import { subscribeEvents, type SseFrame } from '../gateway/sse.js';
import { loadCursorTracker, readCursor, type CursorTracker } from './cursor.js';
import {
  createDeadLetterHandler,
  insertInconsistency,
  type DeadLetterHandler,
} from './deadletter.js';
import {
  createDispatchRegistry,
  dispatchEvent,
  type DispatchRegistry,
  type GatewayEventEnvelope,
} from './dispatch.js';
import { classifyOrphan, OrphanWindowedError } from './orphan.js';

/** 全局单飞锁键（DES/08 §1.1 逐字）：会话级 advisory lock，多实例部署只有一个消费者 */
const LOCK_KEY = 'events:consumer';

/** 最小日志面（pino Logger 结构兼容；与 scheduler/recovery 同模式，测试可用普通对象 fake） */
export interface ConsumerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface EventConsumer {
  /** 优雅关停：断开 SSE、停止重连循环、等在飞事件事务落库（游标已持久化）、释放单飞锁。幂等。 */
  stop(): Promise<void>;
}

// DeadLetterHandler 类型归 deadletter.ts（T-P2-04 落地后签名升级为上下文对象：
// 死信收口需要 pool/tracker/logger 才能三写同事务 + 推进游标）。re-export 保持既有导入面。
export type { DeadLetterContext, DeadLetterHandler } from './deadletter.js';

export interface EventConsumerOptions {
  readonly pool: Pool;
  readonly gatewayUrl: string;
  readonly logger: ConsumerLogger;
  /** 测试注入缝 / 领域任务（T-P2-06/08/09）替换 stub 的接线点；缺省骨架 stub 注册表 */
  readonly registry?: DispatchRegistry;
  /** 测试注入缝：退避递进参数；缺省 SSE_RECONNECT_BACKOFF_START_MS / _MAX_MS（DES/08 §1.1） */
  readonly backoffStartMs?: number;
  readonly backoffMaxMs?: number;
  /** 测试注入缝：死信收口（T-P2-04 已接线，缺省 = deadletter.ts 三写事务实现） */
  readonly deadLetter?: DeadLetterHandler;
}

// ---------- 单帧 → 事件处理事务（§1.2 三写单事务） ----------

export interface EventFrameDeps {
  readonly pool: Pool;
  readonly tracker: CursorTracker;
  readonly registry: DispatchRegistry;
  readonly logger: ConsumerLogger;
  readonly deadLetter?: DeadLetterHandler;
}

/** 契约帧必带 event 类型（REQ §2.1）；防御性兜底 data.type → 'unknown'（分发处 log + skip） */
function resolveType(frame: SseFrame): string {
  if (frame.event !== null) return frame.event;
  if (isRecord(frame.data)) {
    const type = frame.data['type'];
    if (typeof type === 'string') return type;
  }
  return 'unknown';
}

/**
 * 事件处理事务（DES/08 §1.2）：a) INSERT gateway_event ON CONFLICT DO NOTHING（重复推送吸收，
 * 游标照常推进）b') 孤儿分流判定（D3-1：永久孤儿 → 同事务 inconsistency + 跳分发；
 * 建群窗口孤儿 → 抛 OrphanWindowedError 回滚整事务、走死信短重试）
 * b) 按 type 分发（事务内、handler 幂等；未知 type → log + skip）
 * c) 连续前缀游标推进（UPDATE 只在本事务内）。
 * 事务失败 → 全部回滚、内存镜像不动：游标 gap 保证重连后 since 补拉重投（不丢）；
 * 收口交 deadLetter 缝（T-P2-04：缺省 = deadletter.ts 三写事务）。本函数永不 throw——
 * 消费循环绝不因单事件中断（A2）。
 */
export async function handleEventFrame(deps: EventFrameDeps, frame: SseFrame): Promise<void> {
  if (frame.eventId === null) return; // 心跳 / 无 id 帧：不入账、不推游标
  const eventId = frame.eventId;
  const type = resolveType(frame);
  // 坏 JSON data（data=null）：账本记 rawData 原文（jsonb 字符串）——事件内容不丢（A2）
  const payload: unknown = frame.data ?? frame.rawData;
  const event: GatewayEventEnvelope = { eventId, type, payload };
  try {
    await tx(deps.pool, async (client) => {
      // a) 入站幂等第一道闸（DES/02 §1.3）：at-least-once 重复推送在 PK 冲突处吸收
      await client.query(
        'INSERT INTO gateway_event (event_id, type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING',
        [eventId, type, JSON.stringify(payload)],
      );
      // b') 孤儿分流（D3-1，§1.2）：永久孤儿同事务推 inconsistency(unknown_group_event)
      //    并跳过分发；建群窗口内的引用未决回滚转死信短重试（映射很快出现）
      const verdict = await classifyOrphan(client, event);
      if (verdict.route === 'windowed') throw new OrphanWindowedError(verdict.message);
      if (verdict.route === 'orphan') {
        await insertInconsistency(client, event, 'unknown_group_event', verdict.message);
      } else {
        // b) 分发（T-P2-06/08/09 的领域 handler 全须幂等——重复推送/补拉都会重放）
        await dispatchEvent(deps.registry, { client, event, logger: deps.logger });
      }
      // c) 连续前缀游标（UPDATE 只在本事务内——卡片 d）
      await deps.tracker.advanceInTx(eventId, client);
    });
    deps.tracker.commit(eventId); // 内存推进的唯一合法时机：COMMIT 成功之后
  } catch (err) {
    deps.logger.error(
      { err, eventId, type },
      'event transaction failed; cursor unmoved (redelivered via since on reconnect)',
    );
    if (deps.deadLetter !== undefined) {
      try {
        await deps.deadLetter({
          event,
          error: err,
          pool: deps.pool,
          tracker: deps.tracker,
          logger: deps.logger,
        });
      } catch (dlErr) {
        deps.logger.error({ err: dlErr, eventId }, 'dead-letter seam failed; event awaits redelivery');
      }
    }
  }
}

/** 退避递进（DES/08 §1.1：500ms 起 ×2，5s 封顶）。纯函数——递进契约由测试直接断言，零墙钟。 */
export function nextBackoffMs(current: number, max: number): number {
  return Math.min(current * 2, max);
}

// ---------- 消费循环 ----------

export function startEventConsumer(options: EventConsumerOptions): EventConsumer {
  const { pool, gatewayUrl, logger } = options;
  const registry = options.registry ?? createDispatchRegistry();
  const backoffStartMs = options.backoffStartMs ?? SSE_RECONNECT_BACKOFF_START_MS; // 500ms（DES/08 §1.1）
  const backoffMaxMs = options.backoffMaxMs ?? SSE_RECONNECT_BACKOFF_MAX_MS; // 5s 封顶

  let stopped = false;
  let wake: (() => void) | undefined; // stop() 掐断在飞的退避睡眠（关停不等满退避）
  let activeAbort: AbortController | undefined;
  let lockClient: PoolClient | undefined; // 单飞锁的会话载体：独占连接，stop 前不归还
  let lockLost = false; // 锁连接死亡标记（DB 重启等）：回收后重新抢锁
  let frameDeps: EventFrameDeps | undefined; // tracker 装载后构建（跨重连保持，§1.3）
  let chain: Promise<void> = Promise.resolve(); // 帧处理串行链：顺序 = 到达顺序，慢帧不叠事务

  /** 可被 stop() 提前唤醒的睡眠（退避/待命共用；stopped 时立即返回） */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = (): void => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  const releaseLock = async (): Promise<void> => {
    const client = lockClient;
    lockClient = undefined;
    if (client === undefined) return;
    const lost = lockLost;
    lockLost = false;
    if (!lost) {
      try {
        // 必须显式解锁：连接归还 pool 后后端会话仍活着，锁会一直持有
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
      } catch (err) {
        logger.error({ err }, 'advisory unlock failed; destroying the connection to drop the lock');
        client.release(true); // 销毁连接 = 后端会话终止 = 会话锁必然释放
        return;
      }
    }
    client.release(lost); // lost=true → 销毁（连接已不可用）
  };

  const acquireLock = async (): Promise<boolean> => {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      logger.error({ err }, 'pool connect for advisory lock failed');
      return false;
    }
    try {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [LOCK_KEY],
      );
      if (res.rows[0]?.locked !== true) {
        client.release();
        return false;
      }
      client.on('error', (err: Error) => {
        // 锁连接死亡 = 单飞凭据已失：标记待回收，循环顶部重新抢锁
        lockLost = true;
        logger.error({ err }, "advisory lock connection died; will re-acquire 'events:consumer'");
      });
      lockClient = client;
      return true;
    } catch (err) {
      logger.error({ err }, 'advisory lock acquisition failed');
      client.release(true);
      return false;
    }
  };

  const run = async (): Promise<void> => {
    let backoff = backoffStartMs;
    let standbyWarned = false;
    while (!stopped) {
      // —— 全局单飞：会话级 advisory lock（拿不到 → 待命退避重试，绝不开第二条 SSE）——
      if (lockClient !== undefined && lockLost) {
        await releaseLock();
        frameDeps = undefined; // 失联期间可能有别的实例推进了真值：内存镜像作废，重新 boot 装载
      }
      if (lockClient === undefined) {
        const acquired = await acquireLock();
        if (stopped) break;
        if (!acquired) {
          if (!standbyWarned) {
            logger.warn({ lock: LOCK_KEY }, 'another instance holds the events consumer lock; standing by');
            standbyWarned = true;
          }
          await sleep(backoff);
          backoff = nextBackoffMs(backoff, backoffMaxMs);
          continue;
        }
        standbyWarned = false;
        backoff = backoffStartMs;
        logger.info({ lock: LOCK_KEY }, 'acquired events consumer advisory lock; consuming');
      }
      // —— boot 装载：连续前缀游标 + seen 自 gateway_event 重建（§1.3；跨重连保持）——
      if (frameDeps === undefined) {
        try {
          const tracker = await loadCursorTracker(pool);
          // 死信缝缺省接线（T-P2-04）：测试经 options.deadLetter 注入 stub；生产走三写事务
          frameDeps = {
            pool,
            tracker,
            registry,
            logger,
            deadLetter: options.deadLetter ?? createDeadLetterHandler(),
          };
          logger.info({ cursor: tracker.cursor }, 'event cursor loaded (seen rebuilt from gateway_event)');
        } catch (err) {
          logger.error({ err }, 'cursor tracker load failed; retrying');
          await sleep(backoff);
          backoff = nextBackoffMs(backoff, backoffMaxMs);
          continue;
        }
        if (stopped) break;
      }
      // —— 一次连接：since 恒读库（卡片 d），cursor=0 → 不带 since（首部署，§1.1 解读 #11）——
      let since: number;
      try {
        since = await readCursor(pool);
      } catch (err) {
        logger.error({ err }, 'cursor read failed; retrying');
        await sleep(backoff);
        backoff = nextBackoffMs(backoff, backoffMaxMs);
        continue;
      }
      if (stopped) break;
      const controller = new AbortController();
      activeAbort = controller;
      const deps = frameDeps;
      let streamError: unknown;
      let ended = false;
      try {
        const result = await subscribeEvents(gatewayUrl, since === 0 ? undefined : since, {
          signal: controller.signal,
          onFrame: (frame) => {
            backoff = backoffStartMs; // 收到帧 = 连接健康 → 退避重置
            // 串行链：事务按帧到达顺序逐个执行（单飞消费者内无并发前缀推进）；
            // handleEventFrame 自捕获全部错误，catch 只是链不变量的兜底（绝不静默）。
            chain = chain.then(() =>
              handleEventFrame(deps, frame).catch((err: unknown) => {
                logger.error({ err }, 'event frame handling crashed unexpectedly');
              }),
            );
          },
        });
        ended = result === 'ended';
      } catch (err) {
        streamError = err;
      }
      activeAbort = undefined;
      if (stopped) break;
      if (streamError !== undefined) logger.error({ err: streamError, since }, 'events stream failed; reconnecting');
      else logger.info({ since, ended }, 'events stream closed; reconnecting');
      await sleep(backoff);
      backoff = nextBackoffMs(backoff, backoffMaxMs);
    }
    await releaseLock();
  };

  const runDone: Promise<void> = run();
  runDone.catch((err: unknown) => {
    // run() 全程自捕获，这里是最后防线（no-floating-promises + 绝不静默）
    logger.error({ err }, 'events consumer loop crashed');
  });

  return {
    stop: async () => {
      if (!stopped) {
        stopped = true;
        activeAbort?.abort(); // 断开在飞 SSE（subscribeEvents → 'aborted'）
        wake?.(); // 掐断退避/待命睡眠
      }
      try {
        await runDone; // 循环退出前已释放单飞锁
      } catch (err) {
        logger.error({ err }, 'events consumer loop crashed on stop');
      }
      // 等在飞事件事务落库：游标已持久化，重启后 since 补拉（宪法 §3-1）
      await chain.catch((err: unknown) => {
        logger.error({ err }, 'event frame handling crashed on stop');
      });
      await releaseLock(); // 幂等兜底（正常路径循环退出时已释放）
    },
  };
}
