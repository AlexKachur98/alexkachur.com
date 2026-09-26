import { expect, test } from '@playwright/test';

// What every page does: the theme toggle, and the live values from /api/stats.

const stats = { questionsThisMonth: 12, modelCallsThisMonth: 500, cap: 2000, model: 'claude-haiku-4-5', commit: 'abc1234', builtAt: '2026-09-25T12:00:00.000Z' };

test('switches to the other theme and keeps it after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/uses');
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Back to light, which the system already prefers, so the choice is forgotten.
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});

test('adds the month so far to the footer, and names the model on the write-up', async ({ page }) => {
  await page.route('**/api/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stats) }));
  await page.goto('/how-this-site-works');
  await expect(page.locator('[data-readouts]')).toContainText('12 questions this month · AI budget 25% used');
  await expect(page.locator('[data-model]')).toHaveText('claude-haiku-4-5');
  await expect(page.locator('[data-model-line]')).toBeVisible();
});

test('leaves the footer as built when /api/stats fails', async ({ page }) => {
  await page.route('**/api/stats', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"reason":"upstream"}' }));
  await page.goto('/uses');
  const built = await page.locator('[data-readouts]').textContent();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-readouts]')).toHaveText(built!);
});
