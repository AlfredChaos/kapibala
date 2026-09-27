// GET /media/:id 存根（T-P1-04）：恒 404，真实媒体行为（含过期 404 与内容）归 gw-27/C1 任务。
import type { FastifyInstance } from 'fastify';

export function registerMediaRoutes(app: FastifyInstance): void {
  app.get('/media/:mediaId', async (_request, reply) => reply.code(404).send({ message: 'media not available yet' }));
}
