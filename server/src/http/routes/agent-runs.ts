// agent-runs 查询路由（T-P4-13；REQ §2.3 两行）。读路径 → auth:'required'（viewer 可读）。
// 404 设计自定码 AGENT_RUN_NOT_FOUND（同 JOB_NOT_FOUND 先例，DES/04 §7）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { AppError } from '../plugins/errors.js';
import { fetchAgentRun, listAgentRuns } from '../../modules/agent/query.js';

export async function registerAgentRunRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get('/api/agent-runs/:id', { config: { auth: 'required' } }, async (request) => {
    const { id } = request.params as { id: string };
    const run = await fetchAgentRun(deps.pool, id);
    if (run === undefined) {
      throw new AppError('AGENT_RUN_NOT_FOUND', `unknown agent run: ${id}`, { statusCode: 404 });
    }
    return run;
  });

  app.get('/api/groups/:id/agent-runs', { config: { auth: 'required' } }, async (request) => {
    const { id } = request.params as { id: string };
    return listAgentRuns(deps.pool, id);
  });
}
