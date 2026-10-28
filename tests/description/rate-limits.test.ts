import { afterEach, expect, it, vi } from 'vitest';
import { providerOutcomeSchemaFor, searchOutcomeSchemaFor, validate } from '../../src/contracts';
import type { ProviderOutcome, ProviderRequest, SearchPort } from '../../src/contracts';
import { aggregateSearch } from '../../src/search/aggregate';
import { collect } from '../../src/description/collect';
import { corpus, chatScope, request, linkVerifiers } from '../fixtures/description/corpus';
import { context, setup } from './helpers';

afterEach(() => vi.useRealTimers());

it.each([undefined, 4000])(
  'honors a successful context throttle across keyword requests: %s',
  async (retryAfterMs) => {
    vi.useFakeTimers();
    const { native, chat, google } = setup();
    chat.search.mockImplementationOnce(async (input) => ({
      requestId: input.requestId,
      scope: input.scope,
      status: 'success',
      candidates: [corpus[0]],
      coverage: { extent: 'partial', reasons: ['provider-failure', 'missing-evidence'] },
      rateLimit: retryAfterMs === undefined ? {} : { retryAfterMs },
    }));
    const input = request('login security');
    input.query.mode = 'keyword';
    const first = await native.search(input, context());
    expect(first.outcomes[0]).toMatchObject({
      status: 'success',
      candidates: [corpus[0]],
      rateLimit: retryAfterMs === undefined ? {} : { retryAfterMs },
    });
    expect(validate(searchOutcomeSchemaFor(input, linkVerifiers), first).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    const blocked = await native.search(
      { ...input, requestId: 'fiction-throttled-next' as typeof input.requestId },
      context(),
    );
    expect(blocked.outcomes[0]).toMatchObject({
      status: 'rate-limited',
      retryAfterMs: (retryAfterMs ?? 1000) - 200,
    });
    expect(chat.search).toHaveBeenCalledOnce();
    expect(google.search).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync((retryAfterMs ?? 1000) - 200);
    expect((await native.search(input, context())).outcomes[0]?.status).toBe('success');
    expect(chat.search).toHaveBeenCalledTimes(2);
  },
);

it.each([undefined, 4000])(
  'stops only the context-throttled provider within a description and retains its evidence/hint: %s',
  async (retryAfterMs) => {
    const retrieval: SearchPort = {
      invalidate: vi.fn(),
      search: vi.fn<SearchPort['search']>(async (input) =>
        aggregateSearch(
          input,
          input.scopes.map((scope): ProviderOutcome => ({
            requestId: input.requestId,
            scope,
            status: 'success',
            candidates:
              scope.provider === 'chatgpt'
                ? [corpus[0]]
                : corpus.filter((candidate) => candidate.scope.provider === scope.provider),
            coverage:
              scope.provider === 'chatgpt'
                ? { extent: 'partial', reasons: ['provider-failure', 'missing-evidence'] }
                : { extent: 'complete', reasons: [] },
            ...(scope.provider === 'chatgpt'
              ? { rateLimit: retryAfterMs === undefined ? {} : { retryAfterMs } }
              : {}),
          })),
          linkVerifiers,
          200,
          [],
        ),
      ),
    };
    const { engine } = setup({ retrieval, policy: { maxQueries: 2 } });
    const input = request('login security');
    const result = await engine.search(input, context());
    expect(vi.mocked(retrieval.search).mock.calls.map(([call]) => call.query.providers)).toEqual([
      ['chatgpt', 'google-ai-mode'],
      ['google-ai-mode'],
    ]);
    expect(result.results).toContain('security');
    expect(result.outcomes[0]).toMatchObject({
      status: 'success',
      candidates: [corpus[0]],
      rateLimit: retryAfterMs === undefined ? {} : { retryAfterMs },
    });
    expect(validate(searchOutcomeSchemaFor(input, linkVerifiers), result).ok).toBe(true);
  },
);

it.each([
  [{}, undefined, {}],
  [{ retryAfterMs: 2000 }, undefined, { retryAfterMs: 2000 }],
  [{}, { retryAfterMs: 5000 }, { retryAfterMs: 5000 }],
  [{ retryAfterMs: 4000 }, { retryAfterMs: 1000 }, { retryAfterMs: 4000 }],
] as const)(
  'preserves the strongest retry hint while combining successful reads: %j then %j',
  (earlier, later, expected) => {
    const input = request('login security');
    const providerRequest: ProviderRequest = {
      requestId: input.requestId,
      query: input.query,
      scope: chatScope,
    };
    const first: ProviderOutcome = {
      requestId: input.requestId,
      scope: chatScope,
      status: 'success',
      candidates: [corpus[0]],
      coverage: { extent: 'partial', reasons: ['provider-failure'] },
      rateLimit: earlier,
    };
    const next: ProviderOutcome = {
      requestId: input.requestId,
      scope: chatScope,
      status: 'success',
      candidates: [],
      coverage: later
        ? { extent: 'partial', reasons: ['provider-failure'] }
        : { extent: 'complete', reasons: [] },
      ...(later ? { rateLimit: later } : {}),
    };
    const result = collect(first, next, providerRequest, linkVerifiers);
    expect(result).toMatchObject({
      status: 'success',
      candidates: [corpus[0]],
      rateLimit: expected,
    });
    expect(validate(providerOutcomeSchemaFor(providerRequest, linkVerifiers), result).ok).toBe(
      true,
    );
  },
);
