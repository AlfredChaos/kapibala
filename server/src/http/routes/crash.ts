// 崩溃注入控制端点（T-P7-01）：`POST /_test/crash { name, hit? }` 运行时 arm。
// 仅在 `CRASH_CONTROL=1` 环境时注册（子进程测试装配置位）——生产路径零入口。
import type { App } from '../app.js';
import { armCrashPoint, crashControlEnabled } from '../../crash.js';

export async function registerCrashControlRoute(app: App): Promise<void> {
  if (!crashControlEnabled()) return;
  app.post('/_test/crash', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = body['name'];
    if (typeof name !== 'string' || name === '') {
      return reply.code(400).send({ message: 'name is required' });
    }
    const hit = body['hit'];
    const n = typeof hit === 'number' && Number.isInteger(hit) && hit > 0 ? hit : 1;
    armCrashPoint(name, n);
    return reply.send({ armed: name, hit: n });
  });
}
