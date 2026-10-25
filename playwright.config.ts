import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:5184', viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'corepack pnpm dev --host 127.0.0.1 --port 5184', url: 'http://127.0.0.1:5184', reuseExistingServer: false },
});
