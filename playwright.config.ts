import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/playwright',
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:3098',
    headless: true,
  },
  // Start the Express server before tests, stop after
  webServer: {
    command: 'IMAGE_PROVIDER=stub PORT=3098 LOG_LEVEL=warn npx tsx src/server.ts',
    port: 3098,
    timeout: 15000,
    reuseExistingServer: false,
  },
});
