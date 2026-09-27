// 可执行入口（DES/12 §5：单包双 provider；scripted 默认实例 :4200，anthropic C2 实例 :4300 按需另起）。
import { createAgentApp } from './app.js';

const PORT = Number(process.env.PORT ?? 4200);

try {
  // 装配在 listen 之前：AGENT_MODE/ANTHROPIC_API_KEY 未配置在起服前就炸（DES/12 §6）
  const app = createAgentApp({ logger: true });
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  console.error({ err }, 'mock-agent failed to start');
  process.exit(1);
}
