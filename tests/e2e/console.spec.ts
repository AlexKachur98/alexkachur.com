import { expect, test } from '@playwright/test';

// The raw console on the home page: sql.js in a worker, over the database the page was built with.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('runs a query on Ctrl+Enter and shows its rows', async ({ page }) => {
  const input = page.locator('[data-console-input]');
  await input.fill('SELECT 1 AS n UNION ALL SELECT 2');
  await input.press('Control+Enter');
  await expect(page.locator('[data-console-results] tbody tr')).toHaveCount(2);
  await expect(page.locator('[data-console-status]')).toContainText('2 rows');
});

test('says No rows with the rest of the sentence under the results, and drops it on the next run', async ({ page }) => {
  const input = page.locator('[data-console-input]');
  const note = page.locator('[data-console-results] .console-empty');
  await input.fill('SELECT name FROM pets WHERE 0');
  await page.locator('[data-console-run]').click();
  await expect(page.locator('[data-console-status]')).toContainText('No rows');
  await expect(note).toHaveText('The query ran; the data just does not have that.');
  await input.fill('SELECT 1 AS n');
  await page.locator('[data-console-run]').click();
  await expect(page.locator('[data-console-status]')).toContainText('1 row');
  await expect(note).toHaveCount(0);
});

test("shows SQLite's error for a query it rejects, and the guard's sentence for a write", async ({ page }) => {
  const input = page.locator('[data-console-input]');
  const error = page.locator('[data-console-error]');
  await input.fill('SELECT nope FROM pets');
  await page.locator('[data-console-run]').click();
  await expect(error).toContainText('no such column: nope');
  await input.fill('DELETE FROM pets');
  await page.locator('[data-console-run]').click();
  await expect(error).toHaveText('Read-only console: SELECT, WITH and EXPLAIN only.');
});

test('offers Clear only when there is something to clear, and clears it back to the editor', async ({ page }) => {
  const input = page.locator('[data-console-input]');
  const clear = page.locator('[data-console-clear]');
  await expect(clear).toBeHidden();
  await input.fill('SELECT 1 AS n');
  await expect(clear).toBeVisible();
  await page.locator('[data-console-run]').click();
  await expect(page.locator('[data-console-results] tbody tr')).toHaveCount(1);
  await clear.click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.locator('[data-console-results]')).toBeEmpty();
  await expect(clear).toBeHidden();
});

test('loads an example into the editor and runs it', async ({ page }) => {
  const example = page.locator('[data-examples] [data-sql]').first();
  const sql = await example.getAttribute('data-sql');
  await example.click();
  await expect(page.locator('[data-console-input]')).toHaveValue(sql!);
  await expect(page.locator('[data-console-results] tbody tr').first()).toBeVisible();
});
