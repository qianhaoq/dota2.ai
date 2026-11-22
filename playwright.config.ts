import { defineConfig } from '@playwright/test';

/**
 * e2e at 390 and 1280 wide: the home page, the match page's journey from no
 * replay to a review, evidence records, the chat, the next-game goal, axe and
 * keyboard. The webServer builds the app and serves it with the zero-outbound
 * fixture server (scripts/mock-review-server.mjs): the real agent over the
 * trace of match 9100904020, with a scripted model (scripts/mock-agent.mjs).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  fullyParallel: false,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-390',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'desktop-1280',
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run build && node scripts/mock-review-server.mjs',
    url: 'http://localhost:4180/api/health',
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
  },
});
