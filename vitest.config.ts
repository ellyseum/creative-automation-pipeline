/**
 * Vitest configuration — test runner setup for the creative pipeline.
 *
 * Test tiers:
 *   npm test           — unit + CLI E2E (fast, no server, no Docker)
 *   npm run test:api   — API E2E (starts Express server)
 *   npm run test:all   — everything including Playwright
 *
 * Playwright tests have their own config (playwright.config.ts) and
 * are NOT run by vitest — they use @playwright/test runner.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Include all vitest test files (unit, integration, e2e)
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],

    // Exclude Playwright tests (they use @playwright/test runner, not vitest)
    exclude: ['e2e/playwright/**', 'node_modules/**'],

    // Timeouts — CLI E2E needs more time for stub pipeline
    testTimeout: 30000,

    // Reporter — show test names for audit trail
    reporters: ['verbose'],
  },
});
