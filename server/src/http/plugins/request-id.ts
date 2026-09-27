// requestId 横切（DES/01 §6.2）：透传 X-Request-ID，无则生成 uuid v4。
// 挂到 request.id（fastify/pino 的日志序列化自动携带）并回写响应头，供前端与运维对账。
// 以「直接作用于实例的函数」而非 register 插件形态实现：横切钩子必须落在根上下文，
// 否则 fastify 的封装作用域会让兄弟插件里注册的路由（routes/index.ts）拿不到这些钩子。
import { randomUUID } from 'node:crypto';
import type { App } from '../app.js';

export async function applyRequestId(app: App): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = typeof value === 'string' && value.trim() !== '' ? value : randomUUID();
    request.id = requestId;
    reply.header('x-request-id', requestId);
  });
}
