import { describe, expect, it, vi } from 'vitest';
import {
  limits,
  providerOutcomeSchemaFor,
  requireValid,
  searchOutcomeSchemaFor,
  SearchRequestSchema,
  SessionOutcomeSchema,
  validate,
} from '../../../src/contracts';
import type { ProviderPort, ProviderRequest, SessionScope } from '../../../src/contracts';
import { ChatGptProvider } from '../../../src/providers/chatgpt/adapter';
import { chatGptAvailability } from '../../../src/providers/chatgpt/availability';
import {
  chatGptRequest,
  selectedChatGptScope,
  verifiedChatGptScope,
} from '../../fixtures/chatgpt/requests';

const context = () => ({ signal: new AbortController().signal });

describe('ChatGPT verification gate', () => {
  it('publishes concrete missing observations without an enable switch', () => {
    expect(chatGptAvailability).toEqual({
      status: 'unavailable',
      reason: 'verification-required',
      missingEvidence: [
        'selected-extension-context',
        'account-workspace-identity',
        'search-list-evidence-contracts',
        'original-links-and-timestamps',
        'failure-and-coverage-semantics',
      ],
    });
    expect(Object.isFrozen(chatGptAvailability)).toBe(true);
    expect(Object.isFrozen(chatGptAvailability.missingEvidence)).toBe(true);
  });

  it.each([
    { name: 'selected document', scope: selectedChatGptScope() },
    { name: 'synthetic verified label', scope: verifiedChatGptScope() },
    {
      name: 'synthetic no-workspace label',
      scope: { ...verifiedChatGptScope(), workspacePartition: null },
    },
  ])('never reports ready or empty success for $name', async ({ scope }) => {
    const provider: ProviderPort = new ChatGptProvider(scope);
    expect(provider.provider).toBe('chatgpt');
    const session = await provider.inspectSession(context());
    expect(validate(SessionOutcomeSchema, session).ok).toBe(true);
    expect(session).toEqual({
      status: 'unavailable',
      provider: 'chatgpt',
      generation: scope.generation,
    });
    const request = chatGptRequest(scope);
    const result = await provider.search(request, context());
    expect(result).toEqual({ requestId: request.requestId, scope, status: 'unavailable' });
    expect(validate(providerOutcomeSchemaFor(request, {}), result).ok).toBe(true);
    expect(result).not.toHaveProperty('candidates');
    expect(result).not.toHaveProperty('coverage');
  });

  it('exposes the availability diagnostic on the adapter', () => {
    expect(new ChatGptProvider(selectedChatGptScope()).availability).toBe(chatGptAvailability);
  });

  it('does not perform fetch, log input, or allocate background work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected read'));
    const logSpies = ['log', 'warn', 'error', 'info', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const request = chatGptRequest();
    request.query.text = 'Fictional private excerpt; never log or echo this';
    try {
      const provider = new ChatGptProvider(request.scope);
      const session = await provider.inspectSession(context());
      const result = await provider.search(request, context());
      provider.invalidate();
      expect(JSON.stringify([session, result, provider.availability])).not.toContain(
        request.query.text,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(timerSpy).not.toHaveBeenCalled();
      for (const log of logSpies) expect(log).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      timerSpy.mockRestore();
      for (const log of logSpies) log.mockRestore();
    }
  });
});

describe('ChatGPT selected scope isolation', () => {
  it.each([
    {
      name: 'ephemeral partition',
      base: selectedChatGptScope(),
      patch: { partition: 'fictional-other-document' },
    },
    { name: 'new generation', base: selectedChatGptScope(), patch: { generation: 4 } },
    { name: 'old generation', base: selectedChatGptScope(), patch: { generation: 2 } },
    {
      name: 'account',
      base: verifiedChatGptScope(),
      patch: { accountPartition: 'fictional-other-account' },
    },
    {
      name: 'workspace',
      base: verifiedChatGptScope(),
      patch: { workspacePartition: 'fictional-other-workspace' },
    },
    {
      name: 'absence of workspace',
      base: verifiedChatGptScope(),
      patch: { workspacePartition: null },
    },
    { name: 'verified generation', base: verifiedChatGptScope(), patch: { generation: 8 } },
  ])('rejects a different $name', async ({ base, patch }) => {
    const request = chatGptRequest({ ...base, ...patch } as SessionScope);
    const result = await new ChatGptProvider(base).search(request, context());
    expect(result).toEqual({
      status: 'scope-changed',
      requestId: request.requestId,
      scope: request.scope,
    });
    expect(validate(providerOutcomeSchemaFor(request, {}), result).ok).toBe(true);
  });

  it.each([
    { selected: selectedChatGptScope(), requested: verifiedChatGptScope() },
    { selected: verifiedChatGptScope(), requested: selectedChatGptScope() },
  ])('rejects replacing the scope kind', async ({ selected, requested }) => {
    const result = await new ChatGptProvider(selected).search(chatGptRequest(requested), context());
    expect(result.status).toBe('scope-changed');
  });

  it('compares scope values instead of object references', async () => {
    const scope = selectedChatGptScope();
    const result = await new ChatGptProvider(scope).search(chatGptRequest({ ...scope }), context());
    expect(result.status).toBe('unavailable');
  });

  it('snapshots constructor scope and isolates each returned scope', async () => {
    const scope = selectedChatGptScope();
    const original = { ...scope };
    const provider = new ChatGptProvider(scope);
    scope.generation++;
    const request = chatGptRequest(original);
    const first = await provider.search(request, context());
    expect(first.status).toBe('unavailable');
    first.scope.generation++;
    expect(request.scope).toEqual(original);
    const second = await provider.search(request, context());
    expect(second.scope).toEqual(original);
    expect(second.status).toBe('unavailable');
    expect(await provider.inspectSession(context())).toEqual({
      status: 'unavailable',
      provider: 'chatgpt',
      generation: original.generation,
    });
  });

  it('does not share invalidation between instances', async () => {
    const first = new ChatGptProvider(selectedChatGptScope());
    const second = new ChatGptProvider(selectedChatGptScope());
    first.invalidate();
    expect((await first.search(chatGptRequest(), context())).status).toBe('scope-changed');
    expect((await second.search(chatGptRequest(), context())).status).toBe('unavailable');
  });

  it('retires an instance permanently and idempotently', async () => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    provider.invalidate();
    provider.invalidate();
    expect(await provider.inspectSession(context())).toEqual({
      status: 'scope-changed',
      provider: 'chatgpt',
      generation: 3,
    });
    for (let index = 0; index < 2; index++) {
      const request = chatGptRequest();
      request.requestId = requireValid(SearchRequestSchema, {
        requestId: `fictional-after-invalidation-${index}`,
        query: request.query,
        scopes: [request.scope],
      }).requestId;
      expect(await provider.search(request, context())).toEqual({
        status: 'scope-changed',
        requestId: request.requestId,
        scope: request.scope,
      });
    }
  });
});

describe('ChatGPT cancellation and correlation', () => {
  it.each([false, true])('honors cancellation even with invalidated=%s', async (invalidate) => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    if (invalidate) provider.invalidate();
    const controller = new AbortController();
    controller.abort(new Error('Fictional secret abort reason'));
    const request = chatGptRequest();
    const result = await provider.search(request, { signal: controller.signal });
    expect(result).toEqual({
      status: 'cancelled',
      requestId: request.requestId,
      scope: request.scope,
    });
    expect(JSON.stringify(result)).not.toContain('abort reason');
  });

  it('keeps an aborted session inspection unavailable rather than claiming ready', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await new ChatGptProvider(selectedChatGptScope()).inspectSession({
        signal: controller.signal,
      }),
    ).toEqual({ status: 'unavailable', provider: 'chatgpt', generation: 3 });
  });

  it('does not let a cancelled request poison a subsequent operation', async () => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    const controller = new AbortController();
    controller.abort();
    expect((await provider.search(chatGptRequest(), { signal: controller.signal })).status).toBe(
      'cancelled',
    );
    expect((await provider.search(chatGptRequest(), context())).status).toBe('unavailable');
  });

  it('preserves concurrent request IDs without merging results or scopes', async () => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    const requests = Array.from({ length: 4 }, (_, index) => ({
      ...chatGptRequest(),
      requestId: `fictional-concurrent-${index}`,
    }));
    const results = await Promise.all(
      requests.map((input) => provider.search(input as ProviderRequest, context())),
    );
    results.forEach((result, index) => {
      expect(result.requestId).toBe(requests[index]?.requestId);
      expect(result.status).toBe('unavailable');
    });
  });

  it('rejects a reply consumed against an obsolete request or generation', async () => {
    const request = chatGptRequest();
    const result = await new ChatGptProvider(request.scope).search(request, context());
    const replacement = { ...request, requestId: 'fictional-replacement-query' } as ProviderRequest;
    expect(validate(providerOutcomeSchemaFor(replacement, {}), result).ok).toBe(false);
    const nextScope = chatGptRequest({
      ...request.scope,
      generation: request.scope.generation + 1,
    });
    expect(validate(providerOutcomeSchemaFor(nextScope, {}), result).ok).toBe(false);
  });

  it('cannot turn unavailable into aggregate successful no-matches', async () => {
    const request = chatGptRequest();
    const outcome = await new ChatGptProvider(request.scope).search(request, context());
    const aggregateRequest = requireValid(SearchRequestSchema, {
      requestId: request.requestId,
      query: request.query,
      scopes: [request.scope],
    });
    const aggregate = {
      requestId: request.requestId,
      state: 'failure',
      results: [],
      outcomes: [outcome],
      coverage: { extent: 'unknown', reasons: ['provider-failure'] },
    };
    const schema = searchOutcomeSchemaFor(aggregateRequest, {});
    expect(validate(schema, aggregate).ok).toBe(true);
    expect(validate(schema, { ...aggregate, state: 'success' }).ok).toBe(false);
    expect(
      validate(schema, { ...aggregate, coverage: { extent: 'complete', reasons: [] } }).ok,
    ).toBe(false);
  });
});

describe('ChatGPT runtime validation', () => {
  const invalidScopes: { name: string; value: unknown }[] = [
    { name: 'missing scope', value: undefined },
    { name: 'null scope', value: null },
    { name: 'empty scope', value: {} },
    { name: 'wrong provider', value: { ...selectedChatGptScope(), provider: 'google-ai-mode' } },
    { name: 'unknown kind', value: { ...selectedChatGptScope(), kind: 'authenticated' } },
    { name: 'missing partition', value: { kind: 'ephemeral', provider: 'chatgpt', generation: 3 } },
    { name: 'empty partition', value: { ...selectedChatGptScope(), partition: '' } },
    {
      name: 'oversized partition',
      value: { ...selectedChatGptScope(), partition: 'x'.repeat(limits.id + 1) },
    },
    { name: 'zero generation', value: { ...selectedChatGptScope(), generation: 0 } },
    { name: 'fractional generation', value: { ...selectedChatGptScope(), generation: 1.5 } },
    {
      name: 'unsafe generation',
      value: { ...selectedChatGptScope(), generation: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: 'extra account assertion',
      value: { ...selectedChatGptScope(), accountPartition: 'fictional-account' },
    },
    {
      name: 'missing verified workspace',
      value: {
        kind: 'verified',
        provider: 'chatgpt',
        accountPartition: 'fictional-account',
        generation: 3,
      },
    },
    {
      name: 'undefined verified workspace',
      value: { ...verifiedChatGptScope(), workspacePartition: undefined },
    },
  ];

  it.each(invalidScopes)('rejects $name in the constructor', ({ value }) => {
    expect(() => new ChatGptProvider(value as SessionScope)).toThrow('Invalid contract context.');
  });

  const invalidRequests: { name: string; patch: (request: ProviderRequest) => unknown }[] = [
    { name: 'missing request', patch: () => undefined },
    { name: 'null request', patch: () => null },
    { name: 'array request', patch: () => [] },
    { name: 'missing request ID', patch: (r) => ({ scope: r.scope, query: r.query }) },
    { name: 'blank request ID', patch: (r) => ({ ...r, requestId: ' ' }) },
    { name: 'extra URL bridge', patch: (r) => ({ ...r, url: 'https://example.invalid' }) },
    {
      name: 'extra header bridge',
      patch: (r) => ({ ...r, headers: { authorization: 'fictional-secret' } }),
    },
    { name: 'extra operation', patch: (r) => ({ ...r, operation: 'fetch' }) },
    {
      name: 'wrong provider even when selected',
      patch: (r) => ({
        ...r,
        scope: { ...r.scope, provider: 'google-ai-mode' },
        query: { ...r.query, providers: ['google-ai-mode'] },
      }),
    },
    {
      name: 'unselected provider',
      patch: (r) => ({ ...r, query: { ...r.query, providers: ['google-ai-mode'] } }),
    },
    {
      name: 'duplicate providers',
      patch: (r) => ({ ...r, query: { ...r.query, providers: ['chatgpt', 'chatgpt'] } }),
    },
    { name: 'empty query', patch: (r) => ({ ...r, query: { ...r.query, text: '' } }) },
    { name: 'blank query', patch: (r) => ({ ...r, query: { ...r.query, text: '   ' } }) },
    {
      name: 'oversized query',
      patch: (r) => ({ ...r, query: { ...r.query, text: 'x'.repeat(limits.query + 1) } }),
    },
    {
      name: 'control character',
      patch: (r) => ({ ...r, query: { ...r.query, text: 'fictional\u0000query' } }),
    },
    { name: 'unknown mode', patch: (r) => ({ ...r, query: { ...r.query, mode: 'fetch' } }) },
    {
      name: 'unknown timezone',
      patch: (r) => ({ ...r, query: { ...r.query, timeZone: 'Mars/Orchard' } }),
    },
    {
      name: 'undefined date range',
      patch: (r) => ({ ...r, query: { ...r.query, dateRange: undefined } }),
    },
    {
      name: 'impossible date',
      patch: (r) => ({
        ...r,
        query: {
          ...r.query,
          dateRange: { start: '2026-02-30T00:00:00.000Z', end: '2026-03-03T00:00:00.000Z' },
        },
      }),
    },
    {
      name: 'reversed dates',
      patch: (r) => ({
        ...r,
        query: {
          ...r.query,
          dateRange: { start: '2026-10-15T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
        },
      }),
    },
    { name: 'missing scope', patch: (r) => ({ requestId: r.requestId, query: r.query }) },
    { name: 'extra scope key', patch: (r) => ({ ...r, scope: { ...r.scope, loggedIn: true } }) },
  ];

  it.each(invalidRequests)('rejects $name instead of emitting an outcome', async ({ patch }) => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    await expect(
      provider.search(patch(chatGptRequest()) as ProviderRequest, context()),
    ).rejects.toThrow('Invalid contract context.');
  });

  it('does not leak a throwing input getter or echo private validation input', async () => {
    const request = Object.defineProperty(chatGptRequest(), 'requestId', {
      enumerable: true,
      get() {
        throw new Error('Fictional private provider payload');
      },
    });
    await expect(
      new ChatGptProvider(selectedChatGptScope()).search(request as ProviderRequest, context()),
    ).rejects.toThrow(/^Invalid contract context\.$/);
    const scope = Object.defineProperty(selectedChatGptScope(), 'provider', {
      enumerable: true,
      get() {
        throw new Error('Fictional private account identity');
      },
    });
    expect(() => new ChatGptProvider(scope as SessionScope)).toThrow(
      /^Invalid contract context\.$/,
    );
  });

  it('still rejects invalid input when cancelled or retired', async () => {
    const provider = new ChatGptProvider(selectedChatGptScope());
    provider.invalidate();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.search(null as unknown as ProviderRequest, { signal: controller.signal }),
    ).rejects.toThrow('Invalid contract context.');
  });

  it.each(['keyword', 'description'] as const)(
    'leaves valid %s queries unavailable',
    async (mode) => {
      const request = chatGptRequest();
      request.query.mode = mode;
      request.query.text = 'x'.repeat(limits.query);
      request.query.providers = ['chatgpt', 'google-ai-mode'];
      request.query.dateRange = {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      };
      expect((await new ChatGptProvider(request.scope).search(request, context())).status).toBe(
        'unavailable',
      );
      expect(request.query.mode).toBe(mode);
      expect(request.query.dateRange).toEqual({
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      });
    },
  );
});
