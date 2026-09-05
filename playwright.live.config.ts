import { defineConfig, devices } from '@playwright/test';

/**
 * Live-server specs (real Bun server + real pi SDK session pool). They share
 * one global active session, so they must never run concurrently with each
 * other or with the mocked per-file-parallel suite — hence this dedicated
 * workers:1 config. Run via `bun run test:e2e` (chained after the main
 * config) or alone via `bun run test:e2e:live`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /live-(agent|widget)\.spec\.ts$/,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: process.env.CI ? 'on-first-retry' : 'off',
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'bun e2e/fake-llm.ts',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command:
        'mkdir -p /tmp/pi-ui-e2e-workspace /tmp/pi-ui-e2e-agent && bun scripts/maybe-build.ts && PI_PASSWORD=test-password PI_UI_JWT_SECRET=test-e2e-jwt-secret-0123456789abcdef PI_CODING_AGENT_DIR=/tmp/pi-ui-e2e-agent PI_CWD=/tmp/pi-ui-e2e-workspace PORT=3000 bun run start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '.',
    },
  ],
});
