import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:3101', headless: true },
  webServer: {
    command: 'node server.js',
    env: { APP_MODE: 'mock', PORT: '3101' },
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false
  }
});
