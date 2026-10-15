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
import { GoogleAiModeProvider } from '../../../src/providers/google-ai-mode/adapter';
import { googleAiModeAvailability } from '../../../src/providers/google-ai-mode/availability';
import {
  googleAiModeRequest,
  selectedGoogleAiModeScope,
  verifiedGoogleAiModeScope,
} from '../../fixtures/google-ai-mode/requests';

const context = () => ({ signal: new AbortController().signal });

describe('Google Search AI Mode verification gate', () => {
  it('publishes concrete missing observations without an enable switch', () => {
    expect(googleAiModeAvailability).toEqual({
      status: 'verified',
      context: 'chrome-isolated-world',
      requires: 'selected-document-binding',
      messageEvidence: 'partial-rendered',
      missingEvidence: [
        'nondefault-account-selection',
        'timestamp-semantics',
        'continuation-and-coverage',
      ],
    });
    expect(Object.isFrozen(googleAiModeAvailability)).toBe(true);
    expect(Object.isFrozen(googleAiModeAvailability.missingEvidence)).toBe(true);
  });

  it.each([
    { name: 'selected document', scope: selectedGoogleAiModeScope() },
    { name: 'synthetic verified label', scope: verifiedGoogleAiModeScope() },
    {
      name: 'synthetic no-workspace label',
      scope: { ...verifiedGoogleAiModeScope(), workspacePartition: null },
    },
  ])('never reports ready or empty success for $name', async ({ scope }) => {
    const provider: ProviderPort = new GoogleAiModeProvider(scope);
    expect(provider.provider).toBe('google-ai-mode');
    const session = await provider.inspectSession(context());
    expect(validate(SessionOutcomeSchema, session).ok).toBe(true);
    expect(session).toEqual({
      status: 'unavailable',
      provider: 'google-ai-mode',
      generation: scope.generation,
    });
    const request = googleAiModeRequest(scope);
    const result = await provider.search(request, context());
    expect(result).toEqual({ requestId: request.requestId, scope, status: 'unavailable' });
    expect(validate(providerOutcomeSchemaFor(request, {}), result).ok).toBe(true);
    expect(result).not.toHaveProperty('candidates');
    expect(result).not.toHaveProperty('coverage');
  });

  it('exposes the availability diagnostic on the adapter', () => {
    expect(new GoogleAiModeProvider(selectedGoogleAiModeScope()).availability).toBe(
      googleAiModeAvailability,
    );
  });

  it('does not perform fetch, log input, or allocate background work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected read'));
    const logSpies = ['log', 'warn', 'error', 'info', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const request = googleAiModeRequest();
    request.query.text = 'Fictional private excerpt; never log or echo this';
    try {
      const provider = new GoogleAiModeProvider(request.scope);
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

describe('Google Search AI Mode selected scope isolation', () => {
  it.each([
    {
      name: 'ephemeral partition',
      base: selectedGoogleAiModeScope(),
      patch: { partition: 'fictional-other-document' },
    },
    { name: 'new generation', base: selectedGoogleAiModeScope(), patch: { generation: 4 } },
    { name: 'old generation', base: selectedGoogleAiModeScope(), patch: { generation: 2 } },
    {
      name: 'account',
      base: verifiedGoogleAiModeScope(),
      patch: { accountPartition: 'fictional-other-account' },
    },
    {
      name: 'workspace',
      base: verifiedGoogleAiModeScope(),
      patch: { workspacePartition: 'fictional-other-workspace' },
    },
    {
      name: 'absence of workspace',
      base: verifiedGoogleAiModeScope(),
      patch: { workspacePartition: null },
    },
    { name: 'verified generation', base: verifiedGoogleAiModeScope(), patch: { generation: 8 } },
  ])('rejects a different $name', async ({ base, patch }) => {
    const request = googleAiModeRequest({ ...base, ...patch } as SessionScope);
    const result = await new GoogleAiModeProvider(base).search(request, context());
    expect(result).toEqual({
      status: 'scope-changed',
      requestId: request.requestId,
      scope: request.scope,
    });
    expect(validate(providerOutcomeSchemaFor(request, {}), result).ok).toBe(true);
  });

  it.each([
    { selected: selectedGoogleAiModeScope(), requested: verifiedGoogleAiModeScope() },
    { selected: verifiedGoogleAiModeScope(), requested: selectedGoogleAiModeScope() },
  ])('rejects replacing the scope kind', async ({ selected, requested }) => {
    const result = await new GoogleAiModeProvider(selected).search(
      googleAiModeRequest(requested),
      context(),
    );
    expect(result.status).toBe('scope-changed');
  });

  it('compares scope values instead of object references', async () => {
    const scope = selectedGoogleAiModeScope();
    const result = await new GoogleAiModeProvider(scope).search(
      googleAiModeRequest({ ...scope }),
      context(),
    );
    expect(result.status).toBe('unavailable');
  });

  it('snapshots constructor scope and isolates each returned scope', async () => {
    const scope = selectedGoogleAiModeScope();
    const original = { ...scope };
    const provider = new GoogleAiModeProvider(scope);
    scope.generation++;
    const request = googleAiModeRequest(original);
    const first = await provider.search(request, context());
    expect(first.status).toBe('unavailable');
    first.scope.generation++;
    expect(request.scope).toEqual(original);
    const second = await provider.search(request, context());
    expect(second.scope).toEqual(original);
    expect(second.status).toBe('unavailable');
    expect(await provider.inspectSession(context())).toEqual({
      status: 'unavailable',
      provider: 'google-ai-mode',
      generation: original.generation,
    });
  });

  it('does not share invalidation between instances', async () => {
    const first = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    const second = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    first.invalidate();
    expect((await first.search(googleAiModeRequest(), context())).status).toBe('scope-changed');
    expect((await second.search(googleAiModeRequest(), context())).status).toBe('unavailable');
  });

  it('retires an instance permanently and idempotently', async () => {
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    provider.invalidate();
    provider.invalidate();
    expect(await provider.inspectSession(context())).toEqual({
      status: 'scope-changed',
      provider: 'google-ai-mode',
      generation: 3,
    });
    for (let index = 0; index < 2; index++) {
      const request = googleAiModeRequest();
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

describe('Google Search AI Mode cancellation and correlation', () => {
  it.each([false, true])('honors cancellation even with invalidated=%s', async (invalidate) => {
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    if (invalidate) provider.invalidate();
    const controller = new AbortController();
    controller.abort(new Error('Fictional secret abort reason'));
    const request = googleAiModeRequest();
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
      await new GoogleAiModeProvider(selectedGoogleAiModeScope()).inspectSession({
        signal: controller.signal,
      }),
    ).toEqual({ status: 'unavailable', provider: 'google-ai-mode', generation: 3 });
  });

  it('does not let a cancelled request poison a subsequent operation', async () => {
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    const controller = new AbortController();
    controller.abort();
    expect(
      (await provider.search(googleAiModeRequest(), { signal: controller.signal })).status,
    ).toBe('cancelled');
    expect((await provider.search(googleAiModeRequest(), context())).status).toBe('unavailable');
  });

  it('preserves concurrent request IDs without merging results or scopes', async () => {
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    const requests = Array.from({ length: 4 }, (_, index) => ({
      ...googleAiModeRequest(),
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
    const request = googleAiModeRequest();
    const result = await new GoogleAiModeProvider(request.scope).search(request, context());
    const replacement = { ...request, requestId: 'fictional-replacement-query' } as ProviderRequest;
    expect(validate(providerOutcomeSchemaFor(replacement, {}), result).ok).toBe(false);
    const nextScope = googleAiModeRequest({
      ...request.scope,
      generation: request.scope.generation + 1,
    });
    expect(validate(providerOutcomeSchemaFor(nextScope, {}), result).ok).toBe(false);
  });

  it('cannot turn unavailable into aggregate successful no-matches', async () => {
    const request = googleAiModeRequest();
    const outcome = await new GoogleAiModeProvider(request.scope).search(request, context());
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

describe('Google Search AI Mode runtime validation', () => {
  const invalidScopes: { name: string; value: unknown }[] = [
    { name: 'missing scope', value: undefined },
    { name: 'null scope', value: null },
    { name: 'empty scope', value: {} },
    { name: 'wrong provider', value: { ...selectedGoogleAiModeScope(), provider: 'chatgpt' } },
    { name: 'Gemini app alias', value: { ...selectedGoogleAiModeScope(), provider: 'gemini' } },
    { name: 'unknown kind', value: { ...selectedGoogleAiModeScope(), kind: 'authenticated' } },
    {
      name: 'missing partition',
      value: { kind: 'ephemeral', provider: 'google-ai-mode', generation: 3 },
    },
    { name: 'empty partition', value: { ...selectedGoogleAiModeScope(), partition: '' } },
    {
      name: 'oversized partition',
      value: { ...selectedGoogleAiModeScope(), partition: 'x'.repeat(limits.id + 1) },
    },
    { name: 'zero generation', value: { ...selectedGoogleAiModeScope(), generation: 0 } },
    { name: 'fractional generation', value: { ...selectedGoogleAiModeScope(), generation: 1.5 } },
    {
      name: 'unsafe generation',
      value: { ...selectedGoogleAiModeScope(), generation: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: 'extra account assertion',
      value: { ...selectedGoogleAiModeScope(), accountPartition: 'fictional-account' },
    },
    {
      name: 'missing verified workspace',
      value: {
        kind: 'verified',
        provider: 'google-ai-mode',
        accountPartition: 'fictional-account',
        generation: 3,
      },
    },
    {
      name: 'undefined verified workspace',
      value: { ...verifiedGoogleAiModeScope(), workspacePartition: undefined },
    },
  ];

  it.each(invalidScopes)('rejects $name in the constructor', ({ value }) => {
    expect(() => new GoogleAiModeProvider(value as SessionScope)).toThrow(
      'Invalid contract context.',
    );
  });

  const invalidRequests: { name: string; patch: (request: ProviderRequest) => unknown }[] = [
    { name: 'missing request', patch: () => undefined },
    { name: 'null request', patch: () => null },
    { name: 'array request', patch: () => [] },
    { name: 'missing request ID', patch: (r) => ({ scope: r.scope, query: r.query }) },
    { name: 'blank request ID', patch: (r) => ({ ...r, requestId: ' ' }) },
    { name: 'extra URL bridge', patch: (r) => ({ ...r, url: 'https://example.invalid' }) },
    {
      name: 'Gemini app substitution',
      patch: (r) => ({
        ...r,
        scope: { ...r.scope, provider: 'gemini' },
        query: { ...r.query, providers: ['gemini'] },
      }),
    },
    {
      name: 'extra header bridge',
      patch: (r) => ({ ...r, headers: { authorization: 'fictional-secret' } }),
    },
    { name: 'extra operation', patch: (r) => ({ ...r, operation: 'fetch' }) },
    {
      name: 'wrong provider even when selected',
      patch: (r) => ({
        ...r,
        scope: { ...r.scope, provider: 'chatgpt' },
        query: { ...r.query, providers: ['chatgpt'] },
      }),
    },
    {
      name: 'unselected provider',
      patch: (r) => ({ ...r, query: { ...r.query, providers: ['chatgpt'] } }),
    },
    {
      name: 'duplicate providers',
      patch: (r) => ({
        ...r,
        query: { ...r.query, providers: ['google-ai-mode', 'google-ai-mode'] },
      }),
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
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
    await expect(
      provider.search(patch(googleAiModeRequest()) as ProviderRequest, context()),
    ).rejects.toThrow('Invalid contract context.');
  });

  it('does not leak a throwing input getter or echo private validation input', async () => {
    const request = Object.defineProperty(googleAiModeRequest(), 'requestId', {
      enumerable: true,
      get() {
        throw new Error('Fictional private provider payload');
      },
    });
    await expect(
      new GoogleAiModeProvider(selectedGoogleAiModeScope()).search(
        request as ProviderRequest,
        context(),
      ),
    ).rejects.toThrow(/^Invalid contract context\.$/);
    const scope = Object.defineProperty(selectedGoogleAiModeScope(), 'provider', {
      enumerable: true,
      get() {
        throw new Error('Fictional private account identity');
      },
    });
    expect(() => new GoogleAiModeProvider(scope as SessionScope)).toThrow(
      /^Invalid contract context\.$/,
    );
  });

  it('still rejects invalid input when cancelled or retired', async () => {
    const provider = new GoogleAiModeProvider(selectedGoogleAiModeScope());
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
      const request = googleAiModeRequest();
      request.query.mode = mode;
      request.query.text = 'x'.repeat(limits.query);
      request.query.providers = ['google-ai-mode', 'chatgpt'];
      request.query.dateRange = {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      };
      expect(
        (await new GoogleAiModeProvider(request.scope).search(request, context())).status,
      ).toBe('unavailable');
      expect(request.query.mode).toBe(mode);
      expect(request.query.dateRange).toEqual({
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      });
    },
  );
});
