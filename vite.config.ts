import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 产物目录故意不叫 dist：
  // 发布时上传会跳过「构建产物目录」（dist/build/out 之类），
  // 而本应用是「Express 直接托管前端产物」的单端口服务，产物必须跟着源码一起上传。
  build: {
    outDir: 'web',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  }
});
