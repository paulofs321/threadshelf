// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortChatGptDocumentRead,
  readChatGptDocument,
} from '../../../src/providers/chatgpt/document-read';
import type { ChatGptOperation } from '../../../src/providers/chatgpt/transport';
import { bootstrap, bootstrapHtml, conversationId, searchBody } from '../../fixtures/chatgpt/wire';

const fetchMock = vi.fn<typeof fetch>();
const registry = globalThis as typeof globalThis & {
  __threadshelfChatGptReads?: Map<string, AbortController>;
};
const salt = 'synthetic-local-salt';
const operation: ChatGptOperation = { kind: 'search', query: 'prototype' };
const read = (op: ChatGptOperation = operation, expected?: string) =>
  readChatGptDocument(op, 'synthetic-operation', salt, expected);
const html = (value: unknown = bootstrap()) =>
  new Response(bootstrapHtml(value), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
const json = (value: unknown = searchBody()) => Response.json(value);

const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

beforeEach(() => {
  vi.stubGlobal('location', new URL(`https://chatgpt.com/c/${conversationId}`));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = bootstrapHtml();
  fetchMock
    .mockReset()
    .mockImplementation(async (raw) => (new URL(String(raw)).pathname === '/' ? html() : json()));
});
afterEach(() => {
  for (const c of registry.__threadshelfChatGptReads?.values() ?? []) c.abort();

  delete registry.__threadshelfChatGptReads;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isolated ChatGPT session/read boundary', () => {
  it.each([
    { kind: 'inspect' },
    { kind: 'list' },
    operation,
    { kind: 'messages', conversationId },
  ] as ChatGptOperation[])(
    'performs bounded %j with fresh server identity around the read',
    async (op) => {
      const result = await read(op);
      expect(result).toMatchObject({
        status: 'success',
        identityBefore: expect.stringMatching(/^[a-f0-9]{64}$/),
        identityAfter: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC-CREDENTIAL');
      expect(JSON.stringify(result)).not.toContain('synthetic-user');
      expect(fetchMock).toHaveBeenCalledTimes(op.kind === 'inspect' ? 2 : 3);

      for (const [url, init] of fetchMock.mock.calls) {
        expect(new URL(String(url)).origin).toBe('https://chatgpt.com');
        expect(init).toMatchObject({
          method: 'GET',
          credentials: 'same-origin',
          mode: 'same-origin',
          cache: 'no-store',
          redirect: 'manual',
        });

        if (new URL(String(url)).pathname === '/') expect(init?.headers).toBeUndefined();
        else
          expect(init?.headers).toEqual({
            authorization: 'Bearer SYNTHETIC-CREDENTIAL-DO-NOT-RETURN',
          });
      }

      if (op.kind === 'search') {
        const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
        expect(url.pathname).toBe('/backend-api/global/search');
        expect(url.searchParams.get('query')).toBe('prototype');
        expect(url.searchParams.get('sources')).toBe('conversation');
        expect(url.searchParams.get('limit')).toBe('30');
        expect(url.searchParams.get('query_id')).toMatch(/^[a-f0-9-]{36}$/);
      }

      if (op.kind === 'list')
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
          'https://chatgpt.com/backend-api/conversations',
        );

      if (op.kind === 'messages')
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
          `https://chatgpt.com/backend-api/conversation/${conversationId}`,
        );

      expect(registry.__threadshelfChatGptReads).toBeUndefined();
    },
  );
  it('reuses a matching identity only within the same selection salt', async () => {
    const a = await read({ kind: 'inspect' });

    if (a.status !== 'success') throw Error('Expected inspect success');

    expect(await read(operation, a.identityBefore)).toMatchObject({ status: 'success' });
    expect(
      await readChatGptDocument(
        operation,
        'another-operation',
        'another-local-salt',
        a.identityBefore,
      ),
    ).toEqual({ status: 'scope-changed' });
  });
  it('is closure-free when serialized by Chrome', async () => {
    const result = await runInNewContext(
      `(${readChatGptDocument.toString()})({kind:'inspect'},'serialized-operation','synthetic-local-salt')`,
      {
        window,
        location,
        document,
        DOMParser,
        fetch: fetchMock,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        AbortController,
        setTimeout,
        clearTimeout,
        URL,
        Map,
      },
    );
    expect(result.status).toBe('success');
    runInNewContext(`(${abortChatGptDocumentRead.toString()})('absent')`, {});
  });
  it.each(['http://chatgpt.com/', 'https://evil.invalid/'])(
    'rejects wrong origin %s',
    async (url) => {
      vi.stubGlobal('location', new URL(url));
      expect(await read()).toEqual({ status: 'scope-changed' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('rejects subframes', async () => {
    vi.stubGlobal('window', { top: {} });
    expect(await read()).toEqual({ status: 'scope-changed' });
  });
  it.each([
    null,
    { kind: 'fetch' },
    { kind: 'search', query: ' ' },
    { kind: 'search', query: 'x'.repeat(1025) },
    { kind: 'search', query: 4 },
    { kind: 'messages', conversationId: '../escape' },
  ])('rejects untrusted operation %j', async (op) => {
    expect(await read(op as ChatGptOperation)).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ['', 'synthetic-local-salt'],
    ['id', 'short'],
    ['bad id', 'synthetic-local-salt'],
  ])('rejects malformed operation IDs/salts', async (id, s) => {
    expect(await readChatGptDocument(operation, id, s)).toEqual({ status: 'unavailable' });
  });
  it('rejects malformed expected identity and caps concurrent/replayed work', async () => {
    expect(await read(operation, 'bad')).toEqual({ status: 'unavailable' });
    registry.__threadshelfChatGptReads = new Map([['synthetic-operation', new AbortController()]]);
    expect(await read()).toEqual({ status: 'unavailable' });
    registry.__threadshelfChatGptReads = new Map([
      ['one', new AbortController()],
      ['two', new AbortController()],
    ]);
    expect(await read()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 503, 302, 204])(
    'maps HTTP %s without consuming body or leaking errors',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(status === 204 ? null : 'FICTIONAL PRIVATE ERROR', { status }),
      );
      expect(await read()).toEqual({
        status: status === 401 ? 'login-expired' : status === 429 ? 'rate-limited' : 'unavailable',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    '5',
    '0',
    '999999999999',
    'invalid',
    '-1',
    '1.5',
    'Thu, 09 Oct 2025 08:53:20 GMT',
    'Thu, 99 Oct 2025 08:53:20 GMT',
  ])('bounds Retry-After %s without retrying', async (value) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-09T08:53:19Z'));
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': value } }),
    );
    const result = await read();
    expect(result.status).toBe('rate-limited');
    const expected: Record<string, number> = {
      '5': 5000,
      '0': 0,
      '999999999999': 300000,
      'Thu, 09 Oct 2025 08:53:20 GMT': 1000,
    };
    expect(result).toEqual({
      status: 'rate-limited',
      ...(Object.hasOwn(expected, value) ? { retryAfterMs: expected[value] } : {}),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['redirected', 'opaqueredirect'])('rejects %s responses', async (kind) => {
    const r = html();
    Object.defineProperty(r, kind === 'redirected' ? 'redirected' : 'type', {
      value: kind === 'redirected' ? true : 'opaqueredirect',
    });
    fetchMock.mockResolvedValueOnce(r);
    expect(await read()).toEqual({ status: 'unavailable' });
  });
  it.each([
    'missing-mime',
    'wrong-html-mime',
    'wrong-json-mime',
    'invalid-json',
    'invalid-utf8',
    'no-body',
    'declared-oversize',
    'stream-oversize',
  ])('rejects %s', async (kind) => {
    if (kind === 'missing-mime') fetchMock.mockResolvedValueOnce(new Response(new Uint8Array()));

    if (kind === 'wrong-html-mime') fetchMock.mockResolvedValueOnce(json());

    if (kind === 'wrong-json-mime')
      fetchMock.mockResolvedValueOnce(html()).mockResolvedValueOnce(html());

    if (kind === 'invalid-json')
      fetchMock
        .mockResolvedValueOnce(html())
        .mockResolvedValueOnce(
          new Response('PRIVATE INVALID JSON', { headers: { 'content-type': 'application/json' } }),
        );

    if (kind === 'invalid-utf8')
      fetchMock.mockResolvedValueOnce(
        new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/html' } }),
      );

    if (kind === 'no-body')
      fetchMock.mockResolvedValueOnce(
        new Response(null, { headers: { 'content-type': 'text/html' } }),
      );

    if (kind === 'declared-oversize')
      fetchMock.mockResolvedValueOnce(
        new Response('', { headers: { 'content-type': 'text/html', 'content-length': '2097153' } }),
      );

    if (kind === 'stream-oversize')
      fetchMock.mockResolvedValueOnce(
        new Response('x'.repeat(2097153), { headers: { 'content-type': 'text/html' } }),
      );

    expect(await read()).toEqual({ status: 'schema-changed' });
    expect(registry.__threadshelfChatGptReads).toBeUndefined();
  });
  it.each([
    'no-session',
    'duplicate-session',
    'invalid-script',
    'oversized-script',
    'workspace',
    'missing-token',
    'bad-id',
    'bad-server-session',
  ])('fails closed for %s', async (kind) => {
    const b = bootstrap();

    if (kind === 'no-session') document.body.innerHTML = '';

    if (kind === 'duplicate-session') document.body.innerHTML = bootstrapHtml() + bootstrapHtml();

    if (kind === 'invalid-script')
      document.body.innerHTML = '<script type="application/json">invalid</script>';

    if (kind === 'oversized-script')
      document.body.innerHTML =
        '<script type="application/json">' + 'x'.repeat(2097153) + '</script>';

    if (kind === 'workspace') b.session.account.structure = 'workspace';

    if (kind === 'missing-token') b.session.accessToken = '';

    if (kind === 'bad-id') b.session.user.id = 'x'.repeat(257);

    if (['workspace', 'missing-token', 'bad-id'].includes(kind))
      document.body.innerHTML = bootstrapHtml(b);

    if (kind === 'bad-server-session') fetchMock.mockResolvedValueOnce(html({ session: {} }));

    expect(await read()).toEqual({
      status:
        kind === 'workspace' || kind === 'bad-server-session' ? 'unavailable' : 'schema-changed',
    });
  });
  it.each(['user', 'account', 'after-read', 'navigation', 'expected'])(
    'rejects identity/context changes: %s',
    async (kind) => {
      if (kind === 'user') fetchMock.mockResolvedValueOnce(html(bootstrap('different-user')));

      if (kind === 'account')
        fetchMock.mockResolvedValueOnce(html(bootstrap('synthetic-user', 'different-account')));

      if (kind === 'after-read')
        fetchMock.mockImplementation(async (raw) => {
          if (new URL(String(raw)).pathname !== '/') {
            document.body.innerHTML = bootstrapHtml(bootstrap('different-user'));

            return json();
          }

          return html();
        });

      if (kind === 'navigation')
        fetchMock.mockImplementationOnce(async () => {
          vi.stubGlobal('location', new URL('https://chatgpt.com/other'));

          return html();
        });

      expect(await read(operation, kind === 'expected' ? 'b'.repeat(64) : undefined)).toEqual({
        status: 'scope-changed',
      });
    },
  );
  it('handles a non-JSON unrelated bootstrap script without trusting it', async () => {
    document.body.innerHTML = '<script type="application/json">not json</script>' + bootstrapHtml();
    expect(await read()).toMatchObject({ status: 'success' });
  });
  it('redacts fetch failures and releases registry/timers', async () => {
    fetchMock.mockRejectedValueOnce(Error('FICTIONAL PRIVATE FAILURE'));
    expect(await read()).toEqual({ status: 'unavailable' });
    expect(registry.__threadshelfChatGptReads).toBeUndefined();
  });
  it.each(['timeout', 'cancel'])('aborts a stalled stream on %s', async (kind) => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const pending = read();
    await tick();

    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(8_000);
    else abortChatGptDocumentRead('synthetic-operation');

    expect(await pending).toEqual({ status: kind === 'timeout' ? 'timeout' : 'cancelled' });
    expect(cancelled).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.__threadshelfChatGptReads).toBeUndefined();
  });
  it('retains another operation registry while cleaning its own entry', async () => {
    registry.__threadshelfChatGptReads = new Map([['other', new AbortController()]]);
    expect(await read()).toMatchObject({ status: 'success' });
    expect(registry.__threadshelfChatGptReads?.size).toBe(1);
  });
});

it('rejects an atomic identity switch even when both individual DOM/server checks agree', async () => {
  let switched = false;
  const changed = bootstrap('different-user');
  fetchMock.mockImplementation(async (raw) => {
    if (new URL(String(raw)).pathname === '/') return html(switched ? changed : bootstrap());

    switched = true;
    document.body.innerHTML = bootstrapHtml(changed);

    return json();
  });
  expect(await read()).toEqual({ status: 'scope-changed' });
});
it('ignores unrelated valid bootstrap JSON and accepts a bounded declared body length', async () => {
  document.body.innerHTML =
    '<script type="application/json">{"unrelated":true}</script>' + bootstrapHtml();
  const response = html();
  response.headers.set('content-length', '500');
  fetchMock.mockResolvedValueOnce(response);
  expect(await read()).toMatchObject({ status: 'success' });
});
it.each(['stream', 'http'])(
  'consumes a rejected %s cancellation promise without leaking it',
  async (kind) => {
    const stream = new ReadableStream({
      cancel() {
        throw Error('SYNTHETIC PRIVATE CANCEL ERROR');
      },
    });
    const response = new Response(stream, {
      headers: { 'content-type': kind === 'stream' ? 'text/html' : 'text/plain' },
    });
    fetchMock.mockResolvedValueOnce(response);

    if (kind === 'stream') {
      const pending = read();
      await tick();
      abortChatGptDocumentRead('synthetic-operation');
      expect(await pending).toEqual({ status: 'cancelled' });
    } else expect(await read()).toEqual({ status: 'schema-changed' });

    await tick();
  },
);
it('maps a network stream failure to unavailable, preserving no error text', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.error(Error('PRIVATE NETWORK BODY'));
    },
  });
  fetchMock.mockResolvedValueOnce(
    new Response(stream, { headers: { 'content-type': 'text/html' } }),
  );
  expect(await read()).toEqual({ status: 'unavailable' });
});
