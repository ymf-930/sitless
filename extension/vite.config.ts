import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// popup 由 Vite 构建；service worker 单独用 esbuild 打成单文件（MV3 不允许拆 chunk）。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: 'popup.html' },
    },
  },
});
