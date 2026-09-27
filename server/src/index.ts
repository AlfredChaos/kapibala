import Fastify from 'fastify';

// 占位入口（T-P0-01）：仅保证 dev 骨架可启动（根 AGENTS.md §1 `pnpm dev` 的一半）。
// db 基建、requestId/统一错误映射、启动版本门与 /api/health 归 T-P0-04 届时重写本文件。
const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'server failed to start');
  process.exit(1);
}
