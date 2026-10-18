import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, SearchRequest } from '../../src/contracts';
import { request, candidate } from '../fixtures/description/corpus';
import { deferred } from '../fixtures/search/providers';
import { setup, context, ranking } from './helpers';

afterEach(() => vi.useRealTimers());

describe('untrusted model ports', () => {
  it.each([false, true])(
    'uses the same normalized interpretation for retrieval and fallback ranking (invalid ranker: %s)',
    async (invalidRanker) => {
      const item = candidate('orchard', 'Orchard', 'Orchard cultivation.');
      const interpreter = {
        interpret: vi.fn(async (input: SearchRequest) => ({
          requestId: input.requestId,
          topics: ['  ORCHARD  ', ' orchard '],
          keywords: ['  CULTIVATION  '],
        })),
      };
      const { engine, retrieval } = setup(
        {
          interpreter,
          ...(invalidRanker ? { ranker: { rank: vi.fn(async () => ({})) } } : {}),
        },
        [item],
      );
      const result = await engine.search(request('orchard'), context());
      expect(retrieval.search.mock.calls.map(([input]) => input.query.text)).toEqual([
        'orchard',
        'cultivation',
      ]);
      expect(result.description?.terms).toEqual(['orchard', 'cultivation']);
      expect(result.results).toEqual(['orchard']);
      const selection = result.description?.ranking.selections[0];
      expect(selection?.evidenceIds).toContain('orchard-excerpt');
      expect(selection?.spans).toContainEqual({ evidenceId: 'orchard-excerpt', start: 0, end: 7 });
    },
  );
  it('accepts validated interpretation and ranking without model-owned metadata', async () => {
    const interpreter = {
      interpret: vi.fn(async (input: SearchRequest) => ({
        requestId: input.requestId,
        topics: ['security'],
        keywords: [],
      })),
    };
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) =>
        ranking(input, candidates),
      ),
    };
    const result = await setup({ interpreter, ranker }).engine.search(request(), context());
    expect(result.description?.strategy).toBe('model-assisted');
    expect(result.description?.terms).toEqual(['security']);
    expect(ranker.rank).toHaveBeenCalledOnce();
    expect(result.results).toEqual(['security']);
    expect(result.description?.ranking.selections[0]).not.toHaveProperty('originalUrl');
  });
  it.each([
    { topics: [] },
    { topics: ['auth\u0000'] },
    { keywords: ['auth\n'] },
    { proposedProviders: ['google-ai-mode'] },
    { proposedDateRange: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' } },
    { originalUrl: 'https://evil.invalid' },
    { requestId: 'stale' },
    { keywords: ['x'.repeat(129)] },
  ])('rejects invalid plans: %j', async (proposal) => {
    const interpreter = {
      interpret: vi.fn(async (input: SearchRequest) => ({
        requestId: input.requestId,
        topics: ['security'],
        keywords: [],
        ...proposal,
      })),
    };
    const result = await setup({ interpreter }).engine.search(request(), context());
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.description?.notices).toContain('invalid-model-output');
    expect(result.results).toContain('security');
  });
  it.each([
    { candidateId: 'unknown' },
    { evidenceIds: ['other-candidate-evidence'] },
    { score: NaN },
    { score: Infinity },
    { score: -1 },
    { score: 1.01 },
    { originalUrl: 'https://evil.invalid' },
    { quote: 'Invented quote' },
    { date: '2026-01-01' },
    { explanation: 'Unsupported claim' },
    { spans: [{ evidenceId: 'security-title', start: 0, end: 999 }] },
  ])('rejects unsupported ranking: %j', async (changes) => {
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) => {
        const output = ranking(input, candidates);

        return {
          ...output,
          selections: output.selections.map((item) => ({ ...item, ...changes })),
        };
      }),
    };
    const result = await setup({ ranker }).engine.search(request(), context());
    expect(result.description?.notices).toContain('invalid-model-output');
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.results).toContain('security');
  });
  it.each(['selection', 'evidence'])('rejects duplicate %s', async (duplicate) => {
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) => {
        const output = ranking(input, candidates);
        const first = output.selections[0];

        if (first) {
          if (duplicate === 'selection') output.selections.push(first);
          else first.evidenceIds.push(...first.evidenceIds);
        }

        return output;
      }),
    };
    expect(
      (await setup({ ranker }).engine.search(request(), context())).description?.notices,
    ).toContain('invalid-model-output');
  });
  it('accepts an empty ranking without fabricated matches', async () => {
    const ranker = {
      rank: vi.fn(async (input: SearchRequest) => ({ requestId: input.requestId, selections: [] })),
    };
    const result = await setup({ ranker }).engine.search(request(), context());
    expect(result.results).toEqual([]);
    expect(result.description?.strategy).toBe('model-assisted');
  });
  it('handles throwing ports without exposing error text', async () => {
    const interpreter = {
      interpret: vi.fn(async () => {
        throw new Error('private untrusted text');
      }),
    };
    const ranker = {
      rank: vi.fn(async () => {
        throw new Error('private untrusted text');
      }),
    };
    const result = await setup({ interpreter, ranker }).engine.search(request(), context());
    expect(result.description?.notices).toContain('invalid-model-output');
    expect(JSON.stringify(result)).not.toContain('private untrusted text');
  });
  it('times out inference and prevents concurrent reuse until abandoned work settles', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const interpreter = {
      interpret: vi.fn(async (_input: SearchRequest, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;

        return pending.promise;
      }),
    };
    const { engine } = setup({ interpreter, policy: { modelTimeoutMs: 10 } });
    const first = engine.search(request(), context());
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).description?.notices).toContain('model-timeout');
    expect(signal?.aborted).toBe(true);
    const second = await engine.search(request(), context());
    expect(second.description?.notices).toContain('invalid-model-output');
    expect(interpreter.interpret).toHaveBeenCalledOnce();
    pending.reject(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
  });
  it('times out a ranker and retains deterministic ranking', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const ranker = { rank: vi.fn(() => pending.promise) };
    const { engine } = setup({ ranker, policy: { modelTimeoutMs: 10 } });
    const run = engine.search(request(), context());
    await vi.advanceTimersByTimeAsync(10);
    const result = await run;
    expect(result.results).toContain('security');
    expect(result.description?.notices).toContain('model-timeout');
    pending.resolve({});
    await Promise.resolve();
  });
  it('reorders validated selections by score', async () => {
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) => ({
        requestId: input.requestId,
        selections: candidates.map((item, i) => ({
          candidateId: item.id,
          evidenceIds: item.evidence.map((part) => part.id),
          score: i === 0 ? 0.1 : 0.9,
        })),
      })),
    };
    const result = await setup({ ranker }).engine.search(request(), context());
    expect(result.results[0]).not.toBe('security');
  });
});
