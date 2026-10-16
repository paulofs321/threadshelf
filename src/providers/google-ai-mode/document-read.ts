import type { GoogleReadOperation } from './transport';

export interface GoogleDocumentRead {
  operation: GoogleReadOperation;
  partition: string;
  operationId: string;
  expectedIdentity?: string;
}

// Chrome serializes this function. All runtime helpers/constants must stay inside its body.
// It executes only in the extension's isolated world; no page-global bridge is exposed.
export async function readGoogleDocument(input: GoogleDocumentRead): Promise<unknown> {
  const origin = 'https://www.google.com';

  if (
    window !== window.top ||
    location.origin !== origin ||
    location.pathname !== '/search' ||
    new URLSearchParams(location.search).get('udm') !== '50' ||
    new URLSearchParams(location.search).has('authuser')
  )
    return { status: 'unavailable' };

  const kinds = ['inspect', 'list', 'search', 'messages', 'date'];

  if (
    !kinds.includes(input.operation.kind) ||
    !input.partition ||
    !input.operationId ||
    (input.operation.kind === 'search' &&
      (!input.operation.query.trim() || input.operation.query.length > 1024))
  )
    return { status: 'unavailable' };

  if (
    (input.operation.kind === 'messages' || input.operation.kind === 'date') &&
    new URLSearchParams(location.search).get('mtid') !== input.operation.conversationId
  )
    return { status: 'scope-changed' };

  const owned = globalThis as typeof globalThis & {
    __threadshelfGoogleReadControllers?: Map<string, AbortController>;
  };
  const controllers = (owned.__threadshelfGoogleReadControllers ??= new Map());

  if (controllers.size >= 4 || controllers.has(input.operationId)) return { status: 'unavailable' };

  const controller = new AbortController();
  controllers.set(input.operationId, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 8000);

  function fail(status: string): never {
    throw new Error(status);
  }

  function account(document: Document): string | undefined {
    return (
      document
        .querySelector('a[href^="https://accounts.google.com/SignOutOptions"]')
        ?.getAttribute('aria-label')
        // The rendered account control can append a comma-separated accessibility annotation.
        // Keep the address parenthesized and final; annotation text cannot contain another account.
        ?.match(/\(([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\)(?:,[^\S\r\n]+[^@()\r\n]+)?\s*$/i)?.[1]
        ?.toLowerCase()
    );
  }

  async function body(response: Response): Promise<string> {
    if (Number(response.headers.get('content-length')) > 3_000_000) fail('schema-changed');

    const reader = response.body?.getReader();

    if (!reader) return '';

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let result = '',
      size = 0;

    try {
      for (;;) {
        const next = await reader.read();

        if (next.done) break;

        size += next.value.byteLength;

        if (size > 3_000_000) fail('schema-changed');

        result += decoder.decode(next.value, { stream: true });
      }

      result += decoder.decode();

      return result;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function get(url: string): Promise<Response> {
    if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');

    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
  }

  async function inspect(): Promise<string> {
    const renderedAccount = account(document);

    if (!renderedAccount) fail('unavailable');

    const response = await get(origin + '/search?udm=50');

    if (response.status === 401) fail('login-expired');

    if (response.status === 429) fail('rate-limited');

    if (response.status !== 200) fail('unavailable');

    if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      fail('schema-changed');

    const freshDocument = new DOMParser().parseFromString(await body(response), 'text/html');
    const freshAccount = account(freshDocument);

    if (!freshAccount) fail('unavailable');

    if (freshAccount !== renderedAccount) fail('scope-changed');

    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([input.partition, freshAccount])),
    );

    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join(
      '',
    );
  }

  try {
    const before = await inspect();

    if (input.expectedIdentity !== undefined && before !== input.expectedIdentity)
      fail('scope-changed');

    let response;
    let rendered;
    let dateLabel;

    if (input.operation.kind === 'search' || input.operation.kind === 'list') {
      const kind = input.operation.kind;
      const url = new URL(
        '/httpservice/web/AimThreadsService/' +
          (kind === 'search' ? 'SearchThreads' : 'ListThreads'),
        origin,
      );
      url.searchParams.set('udm', '50');
      url.searchParams.set(
        'reqpld',
        JSON.stringify(
          kind === 'search' ? [input.operation.query, 30, null, 2, null, 0] : [null, null, 0],
        ),
      );
      const result = await get(url.href);
      response = {
        status: result.status,
        contentType: result.headers.get('content-type'),
        retryAfter: result.headers.get('retry-after'),
        body: await body(result),
      };
    } else if (input.operation.kind === 'date') {
      // The date beneath the first visible question is a message date, never a creation/update date.
      // This class (capital O) was observed in the rendered conversation; fresh HTML omits it.
      for (;;) {
        if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');

        const label = [...document.querySelectorAll<HTMLElement>('.UYpEO > .kwdzO')]
          .find(
            (element) => element.getBoundingClientRect().width > 0 && element.textContent?.trim(),
          )
          ?.textContent?.trim();

        if (label) {
          if (label.length > 80) fail('schema-changed');

          dateLabel = { text: label, observedAt: new Date().toISOString() };
          break;
        }

        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(wait);
            resolve();
          };

          const wait = setTimeout(() => {
            controller.signal.removeEventListener('abort', stop);
            resolve();
          }, 100);
          controller.signal.addEventListener('abort', stop, { once: true });
        });
      }
    } else if (input.operation.kind === 'messages') {
      // Only the observed rendered last-turn block is supported; no complete-message API is inferred.
      const blocks = [...document.querySelectorAll<HTMLElement>('[data-last-turn]')];
      rendered = blocks
        .filter((e) => e.getBoundingClientRect().width > 0)
        .slice(0, 4)
        .map((e) => {
          const value = e.innerText;
          const end = Math.min(value.length, 2000);
          const last = value.charCodeAt(end - 1);

          return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
        })
        .filter((value) => value.trim().length > 0);

      if (!rendered.length) fail('unavailable');
    }

    const after = await inspect();

    if (
      before !== after ||
      ((input.operation.kind === 'messages' || input.operation.kind === 'date') &&
        new URLSearchParams(location.search).get('mtid') !== input.operation.conversationId)
    )
      fail('scope-changed');

    if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');

    return {
      status: 'success',
      identityBefore: before,
      identityAfter: after,
      ...(response === undefined ? {} : { response }),
      ...(dateLabel === undefined ? {} : { dateLabel }),
      ...(rendered === undefined ? {} : { rendered }),
    };
  } catch (error) {
    const allowed = [
      'login-expired',
      'unavailable',
      'schema-changed',
      'rate-limited',
      'scope-changed',
    ];

    return {
      status: controller.signal.aborted
        ? timedOut
          ? 'timeout'
          : 'cancelled'
        : error instanceof Error && allowed.includes(error.message)
          ? error.message
          : 'unavailable',
    };
  } finally {
    clearTimeout(timer);
    controllers.delete(input.operationId);

    if (!controllers.size) delete owned.__threadshelfGoogleReadControllers;
  }
}

export function abortGoogleDocumentRead(operationId: string): void {
  const owned = globalThis as typeof globalThis & {
    __threadshelfGoogleReadControllers?: Map<string, AbortController>;
  };
  owned.__threadshelfGoogleReadControllers?.get(operationId)?.abort();
}
