// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortGoogleDocumentRead,
  readGoogleDocument,
} from '../../../src/providers/google-ai-mode/document-read';
import type { GoogleDocumentRead } from '../../../src/providers/google-ai-mode/document-read';
import { requireValid } from '../../../src/contracts';
import { GoogleReadResultSchema } from '../../../src/providers/google-ai-mode/transport';
import { googleJson, googleMatch } from '../../fixtures/google-ai-mode/wire';

const html = (email = 'orchard@example.invalid', displayName = 'Fiction') =>
  `<a href="https://accounts.google.com/SignOutOptions?hl=en" aria-label="Google Account: ${displayName} (${email})"></a>`;
const input = (kind: 'inspect' | 'list' | 'search' = 'search'): GoogleDocumentRead => ({
  operation: kind === 'search' ? { kind, query: 'authentication' } : { kind },
  partition: 'fictional-local-salt',
  operationId: 'fictional-operation',
});
const registry = globalThis as typeof globalThis & {
  __threadshelfGoogleReadControllers?: Map<string, AbortController>;
};
const fetchMock = vi.fn<typeof fetch>();
const json = () =>
  new Response(googleJson([[googleMatch()]]), {
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
const identity = (email = 'orchard@example.invalid', displayName = 'Fiction') =>
  new Response(html(email, displayName), {
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50'));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = html();
  fetchMock
    .mockReset()
    .mockImplementation(async (raw) =>
      new URL(String(raw)).pathname === '/search' ? identity() : json(),
    );
});
afterEach(() => {
  for (const controller of registry.__threadshelfGoogleReadControllers?.values() ?? [])
    controller.abort();

  delete registry.__threadshelfGoogleReadControllers;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('self-contained Google document reads', () => {
  it.each(['search', 'list', 'inspect'] as const)(
    'performs bounded %s reads with fresh account checks on both sides',
    async (kind) => {
      const result = await readGoogleDocument(input(kind));
      expect(result).toMatchObject({
        status: 'success',
        identityBefore: expect.stringMatching(/^[a-f0-9]{64}$/),
        identityAfter: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(result)).not.toContain('orchard@example.invalid');
      expect(fetchMock).toHaveBeenCalledTimes(kind === 'inspect' ? 2 : 3);
      const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
      expect(urls[0]?.href).toBe('https://www.google.com/search?udm=50');
      expect(urls.at(-1)?.href).toBe('https://www.google.com/search?udm=50');

      if (kind !== 'inspect')
        expect(JSON.parse(urls[1]?.searchParams.get('reqpld') ?? '')).toEqual(
          kind === 'search' ? ['authentication', 30, null, 2, null, 0] : [null, null, 0],
        );

      for (const [, init] of fetchMock.mock.calls)
        expect(init).toMatchObject({
          method: 'GET',
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'manual',
          cache: 'no-store',
        });

      expect(registry.__threadshelfGoogleReadControllers).toBeUndefined();
    },
  );

  it.each([
    'https://evil.invalid/search?udm=50',
    'https://www.google.com/other',
    'https://www.google.com/search?authuser=1',
  ])('rejects unsupported page context %s before a read', async (url) => {
    vi.stubGlobal('location', new URL(url));
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects subframes and invalid internal operations', async () => {
    vi.stubGlobal('window', { top: {} });
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    vi.unstubAllGlobals();
    vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50'));

    for (const value of [
      { ...input(), partition: '' },
      { ...input(), operationId: '' },
      { ...input(), operation: { kind: 'fetch' } },
      { ...input(), operation: { kind: 'search', query: ' ' } },
      { ...input(), operation: { kind: 'search', query: 'x'.repeat(1025) } },
    ])
      expect(await readGoogleDocument(value as GoogleDocumentRead)).toEqual({
        status: 'unavailable',
      });
  });

  it('caps concurrent document work and rejects operation replay', async () => {
    const active = new AbortController();
    registry.__threadshelfGoogleReadControllers = new Map([['fictional-operation', active]]);
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    registry.__threadshelfGoogleReadControllers = new Map(
      Array.from({ length: 4 }, (_, i) => [`other-${i}`, active]),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])(
    'maps HTTP %s during identity verification before touching history',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      expect(await readGoogleDocument(input())).toEqual({
        status: status === 401 ? 'login-expired' : status === 429 ? 'rate-limited' : 'unavailable',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects missing identity and unexpected identity content types without exposing text', async () => {
    document.body.innerHTML = '';
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    document.body.innerHTML = html();
    fetchMock.mockResolvedValueOnce(json());
    expect(await readGoogleDocument(input())).toEqual({ status: 'schema-changed' });
    fetchMock.mockResolvedValueOnce(
      new Response('<p>Fictional missing identity</p>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
  });

  it('binds identity to the parenthesized account address, not email-like display-name text', async () => {
    const displayName = 'orchard@example.invalid';
    document.body.innerHTML = html('first@example.invalid', displayName);
    fetchMock.mockImplementation(async (raw) =>
      new URL(String(raw)).pathname === '/search'
        ? identity('first@example.invalid', displayName)
        : json(),
    );

    const first = await readGoogleDocument(input('inspect'));

    document.body.innerHTML = html('second@example.invalid', displayName);
    fetchMock.mockImplementation(async (raw) =>
      new URL(String(raw)).pathname === '/search'
        ? identity('second@example.invalid', displayName)
        : json(),
    );

    const second = await readGoogleDocument(input('inspect'));

    expect(first).toMatchObject({ status: 'success' });
    expect(second).toMatchObject({ status: 'success' });
    expect(first).not.toEqual(second);
  });

  it.each(['rendered', 'fresh', 'both'] as const)(
    'accepts an account-menu annotation in the %s label without changing the verified identity',
    async (annotated) => {
      const plain = requireValid(
        GoogleReadResultSchema,
        await readGoogleDocument(input('inspect')),
      );
      const annotatedHtml = html('ORCHARD@example.invalid', 'display@example.invalid').replace(
        ')">',
        '), Opens account menu">',
      );

      if (annotated !== 'fresh') document.body.innerHTML = annotatedHtml;

      fetchMock
        .mockClear()
        .mockImplementation(async (raw) =>
          new URL(String(raw)).pathname === '/search'
            ? annotated === 'rendered'
              ? identity()
              : new Response(annotatedHtml, { headers: { 'content-type': 'text/html' } })
            : json(),
        );
      const result = await readGoogleDocument(input());

      expect(result).toMatchObject(plain);
      expect(result).toMatchObject({ status: 'success', response: { status: 200 } });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(result)).not.toContain('example.invalid');
      expect(registry.__threadshelfGoogleReadControllers).toBeUndefined();
    },
  );

  it('still rejects account changes when rendered labels have an annotation', async () => {
    document.body.innerHTML = html().replace(')">', '), Opens account menu">');
    fetchMock.mockResolvedValueOnce(identity('other@example.invalid'));
    expect(await readGoogleDocument(input())).toEqual({ status: 'scope-changed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(json())
      .mockResolvedValueOnce(identity('other@example.invalid'));
    expect(await readGoogleDocument(input())).toEqual({ status: 'scope-changed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    'Google Account: Fiction (orchard@example.invalid), other@example.invalid',
    'Google Account: Fiction (orchard@example.invalid), (Account menu)',
    'Google Account: Fiction (orchard@example.invalid),\nAccount menu',
    'Google Account: Fiction (orchard@example.invalid) Account menu',
    'Google Account: Fiction orchard@example.invalid, Account menu',
    'Google Account: (display@example.invalid) actual@example.invalid',
  ])(
    'rejects ambiguous or unsupported annotated identity %s before reading history',
    async (label) => {
      document.querySelector('a')?.setAttribute('aria-label', label);
      expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a changed account before a read, after a read, or against an established partition', async () => {
    const other = () =>
      new Response(html('other@example.invalid'), { headers: { 'content-type': 'text/html' } });
    fetchMock.mockResolvedValueOnce(other());
    expect(await readGoogleDocument(input())).toEqual({ status: 'scope-changed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(json())
      .mockResolvedValueOnce(other());
    expect(await readGoogleDocument(input())).toEqual({ status: 'scope-changed' });
    fetchMock.mockReset().mockResolvedValue(identity());
    expect(await readGoogleDocument({ ...input(), expectedIdentity: 'f'.repeat(64) })).toEqual({
      status: 'scope-changed',
    });
  });

  it('enforces response budgets before and during streaming', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { headers: { 'content-type': 'text/html', 'content-length': '3000001' } }),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'schema-changed' });
    fetchMock.mockResolvedValueOnce(
      new Response('x'.repeat(3_000_001), { headers: { 'content-type': 'text/html' } }),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'schema-changed' });
    fetchMock.mockResolvedValueOnce(
      new Response(null, { headers: { 'content-type': 'text/html' } }),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
  });

  it('reports safe network/stream failures and tolerates reader cancellation failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Fictional private network exception'));
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('Fictional secret broken stream'));
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'text/html' } }),
    );
    expect(await readGoogleDocument(input())).toEqual({ status: 'unavailable' });
  });

  it.each(['timeout', 'cancel'] as const)(
    'aborts the document fetch on %s and releases its registry/timer',
    async (action) => {
      vi.useFakeTimers();
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('Fictional abort detail')),
              { once: true },
            ),
          ),
      );
      const pending = readGoogleDocument(input());

      if (action === 'timeout') await vi.advanceTimersByTimeAsync(8000);
      else abortGoogleDocumentRead('fictional-operation');

      expect(await pending).toEqual({ status: action === 'timeout' ? 'timeout' : 'cancelled' });
      expect(registry.__threadshelfGoogleReadControllers).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      abortGoogleDocumentRead('already-gone');
    },
  );

  it('retains another live operation when its own registry entry is removed', async () => {
    registry.__threadshelfGoogleReadControllers = new Map([['other', new AbortController()]]);
    expect(await readGoogleDocument(input('inspect'))).toMatchObject({ status: 'success' });
    expect(registry.__threadshelfGoogleReadControllers?.size).toBe(1);
  });

  it('extracts only bounded observed last-turn text and rejects wrong/changed thread contexts', async () => {
    const operation = { kind: 'messages' as const, conversationId: 'fictional-thread-1' };
    expect(await readGoogleDocument({ ...input(), operation })).toEqual({
      status: 'scope-changed',
    });
    vi.stubGlobal(
      'location',
      new URL('https://www.google.com/search?udm=50&mtid=fictional-thread-1'),
    );
    expect(await readGoogleDocument({ ...input(), operation })).toEqual({ status: 'unavailable' });
    const block = document.createElement('div');
    block.setAttribute('data-last-turn', '');
    block.innerText = 'x'.repeat(1999) + '🌳suffix';
    document.body.append(block);
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);
    expect(await readGoogleDocument({ ...input(), operation })).toMatchObject({
      status: 'success',
      rendered: ['x'.repeat(1999)],
    });
    block.innerText = 'Exact fictional question and answer.';
    expect(await readGoogleDocument({ ...input(), operation })).toMatchObject({
      status: 'success',
      rendered: ['Exact fictional question and answer.'],
    });
    fetchMock.mockImplementationOnce(async () => {
      vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50&mtid=changed'));

      return identity();
    });
    expect(await readGoogleDocument({ ...input(), operation })).toEqual({
      status: 'scope-changed',
    });
  });

  it('works after Chrome-style serialization without module closures', async () => {
    const page: { top?: unknown } = {};
    page.top = page;
    const result: unknown = await runInNewContext(
      `(${readGoogleDocument.toString()})(${JSON.stringify(input('inspect'))})`,
      {
        window: page,
        location,
        document,
        DOMParser,
        URL,
        URLSearchParams,
        AbortController,
        fetch: fetchMock,
        TextDecoder,
        TextEncoder,
        crypto: webcrypto,
        setTimeout,
        clearTimeout,
      },
    );
    expect(result).toMatchObject({ status: 'success' });
  });
});

describe('date-only Google document reads', () => {
  const dateInput = (): GoogleDocumentRead => ({
    ...input(),
    operation: { kind: 'date', conversationId: 'fictional-thread-1' },
  });

  function conversation() {
    vi.stubGlobal(
      'location',
      new URL('https://www.google.com/search?udm=50&mtid=fictional-thread-1'),
    );
  }

  function label(text: string, visible = true) {
    const group = document.createElement('div');
    group.className = 'UYpEO';
    const value = document.createElement('div');
    value.className = 'kwdzO';
    value.textContent = text;
    group.append(value);
    document.body.append(group);
    vi.spyOn(value, 'getBoundingClientRect').mockReturnValue({
      width: visible ? 100 : 0,
    } as DOMRect);

    return value;
  }

  it('reads only the first visible date label, with an observation time and verified identity', async () => {
    conversation();
    label('12 October 2026', false);
    label('13 October 2026');
    label('19:28');
    const result = requireValid(GoogleReadResultSchema, await readGoogleDocument(dateInput()));
    expect(result).toMatchObject({
      status: 'success',
      dateLabel: {
        text: '13 October 2026',
        observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(result).not.toHaveProperty('rendered');
    expect(result).not.toHaveProperty('response');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registry.__threadshelfGoogleReadControllers).toBeUndefined();
  });
  it('waits for asynchronously rendered dates without reading conversation text', async () => {
    vi.useFakeTimers();
    conversation();
    label('  ');
    const pending = readGoogleDocument(dateInput());
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
    label('  19:28  ');
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: 'success', dateLabel: { text: '19:28' } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cancel', 'timeout'] as const)('cleans date wait timers on %s', async (action) => {
    vi.useFakeTimers();
    conversation();
    const pending = readGoogleDocument(dateInput());
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    if (action === 'cancel') abortGoogleDocumentRead('fictional-operation');
    else await vi.advanceTimersByTimeAsync(8000);

    expect(await pending).toEqual({ status: action === 'cancel' ? 'cancelled' : 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.__threadshelfGoogleReadControllers).toBeUndefined();
  });
  it('rejects oversized date labels and wrong or changed conversation contexts', async () => {
    expect(await readGoogleDocument(dateInput())).toEqual({ status: 'scope-changed' });
    conversation();
    const value = label('x'.repeat(81));
    expect(await readGoogleDocument(dateInput())).toEqual({ status: 'schema-changed' });
    value.textContent = '13 October 2026';
    fetchMock.mockImplementationOnce(async () => {
      vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50&mtid=changed'));

      return identity();
    });
    expect(await readGoogleDocument(dateInput())).toEqual({ status: 'scope-changed' });
  });
});
