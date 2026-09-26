import { defineConfig, devices } from '@playwright/test';

// Browser tests of what the pages do once a visitor interacts, against the built site. Run
// npm run build first; npm test does.
export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: 'http://127.0.0.1:4322' },
  webServer: {
    command: 'node tests/e2e/serve.ts',
    url: 'http://127.0.0.1:4322/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
