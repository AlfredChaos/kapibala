// T-P2-02 c)：启动时序（DES/01 §7、D3-2）+ 调度器容错（卡片 b）+ 恢复六扫描清单（DES/10 §3）。
// 真实 DB 不 mock（根 AGENTS.md §4）：版本门 / 监听 / health 全走真路径。
// 时序断言双记录源：pino 捕获流（boot 步骤日志）+ 注入 stub 的记录数组（scan/consumer 调用）。
// D3-2 的证明形态：boot() 在恢复扫描与 consumer seam 都仍 pending 时就已 resolve 且 health 可用。
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino, { type Logger } from 'pino';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { createGatewayClient } from '../src/gateway/client.js';
import { boot, type BootHandle, type EventConsumer } from '../src/index.js';
import { RECOVERY_SCANS, type RecoveryDeps, type RecoveryScan } from '../src/recovery/scans.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createScanRegistry } from '../src/scheduler/registry.js';
import { getTestDb, withTestDb, type TestDbHandle } from './helpers/db.js';

// —— 夹具 ——

/**
 * 延迟 void 信号。【解读】ts-promise-with-resolvers 规约首选 Promise.withResolvers，
 * 但本仓 lib=ES2023（tsconfig.base.json，非本任务所有权）无其类型——constructor 形态
 * 仅限本 helper 这一处；executor 同步赋值，返回时 resolve 已是真函数。
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: () => resolveFn?.() };
}

/** pino 捕获流：JSON 行 → msg 数组（boot 时序断言的日志真值源） */
function captureLogger(): { logger: Logger; messages: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    logger: pino({ level: 'info' }, sink),
    messages: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { msg?: string }).msg ?? ''),
  };
}

/** 结构化捕获 fake（SchedulerLogger / RecoveryLogger 同形的最小日志面）；只记录 error 供断言 */
function fakeBaseLogger(): {
  logger: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  errors: Array<{ obj: unknown; msg: string }>;
} {
  const errors: Array<{ obj: unknown; msg: string }> = [];
  const logger = {
    info: (_obj: unknown, _msg?: string): void => {},
    error: (obj: unknown, msg?: string): void => {
      errors.push({ obj, msg: msg ?? '' });
    },
  };
  return { logger, errors };
}

/** 空闲端口探针：PORT 被 config 校验为 1..65535（0 非法），先取空闲口再交给 boot */
async function freePort(): Promise<number> {
  const probe = createServer();
  const listening = deferred();
  probe.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const { port } = probe.address() as AddressInfo;
  const closed = deferred();
  probe.close(() => closed.resolve());
  await closed.promise;
  return port;
}

describe('boot order (T-P2-02)', () => {
  let db: TestDbHandle;
  beforeAll(async () => {
    db = await getTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const testConfig = (port: number, databaseUrl?: string): AppConfig =>
    loadConfig({
      PORT: String(port),
      DATABASE_URL: databaseUrl ?? db.connectionString,
      GATEWAY_URL: 'http://127.0.0.1:4100',
      AGENT_URL: 'http://127.0.0.1:4200',
    });

  it('boots gate → recovery register → consumer seam → scheduler → listen last; health live while consumer/recovery pending (D3-2)', async () => {
    const port = await freePort();
    const { logger, messages } = captureLogger();
    const timeline: string[] = [];

    // 仪表化恢复扫描：s1 停在 gate 上——boot 若在恢复完成前就监听（D3-2 要求），health 必须照常可用
    const gate = deferred();
    const names = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const scans: RecoveryScan[] = names.map((name, i) => ({
      name,
      async run() {
        timeline.push(`scan:${name}`);
        if (i === 0) await gate.promise;
        return 0;
      },
    }));

    // 仪表化 consumer seam：启动调用同步记录，但句柄 pending 到 release——证明 listen 不等 SSE 就绪
    const consumerRelease = deferred();
    let consumerStopped = false;
    const startConsumer = async (): Promise<EventConsumer> => {
      timeline.push('consumer-start');
      await consumerRelease.promise;
      timeline.push('consumer-ready');
      return {
        stop: async () => {
          consumerStopped = true;
          timeline.push('consumer-stop');
        },
      };
    };

    // 仪表化调度扫描：证明 tick 真在跑
    const registry = createScanRegistry();
    const firstTick = deferred();
    let ticks = 0;
    registry.register('tick-probe', () => {
      ticks += 1;
      if (ticks === 1) firstTick.resolve();
      return 0;
    });

    const handle: BootHandle = await boot({
      config: testConfig(port),
      logger,
      recoveryScans: scans,
      startConsumer,
      registry,
      schedulerTickMs: 5,
    });

    // boot 已返回 = 监听已建立，而恢复与 consumer 都还没跑完（D3-2：登记+异步交接，不阻塞流量开放）
    expect(timeline).toContain('scan:s1'); // 扫描 1 已异步交接（登记段同步启动）
    expect(timeline).not.toContain('scan:s2'); // 顺序执行停在 s1 的 gate 上
    expect(timeline).not.toContain('consumer-ready');
    expect(timeline.indexOf('scan:s1')).toBeLessThan(timeline.indexOf('consumer-start'));

    // /api/health 随监听即可用：走真实 socket（非 inject），证明 HTTP 已开放
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(timeline).not.toContain('consumer-ready'); // health 期间 consumer 仍 pending

    await firstTick.promise; // 调度器已在 listen 前启动并真实 tick
    expect(ticks).toBeGreaterThanOrEqual(1);

    // 日志时序（卡片 b）：门 → 恢复登记 → consumer seam → 调度器 → 监听
    const order = [
      'schema version verified',
      'recovery scans registered',
      'starting events consumer',
      'scheduler started',
      'http server listening',
    ].map((msg) => messages().indexOf(msg));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 严格递增 = 顺序成立

    // 放行恢复 gate：六扫描按 DES/10 §3 顺序全部跑完
    gate.resolve();
    await handle.recovery.done;
    expect(timeline.filter((t) => t.startsWith('scan:'))).toEqual(names.map((n) => `scan:${n}`));

    // 放行 consumer：句柄落定；stop() 时被关停
    consumerRelease.resolve();
    await expect(handle.consumer).resolves.toBeDefined();
    expect(timeline).toContain('consumer-ready');

    await handle.stop();
    expect(consumerStopped).toBe(true);
    expect(timeline).toContain('consumer-stop');

    // 调度器已停：tick 计数不再增长。
    // 真实墙钟例外（ts-no-test-timers）：断言对象是「真实 timer 不再触发」，且本用例同程有
    // 真实 socket/DB I/O（fake timers 会破坏 pg/undici 内部时序）——无法用确定性时间控制替代。
    const ticksAtStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks).toBe(ticksAtStop);

    // HTTP 已关：真实 socket 连接被拒
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('version gate refuses before listen and cleans up its own pool', async () => {
    await withTestDb(async (setupPool, handle) => {
      await setupPool.query('DELETE FROM schema_migrations WHERE version > 1');
      const port = await freePort();
      // 版本门拒启（A0）：boot reject，且从未 listen（端口仍空闲）、自建 pool 已回收（vitest 无悬挂句柄）
      await expect(
        boot({ config: testConfig(port, handle.connectionString), logger: pino({ level: 'silent' }) }),
      ).rejects.toThrow(/missing versions/);
    });
  });

  it('default seams: boot with no injections reaches listen, health 200, stops cleanly', async () => {
    // 生产缺省路径（main() 同形）：RECOVERY_SCANS 六 stub + 真实消费循环（T-P2-03 接线；测试期
    // :4100 无网关 → 连接失败进退避重连，silent 日志下无副作用，stop() 释放单飞锁后干净退出）+ 空调度注册表
    const port = await freePort();
    const handle = await boot({ config: testConfig(port), logger: pino({ level: 'silent' }) });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    await handle.recovery.done; // stub 扫描恒即刻完成（零工作项）
    await handle.stop();
  });

  it('scheduler survives a throwing scan: error logged with scan name, ticking continues (card b)', async () => {
    vi.useFakeTimers();
    try {
      const { logger, errors } = fakeBaseLogger();
      const registry = createScanRegistry();
      registry.register('boom', () => {
        throw new Error('scan exploded');
      });
      let counterRuns = 0;
      registry.register('counter', () => {
        counterRuns += 1;
        return 0;
      });
      expect(() => registry.register('boom', () => 0)).toThrow(/already registered/);

      const scheduler = createScheduler({ registry, logger, tickMs: 5 });
      scheduler.start();
      expect(() => scheduler.start()).toThrow(/already started/);
      // 确定性时间推进：两个 tick（5ms 链式排程），扫描抛错后调度器必须还活着
      await vi.advanceTimersByTimeAsync(10);
      expect(counterRuns).toBeGreaterThanOrEqual(2);
      expect(errors.length).toBeGreaterThanOrEqual(2); // 每轮都记 error，且调度器继续
      expect((errors[0]?.obj as { scan?: string }).scan).toBe('boom');
      expect((errors[0]?.obj as { err?: Error }).err).toBeInstanceOf(Error);
      expect(errors[0]?.msg).toContain('scheduler scan failed');
      await scheduler.stop();
      await scheduler.stop(); // 幂等：重复 stop 不炸
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovery scan list is the six DES/10 §3 scans in order; stubs hand off zero work', async () => {
    // 清单与顺序 = 契约（DES/10 §3 汇总图逐字）；后续任务只充实扫描体，不改名单与次序
    expect(RECOVERY_SCANS.map((s) => s.name)).toEqual([
      'outbound-messages',
      'agent-runs',
      'sequence-runs',
      'jobs',
      'accounts',
      'pending-events',
    ]);
    const { logger } = fakeBaseLogger();
    const deps: RecoveryDeps = {
      pool: db.pool,
      logger,
      gateway: createGatewayClient({ baseUrl: 'http://127.0.0.1:4100' }),
    };
    for (const scan of RECOVERY_SCANS) {
      expect(await scan.run(deps)).toBe(0);
    }
  });
});
