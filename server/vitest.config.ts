import { defineConfig } from 'vitest/config';

// server 测试连真实 PostgreSQL（根 AGENTS.md §4：API / SSE / 调度行为不 mock DB）；
// 测试库隔离基建（模板库 + 随机后缀）归 T-P0-04 落地。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
