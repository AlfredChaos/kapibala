import { defineConfig } from 'vitest/config';

// 前端只写单元（纯函数）与组件/集成层测试（根 AGENTS.md §4，不测视觉样式）。
// 组件测试所需的 DOM environment（jsdom/happy-dom）随 T-P5 前端任务一并引入。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
  },
});
