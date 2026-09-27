// 调度器（T-P2-02；DES/01 §3「定时（1s 粒度）」、§4.6 防漏拍）。
// 语义：
// - 每 tickMs（缺省 SCHEDULER_TICK_MS=1s，DES/01 §4.6）按注册顺序执行全部已注册扫描；
// - 单个扫描抛错 → error 日志（带 scan 名）后继续——调度器绝不退出（T-P2-02 卡片 b）；
// - 链式 setTimeout：上一轮完成后才排下一轮，慢扫描不叠帧；节奏漂移的代价由 DB 真值兜底
//   （§4.6：扫描只是加速器，漏拍重启后第一轮补上）；
// - stop() 清定时器并等在飞 tick 收尾（优雅关停不掐断扫描中途），幂等。
// 本组件不持有任何业务状态（宪法 §3-5）：扫描的触发条件全部在 DB 时间戳里。
import { SCHEDULER_TICK_MS } from '../constants.js';
import type { ScanRegistry } from './registry.js';

/** 最小日志面（只用 info/error）：pino Logger 结构兼容，测试可用普通对象 fake */
export interface SchedulerLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Scheduler {
  /** 一次性生命周期：start 两次 / stop 后再 start 都拒绝（每次 boot 新建实例） */
  start(): void;
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  registry: ScanRegistry;
  logger: SchedulerLogger;
  /** 测试缝：覆盖 tick 周期；缺省 SCHEDULER_TICK_MS（DES/01 §4.6 1s 粒度） */
  tickMs?: number;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { registry, logger } = options;
  const tickMs = options.tickMs ?? SCHEDULER_TICK_MS;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | null = null;
  let started = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    for (const { name, scan } of registry.scans()) {
      try {
        await scan();
      } catch (err) {
        logger.error({ err, scan: name }, 'scheduler scan failed; scheduler continues');
      }
    }
  };

  const loop = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      ticking = tick();
      ticking
        .catch((err: unknown) => {
          // tick 内部已逐扫描捕获；走到这里只剩基础设施故障（如日志器自身抛错）——记录后继续
          logger.error({ err }, 'scheduler tick failed; scheduler continues');
        })
        .finally(() => {
          ticking = null;
          loop();
        });
    }, tickMs);
  };

  return {
    start() {
      if (started) throw new Error('scheduler already started');
      started = true;
      logger.info({ tickMs }, 'scheduler started');
      loop();
    },
    async stop() {
      if (!started || stopped) return;
      stopped = true;
      clearTimeout(timer); // 无守卫：clear* 对 undefined/已清句柄天然 no-op（ts-redundant-clear-guard）
      // tick 的拒绝已由 loop 内的 catch 记录；此处只等收尾，不把二次错误抛给关停路径
      if (ticking !== null) await ticking.catch(() => {});
      logger.info('scheduler stopped');
    },
  };
}
