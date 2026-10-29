// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readGoogleDocument,
  abortGoogleDocumentRead,
} from '../../../src/providers/google-ai-mode/document-read';
import type { GoogleDocumentRead } from '../../../src/providers/google-ai-mode/document-read';
import { GoogleReadResultSchema } from '../../../src/providers/google-ai-mode/transport';
import { requireValid } from '../../../src/contracts';

const label = (email = 'orchard@example.invalid') =>
  `<a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Fiction (${email})"></a>`;
const originalUrl =
  'https://www.google.com/search?mtid=fictional-thread-1&csuir=1&mstk=synthetic_state&udm=50';
let expectedIdentity: string;
let frame: HTMLIFrameElement | undefined;
let child: Document;
let childUrl: string;
const fetchMock = vi.fn<typeof fetch>();
const request = (): GoogleDocumentRead => ({
  operation: { kind: 'messages', conversationId: 'fictional-thread-1', query: 'jobs Switzerland' },
  originalUrl,
  expectedIdentity,
  partition: 'fiction-salt',
  operationId: 'fiction-frame',
});

function turn(text: string, parent: HTMLElement = child.body) {
  const element = child.createElement('div');
  element.className = 'CKgc1d';
  element.innerText = text;
  const answer = child.createElement('div');
  answer.className = 'pWvJNd';
  element.append(answer);
  parent.append(element);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);

  return element;
}

beforeEach(async () => {
  vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50'));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = label();
  fetchMock
    .mockReset()
    .mockImplementation(
      async () => new Response(label(), { headers: { 'content-type': 'text/html' } }),
    );
  const result = requireValid(
    GoogleReadResultSchema,
    await readGoogleDocument({
      operation: { kind: 'inspect' },
      partition: 'fiction-salt',
      operationId: 'establish',
    }),
  );

  if (result.status !== 'success') throw new Error('Synthetic identity setup failed');

  expectedIdentity = result.identityBefore;
  fetchMock.mockClear();
  frame = undefined;
  child = new DOMParser().parseFromString(label(), 'text/html');
  childUrl = originalUrl;
  Object.defineProperty(child, 'URL', { get: () => childUrl, configurable: true });
  turn('General job search. Focus on jobs in Switzerland.');
  const append = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
    const result = append(node);

    if (node instanceof HTMLIFrameElement) {
      frame = node;
      Object.defineProperty(node, 'contentDocument', { get: () => child, configurable: true });
    }

    return result;
  });
});
afterEach(() => {
  expect(document.querySelector('iframe')).toBeNull();
  expect(
    (globalThis as typeof globalThis & { __threadshelfGoogleReadControllers?: unknown })
      .__threadshelfGoogleReadControllers,
  ).toBeUndefined();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Google saved messages through an owned same-origin frame', () => {
  it('uses supported last-turn evidence when full turn containers are unavailable', async () => {
    child.body.innerHTML = label();
    const block = child.createElement('div');
    block.setAttribute('data-last-turn', '');
    block.innerText = 'Food without dairy.';
    child.body.append(block);
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);
    expect(await readGoogleDocument(request())).toMatchObject({
      status: 'success',
      rendered: ['Food without dairy.'],
    });
  });
  it.each(['cross-origin', 'access-error'] as const)(
    'cleans up an inaccessible frame: %s',
    async (reason) => {
      vi.useFakeTimers();
      child.body.innerHTML = label();
      const pending = readGoogleDocument(request());
      await vi.waitFor(() => expect(frame).toBeDefined());
      Object.defineProperty(frame, 'contentDocument', {
        get: () => {
          if (reason === 'access-error') throw new Error('Synthetic private browser error');

          return null;
        },
      });
      await vi.advanceTimersByTimeAsync(reason === 'cross-origin' ? 8000 : 100);
      expect(await pending).toEqual({
        status: reason === 'cross-origin' ? 'timeout' : 'unavailable',
      });
    },
  );
  it('reads earlier and later turns, avoids nested duplicates, and removes its frame without navigation', async () => {
    const outer = turn('Earlier food without dairy discussion.');
    turn('Nested duplicate', outer);
    const before = location.href;
    const result = await readGoogleDocument(request());
    expect(result).toMatchObject({
      status: 'success',
      rendered: [
        'General job search. Focus on jobs in Switzerland.',
        'Earlier food without dairy discussion.',
      ],
    });
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
    expect(frame?.getAttribute('tabindex')).toBe('-1');
    expect(frame?.src).toBe(originalUrl);
    expect(frame?.isConnected).toBe(false);
    expect(location.href).toBe(before);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === 'https://www.google.com/')).toBe(
      true,
    );
  });
  it.each([
    'https://evil.invalid/search',
    originalUrl + '&q=forged',
    originalUrl.replace('udm=50', 'udm=14'),
    originalUrl.replace('fictional-thread-1', 'different'),
    'invalid',
  ])('rejects an unsafe saved destination before reading: %s', async (originalUrl) => {
    expect(await readGoogleDocument({ ...request(), originalUrl })).toEqual({
      status: 'unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires a verified identity and a messages operation for a saved destination', async () => {
    const input = request();
    delete input.expectedIdentity;
    expect(await readGoogleDocument(input)).toEqual({ status: 'unavailable' });
    expect(await readGoogleDocument({ ...request(), operation: { kind: 'inspect' } })).toEqual({
      status: 'unavailable',
    });
  });
  it.each([
    'https://evil.invalid/search?udm=50&mtid=fictional-thread-1',
    originalUrl.replace('/search?', '/other?'),
    originalUrl.replace('fictional-thread-1', 'different'),
    originalUrl.replace('udm=50', 'udm=14'),
    originalUrl + '&authuser=1',
  ])('discards redirected frames: %s', async (url) => {
    childUrl = url;
    expect(await readGoogleDocument(request())).toEqual({ status: 'scope-changed' });
  });
  it('rejects a foreign frame account', async () => {
    child
      .querySelector('a')
      ?.setAttribute('aria-label', 'Google Account: Other (other@example.invalid)');
    expect(await readGoogleDocument(request())).toEqual({ status: 'scope-changed' });
  });
  it.each(['cancel', 'timeout', 'source', 'delayed', 'blank', 'blocked'] as const)(
    'settles and cleans up during %s',
    async (reason) => {
      vi.useFakeTimers();
      child.body.innerHTML = reason === 'blank' ? '' : label();

      if (reason === 'blocked') childUrl = 'about:blank';

      const pending = readGoogleDocument(request());
      await vi.waitFor(() => expect(frame).toBeDefined());

      if (reason === 'cancel') abortGoogleDocumentRead('fiction-frame');
      else if (reason === 'source')
        vi.stubGlobal('location', new URL('https://www.google.com/search?udm=50&mtid=changed'));
      else if (reason === 'delayed') turn('A later TV show about time travel.');

      await vi.advanceTimersByTimeAsync(
        reason === 'timeout' || reason === 'blank' || reason === 'blocked' ? 8000 : 100,
      );
      expect(await pending).toMatchObject({
        status:
          reason === 'cancel'
            ? 'cancelled'
            : reason === 'source'
              ? 'scope-changed'
              : reason === 'delayed'
                ? 'success'
                : 'timeout',
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['account', 'url'] as const)(
    'discards a frame whose %s changes during the final identity check',
    async (change) => {
      fetchMock
        .mockImplementationOnce(
          async () => new Response(label(), { headers: { 'content-type': 'text/html' } }),
        )
        .mockImplementationOnce(async () => {
          if (change === 'account') child.querySelector('a')?.remove();
          else childUrl = originalUrl + '&changed=1';

          return new Response(label(), { headers: { 'content-type': 'text/html' } });
        });
      expect(await readGoogleDocument(request())).toEqual({ status: 'scope-changed' });
    },
  );
  it.each(['size', 'count'] as const)('rejects rendered message %s over budget', async (reason) => {
    child.body.innerHTML = label();

    if (reason === 'size') turn('x'.repeat(3_000_001));
    else for (let i = 0; i < 2049; i++) turn('Fiction');

    expect(await readGoogleDocument(request())).toEqual({ status: 'schema-changed' });
  });
});
