import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { verifyArchive } from '../../scripts/verify-artifacts.mjs';

const files = await verifyArchive();
const temporary = await mkdtemp(join(tmpdir(), 'threadshelf-package-'));
const extension = join(temporary, 'extension');
let context;

try {
  for (const [path, bytes] of files) {
    const destination = join(extension, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }

  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  const external = [];
  const errors = [];
  await context.route(/^https?:/u, (route) => {
    external.push('external request');

    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const origin = worker.url().split('/').slice(0, 3).join('/');
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('page error'));
  await page.goto(`${origin}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: 'ThreadShelf', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connect Google Search AI Mode', exact: true }),
  ).toBeVisible();
  const grants = await worker.evaluate(() => chrome.permissions.getAll());
  assert.deepEqual(grants.permissions, ['sidePanel']);
  assert.deepEqual(grants.origins ?? [], []);
  // In-memory test gesture only; the extracted package is unchanged and contains no test driver.
  await page.evaluate(async () => {
    const browserWindow = await chrome.windows.getCurrent();
    document
      .querySelector('h1')
      .addEventListener('click', () => chrome.sidePanel.open({ windowId: browserWindow.id }), {
        once: true,
      });
  });
  await page.getByRole('heading', { name: 'ThreadShelf', exact: true }).click();
  await expect
    .poll(() =>
      worker.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
      ),
    )
    .toBe(1);
  const after = await verifyArchive();

  for (const [path, bytes] of after) assert.ok(bytes.equals(files.get(path)));

  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Extracted ZIP loads as an unpacked MV3 extension: original manifest/assets, real native panel context, no pregranted optional permissions, account reads or package mutation.\n',
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
