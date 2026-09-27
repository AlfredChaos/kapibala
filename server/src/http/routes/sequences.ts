// POST /api/sequences（T-P6-01；DES/07 §1、REQ §2.3 sequences 行）。
// 写操作 → auth:'write'（viewer 403）。定义阶段不校验占位符（§1 明文：预检在启动时做）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { defineSequence } from '../../modules/sequences/define.js';

export async function registerSequenceRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post('/api/sequences', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = await defineSequence(deps.pool, request.body);
    return reply.status(201).send({ id });
  });
}
