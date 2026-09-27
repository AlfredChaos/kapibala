// POST /api/groups/:id/leave-all 路由（T-P3-07；DES/04 §3.2 INIT、REQ §2.3 leave-all 行）。
// 写操作 → auth:'write'（viewer 403）；群缺失 404 GROUP_NOT_FOUND、已 left 409 ILLEGAL_TRANSITION。
// 受理成功即异步唤醒执行器（fire-and-forget；崩溃窗口由恢复扫描「jobs」接管——同一入口）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { acceptLeaveAll, runLeaveAllJob } from '../../modules/groups/leave-all.js';

export async function registerLeaveAllRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post('/api/groups/:id/leave-all', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { jobId } = await acceptLeaveAll(deps.pool, id);
    void runLeaveAllJob({ pool: deps.pool, gateway: deps.gateway, logger: request.log }, jobId).catch(
      (err: unknown) => {
        request.log.error({ err, jobId }, 'leave-all executor failed; recovery scan will resume');
      },
    );
    return reply.status(202).send({ jobId });
  });
}
