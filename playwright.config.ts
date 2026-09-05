import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // File-level parallelism (fullyParallel stays false). Mock-WS specs are
  // page-isolated and never touch the server's WS; the live trio is excluded
  // below and runs serialized via playwright.live.config.ts.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? 'github' : 'list',
  // Live-server specs share one global active session — excluded here, run
  // serially through playwright.live.config.ts (`bun run test:e2e` chains it).
  testIgnore: ['e2e/live-agent.spec.ts', 'e2e/live-widget.spec.ts'],
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
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    {
      // Local OpenAI-compatible stub — the real SDK completes turns against
      // this instead of a paid provider. See e2e/fake-llm.ts.
      command: 'bun e2e/fake-llm.ts',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // PI_UI_JWT_SECRET is shared with e2e/visual-review.spec.ts, which
      // generates a session token in a separate process (the default random
      // per-process secret would reject it).
      // PI_CODING_AGENT_DIR / PI_CWD point at per-run scratch dirs built by
      // e2e/global-setup.ts: a fake-model-only agent dir (no leftover
      // sessions) and an empty working dir (no trust gate, no project
      // extensions). Live-agent specs never touch real ~/.pi state.
      command:
        'mkdir -p /tmp/pi-ui-e2e-workspace /tmp/pi-ui-e2e-agent && bun scripts/maybe-build.ts && PI_PASSWORD=test-password PI_UI_JWT_SECRET=test-e2e-jwt-secret-0123456789abcdef PI_CODING_AGENT_DIR=/tmp/pi-ui-e2e-agent PI_CWD=/tmp/pi-ui-e2e-workspace PORT=3000 bun run start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '.',
    },
  ],
});
