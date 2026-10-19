import type { GoogleReadOperation } from './transport';

export interface GoogleDocumentRead {
  operation: GoogleReadOperation;
  partition: string;
  operationId: string;
  expectedIdentity?: string;
  originalUrl?: string;
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

  const kinds = ['inspect', 'list', 'search', 'messages'];

  if (
    !kinds.includes(input.operation.kind) ||
    !input.partition ||
    !input.operationId ||
    (input.operation.kind === 'search' &&
      (!input.operation.query.trim() || input.operation.query.length > 1024)) ||
    (input.operation.kind === 'messages' &&
      input.operation.query !== undefined &&
      (!input.operation.query.trim() || input.operation.query.length > 1024))
  )
    return { status: 'unavailable' };

  if (
    input.operation.kind === 'messages' &&
    input.originalUrl === undefined &&
    new URLSearchParams(location.search).get('mtid') !== input.operation.conversationId
  )
    return { status: 'scope-changed' };

  let destination: URL | undefined;

  if (input.originalUrl !== undefined) {
    try {
      destination = new URL(input.originalUrl);
      const parameters = destination.searchParams;

      if (
        input.operation.kind !== 'messages' ||
        !input.expectedIdentity ||
        destination.origin !== origin ||
        destination.pathname !== '/search' ||
        destination.username ||
        destination.password ||
        destination.port ||
        destination.hash ||
        [...destination.searchParams.keys()].length !== 4 ||
        !['mtid', 'mstk', 'csuir', 'udm'].every((key) => parameters.getAll(key).length === 1) ||
        destination.searchParams.get('mtid') !== input.operation.conversationId ||
        destination.searchParams.get('udm') !== '50' ||
        destination.searchParams.get('csuir') !== '1' ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(destination.searchParams.get('mstk') ?? '')
      )
        return { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  const owned = globalThis as typeof globalThis & {
    __threadshelfGoogleReadControllers?: Map<string, AbortController>;
  };
  const controllers = (owned.__threadshelfGoogleReadControllers ??= new Map());

  if (controllers.size >= 4 || controllers.has(input.operationId)) return { status: 'unavailable' };

  const controller = new AbortController();
  controllers.set(input.operationId, controller);
  let timedOut = false;
  let frame: HTMLIFrameElement | undefined;
  const sourceUrl = location.href;
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

  async function messageDocument(): Promise<Document> {
    if (!destination) return document;

    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1000px;height:800px;opacity:0;pointer-events:none;border:0';
    frame.src = destination.href;
    document.body.appendChild(frame);

    for (;;) {
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');

      if (location.href !== sourceUrl) fail('scope-changed');

      const child = frame.contentDocument;

      if (child && child.URL !== 'about:blank') {
        const url = new URL(child.URL);

        if (
          url.origin !== origin ||
          url.pathname !== '/search' ||
          url.searchParams.get('mtid') !== destination.searchParams.get('mtid') ||
          url.searchParams.get('udm') !== '50' ||
          url.searchParams.has('authuser')
        )
          fail('scope-changed');

        const childAccount = account(child);

        if (childAccount && childAccount !== account(document)) fail('scope-changed');

        if (
          childAccount &&
          [...child.querySelectorAll<HTMLElement>('[data-last-turn], div.CKgc1d')].some(
            (element) => element.innerText?.trim() && element.getBoundingClientRect().width > 0,
          )
        )
          return child;
      }

      await new Promise<void>((resolve) => {
        const stopped = () => {
          clearTimeout(poll);
          resolve();
        };

        const poll = setTimeout(() => {
          controller.signal.removeEventListener('abort', stopped);
          resolve();
        }, 100);
        controller.signal.addEventListener('abort', stopped, { once: true });
      });
    }
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

    // AI Mode HTML can be a successful response without an account header. The fixed homepage
    // supplies the observed default-account control; compare it afresh around every operation.
    const response = await get(origin + '/');

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
    let evidenceDocument: Document | undefined;
    let evidenceUrl: string | undefined;

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

      // Reuse only a date already visible in this source document. Search never opens a thread.
      const conversationId = new URLSearchParams(location.search).get('mtid');
      const label = [...document.querySelectorAll<HTMLElement>('.UYpEO > .kwdzO')]
        .find((element) => element.getBoundingClientRect().width > 0 && element.textContent?.trim())
        ?.textContent?.trim();

      if (conversationId && conversationId.length <= 256 && label && label.length <= 80)
        dateLabel = { conversationId, text: label, observedAt: new Date().toISOString() };
    } else if (input.operation.kind === 'messages') {
      evidenceDocument = await messageDocument();
      evidenceUrl = evidenceDocument.URL;
      const turns = [...evidenceDocument.querySelectorAll<HTMLElement>('div.CKgc1d')].filter(
        (element) =>
          !element.parentElement?.closest('div.CKgc1d') &&
          element.querySelector('h2.iMqumd, div.pWvJNd, div.n6owBd'),
      );
      const blocks = turns.length
        ? turns
        : [...evidenceDocument.querySelectorAll<HTMLElement>('[data-last-turn]')];
      rendered = blocks
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => element.innerText)
        .filter((value) => value.trim().length > 0);

      if (
        rendered.length > 2048 ||
        rendered.reduce((sum, value) => sum + value.length, 0) > 3_000_000
      )
        fail('schema-changed');

      // Legacy unqualified reads retain their original small excerpts. Description selection happens
      // in the adapter, using all accessible turns rather than clipping before relevance selection.
      if (!destination && input.operation.query === undefined)
        rendered = rendered.slice(0, 4).map((value) => {
          const end = Math.min(value.length, 2000);

          return value.slice(0, /[\uD800-\uDBFF]/u.test(value.charAt(end - 1)) ? end - 1 : end);
        });

      if (!rendered.length) fail('unavailable');
    }

    const after = await inspect();

    if (
      before !== after ||
      (dateLabel !== undefined &&
        new URLSearchParams(location.search).get('mtid') !== dateLabel.conversationId) ||
      (input.operation.kind === 'messages' &&
        !destination &&
        new URLSearchParams(location.search).get('mtid') !== input.operation.conversationId) ||
      (destination &&
        (location.href !== sourceUrl ||
          evidenceDocument?.URL !== evidenceUrl ||
          evidenceDocument === undefined ||
          account(evidenceDocument) !== account(document)))
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
    frame?.remove();
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
