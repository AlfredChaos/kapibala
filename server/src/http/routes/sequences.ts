// 序列定义路由：GET /api/sequences（定义列表）+ POST /api/sequences（T-P6-01；DES/07 §1、REQ §2.3 sequences 行）。
// 权限矩阵（DES/09 §4）：GET 是读路径 → auth:'required'（viewer 可读；包络逐字对齐 GET /api/groups /
// GET /api/accounts 的裸数组）；POST 是写操作 → auth:'write'（viewer 403）。
// GET 定义列表属契约空隙补全：design/15 §2 页面 5 数据源行要求「GET（定义列表）」而 QR §1 端点表未列
// ——见 design/README 解释声明 #27。定义阶段不校验占位符（§1 明文：预检在启动时做）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { defineSequence } from '../../modules/sequences/define.js';
import { listSequences } from '../../modules/sequences/query.js';

export async function registerSequenceRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get('/api/sequences', { config: { auth: 'required' } }, async () => listSequences(deps.pool));

  app.post('/api/sequences', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = await defineSequence(deps.pool, request.body);
    return reply.status(201).send({ id });
  });
}
