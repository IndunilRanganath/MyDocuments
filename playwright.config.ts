import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'ui.spec.ts', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', viewport: { width: 375, height: 812 }, browserName: 'chromium', ...(process.env.MYDOCUMENTS_CHROME_PATH ? { launchOptions: { executablePath: process.env.MYDOCUMENTS_CHROME_PATH } } : {}) },
  webServer: { command: 'npm run dev -- --hostname 127.0.0.1', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI, timeout: 120000 },
});
