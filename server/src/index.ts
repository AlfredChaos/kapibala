// server 入口 + 启动编排（T-P2-02；DES/01 §7、D3-2）。
// 顺序（卡片 b 逐字）：loadConfig → pool → 迁移版本门（落后/超前都拒启，A0）
//   → 恢复扫描登记（同步）+ 扫描体异步交接 → SSE 消费 seam 异步启动 → 调度器启动 → HTTP 监听（最后）。
// D3-2：/api/health 随监听即可用，不等 SSE 追平、不等恢复扫描跑完——登记完成即世界一致
//   （意图都在 DB），进度由 DB 驱动的常驻组件追赶（DES/01 §4.6）。
// boot() 是纯函数式编排（信号处理不进 boot——测试要多次 boot 而不叠加 process 监听器）；
// SIGINT/SIGTERM 的优雅关停接线在 main()，仅进程入口路径注册。
// 迁移本身不在此执行：由 `pnpm -F server db:migrate` 显式先行（AGENTS.md §1），
// 入口只做「代码版本 == DB 版本」的守门。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino, { type Logger } from 'pino';
import type { Pool } from 'pg';
import type { AppConfig } from './config/index.js';
import { ConfigError, loadConfig } from './config/index.js';
import { createPool } from './db/pool.js';
import { ensureSchemaVersion } from './db/ensure-schema.js';
import { createGatewayClient, type GatewayClient } from './gateway/client.js';
import { createVerifyAccessToken } from './http/routes/auth.js';
import { buildApp, type App } from './http/app.js';
import { startRecovery, type RecoveryHandle } from './recovery/index.js';
import type { RecoveryScan } from './recovery/scans.js';
import { createScheduler, type Scheduler } from './scheduler/index.js';
import { createScanRegistry, type ScanRegistry } from './scheduler/registry.js';

// ---------- SSE 消费 seam（T-P2-03 接线点） ----------

export interface EventConsumer {
  /** 优雅关停：断开 SSE 连接并停止重连循环（游标已持久化，重启后 since 补拉） */
  stop(): Promise<void>;
}

export interface EventConsumerDeps {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly gateway: GatewayClient;
}

/**
 * T-P2-03 落地时把真实消费循环从这里接入（boot 缺省值换成 events/ 的工厂即可，无需重排启动时序）。
 * 契约：调用即「异步启动」——允许返回 pending 的 Promise，boot 不 await 它就绪（D3-2）。
 */
export type StartEventConsumer = (deps: EventConsumerDeps) => EventConsumer | Promise<EventConsumer>;

// ---------- boot ----------

export interface BootOptions {
  /** 缺省 loadConfig()（进程 env / server/.env） */
  config?: AppConfig;
  /** 缺省 pino()（stdout JSON 行） */
  logger?: Logger;
  /** 测试注入缝：仪表化恢复扫描；缺省 RECOVERY_SCANS 六扫描骨架 */
  recoveryScans?: readonly RecoveryScan[];
  /** 测试注入缝 / T-P2-03 接线点：缺省 no-op consumer（骨架期无消费循环） */
  startConsumer?: StartEventConsumer;
  /** 各域扫描的注册表；缺省空表（后续任务经 handle.registry 或 boot 前注册） */
  registry?: ScanRegistry;
  /** 测试注入缝：tick 周期；缺省 SCHEDULER_TICK_MS */
  schedulerTickMs?: number;
}

export interface BootHandle {
  readonly app: App;
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly scheduler: Scheduler;
  readonly recovery: RecoveryHandle;
  /** 消费句柄；boot 返回时可能仍 pending（D3-2），stop() 会 await 后关停 */
  readonly consumer: Promise<EventConsumer>;
  stop(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<BootHandle> {
  const logger = options.logger ?? pino();
  const config = options.config ?? loadConfig();

  // 1. 连接 + 版本门（A0：落后/超前都拒启）。失败要收回 pool——boot 是可被测试反复调用的库函数，
  //    不能像进程入口那样靠 exit(1) 兜底泄漏。
  const pool = createPool(config.databaseUrl);
  let schemaVersion: number;
  try {
    schemaVersion = await ensureSchemaVersion(pool);
  } catch (err) {
    await pool.end().catch((endErr: unknown) => {
      logger.error({ err: endErr }, 'pool cleanup after failed version gate failed');
    });
    throw err;
  }
  logger.info({ schemaVersion, port: config.port }, 'schema version verified');

  const app = await buildApp({ pool, logger, verifyAccessToken: createVerifyAccessToken(pool) });
  const gateway = createGatewayClient({ baseUrl: config.gatewayUrl });

  // 2. 恢复扫描：登记同步完成，扫描体异步交接（D3-2，不 await done）
  const recovery = startRecovery({
    deps: { pool, logger, gateway },
    scans: options.recoveryScans,
  });

  // 3. SSE 消费异步启动（seam）：不 await 就绪，监听不等追平（D3-2）。
  //    启动失败记 error（不静默）；句柄 Promise 保留给 stop() 与调用方。
  const startConsumer: StartEventConsumer =
    options.startConsumer ??
    (() => {
      // 骨架期缺省：no-op（T-P2-03 接入真实消费循环后此缺省值随接线移除）
      logger.info('events consumer seam: no-op until T-P2-03 lands the consumer loop');
      return { stop: async () => {} };
    });
  logger.info('starting events consumer');
  const consumer: Promise<EventConsumer> = (async () =>
    startConsumer({ pool, config, logger, gateway }))();
  void consumer.catch((err: unknown) => {
    logger.error({ err }, 'events consumer failed to start');
  });

  // 4. 调度器（1s 周期扫描注册表；扫描抛错 → error 日志且调度器不退出）
  const registry = options.registry ?? createScanRegistry();
  const scheduler = createScheduler({ registry, logger, tickMs: options.schedulerTickMs });
  scheduler.start();

  // 5. HTTP 监听（最后开放流量；「先恢复世界一致性，再开放流量」——DES/01 §7）。
  //    监听失败（如端口占用）：收回已启动的调度器/消费 seam/pool 再抛——boot 是可反复调用的库函数。
  let address: string;
  try {
    address = await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    await scheduler.stop();
    void consumer.then((c) => c.stop()).catch((stopErr: unknown) => {
      logger.error({ err: stopErr }, 'consumer stop after failed listen failed');
    });
    await recovery.done;
    await pool.end().catch((endErr: unknown) => {
      logger.error({ err: endErr }, 'pool cleanup after failed listen failed');
    });
    throw err;
  }
  logger.info({ address }, 'http server listening');

  const stop = async (): Promise<void> => {
    logger.info('shutting down');
    await scheduler.stop();
    try {
      const eventConsumer = await consumer;
      await eventConsumer.stop();
    } catch (err) {
      logger.error({ err }, 'events consumer stop failed');
    }
    await app.close();
    await recovery.done; // 不会 reject：单扫描错误已在 startRecovery 内捕获记录
    await pool.end();
    logger.info('shutdown complete');
  };

  return { app, pool, registry, scheduler, recovery, consumer, stop };
}

// ---------- 进程入口 ----------

async function main(): Promise<void> {
  const logger = pino();
  const handle = await boot({ logger });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return; // 重复信号：关停已在进行
    stopping = true;
    logger.info({ signal }, 'signal received');
    handle.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ESM 主模块判定：被测试 import 时不启动（vitest 的 argv[1] 不指向本文件）
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      pino().error({ issues: err.issues }, 'invalid configuration, refusing to start');
    } else {
      // 版本门拒绝也走这里：err.message 列出缺失/多余版本（English，DES/01 §6.2）
      pino().error({ err }, 'startup failed');
    }
    process.exit(1);
  });
}
