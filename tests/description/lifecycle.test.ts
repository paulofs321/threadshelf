import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchOutcome, SearchPort } from '../../src/contracts';
import { request, chatScope, now, linkVerifiers } from '../fixtures/description/corpus';
import { aggregateSearch } from '../../src/search/aggregate';
import { deferred } from '../fixtures/search/providers';
import { setup, context } from './helpers';

afterEach(() => vi.useRealTimers());

describe('description lifecycle', () => {
  it.each(['interpret', 'retrieval', 'rank'] as const)(
    'cancels during %s and discards late output',
    async (stage) => {
      const pending = deferred();
      const controller = new AbortController();
      const interpreter = { interpret: vi.fn(() => pending.promise) };
      const ranker = { rank: vi.fn(() => pending.promise) };
      const waiting = {
        search: vi.fn<SearchPort['search']>(() => pending.promise as Promise<SearchOutcome>),
        invalidate: vi.fn(),
      };
      const { engine } = setup({
        ...(stage === 'interpret' ? { interpreter } : {}),
        ...(stage === 'rank' ? { ranker } : {}),
        ...(stage === 'retrieval' ? { retrieval: waiting } : {}),
      });
      const run = engine.search(request(), { signal: controller.signal });
      await vi.waitFor(() =>
        expect(
          stage === 'interpret'
            ? interpreter.interpret
            : stage === 'rank'
              ? ranker.rank
              : waiting.search,
        ).toHaveBeenCalled(),
      );
      controller.abort();
      const result = await run;
      expect(result.state).toBe('cancelled');
      expect(result.results).toEqual([]);
      expect(result.description).toBeUndefined();
      pending.resolve({});
      await Promise.resolve();
    },
  );
  it('pre-aborted signals do not read the clock or dispatch', async () => {
    const clock = vi.fn(() => now);
    const { engine, retrieval } = setup({ now: clock });
    const controller = new AbortController();
    controller.abort();
    expect((await engine.search(request(), { signal: controller.signal })).state).toBe('cancelled');
    expect(clock).not.toHaveBeenCalled();
    expect(retrieval.search).not.toHaveBeenCalled();
  });
  it('replaces pending searches with the same caller ID safely', async () => {
    const pending = deferred();
    const interpreter = { interpret: vi.fn(() => pending.promise) };
    const { engine } = setup({ interpreter });
    const old = engine.search(request(), context());
    await vi.waitFor(() => expect(interpreter.interpret).toHaveBeenCalled());
    const current = engine.search(request(), context());
    expect((await old).state).toBe('cancelled');
    expect((await current).results).toContain('security');
    pending.resolve({});
    await Promise.resolve();
  });
  it('bounds the whole request including uncooperative retrieval', async () => {
    vi.useFakeTimers();
    const pending = deferred<SearchOutcome>();
    const retrieval = { search: vi.fn(() => pending.promise), invalidate: vi.fn() };
    const { engine } = setup({ retrieval, policy: { requestTimeoutMs: 10 } });
    const promise = engine.search(request(), context());
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.results).toEqual([]);
    expect(result.outcomes.every((item) => item.status === 'timeout')).toBe(true);
    pending.resolve({} as SearchOutcome);
    await Promise.resolve();
  });
  it.each(['resolved', 'rejected'] as const)(
    'waits for an abort-aware replaced retrieval to settle: %s',
    async (settlement) => {
      const { native } = setup();
      const retrieval = {
        search: vi
          .fn<SearchPort['search']>()
          .mockImplementation((input, ctx) => native.search(input, ctx)),
        invalidate: vi.fn(),
      };
      retrieval.search.mockImplementationOnce(
        (input, ctx) =>
          new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              queueMicrotask(() => {
                if (settlement === 'rejected') reject(new Error('Synthetic abort'));
                else
                  resolve(
                    aggregateSearch(
                      input,
                      input.scopes.map((scope) => ({
                        requestId: input.requestId,
                        scope,
                        status: 'cancelled',
                      })),
                      linkVerifiers,
                      100,
                      [],
                    ),
                  );
              });
            });
          }),
      );
      const { engine } = setup({ retrieval });
      const old = engine.search(request(), context());
      await vi.waitFor(() => expect(retrieval.search).toHaveBeenCalledOnce());
      const current = engine.search(request(), context());
      expect((await old).state).toBe('cancelled');
      const result = await current;
      expect(result.state).toBe('success');
      expect(result.results).toContain('security');
      expect(retrieval.search).toHaveBeenCalledTimes(3);
    },
  );
  it('bounds replacement waiting without overlapping an uncooperative retrieval', async () => {
    vi.useFakeTimers();
    const pending = deferred<SearchOutcome>();
    const retrieval = { search: vi.fn(() => pending.promise), invalidate: vi.fn() };
    const { engine } = setup({ retrieval, policy: { requestTimeoutMs: 10 } });
    const old = engine.search(request(), context());
    await vi.advanceTimersByTimeAsync(0);
    const current = engine.search(request(), context());
    expect((await old).state).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(10);
    const result = await current;
    expect(result.outcomes.every((item) => item.status === 'timeout')).toBe(true);
    expect(retrieval.search).toHaveBeenCalledOnce();
    pending.resolve({} as SearchOutcome);
    await vi.advanceTimersByTimeAsync(0);
  });
  it.each(['cancel', 'invalidate', 'replace'] as const)(
    'does not dispatch an obsolete waiter after %s',
    async (action) => {
      vi.useFakeTimers();
      const pending = deferred<SearchOutcome>();
      const { native } = setup();
      const retrieval = {
        search: vi
          .fn<SearchPort['search']>()
          .mockImplementation((input, ctx) => native.search(input, ctx)),
        invalidate: vi.fn(),
      };
      retrieval.search.mockImplementationOnce(() => pending.promise);
      const { engine } = setup({ retrieval });
      const old = engine.search(request(), context());
      await vi.advanceTimersByTimeAsync(0);
      const controller = new AbortController();
      const waiting = engine.search(request(), { signal: controller.signal });
      expect((await old).state).toBe('cancelled');
      await vi.advanceTimersByTimeAsync(5);
      expect(retrieval.search).toHaveBeenCalledOnce();
      let current: Promise<SearchOutcome> | undefined;

      if (action === 'cancel') controller.abort();
      else if (action === 'invalidate') engine.invalidate(chatScope);
      else current = engine.search(request(), context());

      const obsolete = await waiting;
      expect(obsolete.results).toEqual([]);
      expect(
        obsolete.outcomes.every(
          (item) => item.status === (action === 'invalidate' ? 'scope-changed' : 'cancelled'),
        ),
      ).toBe(true);
      pending.resolve({} as SearchOutcome);
      await vi.advanceTimersByTimeAsync(0);

      if (current) {
        expect((await current).results).toContain('security');
        expect(retrieval.search).toHaveBeenCalledTimes(3);
      } else expect(retrieval.search).toHaveBeenCalledOnce();
    },
  );
  it('invalidates ranking and retired generations while permitting newer scopes', async () => {
    const pending = deferred();
    const ranker = { rank: vi.fn(() => pending.promise) };
    const { engine, retrieval } = setup({ ranker });
    const running = engine.search(request(), context());
    await vi.waitFor(() => expect(ranker.rank).toHaveBeenCalled());
    engine.invalidate(chatScope);
    engine.invalidate(chatScope);
    const result = await running;
    expect(result.results).toEqual([]);
    expect(result.outcomes.every((item) => item.status === 'scope-changed')).toBe(true);
    expect((await engine.search(request(), context())).state).toBe('failure');
    expect(retrieval.invalidate).toHaveBeenCalledWith(chatScope);
    const newer = request();
    newer.scopes = newer.scopes.map((scope) => ({ ...scope, generation: scope.generation + 1 }));
    pending.resolve({});
    await Promise.resolve();
    await Promise.resolve();
    expect((await engine.search(newer, context())).description).toBeDefined();
  });
});

it('fails malformed or rejected retrieval without trusting its payload', async () => {
  for (const mode of ['malformed', 'rejected']) {
    const retrieval = {
      search: vi.fn<SearchPort['search']>(async () => {
        if (mode === 'rejected') throw new Error('private payload');

        return {} as SearchOutcome;
      }),
      invalidate: vi.fn(),
    };
    const result = await setup({ retrieval }).engine.search(request(), context());
    expect(result.state).toBe('failure');
    expect(result.outcomes.every((item) => item.status === 'schema-changed')).toBe(true);
    expect(result.results).toEqual([]);
  }
});
