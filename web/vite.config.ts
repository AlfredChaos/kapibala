import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期同源代理到 server(:3000)：REST 走 /api，WS 走 /ws，
// 避免浏览器跨源（CORS / WS origin 校验）问题——DES/15 §1「fetch 封装 + 同源」的前置。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
