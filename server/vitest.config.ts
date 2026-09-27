import { defineConfig } from 'vitest/config';

// server 测试连真实 PostgreSQL（根 AGENTS.md §4：API / SSE / 调度行为不 mock DB）；
// 测试库隔离基建（模板库 + 随机后缀）归 T-P0-04 落地。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // 默认 testTimeout 5000 在全套件并行负载下对「等 DB/SSE/socket 收敛」的时序断言过紧
    // （全绿基线上随机 5s 超时 flake，单跑即过）；放宽至 20s——契约计时断言（如 ≤3s 补发）
    // 在断言行内自有限额，不受此放宽稀释。
    testTimeout: 20000,
    // 每文件独立测试库 + mock 进程内装配 + 崩溃子进程：全核并行会在重负载下随机饿死
    // DB 连接 / port bind / SSE 收敛（绿色基线上随机落 flake，单跑必过）。限 4 worker 换
    // 稳定全绿；隔离性不因并发度损失。
    maxWorkers: 4,
  },
});
