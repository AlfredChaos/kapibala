// 时间线端点（T-P2-11）：GET /api/groups/:id/messages?before=<cursor>&limit=<n>。
// 权限矩阵：GET 只读 → auth:'required'（viewer 可读，与 GET /api/accounts 同档）。
// 判定/错误码全部归 modules/messages/timeline.ts（GROUP_NOT_FOUND / VALIDATION_ERROR 由此抛出，
// errors.ts 统一映射）；本文件只做 querystring → 模块入参的装配。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { listTimeline } from '../../modules/messages/timeline.js';
import { listMessageActivity } from '../../modules/messages/activity.js';
import { AppError } from '../plugins/errors.js';

export async function registerMessageRoutes(app: App, deps: RouteDeps): Promise<void> {
  // dashboard「近 30 分钟」柱图：整库分钟桶一次聚合，替代前端逐群拉全量
  app.get('/api/messages/activity', { config: { auth: 'required' } }, async (request) => {
    const q = request.query as Record<string, unknown>;
    let buckets: number | undefined;
    if (q['buckets'] !== undefined) {
      const n = Number(q['buckets']);
      if (!Number.isInteger(n)) throw new AppError('VALIDATION_ERROR', 'buckets must be an integer');
      buckets = n;
    }
    let bucketMs: number | undefined;
    if (q['bucketMs'] !== undefined) {
      const n = Number(q['bucketMs']);
      if (!Number.isInteger(n)) throw new AppError('VALIDATION_ERROR', 'bucketMs must be an integer');
      bucketMs = n;
    }
    return listMessageActivity({ pool: deps.pool }, { buckets, bucketMs });
  });

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
