import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptProvider } from '../../../src/providers/chatgpt/adapter';
import type { ChatGptReadPort } from '../../../src/providers/chatgpt/transport';
import { chatGptRequest, selectedChatGptScope } from '../../fixtures/chatgpt/requests';
import {
  conversationId,
  otherConversationId,
  identity,
  searchBody,
  searchItem,
  listBody,
  messagesBody,
  readResult,
} from '../../fixtures/chatgpt/wire';
import { deferred } from '../../platform/helpers';

const context = () => ({ signal: new AbortController().signal });

function harness() {
  const port = {
    read: vi.fn<ChatGptReadPort['read']>().mockResolvedValue(readResult(searchBody())),
  };
  const provider = new ChatGptProvider(selectedChatGptScope(), port);

  return { port, provider, request: chatGptRequest() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connected ChatGPT provider', () => {
  it('exposes a session-required capability descriptor without claiming authentication', () => {
    expect(harness().provider.availability).toEqual({
      status: 'session-required',
      operations: ['search', 'list', 'messages'],
      account: 'personal-only',
    });
  });
  it('inspects the session and normalizes a scoped keyword response', async () => {
    const { provider, port, request } = harness();
    port.read.mockResolvedValueOnce(readResult());
    expect(await provider.inspectSession(context())).toEqual({
      status: 'ready',
      scope: request.scope,
    });
    const result = await provider.search(request, context());
    expect(result.status).toBe('success');
    if (result.status === 'success')
      expect(result.candidates[0]?.conversationId).toBe(conversationId);
    expect(port.read.mock.calls[1]?.[0]).toEqual({ kind: 'search', query: request.query.text });
    expect(port.read.mock.calls[1]?.[1]).toBe(identity);
  });
  it('lists a bounded page without substituting an empty search', async () => {
    const { provider, port, request } = harness();
    port.read.mockResolvedValueOnce(readResult(listBody()));
    expect((await provider.list(request, context())).status).toBe('success');
    expect(port.read.mock.calls[0]?.[0]).toEqual({ kind: 'list' });
  });
  it('reports unknown dates with a date filter', async () => {
    const { provider, port, request } = harness();
    request.query.dateRange = {
      start: '2025-01-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z',
    };
    port.read.mockResolvedValueOnce(
      readResult(searchBody([{ ...searchItem(), update_time: null }])),
    );
    const result = await provider.search(request, context());
    if (result.status !== 'success') throw Error('Expected success');
    expect(result.coverage.reasons).toContain('unknown-dates');
    expect(result.candidates[0]).not.toHaveProperty('date');
  });
  it.each([
    'login-expired',
    'permission-needed',
    'unavailable',
    'schema-changed',
    'timeout',
    'cancelled',
    'scope-changed',
    'interrupted',
    'rate-limited',
  ] as const)('preserves %s independently of no-match success', async (status) => {
    const { provider, port, request } = harness();
    port.read.mockResolvedValueOnce({
      status,
      ...(status === 'rate-limited' ? { retryAfterMs: 5000 } : {}),
    });
    const result = await provider.search(request, context());
    expect(result).toEqual({
      requestId: request.requestId,
      scope: request.scope,
      status,
      ...(status === 'rate-limited' ? { retryAfterMs: 5000 } : {}),
    });
    if (status === 'login-expired' || status === 'scope-changed')
      expect((await provider.search(request, context())).status).toBe('scope-changed');
  });
  it.each([
    'login-expired',
    'permission-needed',
    'scope-changed',
    'timeout',
    'rate-limited',
  ] as const)('maps inspection failure %s to the session contract', async (status) => {
    const { provider, port } = harness();
    port.read.mockResolvedValueOnce({ status });
    expect((await provider.inspectSession(context())).status).toBe(
      ['login-expired', 'permission-needed', 'scope-changed'].includes(status)
        ? status
        : 'unavailable',
    );
  });
  it.each([
    {},
    null,
    {
      status: 'success',
      identityBefore: identity,
      identityAfter: identity,
      body: {},
      extra: 'private',
    },
    { status: 'rate-limited', retryAfterMs: 300001 },
    { ...readResult(), identityBefore: 'bad' },
  ])('rejects malformed read-port replies %j', async (reply) => {
    const { provider, port, request } = harness();
    port.read.mockResolvedValueOnce(reply);
    expect((await provider.search(request, context())).status).toBe('schema-changed');
  });
  it('rejects malformed wire success and does not retain it for enrichment', async () => {
    const { provider, port, request } = harness();
    port.read.mockResolvedValueOnce(readResult({ items: [] }));
    expect((await provider.search(request, context())).status).toBe('schema-changed');
    expect((await provider.enrich(request, context())).status).toBe('scope-changed');
  });
  it.each(['before-after', 'next-operation'])(
    'permanently retires changed identity: %s',
    async (kind) => {
      const { provider, port, request } = harness();
      if (kind === 'next-operation') await provider.search(request, context());
      port.read.mockResolvedValueOnce({
        ...readResult(searchBody()),
        identityBefore: kind === 'before-after' ? identity : 'b'.repeat(64),
        identityAfter: 'b'.repeat(64),
      });
      expect((await provider.search(request, context())).status).toBe('scope-changed');
      expect((await provider.inspectSession(context())).status).toBe('scope-changed');
    },
  );
  it('does not access the port for cancellation, wrong generation, or a retired instance', async () => {
    const { provider, port, request } = harness();
    const controller = new AbortController();
    controller.abort();
    expect((await provider.search(request, { signal: controller.signal })).status).toBe(
      'cancelled',
    );
    expect(
      (
        await provider.search(
          { ...request, scope: { ...request.scope, generation: 99 } },
          context(),
        )
      ).status,
    ).toBe('scope-changed');
    expect((await provider.enrich(request, { signal: controller.signal })).status).toBe(
      'cancelled',
    );
    provider.invalidate();
    expect((await provider.inspectSession(context())).status).toBe('scope-changed');
    expect(port.read).not.toHaveBeenCalled();
  });
  it('does not log or echo provider exception or cancellation reasons', async () => {
    const { provider, port, request } = harness();
    port.read.mockRejectedValueOnce(Error('SYNTHETIC PRIVATE EXCEPTION'));
    const logs = ['log', 'warn', 'error', 'info', 'debug'].map((name) =>
      vi.spyOn(console, name as 'log').mockImplementation(() => {}),
    );
    expect(await provider.search(request, context())).toEqual({
      requestId: request.requestId,
      scope: request.scope,
      status: 'unavailable',
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'cancel', 'invalidate', 'replace'])(
    'settles a hung port and ignores late success on %s',
    async (kind) => {
      vi.useFakeTimers();
      const { provider, port, request } = harness();
      const held = deferred<unknown>();
      port.read.mockReturnValueOnce(held.promise);
      const c = new AbortController();
      const first = provider.search(request, { signal: c.signal });
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
      if (kind === 'cancel') c.abort(Error('Private reason'));
      if (kind === 'invalidate') provider.invalidate();

      if (kind === 'replace') {
        expect(
          (
            await provider.search(
              { ...request, requestId: 'replacement' as typeof request.requestId },
              context(),
            )
          ).status,
        ).toBe('success');
      }

      expect((await first).status).toBe(
        kind === 'timeout' ? 'timeout' : kind === 'invalidate' ? 'scope-changed' : 'cancelled',
      );
      held.resolve(readResult(searchBody()));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('adds API-message provenance only to retrieved candidates, preserving original snippets', async () => {
    const { provider, port, request } = harness();
    await provider.search(request, context());
    port.read.mockResolvedValueOnce(readResult(messagesBody()));
    const result = await provider.enrich(request, context());
    if (result.status !== 'success') throw Error('Expected success');
    expect(result.candidates[0]?.evidence.map((e) => e.source)).toEqual([
      'native-snippet',
      'provider-message',
      'provider-message',
    ]);
    expect(result.candidates[0]?.evidence.at(-1)?.text).toBe('  Exact fictional message.  ');
    expect(result.coverage.reasons).toContain('missing-evidence');
    expect(result.coverage.extent).toBe('partial');
    expect(port.read.mock.calls[1]?.[0]).toEqual({ kind: 'messages', conversationId });
  });
  it('rejects enrichment of another request and stale snapshots; never accepts external IDs/links', async () => {
    const { provider, port, request } = harness();
    expect((await provider.enrich(request, context())).status).toBe('scope-changed');
    await provider.search(request, context());
    expect(
      (
        await provider.enrich(
          { ...request, requestId: 'other' as typeof request.requestId },
          context(),
        )
      ).status,
    ).toBe('scope-changed');
    port.read.mockResolvedValueOnce(readResult(searchBody([])));
    await provider.search(
      { ...request, requestId: 'replacement' as typeof request.requestId },
      context(),
    );
    expect((await provider.enrich(request, context())).status).toBe('scope-changed');
  });
  it.each(['failure', 'schema'])(
    'propagates enrichment %s without retaining raw messages',
    async (kind) => {
      const { provider, port, request } = harness();
      await provider.search(request, context());
      port.read.mockResolvedValueOnce(
        kind === 'failure' ? { status: 'rate-limited' } : readResult({}),
      );
      expect((await provider.enrich(request, context())).status).toBe(
        kind === 'failure' ? 'rate-limited' : 'schema-changed',
      );
    },
  );
  it('limits enrichment to three conversations and discloses the query budget', async () => {
    const { provider, port, request } = harness();
    const ids = [
      conversationId,
      otherConversationId,
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    port.read.mockResolvedValueOnce(readResult(searchBody(ids.map(searchItem))));
    await provider.search(request, context());
    port.read.mockImplementation(async (op) =>
      readResult(op.kind === 'messages' ? messagesBody(op.conversationId) : null),
    );
    const result = await provider.enrich(request, context());
    if (result.status !== 'success') throw Error('Expected success');
    expect(port.read).toHaveBeenCalledTimes(4);
    expect(result.coverage.reasons).toContain('query-budget');
    expect(result.candidates[3]?.evidence).toHaveLength(1);
  });
});

it('honors the per-candidate evidence cap while retaining distinct exact API text', async () => {
  const { provider, port, request } = harness();
  port.read.mockResolvedValueOnce(
    readResult(
      searchBody(
        Array.from({ length: 7 }, (_, n) => ({
          ...searchItem(),
          snippet: `Existing snippet ${n}`,
        })),
      ),
    ),
  );
  await provider.search(request, context());
  port.read.mockResolvedValueOnce(readResult(messagesBody()));
  const result = await provider.enrich(request, context());
  if (result.status !== 'success') throw Error('Expected success');
  expect(result.candidates[0]?.evidence).toHaveLength(8);
  expect(result.candidates[0]?.evidence.at(-1)?.text).toBe('Synthetic question?');
});
it('deduplicates an API excerpt already present as exact native evidence', async () => {
  const { provider, port, request } = harness();
  port.read.mockResolvedValueOnce(
    readResult(searchBody([{ ...searchItem(), snippet: 'Synthetic question?' }])),
  );
  await provider.search(request, context());
  port.read.mockResolvedValueOnce(readResult(messagesBody()));
  const result = await provider.enrich(request, context());
  if (result.status !== 'success') throw Error('Expected success');
  expect(result.candidates[0]?.evidence).toHaveLength(2);
});
