// GET /api/sequence-runs/:id（T-P6-05；REQ §2.3）。读路径 → auth:'required'。
// 404 设计自定码 SEQUENCE_RUN_NOT_FOUND（同 AGENT_RUN_NOT_FOUND/JOB_NOT_FOUND 先例）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { AppError } from '../plugins/errors.js';
import { fetchSequenceRun } from '../../modules/sequences/query.js';

export async function registerSequenceRunQueryRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get('/api/sequence-runs/:id', { config: { auth: 'required' } }, async (request) => {
    const { id } = request.params as { id: string };
    const run = await fetchSequenceRun(deps.pool, id);
    if (run === undefined) {
      throw new AppError('SEQUENCE_RUN_NOT_FOUND', `unknown sequence run: ${id}`, { statusCode: 404 });
    }
    return run;
  });
}
