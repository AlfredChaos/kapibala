// Playwright C3 冒烟配置（T-P8-03；REQ C3 逐字「一条 Playwright 测试」+ DES/15 §6 获准例外）。
// webServer 数组拉起全栈：① scripts/e2e/backend.ts（真 PG 模板库 + mock-gateway +
// mock-agent + boot() 固定 :3000——vite.config.ts 代理逐字目标；装配数据后打 E2E_READY）
// ② vite dev :5173（/api、/ws 同源代理到 :3000，零 CORS/WS origin 适配）。
import { defineConfig, devices } from '@playwright/test';
// 注意：本文件也会在 worker 进程里再求值一次——状态文件清理不能放顶层
//（worker 启动晚于 backend 写盘，顶层 rmSync 会在测试跑一半时把 state 删了）。
// 清理挪到 globalSetup：主进程一次、在 webServer 拉起之后/测试执行之前。

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000, // 全栈装配在并行测试负载下可拖到分钟级（契约只要求可重复，不计时） // 全栈装配（建群+run 终态）可能耗数十秒——一次给足
  retries: 0,
  workers: 1, // 单条用例 + 固定端口，无并行意义
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './tests/e2e/global-setup.ts',
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
