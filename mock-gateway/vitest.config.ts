import { defineConfig } from 'vitest/config';

// mock-gateway：无 DB、无外部依赖（DES/14 §6），测试为纯进程内断言。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
