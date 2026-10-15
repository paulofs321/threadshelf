import type { ChatGptOperation, ChatGptReadResult } from './transport';

// Serialized by Chrome into ISOLATED world. Keep all runtime dependencies inside this function.
// Authentication is transient in this browser document; credentials never enter the result.
export async function readChatGptDocument(
  operation: ChatGptOperation,
  requestId: string,
  salt: string,
  expectedIdentity?: string,
): Promise<ChatGptReadResult> {
  const failed = (
    status: Exclude<ChatGptReadResult['status'], 'success' | 'rate-limited'>,
  ): ChatGptReadResult => ({ status });

  if (window !== window.top || location.origin !== 'https://chatgpt.com')
    return failed('scope-changed');

  if (!/^[a-zA-Z0-9-]{1,128}$/.test(requestId) || !/^[a-zA-Z0-9-]{16,128}$/.test(salt))
    return failed('unavailable');

  if (!operation || !['inspect', 'search', 'list', 'messages'].includes(operation.kind))
    return failed('unavailable');

  if (
    operation.kind === 'search' &&
    (typeof operation.query !== 'string' ||
      !operation.query.trim() ||
      operation.query.length > 1_024)
  )
    return failed('unavailable');

  if (
    operation.kind === 'messages' &&
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operation.conversationId)
  )
    return failed('unavailable');

  if (expectedIdentity !== undefined && !/^[a-f0-9]{64}$/.test(expectedIdentity))
    return failed('unavailable');

  const root = globalThis as typeof globalThis & {
    __threadshelfChatGptReads?: Map<string, AbortController>;
  };
  const registry = (root.__threadshelfChatGptReads ??= new Map());

  if (registry.size >= 2 || registry.has(requestId)) return failed('unavailable');

  const controller = new AbortController();
  registry.set(requestId, controller);
  const href = location.href;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 8_000);
  let failure: ChatGptReadResult = failed('unavailable');

  const stop = (result: ChatGptReadResult): never => {
    failure = result;
    throw new Error('Provider read stopped.');
  };

  const check = () => {
    if (controller.signal.aborted) stop(failed(timedOut ? 'timeout' : 'cancelled'));

    if (location.href !== href) stop(failed('scope-changed'));
  };

  const maximum = 2_097_152;

  async function bytes(response: Response): Promise<string> {
    const declared = response.headers.get('content-length');

    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum)
      stop(failed('schema-changed'));

    const stream = response.body;

    if (!stream) return stop(failed('schema-changed'));

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    const cancel = () => {
      void reader.cancel().catch(() => {});
    };

    controller.signal.addEventListener('abort', cancel, { once: true });

    try {
      for (;;) {
        check();
        const part = await reader.read();
        check();

        if (part.done) break;

        size += part.value.byteLength;

        if (size > maximum) stop(failed('schema-changed'));

        chunks.push(part.value);
      }

      const value = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        value.set(chunk, offset);
        offset += chunk.byteLength;
      }

      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(value);
      } catch {
        return stop(failed('schema-changed'));
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
      chunks.length = 0;
    }
  }

  async function get(url: string, mime: 'json' | 'html', token?: string): Promise<string> {
    check();
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    check();

    const reject = (result: ChatGptReadResult): never => {
      void response.body?.cancel().catch(() => {});

      return stop(result);
    };

    if (response.type === 'opaqueredirect' || response.redirected)
      return reject(failed('unavailable'));

    if (response.status === 401) return reject(failed('login-expired'));

    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      let retryAfterMs: number | undefined;

      if (raw !== null && /^\d{1,12}$/.test(raw))
        retryAfterMs = Math.min(300_000, Number(raw) * 1_000);
      // Accept only the standard IMF-fixdate shape, not loose locale/number parsing.
      else if (
        raw !== null &&
        /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
          raw,
        )
      ) {
        const date = Date.parse(raw);

        if (Number.isFinite(date)) retryAfterMs = Math.min(300_000, Math.max(0, date - Date.now()));
      }

      return reject({
        status: 'rate-limited',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }

    if (response.status !== 200) return reject(failed('unavailable'));

    const type = response.headers.get('content-type') ?? '';

    if (!(mime === 'json' ? /^application\/json(?:\s*;|$)/i : /^text\/html(?:\s*;|$)/i).test(type))
      return reject(failed('schema-changed'));

    return bytes(response);
  }

  function bootstrap(doc: Document) {
    const sessions: { userId: string; accountId: string; token: string; structure: string }[] = [];

    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      if ((script.textContent?.length ?? 0) > maximum) stop(failed('schema-changed'));

      let data;

      try {
        data = JSON.parse(script.textContent ?? '');
      } catch {
        continue;
      }

      const session = data?.session;

      if (!session) continue;

      if (
        typeof session.account?.structure !== 'string' ||
        typeof session.user?.id !== 'string' ||
        !session.user.id ||
        session.user.id.length > 256 ||
        typeof session.account?.id !== 'string' ||
        !session.account.id ||
        session.account.id.length > 256 ||
        typeof session.accessToken !== 'string' ||
        !session.accessToken ||
        session.accessToken.length > 32_768
      )
        stop(failed('schema-changed'));

      sessions.push({
        userId: session.user.id,
        accountId: session.account.id,
        token: session.accessToken,
        structure: session.account.structure,
      });
    }

    if (sessions.length !== 1) return stop(failed('schema-changed'));

    return sessions[0] as { userId: string; accountId: string; token: string; structure: string };
  }

  let observedIdentity: string | undefined;

  async function fresh() {
    const current = bootstrap(document);

    if (current.structure !== 'personal')
      stop(
        failed(
          expectedIdentity !== undefined || observedIdentity !== undefined
            ? 'scope-changed'
            : 'unavailable',
        ),
      );

    const html = await get('https://chatgpt.com/', 'html');
    check();
    const server = bootstrap(new DOMParser().parseFromString(html, 'text/html'));

    if (current.userId !== server.userId || current.accountId !== server.accountId)
      stop(failed('scope-changed'));

    if (server.structure !== 'personal')
      stop(
        failed(
          expectedIdentity !== undefined || observedIdentity !== undefined
            ? 'scope-changed'
            : 'unavailable',
        ),
      );

    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([salt, server.userId, server.accountId])),
    );
    const identity = Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');

    if (expectedIdentity !== undefined && expectedIdentity !== identity)
      stop(failed('scope-changed'));

    observedIdentity ??= identity;

    return { identity, token: server.token };
  }

  try {
    let before = await fresh();
    let body: unknown = null;

    if (operation.kind !== 'inspect') {
      let url: URL;

      if (operation.kind === 'search') {
        url = new URL('https://chatgpt.com/backend-api/global/search');
        url.searchParams.set('query', operation.query);
        url.searchParams.set('limit', '30');
        url.searchParams.set('sources', 'conversation');
        url.searchParams.set('query_id', crypto.randomUUID());
      } else if (operation.kind === 'list')
        url = new URL('https://chatgpt.com/backend-api/conversations');
      else
        url = new URL(`https://chatgpt.com/backend-api/conversation/${operation.conversationId}`);

      const json = await get(url.href, 'json', before.token);
      before = { identity: before.identity, token: '' };

      try {
        body = JSON.parse(json);
      } catch {
        return failed('schema-changed');
      }
    }

    const after = await fresh();
    check();

    if (before.identity !== after.identity) return failed('scope-changed');

    return {
      status: 'success',
      identityBefore: before.identity,
      identityAfter: after.identity,
      body,
    };
  } catch {
    if (controller.signal.aborted) return failed(timedOut ? 'timeout' : 'cancelled');

    return failure;
  } finally {
    clearTimeout(timer);
    controller.abort();
    registry.delete(requestId);

    if (registry.size === 0) delete root.__threadshelfChatGptReads;
  }
}

// Also serialized into the same ISOLATED document. Cannot cancel another operation by URL/code.
export function abortChatGptDocumentRead(requestId: string): void {
  const root = globalThis as typeof globalThis & {
    __threadshelfChatGptReads?: Map<string, AbortController>;
  };
  root.__threadshelfChatGptReads?.get(requestId)?.abort();
}
