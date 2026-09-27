// Fastify 应用装配（T-P0-04）。横切以「直接作用于根实例的函数」形态挂载（封装作用域问题的
// 说明见 plugins/request-id.ts 头注），顺序即语义：
//   requestId 最先（后续 401/403 错误体要带 requestId）→ 错误映射兜底 → auth guard → 路由。
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import type { Pool } from 'pg';
import { applyRequestId } from './plugins/request-id.js';
import { applyErrorMapping } from './plugins/errors.js';
import { applyAuthGuard, stubVerifyAccessToken, type VerifyAccessToken } from './plugins/auth-guard.js';
import { registerRoutes } from './routes/index.js';

/**
 * 全应用统一的实例类型：logger 泛型钉在 pino.Logger。
 * 【解读】pino.Logger 与 fastify 的 FastifyBaseLogger 在 childLoggerFactory 等逆变位置不兼容，
 * 混用 boolean/object 两种 logger 选项会让实例泛型分叉、互相不可赋值——统一走 loggerInstance。
 */
export type App = FastifyInstance<
  Server<typeof IncomingMessage, typeof ServerResponse>,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface BuildAppOptions {
  pool: Pool;
  /** 注入日志器（测试捕获流用）；缺省 = pino() 默认 JSON 行日志（stdout） */
  logger?: Logger;
  /** T-P0-07 落地后由认证模块注入；缺省 = stub（一切 token 401，守卫不可绕过） */
  verifyAccessToken?: VerifyAccessToken;
}

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app: App = Fastify({ loggerInstance: options.logger ?? pino() });
  await applyRequestId(app);
  await applyErrorMapping(app);
  await applyAuthGuard(app, { verifyAccessToken: options.verifyAccessToken ?? stubVerifyAccessToken });
  await registerRoutes(app, { pool: options.pool });
  return app;
}
