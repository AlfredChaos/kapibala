import { defineConfig } from 'vitest/config';

// mock-agent：scripted provider 是确定性剧本引擎，测试无需 DB / 网络真实依赖（DES/12 §6）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
