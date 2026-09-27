// 操作员 send 端点（T-P3-01）：POST /api/groups/:id/send → 202 {clientMsgId}。
// 权限矩阵：写操作 → auth:'write'（viewer 403）。入参/判序/错误码全部归
// modules/messages/accept.ts；本文件只做 JSON body 装配与 AppError 透传。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { acceptOperatorMessage } from '../../modules/messages/accept.js';
import { AppError } from '../plugins/errors.js';

export async function registerGroupsSendRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post('/api/groups/:id/send', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const accountId = body['accountId'];
    const text = body['text'];
    if (typeof accountId !== 'string' || accountId === '') {
      throw new AppError('VALIDATION_ERROR', 'accountId is required');
    }
    if (typeof text !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'text must be a string');
    }
    const { clientMsgId } = await acceptOperatorMessage({ pool: deps.pool }, id, {
      accountId,
      text,
    });
    // 202：受理即落库（先持久化后返回，DES/05 §2.3-1）
    return reply.status(202).send({ clientMsgId });
  });
}
