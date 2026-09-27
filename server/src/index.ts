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
import { startEventConsumer } from './events/consumer.js';
import { createDispatchRegistry, type DispatchRegistry } from './events/dispatch.js';
import { createAccountStatusHandler } from './events/handlers/account-status.js';
import { createMessageHandler } from './events/handlers/message.js';
import { createMemberHandler } from './events/handlers/member.js';
import { createMessageSentHandler, createMessageFailedHandler } from './events/handlers/confirm.js';
import { createGatewayClient, type GatewayClient } from './gateway/client.js';
import { createVerifyAccessToken } from './http/routes/auth.js';
import { buildApp, type App } from './http/app.js';
import { startRecovery, type RecoveryHandle } from './recovery/index.js';
import type { RecoveryScan } from './recovery/scans.js';
import { createScheduler, type Scheduler } from './scheduler/index.js';
import { createScanRegistry, type ScanRegistry } from './scheduler/registry.js';
import { registerDeadLetterScan } from './scheduler/deadletter-scan.js';
import { registerRateLimitScan } from './scheduler/ratelimit-scan.js';
import { registerJoinTimeoutScan } from './scheduler/join-timeout-scan.js';
import { registerDispatchWakeupScan } from './scheduler/dispatch-wakeup.js';
import { startOutboundDispatcher, type OutboundDispatcher } from './modules/messages/dispatcher.js';
import { registerUnknownSettleScan } from './scheduler/unknown-scan.js';
import { attachWsHub, type WsHub } from './ws/hub.js';
import { createWsEventRetentionScan, WS_EVENT_RETENTION_SCAN_NAME } from './ws/retention.js';

// ---------- SSE 消费 seam（T-P2-03 已接线：缺省 = events/consumer.ts 的真实消费循环） ----------

export interface EventConsumer {
  /** 优雅关停：断开 SSE 连接并停止重连循环（游标已持久化，重启后 since 补拉） */
  stop(): Promise<void>;
}

export interface EventConsumerDeps {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly gateway: GatewayClient;
  /** 分发注册表（boot 共享实例：消费循环与死信重试/领域 handler 注册同表，T-P2-04+） */
  readonly registry: DispatchRegistry;
}

/**
 * 缺省实现 = events/consumer.ts 的 startEventConsumer（T-P2-03 接线；测试注入缝不变）。
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
  /** 测试注入缝：缺省 events/consumer.ts 的真实消费循环（全局单飞 + 连续前缀游标 + 退避重连） */
  startConsumer?: StartEventConsumer;
  /** 分发注册表（boot 共享实例：消费循环分发 + 死信重试 + 领域 handler 注册同表，T-P2-04）；缺省骨架 stub 注册表 */
  dispatch?: DispatchRegistry;
  /** 各域扫描的注册表；缺省空表 + dead-letter 注册行（T-P2-04 接线后恒存在） */
  registry?: ScanRegistry;
  /** 测试注入缝：tick 周期；缺省 SCHEDULER_TICK_MS */
  schedulerTickMs?: number;
}

export interface BootHandle {
  readonly app: App;
  readonly pool: Pool;
  /** 分发注册表（领域 handler 注册入口；消费循环/死信重试共用，T-P2-04+） */
  readonly dispatch: DispatchRegistry;
  readonly registry: ScanRegistry;
  readonly scheduler: Scheduler;
  readonly recovery: RecoveryHandle;
  /** WS hub 句柄（/ws 升级 + ws_event 投递；T-P2-10） */
  readonly wsHub: WsHub;
  /** 消费句柄；boot 返回时可能仍 pending（D3-2），stop() 会 await 后关停 */
  readonly consumer: Promise<EventConsumer>;
  /** 出站 dispatcher 句柄（T-P3-02：wake 驱动 + 兜底扫描；stop 退避睡眠立醒） */
  readonly dispatcher: OutboundDispatcher;
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

  // 网关 client 先于 buildApp：账号域路由（connect/transition 补偿调用）需要注入同一实例（T-P2-05）
  const gateway = createGatewayClient({ baseUrl: config.gatewayUrl });
  // 出站 dispatcher（T-P3-02）：先于 buildApp 创建——onMessageAccepted 缝要往这里接线；
  // 泵是惰性（无 wake 不占连接），创建即「启动」：wake/扫描/到期恢复三路唤醒由它内部 advisory lock 消化。
  const outboundDispatcher = startOutboundDispatcher({ pool, gateway, logger });
  const app = await buildApp({
    pool,
    logger,
    gateway,
    verifyAccessToken: createVerifyAccessToken(pool),
    onMessageAccepted: outboundDispatcher.wake,
  });

  // 分发注册表为 boot 共享实例（T-P2-04）：消费循环的分发、死信重试的 b) 重放、
  // 后续领域任务（T-P2-06/08/09…）的 handler 注册，全部指向同一张表。
  const dispatch = options.dispatch ?? createDispatchRegistry();
  // T-P2-06：account_status 事件 → enterTerminal（终态副作用；三来源之一）
  dispatch.register('account_status', createAccountStatusHandler(logger));
  // T-P2-08：message 事件 → 入站投影（去重/回流合并/agent 触发入口）
  dispatch.register('message', createMessageHandler());
  // T-P2-09：member_joined / member_left 事件 → 成员投影（墓碑/单调防线/R-A 终态）
  const memberHandler = createMemberHandler(logger);
  dispatch.register('member_joined', memberHandler);
  dispatch.register('member_left', memberHandler);
  dispatch.register('message_sent', createMessageSentHandler(logger));
  dispatch.register('message_failed', createMessageFailedHandler(logger));

  // 2. 恢复扫描：登记同步完成，扫描体异步交接（D3-2，不 await done）
  const recovery = startRecovery({
    deps: { pool, logger, gateway, dispatch, wakeDispatcher: outboundDispatcher.wake },
    scans: options.recoveryScans,
  });

  // 3. SSE 消费异步启动（seam）：不 await 就绪，监听不等追平（D3-2）。
  //    启动失败记 error（不静默）；句柄 Promise 保留给 stop() 与调用方。
  const startConsumer: StartEventConsumer =
    options.startConsumer ??
    ((deps) =>
      // T-P2-03/04 接线：消费循环需要 pool / gatewayUrl / logger / 共享分发注册表（死信缝走缺省）
      startEventConsumer({
        pool: deps.pool,
        gatewayUrl: deps.config.gatewayUrl,
        logger: deps.logger,
        registry: deps.registry,
      }));
  logger.info('starting events consumer');
  const consumer: Promise<EventConsumer> = (async () =>
    startConsumer({ pool, config, logger, gateway, registry: dispatch }))();
  void consumer.catch((err: unknown) => {
    logger.error({ err }, 'events consumer failed to start');
  });

  // 4. 调度器（1s 周期扫描注册表；扫描抛错 → error 日志且调度器不退出）。
  //    已接线扫描：dead-letter（T-P2-04，5s 节流）、rate-limit-expiry（T-P2-07，到期回 online）、
  //    ws-event-retention（T-P2-10，30min 窗口清理）。
  const registry = options.registry ?? createScanRegistry();
  registerDeadLetterScan({ pool, registry, dispatch, logger });
  registerRateLimitScan({ pool, registry, logger, wakeDispatcher: outboundDispatcher.wake }); // T-P2-07：到期回 online + 唤醒 dispatcher
  registerDispatchWakeupScan({ pool, registry, logger, wake: outboundDispatcher.wake }); // T-P3-02：queued 漏唤醒兜底（1s 节拍）
  registerJoinTimeoutScan({ pool, registry }); // T-P3-06：waiting_joins 的 join_deadline 超时收口
  registerUnknownSettleScan({ pool, registry, logger, gateway, wakeDispatcher: outboundDispatcher.wake }); // T-P3-03：unknown 判定器 1s 兜底节拍
  registry.register(WS_EVENT_RETENTION_SCAN_NAME, createWsEventRetentionScan({ pool }));
  // WS hub（T-P2-10）：挂在共享 app.server 的 /ws 升级路径（DES/01 同端口）；
  // 监听前先 attach——upgrade 监听随 listen 生效，boot 测试断言 attach 顺序无要求。
  const wsHub = attachWsHub(app.server, { pool, logger });
  const scheduler = createScheduler({ registry, logger, tickMs: options.schedulerTickMs });
  scheduler.start();
  // 5. HTTP 监听（最后开放流量；「先恢复世界一致性，再开放流量」——DES/01 §7）。
  //    监听失败（如端口占用）：收回已启动的调度器/消费 seam/pool 再抛——boot 是可反复调用的库函数。
  let address: string;
  try {
    address = await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    await wsHub.close();
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
    await scheduler.stop();
    await outboundDispatcher.stop(); // 退避睡眠立即醒；在途 send 自然返回后退出（写回先行）
    try {
      const eventConsumer = await consumer;
      await eventConsumer.stop();
    } catch (err) {
      logger.error({ err }, 'events consumer stop failed');
    }
    await wsHub.close(); // 断开升级连接后再收 app——WS 连接不属于 fastify 生命周期
    await app.close();
    await recovery.done; // 不会 reject：单扫描错误已在 startRecovery 内捕获记录
    await pool.end();
    logger.info('shutdown complete');
  };

  return { app, pool, dispatch, registry, scheduler, recovery, wsHub, consumer, dispatcher: outboundDispatcher, stop };
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
