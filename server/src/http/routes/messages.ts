// 时间线端点（T-P2-11）：GET /api/groups/:id/messages?before=<cursor>&limit=<n>。
// 权限矩阵：GET 只读 → auth:'required'（viewer 可读，与 GET /api/accounts 同档）。
// 判定/错误码全部归 modules/messages/timeline.ts（GROUP_NOT_FOUND / VALIDATION_ERROR 由此抛出，
// errors.ts 统一映射）；本文件只做 querystring → 模块入参的装配。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { listTimeline } from '../../modules/messages/timeline.js';
import { AppError } from '../plugins/errors.js';

export async function registerMessageRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get('/api/groups/:id/messages', { config: { auth: 'required' } }, async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as Record<string, unknown>;
    const before = typeof q['before'] === 'string' && q['before'] !== '' ? q['before'] : undefined;
    let limit: number | undefined;
    if (q['limit'] !== undefined) {
      const n = Number(q['limit']);
      if (!Number.isFinite(n)) {
        throw new AppError('VALIDATION_ERROR', 'limit must be a number');
      }
      limit = n;
    }
    return listTimeline({ pool: deps.pool }, id, { before, limit });
  });
}
