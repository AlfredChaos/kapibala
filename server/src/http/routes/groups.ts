// POST /api/groups 受理路由（T-P3-05；DES/04 §2.1、REQ §2.3 群行）。
// 写操作 → auth:'write'（viewer 403）。受理成功即异步唤醒执行器（fire-and-forget，
// 日志记录启动失败；恢复器兜底重启 running job——outbox 语义在 job 表）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { acceptCreateGroup, runCreateGroupJob } from '../../modules/groups/create-job.js';

export async function registerGroupRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post('/api/groups', { config: { auth: 'write' } }, async (request, reply) => {
    const { jobId } = await acceptCreateGroup(deps.pool, request.body);
    // 受理后立即启动执行器（不 await——202 先于建群返回；崩溃窗口由恢复扫描接管）
    void runCreateGroupJob({ pool: deps.pool, gateway: deps.gateway, logger: request.log }, jobId).catch(
      (err: unknown) => {
        request.log.error({ err, jobId }, 'create-group executor failed; recovery scan will resume');
      },
    );
    return reply.status(202).send({ jobId });
  });
}
