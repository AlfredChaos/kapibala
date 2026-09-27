// 路由注册表（T-P0-04 起 lane-A 共享文件：后续任务只在此追加注册行——DAG 规则 7 列出的
// 渐进编辑共享文件之一，编辑者两两之间存在编号顺序串行关系）。
import { registerAuthRoutes } from './auth.js';
import type { App } from '../app.js';
import type { Pool } from 'pg';
import { registerHealthRoutes } from './health.js';

export interface RouteDeps {
  pool: Pool;
}

export async function registerRoutes(app: App, deps: RouteDeps): Promise<void> {
  await registerHealthRoutes(app, deps);
  await registerAuthRoutes(app, deps);
  // T-P2-05: await registerAccountRoutes(app, deps);
}
