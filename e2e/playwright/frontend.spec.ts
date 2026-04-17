/**
 * Playwright frontend tests — verifies the web UI end-to-end.
 *
 * Runs against the Express server in stub mode (no real API calls).
 * Tests: page load, brief selection, pipeline execution, result display.
 */

import { test, expect } from '@playwright/test';

test.describe('Creative Pipeline Frontend', () => {
  test('page loads with title and controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Creative Pipeline');
    await expect(page.locator('#brief-select')).toBeVisible();
    await expect(page.locator('#run-btn')).toBeVisible();
    await expect(page.locator('#run-btn')).toHaveText('Run Pipeline');
  });

  test('brief selector shows available briefs', async ({ page }) => {
    await page.goto('/');
    // Wait for briefs to load via fetch
    await page.waitForFunction(() => {
      const sel = document.getElementById('brief-select') as HTMLSelectElement;
      return sel && sel.options.length > 0 && sel.options[0].value !== '';
    });

    const options = await page.locator('#brief-select option').allTextContents();
    expect(options).toContain('example.yaml');
    expect(options).toContain('example-ja.yaml');
  });

  test('run pipeline and display results', async ({ page }) => {
    await page.goto('/');

    // Wait for briefs to load
    await page.waitForFunction(() => {
      const sel = document.getElementById('brief-select') as HTMLSelectElement;
      return sel && sel.options.length > 0 && sel.options[0].value !== '';
    });

    // Select brief and run
    await page.selectOption('#brief-select', 'briefs/example.yaml');
    await page.click('#run-btn');

    // Status should show queued/running
    await expect(page.locator('#status')).toBeVisible();

    // Wait for completion (stub mode ~2-3s)
    await page.waitForFunction(() => document.getElementById('status')?.classList.contains('completed'), {
      timeout: 30000,
    });

    // Results should be visible
    await expect(page.locator('#results')).toBeVisible();

    // Cost summary should show stats
    await expect(page.locator('#cost-summary')).toContainText('Total cost');
    await expect(page.locator('#cost-summary')).toContainText('Products');

    // Creative grid should have 6 cards (2 products × 3 ratios)
    const cards = page.locator('.card');
    await expect(cards).toHaveCount(6);

    // Each card should have an image and product name
    const firstCardImg = cards.first().locator('img');
    await expect(firstCardImg).toBeVisible();

    // Cards should show brand/legal badges
    const badges = page.locator('.badge');
    expect(await badges.count()).toBeGreaterThanOrEqual(6);

    // Run button should be re-enabled
    await expect(page.locator('#run-btn')).toHaveText('Run Pipeline');
    await expect(page.locator('#run-btn')).toBeEnabled();
  });

  test('past runs list updates after pipeline run', async ({ page }) => {
    await page.goto('/');

    // Run a pipeline first
    await page.waitForFunction(() => {
      const sel = document.getElementById('brief-select') as HTMLSelectElement;
      return sel && sel.options.length > 0 && sel.options[0].value !== '';
    });
    await page.click('#run-btn');
    await page.waitForFunction(() => document.getElementById('status')?.classList.contains('completed'), {
      timeout: 30000,
    });

    // Past runs list should have at least one entry
    const runItems = page.locator('#runs-list li');
    expect(await runItems.count()).toBeGreaterThan(0);

    // Clicking a past run should display its results
    await runItems.first().click();
    await expect(page.locator('#results')).toBeVisible();
  });
});
