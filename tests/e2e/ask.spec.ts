import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// The Ask box on the home page. Its chips run their SQL in the browser; a typed question goes to
// /api/ask, which each test answers itself.

const json = (status: number, body: unknown) => (route: Route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function ask(page: Page, question: string): Promise<void> {
  await page.locator('[data-ask-input]').fill(question);
  await page.locator('[data-ask-input]').press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('answers a chip from the built database without a request to the model', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/ask')) asked.push(request.url());
  });
  await page.locator('[data-ask] .chip').first().click();
  await expect(page.locator('[data-ask-results] tbody tr').first()).toBeVisible();
  expect(asked).toEqual([]);
});

test("shows the storage chip's line to the full details under its answer", async ({ page }) => {
  await page.locator('[data-ask] .chip[data-more]').click();
  await expect(page.locator('[data-ask-results] tbody tr').first()).toBeVisible();
  await expect(page.locator('[data-ask-more]')).toBeVisible();
  await expect(page.locator('[data-ask-more] a')).toHaveAttribute('href', '/api#what-is-stored');
});

test('clears the question field on Escape and with its control, keeping focus in the field', async ({ page }) => {
  const input = page.locator('[data-ask-input]');
  const clear = page.locator('[data-ask-clear]');
  await input.fill('What has Alex built?');
  await expect(clear).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(clear).toBeHidden();
  await expect(input).toBeFocused();
  await input.fill('Where is Alex?');
  await clear.click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
});

test('runs the SQL /api/ask returns and shows the sentence with it', async ({ page }) => {
  await page.route('**/api/ask', json(200, { sql: 'SELECT 1 AS n', explanation: 'One row with the number one.', cached: false }));
  await ask(page, 'Give me one row');
  await expect(page.locator('[data-ask-explanation]')).toHaveText('One row with the number one.');
  await expect(page.locator('[data-ask-sql]')).toHaveText('SELECT 1 AS n');
  await expect(page.locator('[data-ask-results] tbody tr')).toHaveCount(1);
});

test('offers to send a question the site could not answer, posts it with its token, and says thanks', async ({ page }) => {
  await page.route('**/api/ask', json(200, { sql: '', explanation: 'The database holds no salary data.', cached: false, token: 'a-token' }));
  const sent: unknown[] = [];
  await page.route('**/api/questions', async (route) => {
    sent.push(route.request().postDataJSON());
    await json(200, { sent: true })(route);
  });
  await ask(page, 'What salary does Alex want?');
  await expect(page.locator('[data-ask-explanation]')).toHaveText('The database holds no salary data.');
  await page.locator('[data-ask-send]').click();
  await expect(page.locator('[data-ask-sent]')).toBeVisible();
  await expect(page.locator('[data-ask-sent]')).toBeFocused();
  expect(sent).toEqual([{ question: 'What salary does Alex want?', token: 'a-token' }]);
});

test('says the month is used up and lists the examples when the cap is reached', async ({ page }) => {
  await page.route('**/api/ask', json(503, { reason: 'budget' }));
  await ask(page, 'What has Alex built?');
  await expect(page.locator('[data-ask-error]')).toContainText('The AI budget for this month is used up.');
  await expect(page.locator('[data-ask-fallback]')).toBeVisible();
});

test("puts the example answer's SQL in the console with Edit this query", async ({ page }) => {
  const edit = page.locator('[data-ask-example] [data-ask-edit]');
  const sql = await edit.getAttribute('data-sql');
  await edit.click();
  await expect(page.locator('[data-console-input]')).toHaveValue(sql!);
});
