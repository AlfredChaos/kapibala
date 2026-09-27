// 可执行入口（DES/14 §1：单进程、内存状态；默认实例 :4100，AGENTS.md 端口约定）。
import { createGatewayApp } from './app.js';

const PORT = Number(process.env.PORT ?? 4100);

const app = createGatewayApp({ logger: true });

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'mock-gateway failed to start');
  process.exit(1);
}
