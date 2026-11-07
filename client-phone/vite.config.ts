import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({
  root: path.resolve(__dirname),
  base: '/',
  resolve: { alias: { '@pr/shared': path.resolve(__dirname, '../shared/src') } },
  build: { outDir: path.resolve(__dirname, '../dist/client-phone'), emptyOutDir: true, target: 'es2019', chunkSizeWarningLimit: 1500 },
  server: { fs: { allow: ['..'] } },
});
