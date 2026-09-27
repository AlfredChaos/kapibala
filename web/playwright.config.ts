// Playwright C3 冒烟配置（T-P8-03；REQ C3 逐字「一条 Playwright 测试」+ DES/15 §6 获准例外）。
// webServer 数组拉起全栈：① server/tests/e2e/backend.ts（tsx 直跑：真 PG 模板库 +
// mock-gateway + mock-agent + boot() 固定 :3000——vite.config.ts 代理逐字目标；
// 数据装配完写 tests/e2e/.e2e-state.json stage=ready）② vite dev :5173 --host 127.0.0.1。
// 注意：本文件在每个 worker 进程里会再求值一次——任何顶层副作用（删 state 文件等）
// 会在测试跑一半时误删本轮文件；状态文件生命周期由 backend 自理（启动即删旧、ready 最后写）。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000, // 全栈装配（建群+agent run 首步）在并行测试负载下可拖到分钟级——契约只要求可重复，不计时
  retries: 0,
  workers: 1, // 单条用例 + 固定端口，无并行意义
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: '../node_modules/.bin/tsx ../server/tests/e2e/backend.ts 2>&1 | tee tests/e2e/.e2e-backend.log',
      url: 'http://127.0.0.1:3000/api/health',
      timeout: 240_000,
      reuseExistingServer: false, // 可重复运行（卡片 a）：每次全新库+新进程
    },
    {
      command: '../node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
