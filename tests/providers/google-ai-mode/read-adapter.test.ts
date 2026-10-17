import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAiModeProvider } from '../../../src/providers/google-ai-mode/adapter';
import type { GoogleAiModeReadPort } from '../../../src/providers/google-ai-mode/transport';
import type { ProviderOutcome } from '../../../src/contracts';
import { googleAiModeRequest } from '../../fixtures/google-ai-mode/requests';
import { googleJson, googleMatch, googleThread } from '../../fixtures/google-ai-mode/wire';

const context = () => ({ signal: new AbortController().signal });
const identity = 'a'.repeat(64);
const success = (body = googleJson([[googleMatch()]])) => ({
  status: 'success',
  identityBefore: identity,
  identityAfter: identity,
  response: { status: 200, contentType: 'application/json', retryAfter: null, body },
});

function fixture(value: unknown = success()) {
  const port = {
    read: vi.fn<GoogleAiModeReadPort['read']>().mockResolvedValue(value),
    openEvidence: vi.fn<NonNullable<GoogleAiModeReadPort['openEvidence']>>().mockResolvedValue({
      status: 'success',
      identityBefore: identity,
      identityAfter: identity,
      rendered: ['An exact fictional rendered turn.'],
    }),
  };
  const request = googleAiModeRequest();
  let next = 0;
  const provider = new GoogleAiModeProvider(request.scope, port, {
    freshId: () => `fictional-${next++}`,
    now: () => 0,
  });

  return { port, request, provider };
}

afterEach(() => vi.useRealTimers());

describe('Google native read adapter', () => {
  it('allocates independent opaque candidate IDs with the production default factory', async () => {
    const request = googleAiModeRequest();
    const port = { read: vi.fn<GoogleAiModeReadPort['read']>().mockResolvedValue(success()) };
    const first = await new GoogleAiModeProvider(request.scope, port).search(request, context());
    const second = await new GoogleAiModeProvider(request.scope, port).search(request, context());
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');

    if (first.status !== 'success' || second.status !== 'success')
      throw new Error('Expected synthetic success');

    expect(first.candidates[0]?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.candidates[0]?.id).not.toBe(second.candidates[0]?.id);
  });
  it('searches and lists through the injected port with exact normalized evidence', async () => {
    const { port, request, provider } = fixture();
    const result = await provider.search(request, context());
    expect(result.status).toBe('success');

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.evidence[1]?.source).toBe('native-snippet');
    expect(port.read).toHaveBeenCalledWith(
      { kind: 'search', query: request.query.text },
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    port.read.mockResolvedValue(
      success(googleJson([[googleThread()], null, 0, null, null, 'fictional-tail'])),
    );
    expect((await provider.list(request, context())).status).toBe('success');
    expect(port.read).toHaveBeenLastCalledWith({ kind: 'list' }, identity, expect.anything());
  });

  it('recognizes genuine no-match success with unknown coverage', async () => {
    const { provider, request } = fixture(success(googleJson([])));
    expect(await provider.search(request, context())).toMatchObject({
      status: 'success',
      candidates: [],
      coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
    });
  });

  it.each([
    'login-expired',
    'permission-needed',
    'unavailable',
    'schema-changed',
    'rate-limited',
    'timeout',
    'cancelled',
    'scope-changed',
    'interrupted',
  ] as const)('preserves explicit %s read failure', async (status) => {
    const { provider, request } = fixture({ status });
    expect(await provider.search(request, context())).toEqual({
      status,
      requestId: request.requestId,
      scope: request.scope,
    });
  });

  it.each([
    null,
    {},
    { status: 'success' },
    { ...success(), extra: 'private' },
    { ...success(), response: undefined },
    { ...success(), rendered: ['unexpected'] },
  ])('rejects malformed or wrong-operation replies', async (value) => {
    const { provider, request } = fixture(value);
    expect((await provider.search(request, context())).status).toBe('schema-changed');
  });

  it('maps HTTP errors and parser failures without leaking bodies', async () => {
    const { port, provider, request } = fixture();
    port.read.mockResolvedValue({
      ...success(),
      response: { ...success().response, status: 429, retryAfter: '2', body: 'Fictional secret' },
    });
    expect(await provider.search(request, context())).toMatchObject({
      status: 'rate-limited',
      retryAfterMs: 2000,
    });
    port.read.mockResolvedValue(success('Fictional secret malformed response'));
    expect(await provider.search(request, context())).toEqual({
      status: 'schema-changed',
      requestId: request.requestId,
      scope: request.scope,
    });
    port.read.mockRejectedValue(new Error('Fictional secret provider exception'));
    expect((await provider.search(request, context())).status).toBe('unavailable');
  });

  it.each(['login-expired', 'permission-needed'] as const)(
    'retires identity and candidate access after %s',
    async (status) => {
      const { provider, request, port } = fixture();
      await provider.search(request, context());
      port.read.mockResolvedValue({ status });
      expect((await provider.inspectSession(context())).status).toBe(status);
      expect((await provider.messages(request, 'fictional-thread-1', context())).status).toBe(
        'scope-changed',
      );
      expect(port.openEvidence).not.toHaveBeenCalled();
    },
  );
  it('retires a scope after an authenticated HTTP401 reply', async () => {
    const { provider, request, port } = fixture();
    port.read.mockResolvedValue({ ...success(), response: { ...success().response, status: 401 } });
    expect((await provider.search(request, context())).status).toBe('login-expired');
    expect((await provider.inspectSession(context())).status).toBe('scope-changed');
  });

  it('requires stable identity both around a read and across operations', async () => {
    const { port, provider, request } = fixture();
    expect((await provider.search(request, context())).status).toBe('success');
    port.read.mockResolvedValue({
      ...success(),
      identityBefore: 'b'.repeat(64),
      identityAfter: 'b'.repeat(64),
    });
    expect((await provider.search(request, context())).status).toBe('scope-changed');
    expect((await provider.search(request, context())).status).toBe('scope-changed');
    const changed = fixture({ ...success(), identityAfter: 'b'.repeat(64) });
    expect((await changed.provider.search(changed.request, context())).status).toBe(
      'scope-changed',
    );
  });

  it('reports ready only after a valid inspection and hides unsupported session statuses', async () => {
    const inspected = { status: 'success', identityBefore: identity, identityAfter: identity };
    const { provider, port, request } = fixture(inspected);
    const ready = await provider.inspectSession(context());
    expect(ready).toEqual({ status: 'ready', scope: request.scope });

    if (ready.status !== 'ready') throw new Error('Expected synthetic ready');

    ready.scope.generation++;
    expect(await provider.inspectSession(context())).toEqual({
      status: 'ready',
      scope: request.scope,
    });

    for (const status of ['login-expired', 'permission-needed', 'scope-changed'] as const) {
      const f = fixture({ status });
      expect(await f.provider.inspectSession(context())).toEqual({
        status,
        provider: 'google-ai-mode',
        generation: f.request.scope.generation,
      });
    }

    port.read.mockResolvedValue({ status: 'timeout' });
    expect(await provider.inspectSession(context())).toMatchObject({ status: 'unavailable' });
    port.read.mockResolvedValue(success());
    expect(await provider.inspectSession(context())).toMatchObject({ status: 'unavailable' });
  });

  it.each(['cancel', 'invalidate', 'timeout', 'replacement'] as const)(
    'discards late output after %s and cleans watchdogs',
    async (action) => {
      vi.useFakeTimers();
      const { provider, request, port } = fixture();
      let finish: ((value: unknown) => void) | undefined;
      port.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const controller = new AbortController();
      const pending = provider.search(request, { signal: controller.signal });

      if (action === 'cancel') controller.abort();

      if (action === 'invalidate') provider.invalidate();

      if (action === 'timeout') await vi.advanceTimersByTimeAsync(10_000);

      if (action === 'replacement')
        expect((await provider.search(request, context())).status).toBe('success');

      const result = await pending;
      expect(result.status).toBe(
        action === 'cancel' ? 'cancelled' : action === 'timeout' ? 'timeout' : 'scope-changed',
      );
      finish?.(success());
      await Promise.resolve();
      expect(result).not.toHaveProperty('candidates');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['cancel', 'invalidate', 'timeout'] as const)(
    'preserves %s when a faulty port throws during cancellation',
    async (action) => {
      vi.useFakeTimers();
      const { provider, request, port } = fixture();
      const controller = new AbortController();
      port.read.mockImplementationOnce(() => {
        if (action === 'cancel') controller.abort();

        if (action === 'invalidate') provider.invalidate();

        if (action === 'timeout') vi.advanceTimersByTime(10_000);

        throw new Error('Fictional private synchronous port failure');
      });
      expect((await provider.search(request, { signal: controller.signal })).status).toBe(
        action === 'cancel' ? 'cancelled' : action === 'timeout' ? 'timeout' : 'scope-changed',
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('enriches only a candidate retrieved for this exact request and snapshots its metadata', async () => {
    const { provider, request, port } = fixture();
    const retrieved = await provider.search(request, context());

    if (retrieved.status !== 'success') throw new Error('Expected synthetic success');

    const candidate = retrieved.candidates[0];

    if (!candidate) throw new Error('Missing synthetic candidate');

    candidate.originalUrl = 'https://evil.invalid';
    const result = await provider.messages(request, candidate.conversationId, context());
    expect(result.status).toBe('success');

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.originalUrl).not.toBe('https://evil.invalid');
    expect(result.candidates[0]?.evidence.at(-1)).toEqual({
      id: 'rendered-0',
      text: 'An exact fictional rendered turn.',
      source: 'rendered-message',
    });
    expect(result.coverage.reasons).toContain('missing-evidence');
    expect(port.openEvidence).toHaveBeenCalledTimes(1);
    expect((await provider.messages(request, 'unknown', context())).status).toBe('unavailable');
    expect(
      (
        await provider.messages(
          { ...request, query: { ...request.query, text: 'replacement' } },
          candidate.conversationId,
          context(),
        )
      ).status,
    ).toBe('unavailable');
    expect(port.openEvidence).toHaveBeenCalledTimes(1);
  });

  it('does not open evidence without a supported port or current retrieved inventory', async () => {
    const request = googleAiModeRequest();
    expect(
      (await new GoogleAiModeProvider(request.scope).messages(request, 'fictional', context()))
        .status,
    ).toBe('unavailable');
    const { provider, port } = fixture();
    await provider.search(request, context());
    port.read.mockResolvedValue({ status: 'unavailable' });
    await provider.search(request, context());
    expect((await provider.messages(request, 'fictional-thread-1', context())).status).toBe(
      'unavailable',
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      (await provider.messages(request, 'fictional', { signal: controller.signal })).status,
    ).toBe('cancelled');
    provider.invalidate();
    expect((await provider.messages(request, 'fictional', context())).status).toBe('scope-changed');
  });

  it('handles evidence failure/empty/schema/account outcomes and preserves explicit date limits', async () => {
    const { provider, request, port } = fixture();
    request.query.dateRange = {
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
    };
    await provider.search(request, context());

    for (const value of [
      { status: 'timeout' },
      { status: 'success', identityBefore: identity, identityAfter: identity },
      { status: 'success', identityBefore: identity, identityAfter: identity, rendered: [] },
      success(),
    ]) {
      port.openEvidence.mockResolvedValue(value);
      expect((await provider.messages(request, 'fictional-thread-1', context())).status).toBe(
        value.status === 'timeout' ? 'timeout' : 'schema-changed',
      );
    }

    port.openEvidence.mockResolvedValue({
      status: 'success',
      identityBefore: identity,
      identityAfter: identity,
      rendered: ['Exact fictional turn.'],
    });
    const result = await provider.messages(request, 'fictional-thread-1', context());
    expect(result).toMatchObject({
      status: 'success',
      coverage: { reasons: ['unknown-reach', 'missing-evidence'] },
    });
  });

  it('bounds enrichment when native evidence already fills the candidate', async () => {
    const row = googleThread();
    const { provider, request } = fixture(
      success(googleJson([Array.from({ length: 7 }, (_, i) => googleMatch(row, `passage ${i}`))])),
    );
    await provider.search(request, context());
    const result: ProviderOutcome = await provider.messages(
      request,
      'fictional-thread-1',
      context(),
    );

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.evidence).toHaveLength(8);
  });
});
