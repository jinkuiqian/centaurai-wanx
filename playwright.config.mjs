import { defineConfig } from '@playwright/test';

const browserChannel = process.env.WANXIANG_E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 3_600_000,
  actionTimeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
});
