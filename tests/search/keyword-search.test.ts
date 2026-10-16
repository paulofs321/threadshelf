import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireValid,
  SearchRequestSchema,
  searchOutcomeSchemaFor,
  SessionScopeSchema,
  validate,
} from '../../src/contracts';
import type {
  Candidate,
  ProviderOutcome,
  ProviderRequest,
  SearchRequest,
} from '../../src/contracts';
import { calendarDateRange, KeywordSearch } from '../../src/search';
import type { SearchPolicy } from '../../src/search';
import {
  chatCandidate,
  chatScope,
  deferred,
  googleCandidate,
  googleScope,
  linkVerifiers,
  providerPort,
  searchRequest,
} from '../fixtures/search/providers';

function setup(
  policy: Partial<SearchPolicy> = {},
  chatCandidates?: Candidate[],
  googleCandidates?: Candidate[],
) {
  const chat = providerPort('chatgpt', chatCandidates);
  const google = providerPort('google-ai-mode', googleCandidates);
  const engine = new KeywordSearch({ providers: [chat, google], linkVerifiers, policy });

  return { chat, google, engine };
}

function solo(): SearchRequest {
  const request = searchRequest();

  return requireValid(SearchRequestSchema, {
    ...request,
    query: { ...request.query, providers: ['chatgpt'] },
    scopes: [chatScope],
  });
}

function success(
  request: ProviderRequest,
  candidates: Candidate[] = [chatCandidate],
): ProviderOutcome {
  return {
    status: 'success',
    requestId: request.requestId,
    scope: request.scope,
    candidates: structuredClone(candidates),
    coverage: { extent: 'complete', reasons: [] },
  };
}

const context = () => ({ signal: new AbortController().signal });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-15T10:00:00.000Z');
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('keyword retrieval and truthful outcomes', () => {
  it('supports the full 200-result bound without merging equal titles or conversation IDs across providers', async () => {
    const candidates = (template: Candidate) =>
      Array.from({ length: 100 }, (_, index): Candidate => ({
        ...template,
        id: `${template.scope.provider}:${index}` as Candidate['id'],
        conversationId: `fictional-shared-id-${index}` as Candidate['conversationId'],
        originalUrl: `https://${template.scope.provider}.example.invalid/threads/fictional-shared-id-${index}`,
      }));
    const { engine } = setup({}, candidates(chatCandidate), candidates(googleCandidate));
    const result = await engine.search(searchRequest(), context());
    expect(result.state).toBe('success');
    expect(result.results).toHaveLength(200);
    expect(new Set(result.results).size).toBe(200);
  });

  it('returns successful zero date matches with explicit unknown-date limits', async () => {
    const candidate = structuredClone(chatCandidate);
    delete candidate.date;
    const { engine } = setup({}, [candidate]);
    const request = searchRequest();
    request.query.dateRange = calendarDateRange('2026-09-01', '2026-10-01', 'UTC');
    expect(await engine.search(request, context())).toMatchObject({
      state: 'success',
      results: [],
      coverage: { extent: 'partial', reasons: ['unknown-dates'] },
    });
  });

  it.each(['obsolete-request', 'obsolete-generation', 'unrequested-scope'] as const)(
    'rejects %s replies without hiding the other provider',
    async (kind) => {
      const { engine, chat } = setup();
      chat.search.mockImplementation(async (request) => ({
        ...success(request),
        ...(kind === 'obsolete-request'
          ? { requestId: 'fictional-old-request' }
          : {
              scope:
                kind === 'obsolete-generation' ? { ...request.scope, generation: 99 } : googleScope,
            }),
      }));
      expect(await engine.search(searchRequest(), context())).toMatchObject({
        state: 'partial',
        results: [googleCandidate.id],
        outcomes: [{ status: 'schema-changed' }, { status: 'success' }],
      });
    },
  );

  it('returns independent equal-title matches in selected order, regardless of arrival order', async () => {
    const { engine, chat, google } = setup();
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const request = searchRequest();
    const running = engine.search(request, context());
    await flush();
    expect(google.search).toHaveBeenCalledOnce();
    pending.resolve(success({ ...request, scope: chatScope }));
    const result = await running;
    expect(result.results).toEqual([chatCandidate.id, googleCandidate.id]);
    expect(result).toMatchObject({
      state: 'success',
      coverage: { extent: 'complete', reasons: [] },
    });
    expect(validate(searchOutcomeSchemaFor(request, linkVerifiers), result).ok).toBe(true);
    expect(chat.inspectSession).not.toHaveBeenCalled();
  });

  it('selects only explicit providers, trims query text and snapshots caller input', async () => {
    const { engine, chat, google } = setup();
    const input = solo();
    input.query.text = '  floating library  ';
    const running = engine.search(input, context());
    input.query.text = 'mutated caller text';
    input.scopes[0] = { ...chatScope, generation: 9 };
    const result = await running;
    expect(chat.search.mock.calls[0]?.[0]).toMatchObject({
      query: { text: 'floating library' },
      scope: chatScope,
    });
    expect(google.search).not.toHaveBeenCalled();
    expect(result.results).toEqual([chatCandidate.id]);
  });

  it('does not permit a port to mutate the request used for contextual validation', async () => {
    const { engine, chat } = setup();
    chat.search.mockImplementation(async (request) => {
      const outcome = success(request);
      request.requestId = 'fictional-mutated-request' as SearchRequest['requestId'];
      request.query.providers.splice(0);

      return outcome;
    });
    expect((await engine.search(solo(), context())).results).toEqual([chatCandidate.id]);
  });

  it.each([
    'unavailable',
    'login-expired',
    'permission-needed',
    'schema-changed',
    'rate-limited',
    'timeout',
    'cancelled',
    'scope-changed',
    'interrupted',
  ] as const)('preserves useful results and precise %s failures', async (status) => {
    const { engine, google } = setup();
    google.search.mockImplementation(async (request) => ({
      status,
      requestId: request.requestId,
      scope: request.scope,
    }));
    const result = await engine.search(searchRequest(), context());
    expect(result).toMatchObject({
      state: 'partial',
      results: [chatCandidate.id],
      coverage: { reasons: ['provider-failure'] },
    });
    expect(result.outcomes[1]?.status).toBe(status);
  });

  it('preserves partial-provider failure when successful providers return zero', async () => {
    const { engine, google } = setup({}, []);
    google.search.mockRejectedValue(new Error('fictional private exception'));
    expect(await engine.search(searchRequest(), context())).toMatchObject({
      state: 'partial',
      results: [],
      outcomes: [{ status: 'success' }, { status: 'unavailable' }],
    });
  });

  it('distinguishes genuine empty from all-provider failure', async () => {
    const { engine } = setup({}, [], []);
    expect(await engine.search(searchRequest(), context())).toMatchObject({
      state: 'success',
      results: [],
      coverage: { extent: 'complete' },
    });
    const unavailable = new KeywordSearch({ providers: [], linkVerifiers });
    expect(await unavailable.search(searchRequest(), context())).toMatchObject({
      state: 'failure',
      results: [],
      outcomes: [{ status: 'unavailable' }, { status: 'unavailable' }],
    });
  });

  it('retains every provider coverage reason and never promotes unknown reach', async () => {
    const { engine, chat, google } = setup();
    chat.search.mockImplementation(async (request) => ({
      ...success(request),
      coverage: { extent: 'unknown', reasons: ['unknown-reach', 'missing-evidence'] },
    }));
    google.search.mockImplementation(async (request) => ({
      ...success(request, [googleCandidate]),
      coverage: { extent: 'partial', reasons: ['result-limit', 'query-budget'] },
    }));
    const result = await engine.search(searchRequest(), context());
    expect(result.state).toBe('success');
    expect(result.coverage).toEqual({
      extent: 'unknown',
      reasons: ['unknown-reach', 'missing-evidence', 'result-limit', 'query-budget'],
    });
  });

  it('bounds aggregate results without destroying retrieved evidence', async () => {
    const { engine } = setup({ maxResults: 1 });
    const result = await engine.search(searchRequest(), context());
    expect(result.results).toEqual([chatCandidate.id]);
    expect(result.outcomes[1]).toMatchObject({ candidates: [googleCandidate] });
    expect(result.coverage).toEqual({ extent: 'partial', reasons: ['result-limit'] });
  });

  it('rejects cross-provider candidate-ID aliases without merging conversations', async () => {
    const { engine } = setup({}, undefined, [{ ...googleCandidate, id: chatCandidate.id }]);
    expect(await engine.search(searchRequest(), context())).toMatchObject({
      state: 'partial',
      results: [chatCandidate.id],
      outcomes: [{ status: 'success' }, { status: 'schema-changed' }],
    });
  });

  it('uses half-open available-date filtering without changing retrieved inventories', async () => {
    const dateRange = calendarDateRange('2026-09-01', '2026-10-01', 'Europe/Zurich');
    const known = (id: string, at: string): Candidate => ({
      ...chatCandidate,
      id: id as Candidate['id'],
      conversationId: id as Candidate['conversationId'],
      originalUrl: `https://chatgpt.example.invalid/threads/${id}`,
      date: { at, meaning: 'conversation-updated', source: 'provider-metadata' },
    });
    const start = known('fictional-start', dateRange.start);
    const end = known('fictional-end', dateRange.end);
    const before = known('fictional-before', '2026-08-31T21:59:59.999Z');
    const { engine } = setup({}, [start, end, before]);
    const request = searchRequest();
    request.query.dateRange = dateRange;
    const result = await engine.search(request, context());
    expect(result.results).toEqual([start.id]);
    expect(result.coverage).toEqual({ extent: 'partial', reasons: ['unknown-dates'] });
    expect(result.outcomes[0]).toMatchObject({ candidates: [start, end, before] });
    expect(result.outcomes[1]).toMatchObject({ candidates: [googleCandidate] });
  });

  it.each(['conversation-created', 'conversation-updated', 'message-sent'] as const)(
    'preserves the %s date meaning and provenance',
    async (meaning) => {
      const candidate = {
        ...chatCandidate,
        date: { at: '2026-09-12T10:00:00.000Z', meaning, source: 'provider-metadata' as const },
      };
      const { engine } = setup({}, [candidate]);
      const request = solo();
      request.query.dateRange = calendarDateRange('2026-09-01', '2026-10-01', 'UTC');
      expect(await engine.search(request, context())).toMatchObject({
        results: [candidate.id],
        outcomes: [{ candidates: [candidate] }],
      });
    },
  );

  it.each([
    { query: { ...solo().query, text: ' '.repeat(8) } },
    { query: { ...solo().query, text: 'x'.repeat(1_025) } },
    { query: { ...solo().query, mode: 'description' } },
    { query: { ...solo().query, providers: ['chatgpt', 'chatgpt'] } },
    { query: { ...solo().query, timeZone: 'fictional/unknown' } },
    { scopes: [] },
    { extra: 'untrusted' },
  ])('rejects invalid input before dispatch: %j', async (patch) => {
    const { engine, chat, google } = setup();
    await expect(
      engine.search({ ...solo(), ...patch } as SearchRequest, context()),
    ).rejects.toThrow('Invalid contract context.');
    expect(chat.search).not.toHaveBeenCalled();
    expect(google.search).not.toHaveBeenCalled();
  });

  it.each([
    { concurrency: 3 },
    { maxProviderCalls: 0 },
    { maxResults: 201 },
    { providerTimeoutMs: NaN },
    { requestTimeoutMs: 60_001 },
  ])('rejects unsafe budgets: %j', (policy) => {
    expect(() => setup(policy)).toThrow('Invalid contract context.');
  });

  it('rejects duplicate provider capabilities', () => {
    expect(
      () =>
        new KeywordSearch({
          providers: [providerPort('chatgpt'), providerPort('chatgpt')],
          linkVerifiers,
        }),
    ).toThrow('Duplicate provider port.');
  });
});

describe('bounded work, cancellation and generation ownership', () => {
  it('does not dispatch a queued provider after its scope is invalidated', async () => {
    const { engine, chat, google } = setup({ concurrency: 1 });
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const running = engine.search(searchRequest(), context());
    await flush();
    engine.invalidate(googleScope);
    pending.resolve(success({ ...solo(), scope: chatScope }));
    expect(await running).toMatchObject({
      state: 'partial',
      results: [chatCandidate.id],
      outcomes: [{ status: 'success' }, { status: 'scope-changed' }],
    });
    expect(google.search).not.toHaveBeenCalled();
  });

  it.each(['account', 'workspace', 'ephemeral-partition'] as const)(
    'isolates a changed %s until a new generation arrives',
    async (kind) => {
      const { engine, chat } = setup();
      const old = solo();

      if (kind === 'ephemeral-partition')
        old.scopes = [
          requireValid(SessionScopeSchema, {
            provider: 'chatgpt',
            kind: 'ephemeral',
            partition: 'fictional-partition-a',
            generation: 1,
          }),
        ];

      chat.search.mockImplementation(async (request) =>
        success(request, [{ ...chatCandidate, scope: request.scope }]),
      );
      expect((await engine.search(old, context())).state).toBe('success');
      const changed = requireValid(SearchRequestSchema, {
        ...old,
        scopes: [
          {
            ...old.scopes[0],
            ...(kind === 'account'
              ? { accountPartition: 'fictional-other-account' }
              : kind === 'workspace'
                ? { workspacePartition: 'fictional-other-workspace' }
                : { partition: 'fictional-partition-b' }),
          },
        ],
      });
      expect((await engine.search(changed, context())).outcomes[0]?.status).toBe('scope-changed');
      changed.scopes = changed.scopes.map((scope) => ({ ...scope, generation: 2 }));
      expect((await engine.search(changed, context())).state).toBe('success');
      expect(chat.search).toHaveBeenCalledTimes(2);
    },
  );

  it('dispatches a replacement after an abort-aware provider releases its call', async () => {
    const { engine, chat } = setup();
    chat.search.mockImplementationOnce(
      (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fictional cancelled read')), {
            once: true,
          });
        }),
    );
    const old = engine.search(solo(), context());
    await flush();
    const replacement = engine.search(solo(), context());
    expect((await old).state).toBe('cancelled');
    expect((await replacement).results).toEqual([chatCandidate.id]);
    expect(chat.search).toHaveBeenCalledTimes(2);
  });

  it('applies provider selection order when the supplied scope order differs', async () => {
    const { engine } = setup();
    const request = searchRequest({ scopes: [googleScope, chatScope] });
    expect((await engine.search(request, context())).results).toEqual([
      chatCandidate.id,
      googleCandidate.id,
    ]);
  });

  it('rejects a result invalidated during contextual link validation', async () => {
    const chat = providerPort('chatgpt');
    const engine = new KeywordSearch({
      providers: [chat],
      linkVerifiers: {
        chatgpt: () => {
          engine.invalidate(chatScope);

          return true;
        },
      },
    });
    expect(await engine.search(solo(), context())).toMatchObject({
      state: 'failure',
      results: [],
      outcomes: [{ status: 'scope-changed' }],
    });
  });

  it('retires pending older scopes when a newer generation is invalidated', async () => {
    const { engine, chat } = setup();
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const running = engine.search(solo(), context());
    await flush();
    engine.invalidate({ ...chatScope, generation: 2 });
    expect((await running).outcomes[0]?.status).toBe('scope-changed');
    pending.resolve(null);
    await flush();
  });

  it('runs a bounded queue and reports exhausted query budgets', async () => {
    const { engine, chat, google } = setup({ concurrency: 1, maxProviderCalls: 1 });
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const request = searchRequest();
    const running = engine.search(request, context());
    await flush();
    expect(google.search).not.toHaveBeenCalled();
    pending.resolve(success({ ...request, scope: chatScope }));
    expect(await running).toMatchObject({
      state: 'partial',
      coverage: { extent: 'partial', reasons: ['query-budget', 'provider-failure'] },
    });
    expect(google.search).not.toHaveBeenCalled();
  });

  it('does not start any work for a pre-aborted request', async () => {
    const { engine, chat, google } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await engine.search(searchRequest(), controller)).toMatchObject({
      state: 'cancelled',
      results: [],
    });
    expect(chat.search).not.toHaveBeenCalled();
    expect(google.search).not.toHaveBeenCalled();
  });

  it('cancels queued and in-flight providers before a scheduled port call starts', async () => {
    const { engine, chat, google } = setup({ concurrency: 1 });
    const controller = new AbortController();
    const running = engine.search(searchRequest(), controller);
    controller.abort();
    expect(await running).toMatchObject({ state: 'cancelled', results: [] });
    expect(chat.search).not.toHaveBeenCalled();
    expect(google.search).not.toHaveBeenCalled();
  });

  it('clears completed results on explicit cancellation and rejects late responses', async () => {
    const { engine, chat, google } = setup();
    const pending = deferred();
    google.search.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const running = engine.search(searchRequest(), controller);
    await flush();
    expect(chat.search).toHaveBeenCalledOnce();
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ state: 'cancelled', results: [] });
    expect(google.search.mock.calls[0]?.[1].signal.aborted).toBe(true);
    pending.resolve(success({ ...searchRequest(), scope: googleScope }, [googleCandidate]));
    await flush();
    expect(result.results).toEqual([]);
  });

  it('replaces a search even when caller request IDs are reused', async () => {
    const { engine, chat } = setup();
    const pending = deferred();
    chat.search.mockReturnValueOnce(pending.promise);
    const first = engine.search(solo(), context());
    await flush();
    const second = engine.search(solo(), context());
    expect(await first).toMatchObject({ state: 'cancelled', results: [] });
    expect(await second).toMatchObject({ state: 'failure', outcomes: [{ status: 'interrupted' }] });
    expect(chat.search).toHaveBeenCalledOnce();
    pending.reject(new Error('fictional late private rejection'));
    await flush();
    expect((await engine.search(solo(), context())).results).toEqual([chatCandidate.id]);
  });

  it('does not let an invalid replacement cancel useful work', async () => {
    const { engine, chat } = setup();
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const running = engine.search(solo(), context());
    await expect(
      engine.search({ ...solo(), query: { ...solo().query, text: '' } }, context()),
    ).rejects.toThrow();
    pending.resolve(success({ ...solo(), scope: chatScope }));
    expect((await running).results).toEqual([chatCandidate.id]);
  });

  it('settles an ignoring provider on timeout, retains useful matches and bounds physical concurrency', async () => {
    const { engine, chat, google } = setup({ providerTimeoutMs: 100 });
    const pending = deferred();
    google.search.mockReturnValue(pending.promise);
    const running = engine.search(searchRequest(), context());
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({
      state: 'partial',
      results: [chatCandidate.id],
      outcomes: [{ status: 'success' }, { status: 'timeout' }],
    });
    expect(google.search.mock.calls[0]?.[1].signal.aborted).toBe(true);
    const again = await engine.search(searchRequest(), context());
    expect(again.outcomes[1]?.status).toBe('interrupted');
    expect(chat.search).toHaveBeenCalledTimes(2);
    expect(google.search).toHaveBeenCalledOnce();
    pending.resolve(null);
    await flush();
  });

  it('holds a global concurrency slot across abandoned requests', async () => {
    const { engine, chat, google } = setup({ concurrency: 1, providerTimeoutMs: 100 });
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const first = engine.search(solo(), context());
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const input = searchRequest();
    input.query.providers = ['google-ai-mode'];
    input.scopes = [googleScope];
    expect(await engine.search(input, context())).toMatchObject({
      outcomes: [{ status: 'interrupted' }],
    });
    expect(google.search).not.toHaveBeenCalled();
    pending.resolve(null);
    await flush();
  });

  it('stops a queued provider when the total deadline expires', async () => {
    const { engine, chat, google } = setup({ concurrency: 1, requestTimeoutMs: 50 });
    const pending = deferred();
    chat.search.mockReturnValue(pending.promise);
    const running = engine.search(searchRequest(), context());
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({
      state: 'failure',
      outcomes: [{ status: 'timeout' }, { status: 'timeout' }],
    });
    expect(google.search).not.toHaveBeenCalled();
    pending.resolve(null);
    await flush();
  });

  it('retains successful providers when the request deadline stops the remaining work', async () => {
    const { engine, google } = setup({ requestTimeoutMs: 50 });
    const pending = deferred();
    google.search.mockReturnValue(pending.promise);
    const running = engine.search(searchRequest(), context());
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({
      state: 'partial',
      results: [chatCandidate.id],
      outcomes: [{ status: 'success' }, { status: 'timeout' }],
    });
    pending.resolve(null);
    await flush();
  });

  it.each([undefined, 5_000, 0])(
    'honors rate limits across replacements without retrying (%s)',
    async (hint) => {
      const { engine, chat } = setup();
      chat.search.mockImplementationOnce(async (request) => ({
        status: 'rate-limited',
        requestId: request.requestId,
        scope: request.scope,
        ...(hint === undefined ? {} : { retryAfterMs: hint }),
      }));
      const result = await engine.search(solo(), context());
      expect(result.outcomes[0]?.status).toBe('rate-limited');
      const waiting = await engine.search(solo(), context());

      if (hint === 0) expect(waiting.state).toBe('success');
      else {
        expect(waiting.outcomes[0]).toMatchObject({
          status: 'rate-limited',
          retryAfterMs: hint ?? 1_000,
        });
        expect(chat.search).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(hint ?? 1_000);
        expect((await engine.search(solo(), context())).state).toBe('success');
      }
    },
  );

  it('invalidates completed results while another provider is pending', async () => {
    const { engine, google } = setup();
    const pending = deferred();
    google.search.mockReturnValue(pending.promise);
    const request = searchRequest();
    const running = engine.search(request, context());
    await flush();
    engine.invalidate(chatScope);
    pending.resolve(success({ ...request, scope: googleScope }, [googleCandidate]));
    expect(await running).toMatchObject({
      state: 'partial',
      results: [googleCandidate.id],
      outcomes: [{ status: 'scope-changed' }, { status: 'success' }],
    });
  });

  it('stops pending reads on logout and never reuses a retired generation', async () => {
    const { engine, chat } = setup();
    const pending = deferred();
    chat.search.mockReturnValueOnce(pending.promise);
    const running = engine.search(solo(), context());
    await flush();
    engine.invalidate(chatScope);
    expect(await running).toMatchObject({
      state: 'failure',
      results: [],
      outcomes: [{ status: 'scope-changed' }],
    });
    expect(chat.search.mock.calls[0]?.[1].signal.aborted).toBe(true);
    pending.resolve(success({ ...solo(), scope: chatScope }));
    await flush();
    expect(await engine.search(solo(), context())).toMatchObject({
      outcomes: [{ status: 'scope-changed' }],
    });
    expect(chat.search).toHaveBeenCalledOnce();
  });

  it('accepts a fresh generation, ignores old invalidations and rejects regressions/partition aliases', async () => {
    const { engine, chat } = setup();
    engine.invalidate(chatScope);
    const fresh = solo();
    const scope = { ...chatScope, generation: 2 };
    fresh.scopes = [scope];
    chat.search.mockImplementation(async (request) =>
      success(request, [{ ...chatCandidate, scope: request.scope }]),
    );
    engine.invalidate({ ...chatScope, generation: 1 });
    expect((await engine.search(fresh, context())).state).toBe('success');
    engine.invalidate(chatScope);
    expect((await engine.search(fresh, context())).state).toBe('success');
    expect((await engine.search(solo(), context())).outcomes[0]?.status).toBe('scope-changed');
    const alias = {
      ...fresh,
      scopes: [
        {
          ...scope,
          accountPartition: 'fictional-other-account' as typeof chatScope.accountPartition,
        },
      ],
    };
    expect((await engine.search(alias, context())).outcomes[0]?.status).toBe('scope-changed');
    engine.invalidate({ ...scope, generation: 3 });
    expect((await engine.search(fresh, context())).outcomes[0]?.status).toBe('scope-changed');
  });

  it.each(['login-expired', 'permission-needed', 'scope-changed'] as const)(
    'retires a provider reporting %s without a retry loop',
    async (status) => {
      const { engine, chat } = setup();
      chat.search.mockImplementation(async (request) => ({
        status,
        requestId: request.requestId,
        scope: request.scope,
      }));
      expect((await engine.search(solo(), context())).outcomes[0]?.status).toBe(status);
      expect((await engine.search(solo(), context())).outcomes[0]?.status).toBe('scope-changed');
      expect(chat.search).toHaveBeenCalledOnce();
    },
  );

  it('cleans listeners after completion and does not log private exceptions', async () => {
    const { engine, chat } = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const log = vi.spyOn(console, 'error');
    chat.search.mockRejectedValue(new Error('fictional private body'));
    const result = await engine.search(solo(), controller);
    controller.abort();
    expect(result.outcomes[0]?.status).toBe('unavailable');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    remove.mockRestore();
  });
});
