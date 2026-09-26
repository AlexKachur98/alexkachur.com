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

// Beside the form, the answer the page opens with gives way to the first question, and the pane
// keeps the example's height so nothing below it moves.
test('takes the example answer away as the first chip runs, keeping its height', async ({ page }) => {
  const example = page.locator('[data-ask-example]');
  const height = await example.evaluate((element) => element.getBoundingClientRect().height);
  await page.locator('[data-ask] .chip').first().click();
  await expect(example).toHaveCount(0);
  const held = await page.locator('[data-ask-panel]').evaluate((element) => element.style.getPropertyValue('--example-height'));
  expect(Math.abs(parseFloat(held) - height)).toBeLessThan(2);
});

// Beside the form, with a mouse and a tall enough window, a long answer scrolls inside its box:
// each answer starts at its first row, and the box says it scrolls only while it does.
test('starts each answer at its first row, and says so while the box scrolls', async ({ page }) => {
  const rows = (n: number) => `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT x FROM c`;
  let next = rows(40);
  await page.route('**/api/ask', async (route) => json(200, { sql: next, explanation: 'Some rows.', cached: false })(route));
  const results = page.locator('[data-ask-results]');
  const cue = page.locator('[data-ask-scroll-cue]');
  await ask(page, 'Forty rows, please');
  await expect(results.locator('tbody tr')).toHaveCount(40);
  await expect(cue).toBeVisible();
  await results.evaluate((element) => element.scrollTo(0, 300));
  await ask(page, 'Forty more rows, please');
  await expect(page.locator('[data-ask-question]')).toHaveText('Forty more rows, please');
  await expect(results.locator('tbody tr')).toHaveCount(40);
  expect(await results.evaluate((element) => element.scrollTop)).toBe(0);
  next = rows(1);
  await ask(page, 'Just one row');
  await expect(results.locator('tbody tr')).toHaveCount(1);
  await expect(cue).toBeHidden();
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

test('runs the SQL /api/ask returns, shows the sentence with it, and edits it in the console', async ({ page }) => {
  await page.route('**/api/ask', json(200, { sql: 'SELECT 1 AS n', explanation: 'One row with the number one.', cached: false }));
  await ask(page, 'Give me one row');
  await expect(page.locator('[data-ask-explanation]')).toHaveText('One row with the number one.');
  await expect(page.locator('[data-ask-sql]')).toHaveText('SELECT 1 AS n');
  await expect(page.locator('[data-ask-results] tbody tr')).toHaveCount(1);
  await page.locator('[data-ask-panel] > [data-ask-edit]').click();
  await expect(page.locator('[data-console-input]')).toHaveValue('SELECT 1 AS n');
  await expect(page.locator('[data-console-clear]')).toBeVisible();
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
  // Nothing is sent until the button is clicked.
  expect(sent).toEqual([]);
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
