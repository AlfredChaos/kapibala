// 应用工厂（DES/14 §1 HTTP 契约层）：进程内装配（app.inject）与独立进程共用同一工厂。
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts.js';
import { registerSseRoutes } from './sse.js';
import { registerGroupRoutes } from './groups.js';
import { registerMediaRoutes } from './media.js';
import { registerMessagingRoutes } from './messaging.js';
import { registerTestPlane } from './test-plane.js';
import { createGatewayState, DEFAULT_SEED_ACCOUNTS, type GatewayState } from './state.js';
import { createDupDelivery } from './switches/basic.js';
import { createReorderDelivery } from './switches/timing.js';

/** Fastify 实例 + 状态句柄（测试与后续域模块直接读状态/账本） */
export type GatewayApp = FastifyInstance & { gatewayState: GatewayState };

export interface GatewayAppOptions {
  /** 预置账号 id（DES/14 §6 GATEWAY_SEED_ACCOUNTS；缺省用契约默认四账号） */
  seedAccountIds?: readonly string[];
  /** 测试内联装配时关日志；独立进程入口开 */
  logger?: boolean;
}

/** 解析 GATEWAY_SEED_ACCOUNTS 环境变量（逗号分隔；DES/14 §6） */
function seedAccountsFromEnv(): readonly string[] {
  const raw = process.env['GATEWAY_SEED_ACCOUNTS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SEED_ACCOUNTS;
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

export function createGatewayApp(options: GatewayAppOptions = {}): GatewayApp {
  const seedAccountIds = options.seedAccountIds ?? seedAccountsFromEnv();
  const state = createGatewayState(seedAccountIds);
  // 单点受控断言：下一行 decorate 补上 gatewayState；经 unknown 是 Fastify decorate 的标准模式
  const app = Fastify({ logger: options.logger === true }) as unknown as GatewayApp;
  app.decorate('gatewayState', state);

  registerAccountRoutes(app, state);
  registerTestPlane(app, state);
  // SSE 推送器（T-P1-02）+ 投递链（DES/14 §3「推送器按开关修饰后投递」）：
  // gw-4 相邻乱序（外层定序，T-P2-12）→ gw-3 双推（内层复制，T-P1-05）→ socket。
  // 定序在外、复制在内 → 双推的两份始终相邻；两开关各自独立可关（关则直通）。
  registerSseRoutes(app, state, {
    createFrameDelivery: (sink) => {
      const dup = createDupDelivery(state, sink);
      return createReorderDelivery(state, (frame) => dup.push(frame));
    },
  });
  registerGroupRoutes(app, state); // T-P1-03（最小 wiring 适配）
  registerMessagingRoutes(app, state); // T-P1-04（最小 wiring 适配）
  registerMediaRoutes(app); // T-P1-04（最小 wiring 适配）
  return app;
}
