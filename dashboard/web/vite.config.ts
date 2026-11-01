import { defineConfig } from 'vite';

const API = process.env.TVRE_API ?? 'http://127.0.0.1:8000';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': { target: API, changeOrigin: true } } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
} as never);
