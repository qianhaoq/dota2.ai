import { defineConfig } from '@playwright/test';

/**
 * PR7 e2e: evidence sheet (390) + panel (1280), visual baselines, axe,
 * keyboard/focus and screen-digit assertions against the fixture review.
 * The webServer builds the app and serves it with the zero-outbound mock
 * (scripts/mock-review-server.mjs) — match 9035042364, hero pudge.
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
