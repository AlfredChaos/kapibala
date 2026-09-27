// 路由注册表（T-P0-04 起 lane-A 共享文件：后续任务只在此追加注册行——DAG 规则 7 列出的
// 渐进编辑共享文件之一，编辑者两两之间存在编号顺序串行关系）。
import { registerAuthRoutes } from './auth.js';
import type { App } from '../app.js';
import type { Pool } from 'pg';
import type { GatewayClient } from '../../gateway/client.js';
import { registerHealthRoutes } from './health.js';
import { registerAccountRoutes } from './accounts.js';
import { registerMessageRoutes } from './messages.js';
import { registerGroupRoutes } from './groups.js';
import { registerJobRoutes } from './jobs.js';
import { registerGroupsSendRoutes } from './groups-send.js';

export interface RouteDeps {
  pool: Pool;
  /** T-P2-05 起账号域 connect/transition 需要（connect 先调网关；disconnect 补偿调用） */
  gateway: GatewayClient;
}

export async function registerRoutes(app: App, deps: RouteDeps): Promise<void> {
  await registerHealthRoutes(app, deps);
  await registerAuthRoutes(app, deps);
  await registerAccountRoutes(app, deps);
  await registerMessageRoutes(app, deps);
  await registerGroupRoutes(app, deps);
  await registerJobRoutes(app, deps);
  await registerGroupsSendRoutes(app, deps);
}
