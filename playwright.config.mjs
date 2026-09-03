import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 0,
  actionTimeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    channel: process.env.WANXIANG_E2E_BROWSER_CHANNEL || 'chrome',
    headless: true,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
});
