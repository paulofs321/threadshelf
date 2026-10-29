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
  let chatSearchReads = 0;
  let messageReads = 0;
  const signedOut = new Set();
  let googleResultThread = googleFixtures.googleThread('fictional-unopened-thread');
  googleResultThread[5] = [Date.parse('2026-10-13T12:00:00.000Z') / 1000, 0];
  await context.unroute(/^https?:/);
  await context.route(/^https?:/, async (route) => {
    const url = new URL(route.request().url());

    if (
      (url.origin === 'https://chatgpt.com' && url.pathname === '/auth/login') ||
      url.origin === 'https://accounts.google.com'
    )
      return route.fulfill({
        contentType: 'text/html',
        body: '<h1>Synthetic provider-managed sign-in</h1>',
      });

    if (
      signedOut.has('chatgpt') &&
      url.origin === 'https://chatgpt.com' &&
      url.pathname === '/' &&
      !route.request().isNavigationRequest()
    )
      return route.fulfill({ status: 401, body: '' });

    if (
      signedOut.has('google-ai-mode') &&
      url.origin === 'https://www.google.com' &&
      ['/', '/search'].includes(url.pathname)
    )
      return route.fulfill({
        contentType: 'text/html',
        body: '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>',
      });

    if (url.origin === 'https://chatgpt.com' && url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: chatFixtures.bootstrapHtml() });

    if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/global/search') {
      keywordReads++;
      chatSearchReads++;
      const body = chatFixtures.searchBody();

      // Distinct conversations reuse chatgpt:0 in separate native responses. Description
      // collection must allocate independent references instead of failing the provider.
      if (chatSearchReads === 5) {
        body.items[0].payload.conversation_id = chatFixtures.otherConversationId;
        body.items[0].snippet = 'A second fictional orchard excerpt.';
      }

      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }

    if (
      url.origin === 'https://chatgpt.com' &&
      url.pathname.startsWith('/backend-api/conversation/')
    ) {
      messageReads++;
      const id = url.pathname.split('/').at(-1);
      const body = chatFixtures.messagesBody(id);
      body.mapping.answer.message.content.parts = [
        ...Array.from({ length: 12 }, (_, i) => `General fictional life discussion ${i}.`),
        'A fictional orchard subtopic covers gate maintenance.',
        'Other life plans.',
      ];

      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }

    if (url.origin === 'https://www.google.com' && url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<a href="https://accounts.google.com/SignOutOptions?hl=en" aria-label="Google Account: Fiction (orchard@example.invalid)">Account</a>',
      });

    if (url.origin === 'https://www.google.com' && url.pathname === '/search')
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'x-frame-options': 'SAMEORIGIN' },
        body: route.request().isNavigationRequest()
          ? `<a href="https://accounts.google.com/SignOutOptions?hl=en" aria-label="Google Account: Fiction (orchard@example.invalid), Opens account menu">Account</a>${url.searchParams.has('mtid') ? '<div class="UYpEO"><div class="kwdzO">13 October 2026</div></div><div class="CKgc1d"><div class="pWvJNd">General planning notes. A fictional orchard subtopic covers gate maintenance.</div></div><div class="CKgc1d" data-last-turn><div class="pWvJNd">Later unrelated life plans.</div></div>' : ''}`
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

  try {
    await expect.poll(async () => (await drive('snapshot').catch(() => null))?.ready).toBe(true);
  } catch {
    const contexts = await worker.evaluate(async () =>
      (await chrome.runtime.getContexts({})).map((item) => item.contextType),
    );
    throw new Error(
      `Synthetic panel did not mount: ${JSON.stringify({ contexts, errors, snapshot: await drive('snapshot').catch(() => null) })}`,
    );
  }

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
  assert.equal(messageReads, 0);
  // A previously unopened saved thread must load inside an owned frame, without a new tab.
  googleResultThread = googleFixtures.googleThread('fictional-background-context');
  const googleSourceUrl = googlePage.url();
  await drive('description-mode');
  await drive('search');
  await expect.poll(() => keywordReads).toBe(10);
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({
      // Broad titles/native previews now qualify through actual bounded message evidence.
      results: 3,
      resultLinks: expect.arrayContaining([
        `https://chatgpt.com/c/${chatFixtures.conversationId}`,
        `https://chatgpt.com/c/${chatFixtures.otherConversationId}`,
      ]),
      explanations: 3,
      notes: expect.arrayContaining([
        expect.stringContaining('Literal keyword fallback'),
        expect.stringContaining('AI prompts sent: interpretation 0; matching 0.'),
      ]),
    });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  assert.equal(messageReads, 2);
  assert.equal(googlePage.url(), googleSourceUrl);
  await expect.poll(() => googlePage.locator('iframe').count()).toBe(0);
  await drive('check-ai');
  await expect.poll(async () => (await drive('snapshot')).aiStatus).not.toContain('Checking');
  const nativeAi = await drive('snapshot');
  process.stdout.write(
    `Native-panel local AI capability (before synthetic injection): ${JSON.stringify({ api: nativeAi.aiApi, status: nativeAi.aiStatus })}\n`,
  );
  await drive('synthetic-ai');
  await expect
    .poll(async () => (await drive('snapshot')).aiStatus)
    .toContain('Local AI is available');
  await drive('enable-ai');
  await expect.poll(async () => (await drive('snapshot')).aiStatus).toContain('Local AI enabled');
  await drive('search');
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({
      results: 1,
      explanations: 1,
      notes: expect.arrayContaining([
        expect.stringContaining('Model-assisted matching with verified evidence'),
        expect.stringContaining('AI prompts sent: interpretation 1; matching 1.'),
      ]),
    });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  await drive('disable-ai');
  await drive('synthetic-ai-unsupported');
  await expect
    .poll(async () => (await drive('snapshot')).aiStatus)
    .toContain('Local AI is available');
  await drive('enable-ai');
  await expect.poll(async () => (await drive('snapshot')).aiStatus).toContain('Local AI enabled');
  await drive('search');
  await expect
    .poll(async () => await drive('snapshot'))
    .toMatchObject({
      results: 1,
      notes: expect.arrayContaining([
        expect.stringContaining('Model-assisted matching with verified evidence'),
        expect.stringContaining('AI prompts sent: interpretation 2; matching 2.'),
      ]),
    });
  assert.deepEqual(await tabIds(), beforeSearchTabs);
  assert.equal(searchCreatedPages, 0);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);

  // Real production worker/client/isolated readers, with entirely synthetic sign-in pages and
  // user-completed return simulated by navigation. No credentials, login-host scripting or accounts.
  await drive('disable-ai');
  await drive('show-connections');

  for (const [provider, source, command, entry, destination, index] of [
    [
      'chatgpt',
      chatPage,
      'connect-chat',
      'https://chatgpt.com/auth/login',
      'https://chatgpt.com/',
      0,
    ],
    [
      'google-ai-mode',
      googlePage,
      'connect-google',
      'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fudm%3D50',
      'https://www.google.com/search?udm=50',
      1,
    ],
  ]) {
    signedOut.add(provider);
    await source.reload();
    await expect.poll(async () => (await drive('snapshot')).statuses[index]).toContain('changed');
    const originalUrl = source.url();
    // Cancel an actual panel-owned wait; a late synthetic login return must not reconnect.
    const cancelledCreated = context.waitForEvent('page');
    await drive(command);
    const cancelledLogin = await cancelledCreated;
    await cancelledLogin.goto(entry);
    await expect
      .poll(async () => (await drive('snapshot')).statuses[index])
      .toContain('Waiting for sign-in');
    await drive('cancel-connect');
    await expect.poll(async () => (await drive('snapshot')).statuses[index]).toContain('cancelled');
    assert.equal(cancelledLogin.isClosed(), false);
    signedOut.delete(provider);
    await cancelledLogin.goto(destination);
    await expect.poll(async () => (await drive('snapshot')).statuses[index]).toContain('cancelled');
    assert.equal(source.url(), originalUrl);
    await cancelledLogin.close();

    // Closing the foreground sign-in tab also terminates waiting without an authenticated scope.
    signedOut.add(provider);
    const closedCreated = context.waitForEvent('page');
    await drive(command);
    const closedLogin = await closedCreated;
    await closedLogin.goto(entry);
    await expect
      .poll(async () => (await drive('snapshot')).statuses[index])
      .toContain('Waiting for sign-in');
    await closedLogin.close();
    await expect.poll(async () => (await drive('snapshot')).statuses[index]).toContain('cancelled');

    const loginCreated = context.waitForEvent('page');
    await drive(command);
    const login = await loginCreated;
    // Reissue after Playwright attaches so its isolated synthetic route owns the initial request.
    await login.goto(entry);
    await expect
      .poll(async () => (await drive('snapshot')).statuses[index])
      .toContain('Waiting for sign-in');
    assert.equal(source.url(), originalUrl);
    assert.equal((await drive('snapshot')).results, 0);
    assert.equal(
      await worker.evaluate(() =>
        chrome.permissions.contains({ origins: ['https://accounts.google.com/*'] }),
      ),
      false,
    );
    signedOut.delete(provider);
    await login.goto(destination);
    await expect
      .poll(async () => (await drive('snapshot')).statuses[index])
      .toContain('already connected');
    assert.equal(source.url(), originalUrl);
    assert.equal(login.isClosed(), false);
  }

  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);

  process.stdout.write(
    'Chromium MV3 UI smoke passed: production native-panel runtime/providers with synthetic transport; authenticated Connect and foreground sign-in/return for both providers without login-host access; old results cleared and user source pages preserved; zero new search tabs; bounded description context and synthetic local AI; cancellation/reconnect; keyboard/focus; 240–400px; no external requests or CSP errors.\n',
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
