import { defineConfig } from '@playwright/test';

const port = Number(process.env.UI_TEST_PORT ?? 3102);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('UI_TEST_PORT must be a valid TCP port.');
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: origin, headless: true },
  webServer: {
    command: process.env.ENGLISH_UI_CANDIDATE_DIR ? 'node tests\\browser\\candidate-server.js' : 'node server.js',
    env: { APP_MODE: 'mock', PORT: String(port) },
    url: `${origin}/api/health`,
    reuseExistingServer: false
  }
});
