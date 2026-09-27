// POST /api/groups/:id/sequence-runs（T-P6-02；DES/07 §2.4、REQ §2.3 sequence-runs 行）。
// 写操作 → auth:'write'。域判定全归 modules/sequences/start.ts（群前置/预检/互斥/快照同事务）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { startSequenceRun } from '../../modules/sequences/start.js';

export async function registerSequenceRunRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post('/api/groups/:id/sequence-runs', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { runId } = await startSequenceRun(deps.pool, id, request.body);
    return reply.status(201).send({ runId });
  });
}
