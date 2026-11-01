import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Isolated stack for e2e: its own API server (temp DB) + Vite; reuses the TradingView sidecar on :8787.
const db = path.join(os.tmpdir(), `tvre-e2e-${process.pid}.sqlite3`);
const venv = path.resolve(here, '../../csi500_enhance/.venv/bin/python');
const py = process.env.TVRE_PYTHON ?? (fs.existsSync(venv) ? venv : 'python3');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'chrome', viewport: { width: 1500, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    {
      command: `"${py}" -m uvicorn --factory tvre.app:create_app --host 127.0.0.1 --port 8100`,
      cwd: path.resolve(here, '../server'),
      env: { TVRE_DB: db, TVRE_ALERT_INTERVAL: '3600' },
      url: 'http://127.0.0.1:8100/api/health', reuseExistingServer: false, timeout: 60_000,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5174 --strictPort',
      env: { TVRE_API: 'http://127.0.0.1:8100' },
      url: 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 60_000,
    },
  ],
});
