import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1', port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)), emptyOutDir: true },
});
