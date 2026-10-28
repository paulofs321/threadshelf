import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium, expect } from '@playwright/test';

const server = await preview({
  configFile: 'vite.demo.config.ts',
  preview: { host: '127.0.0.1', port: 0 },
});
const address = server.httpServer.address();

if (!address || typeof address === 'string') throw new Error('Missing demo preview address.');

const origin = `http://127.0.0.1:${address.port}`;
let browser;

try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext();
  const unexpected = [];
  const errors = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      unexpected.push('external request');

      return route.abort();
    }

    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('page error'));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console error');
  });
  await page.goto(`${origin}${process.env.DEMO_BASE ?? '/'}`);
  const query = page.getByRole('searchbox', { name: 'Search conversations' });
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(
    page.getByText('Fictional demo · no live provider connection', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
  await query.fill('floating library');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(3);
  await expect(results.getByRole('link')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Google AI Mode' }).click();
  await expect(results.getByRole('article')).toHaveCount(2);
  await page.getByRole('tab', { name: 'All sources' }).click();
  await page.getByRole('button', { name: 'Search settings' }).click();
  await page.getByLabel('Search mode', { exact: true }).selectOption('description');
  await query.fill('Where did I discuss login security?');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(1);
  await expect(results.getByText('Literal keyword fallback', { exact: true })).toBeVisible();
  await results.getByText('Why this matched', { exact: true }).click();
  await expect(
    results.getByText('Selected evidence from this conversation:', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Search mode', { exact: true }).selectOption('keyword');
  await page.getByRole('checkbox', { name: 'ChatGPT', exact: true }).uncheck();
  await query.fill('floating library');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(2);
  await page.getByLabel('From date', { exact: true }).fill('2026-10-01');
  await page.getByLabel('Before date (exclusive)', { exact: true }).fill('2026-11-01');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(1);

  await page.getByLabel('Simulated provider behavior').selectOption('google-unavailable');
  await query.fill('floating library');
  await query.press('Enter');
  await expect(results.getByRole('status')).toContainText('Partial search: 1 match');
  await page.getByLabel('Simulated provider behavior').selectOption('empty');
  await query.fill('floating library');
  await query.press('Enter');
  await expect(results.getByRole('status')).toHaveText('No matches in the searched conversations.');
  await page.getByLabel('Simulated provider behavior').selectOption('slow');
  await query.fill('floating library');
  await query.press('Enter');
  await page.getByRole('button', { name: 'Cancel search', exact: true }).click();
  await expect(results.getByRole('status')).toHaveText('Search cancelled.');
  await expect(results.getByRole('heading', { name: 'Search results', exact: true })).toBeFocused();

  await page.getByLabel('Simulated provider behavior').selectOption('ready');
  await query.fill('floating library');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(3);
  await mkdir('output/playwright', { recursive: true });

  for (const width of [1200, 360, 240]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

      window.scrollTo(0, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );

    if (width !== 240)
      await page.screenshot({ path: `output/playwright/demo-${width}.png`, fullPage: true });
  }

  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await page.reload();
  await expect(query).toHaveValue('');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Static demo browser checks passed: shared search, literal description evidence, providers/dates, empty/partial/cancel, nested base, 240–1200px, no external requests or persisted state.\n',
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
