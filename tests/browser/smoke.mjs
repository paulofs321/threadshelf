import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build, transformWithOxc } from 'vite';
import { pathToFileURL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from '@playwright/test';

const temporary = await mkdtemp(join(tmpdir(), 'threadshelf-ui-smoke-'));
const extension = join(temporary, 'extension');
let context;

try {
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  await build({
    configFile: false,
    root: resolve('tests/browser'),
    base: './',
    logLevel: 'error',
    plugins: [tailwindcss()],
    oxc: { jsx: { runtime: 'automatic' } },
    build: {
      outDir: extension,
      emptyOutDir: false,
      sourcemap: false,
      rolldownOptions: {
        input: {
          smoke: resolve('tests/browser/smoke.html'),
          'runtime-driver': resolve('tests/browser/runtime-driver.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['sidePanel']);
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://chatgpt.com/*',
    'https://www.google.com/*',
  ]);
  // A temporary manifest pregrants the same narrow optional capabilities. Production output
  // and its permission audit above remain unchanged; the synthetic driver never ships.
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      permissions: [...manifest.permissions, 'scripting'],
      host_permissions: manifest.optional_host_permissions,
    }),
  );
  const panelHtml = await readFile(join(extension, 'sidepanel.html'), 'utf8');
  await writeFile(
    join(extension, 'sidepanel.html'),
    panelHtml.replace('</head>', '<script type="module" src="/runtime-driver.js"></script></head>'),
  );
  await writeFile(
    join(extension, 'opener.html'),
    '<!doctype html><button id="open" disabled>Open native panel</button><script src="opener.js"></script>',
  );
  await writeFile(
    join(extension, 'opener.js'),
    "chrome.windows.getCurrent().then(window => { const button = document.getElementById('open'); button.disabled = false; button.onclick = () => chrome.sidePanel.open({ windowId: window.id }); });",
  );
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const origin = new URL(worker.url()).origin;
  // URL.origin is "null" for chrome-extension: in Node's URL implementation.
  const extensionOrigin =
    origin === 'null' ? worker.url().split('/').slice(0, 3).join('/') : origin;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const externalRequests = [];
  await context.route(/^https?:/, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  await page.setViewportSize({ width: 280, height: 900 });
  await page.goto(`${extensionOrigin}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: 'ThreadShelf', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to ThreadShelf' })).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);

  for (const width of [240, 280, 320, 400]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `connection page overflow at ${width}px`,
    );
  }

  if (process.env.THREADSHELF_CONNECTION_SCREENSHOT)
    await page.screenshot({ path: process.env.THREADSHELF_CONNECTION_SCREENSHOT, fullPage: true });

  const computed = await page
    .getByRole('button', { name: 'Connect ChatGPT', exact: true })
    .evaluate((button) => ({
      color: getComputedStyle(button).backgroundColor,
      radius: getComputedStyle(button).borderRadius,
    }));
  assert.equal(computed.color, 'rgb(44, 80, 69)');
  assert.notEqual(computed.radius, '0px');
  await page.getByRole('button', { name: 'Back to search' }).click();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await page.goto(`${extensionOrigin}/smoke.html`);
  const query = page.getByRole('searchbox', { name: 'Search conversations' });
  const results = page.getByRole('region', { name: 'Search results' });
  await query.fill('slow');
  await query.press('Enter');
  await expect(results.getByRole('status')).toHaveText('Searching selected providers…');
  await page.getByRole('button', { name: 'Cancel search', exact: true }).click();
  await expect(results.getByRole('status')).toHaveText('Search cancelled.');
  await expect(results.getByRole('heading', { name: 'Search results', exact: true })).toBeFocused();
  await query.fill('expired');
  await query.press('Enter');
  await expect(
    results.getByText('Login expired. Sign in on the provider site, then reconnect.', {
      exact: true,
    }),
  ).toHaveCount(1);
  await results.getByRole('button', { name: 'Reconnect ChatGPT', exact: true }).click();
  await expect(page.getByText('ChatGPT is already connected.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Google Search AI Mode is already connected.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recheck connection' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Continue to search' }).click();
  await expect(results.getByRole('status')).toContainText('Ready');
  await query.fill('long excerpt');
  await query.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(query).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to search' }).click();
  await expect(query).toHaveValue('long excerpt');
  await expect(results.getByRole('article')).toHaveCount(2);
  await expect(results.getByText('Date unavailable', { exact: true })).toBeVisible();
  const firstResult = results.getByRole('article').first();
  assert.equal(Array.from(await firstResult.locator('blockquote').innerText()).length, 181);
  const expand = firstResult.getByRole('button', { name: 'Show more', exact: true });
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(firstResult.getByRole('button', { name: 'Show less', exact: true })).toBeFocused();
  assert.equal((await firstResult.locator('blockquote').textContent()).includes('\n'), true);
  assert.equal((await firstResult.locator('blockquote').textContent()).length > 1000, true);
  await page.keyboard.press('Space');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  assert.equal(Array.from(await firstResult.locator('blockquote').innerText()).length, 181);

  for (const width of [240, 280, 320, 400]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `overflow at ${width}px`,
    );
    await expect(query).toBeVisible();
  }

  await page.getByRole('tab', { name: 'ChatGPT 1', exact: true }).click();
  await expect(results.getByRole('article')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Google AI Mode 1', exact: true })).toBeFocused();
  await expect(results.getByRole('article')).toHaveCount(1);
  await expect(results.getByText('Date unavailable', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'All sources 2', exact: true }).click();
  await expect(results.getByRole('article')).toHaveCount(2);
  await query.focus();

  if (process.env.THREADSHELF_SMOKE_SCREENSHOT)
    await page.screenshot({ path: process.env.THREADSHELF_SMOKE_SCREENSHOT, fullPage: true });

  await page.getByRole('button', { name: 'Search settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Google Search AI Mode', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('checkbox', { name: 'Google Search AI Mode', exact: true }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Search', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(results.getByRole('article')).toHaveCount(1);
  await expect(results.getByRole('heading', { name: 'Search results', exact: true })).toBeFocused();

  // Load handwritten transport bodies through Vite's TS transformer; no live account/profile.
  const fixtureModule = async (name) => {
    const source = await readFile(resolve(`tests/fixtures/${name}/wire.ts`), 'utf8');
    const transformed = await transformWithOxc(source, `${name}.ts`, { lang: 'ts' });
    const filename = join(temporary, `${name}.mjs`);
    await writeFile(filename, transformed.code);

    return import(pathToFileURL(filename).href);
  };

  const chatFixtures = await fixtureModule('chatgpt');
  const googleFixtures = await fixtureModule('google-ai-mode');
  let keywordReads = 0;
  let googleResultThread = googleFixtures.googleThread('fictional-unopened-thread');
  googleResultThread[5] = [Date.parse('2026-10-13T12:00:00.000Z') / 1000, 0];
  await context.unroute(/^https?:/);
  await context.route(/^https?:/, async (route) => {
    const url = new URL(route.request().url());

    if (url.origin === 'https://chatgpt.com' && url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: chatFixtures.bootstrapHtml() });

    if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/global/search') {
      keywordReads++;

      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(chatFixtures.searchBody()),
      });
    }

    if (url.origin === 'https://www.google.com' && url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<a href="https://accounts.google.com/SignOutOptions?hl=en" aria-label="Google Account: Fiction (orchard@example.invalid)">Account</a>',
      });

    if (url.origin === 'https://www.google.com' && url.pathname === '/search')
      return route.fulfill({
        contentType: 'text/html',
        body: route.request().isNavigationRequest()
          ? `<a href="https://accounts.google.com/SignOutOptions?hl=en" aria-label="Google Account: Fiction (orchard@example.invalid), Opens account menu">Account</a>${url.searchParams.has('mtid') ? '<div class="UYpEO"><div class="kwdzO">13 October 2026</div></div>' : ''}`
          : '<p>Fictional AI Mode response without account metadata.</p>',
      });

    if (
      url.origin === 'https://www.google.com' &&
      url.pathname === '/httpservice/web/AimThreadsService/SearchThreads'
    ) {
      keywordReads++;

      return route.fulfill({
        contentType: 'application/json',
        body: googleFixtures.googleJson([[googleFixtures.googleMatch(googleResultThread)]]),
      });
    }

    externalRequests.push(url.origin);

    return route.abort();
  });
  // Playwright-created targets install interception before navigating. Extension-created targets
  // can start their initial navigation before Playwright attaches; DNS is blackholed as a backstop.
  const chatPage = await context.newPage();
  await chatPage.goto('https://chatgpt.com/');
  const googlePage = await context.newPage();
  const googleThreadUrl = new URL('https://www.google.com/search');

  for (const [key, value] of googleFixtures.googleThread()[22])
    googleThreadUrl.searchParams.set(key, value);

  await googlePage.goto(googleThreadUrl.href);
  await page.goto(`${extensionOrigin}/opener.html`);
  await page.getByRole('button', { name: 'Open native panel', exact: true }).click();
  const drive = (command) =>
    worker.evaluate(
      (command) => chrome.runtime.sendMessage({ kind: 'synthetic-panel-driver', command }),
      command,
    );
  await expect.poll(async () => (await drive('snapshot').catch(() => null))?.ready).toBe(true);
  await drive('connect-chat');
  await expect
    .poll(async () => (await drive('snapshot')).statuses[0])
    .toContain('already connected');
  await drive('connect-google');
  await expect
    .poll(async () => (await drive('snapshot')).statuses[1])
    .toContain('already connected');
  await drive('continue');
  await page.bringToFront();
  const tabIds = () =>
    worker.evaluate(async () =>
      (await chrome.tabs.query({})).map((tab) => tab.id).sort((a, b) => a - b),
    );
  const beforeSearchTabs = await tabIds();
  let searchCreatedPages = 0;
  context.on('page', () => searchCreatedPages++);
  await drive('search');
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({ results: 2, dates: expect.arrayContaining(['2026-10-13T12:00:00.000Z']) })
    .catch(async () => {
      throw new Error(`Synthetic native-panel failure: ${JSON.stringify(await drive('snapshot'))}`);
    });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  // The next search returns the thread already rendered in the source tab. Its visible date wins.
  googleResultThread = googleFixtures.googleThread();
  await drive('search');
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({
      results: 2,
      dates: expect.arrayContaining(['2026-10-13']),
    });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  await chatPage.bringToFront();
  await googlePage.bringToFront();
  await page.bringToFront();
  const retained = await drive('snapshot');
  assert.equal(
    retained.statuses.slice(0, 2).every((status) => status.includes('already connected')),
    true,
  );
  await drive('show-connections');
  await drive('continue');
  await googlePage.locator('.kwdzO').evaluate((label) => {
    label.textContent = '19:28';
  });
  const today = await googlePage.evaluate(() => {
    const now = new Date();

    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  });
  await drive('search');
  await expect.poll(() => keywordReads).toBe(6);
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({ results: 2, dates: expect.arrayContaining([today]) });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);

  process.stdout.write(
    'Chromium MV3 UI smoke passed: production mount/theme; real native-panel runtime/providers with synthetic transport; zero new tabs across native/visible/time-only date searches; synthetic cancellation/reconnect; compact previews; keyboard/focus; 240–400px; no external requests or CSP errors.\n',
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
