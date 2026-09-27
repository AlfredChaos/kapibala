// GET /api/jobs/:jobId（T-P3-05；DES/04 §7 逐字：{status, errors:[{step,code}]}；
// 404 JOB_NOT_FOUND 为设计自定码）。读路径 → auth:'required'（viewer 可读）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { AppError } from '../plugins/errors.js';

interface JobQueryRow {
  status: string;
  errors: unknown;
}

export async function registerJobRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get('/api/jobs/:jobId', { config: { auth: 'required' } }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    const { rows } = await deps.pool.query<JobQueryRow>(
      'SELECT status, errors FROM job WHERE id = $1',
      [jobId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AppError('JOB_NOT_FOUND', `unknown job: ${jobId}`);
    }
    return { status: row.status, errors: row.errors };
  });
}
