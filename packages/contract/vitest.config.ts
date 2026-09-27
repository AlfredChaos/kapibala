import { defineConfig } from 'vitest/config';

// contract：纯类型包（无 DB / 网络依赖）；include 限定 src 源码内测试，
// 避免误执行 dist/ 下的编译副本（T-P0-02 review 发现）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
