import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateListSchema, validate } from '../../../src/contracts';
import type { ModelOperationContext, SearchRequest } from '../../../src/contracts';
import { candidate, request } from '../../fixtures/description/corpus';
import { deferred } from '../../fixtures/search/providers';
import { context, setup } from '../helpers';
import { fixture } from './helpers';

afterEach(() => vi.useRealTimers());

function richInventory(count: number, messages: number, text = 'x') {
  return Array.from({ length: count }, (_, i) => {
    const item = candidate(`rich-${i}`, 'Notebook', text.repeat(2000));
    item.evidence.push(
      ...Array.from({ length: messages }, (_, n) => ({
        id: `rich-${i}-message-${n}` as (typeof item.evidence)[number]['id'],
        source: 'provider-message' as const,
        text: text.repeat(2000),
      })),
    );

    return item;
  });
}

describe('per-search inference accounting', () => {
  it.each([
    { count: 7, messages: 3, text: 'x' },
    { count: 9, messages: 1, text: '"' },
  ])(
    'prompts for every candidate in a valid inventory requiring $count batches',
    async ({ count, messages, text }) => {
      const items = richInventory(count, messages, text);
      expect(validate(CandidateListSchema, items).ok).toBe(true);
      const f = fixture();
      await f.ready();
      f.session.prompt.mockImplementation(async (prompt) => {
        if (String(prompt).startsWith('Interpret'))
          return JSON.stringify({ topics: ['notebook'], keywords: [] });

        const data = JSON.parse(String(prompt).split('Untrusted input JSON:\n')[1] ?? '{}');

        return JSON.stringify({
          selections: data.candidates.map(
            (item: { candidateId: string; evidence: { evidenceId: string }[] }) => ({
              candidateId: item.candidateId,
              score: 0.9,
              evidenceIds: [item.evidence[0]?.evidenceId],
            }),
          ),
        });
      });
      const result = await setup({ model: () => f.model }, items).engine.search(
        request('notebook'),
        context(),
      );
      expect(result.results).toEqual(items.map((item) => item.id));
      expect(result.description?.strategy).toBe('model-assisted');
      expect(result.description?.execution).toEqual({
        interpretation: { status: 'completed', promptCalls: 1 },
        matching: { status: 'completed', promptCalls: count },
        candidates: count,
        messageCandidates: count,
      });
      expect(f.session.prompt).toHaveBeenCalledTimes(count + 1);
      expect(f.session.destroy).toHaveBeenCalledTimes(count + 1);

      for (const [prompt] of f.session.prompt.mock.calls)
        expect(String(prompt).length).toBeLessThanOrEqual(16_000);
    },
  );

  it('retains the overall ranking deadline across batches and discards incomplete ranking', async () => {
    vi.useFakeTimers();
    const items = richInventory(7, 3);
    const f = fixture();
    await f.ready();
    f.session.prompt.mockImplementation(async (prompt) => {
      if (String(prompt).startsWith('Interpret'))
        return JSON.stringify({ topics: ['notebook'], keywords: [] });

      const data = JSON.parse(String(prompt).split('Untrusted input JSON:\n')[1] ?? '{}');
      await new Promise((resolve) => setTimeout(resolve, 6000));

      return JSON.stringify({
        selections: [
          {
            candidateId: data.candidates[0].candidateId,
            score: 0.9,
            evidenceIds: [data.candidates[0].evidence[0].evidenceId],
          },
        ],
      });
    });
    const { engine } = setup(
      { model: () => f.model, policy: { rankingTimeoutMs: 40_000, requestTimeoutMs: 60_000 } },
      items,
    );
    const run = engine.search(request('notebook'), context());
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await run;
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.description?.execution?.matching).toEqual({ status: 'timeout', promptCalls: 7 });
    expect(result.description?.notices).toContain('model-timeout');
    expect(result.description?.notices).toContain('literal-keywords');
    expect(result.results).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.session.destroy).toHaveBeenCalledTimes(8);
  });

  it.each(['context', 'prompt', 'output'])(
    'does not claim AI matching succeeded after a %s failure, even while the model remains ready',
    async (failure) => {
      const f = fixture({ topics: ['jobs'], keywords: [] });
      await f.ready();

      if (failure === 'context')
        f.session.measureContextUsage.mockResolvedValueOnce(200).mockResolvedValue(9000);

      if (failure === 'prompt')
        f.session.prompt
          .mockResolvedValueOnce(JSON.stringify({ topics: ['jobs'], keywords: [] }))
          .mockRejectedValue(new Error('private model error'));

      const result = await setup({ model: () => f.model }, [
        candidate('literal', 'Notes', 'Jobs in Switzerland.'),
      ]).engine.search(request('jobs in Switzerland'), context());
      expect(result.results).toEqual(['literal']);
      expect(result.description?.strategy).toBe('keyword-topic-fallback');
      expect(result.description?.execution).toMatchObject({
        interpretation: { status: 'completed', promptCalls: 1 },
        matching: { status: 'failed', promptCalls: failure === 'context' ? 0 : 1 },
      });
      expect(f.session.prompt).toHaveBeenCalledTimes(failure === 'context' ? 1 : 2);
      expect(f.publish).toHaveBeenLastCalledWith({ status: 'ready' });
      expect(JSON.stringify(result)).not.toContain('private model error');
    },
  );

  it('reports no prompts when AI is off and does not claim paraphrases are understood', async () => {
    const result = await setup({}, [
      candidate('literal', 'Notes', 'Jobs in Switzerland.'),
      candidate('paraphrase', 'Notes', 'Swiss engineering roles.'),
      candidate('unrelated', 'Notes', 'Jobs in Canada. Holidays in Switzerland.'),
    ]).engine.search(request('jobs in Switzerland'), context());
    expect(result.results).toEqual(['literal']);
    expect(result.description?.execution).toEqual({
      interpretation: { status: 'unavailable', promptCalls: 0 },
      matching: { status: 'unavailable', promptCalls: 0 },
      candidates: 3,
      messageCandidates: 0,
    });
  });

  it('skips matching when native retrieval produces no candidates', async () => {
    const f = fixture({ topics: ['origami'], keywords: [] });
    await f.ready();
    const result = await setup({ model: () => f.model }, []).engine.search(request(), context());
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.description?.execution).toMatchObject({
      interpretation: { status: 'completed', promptCalls: 1 },
      matching: { status: 'no-candidates', promptCalls: 0 },
      candidates: 0,
    });
    expect(f.session.prompt).toHaveBeenCalledOnce();
  });

  it.each(['interpretation', 'matching'] as const)(
    'records a %s deadline and ignores callbacks from abandoned work',
    async (stage) => {
      vi.useFakeTimers();
      const pending = deferred();
      let abandoned: ModelOperationContext | undefined;

      const hold = (_request: SearchRequest, ctx: ModelOperationContext) => {
        abandoned = ctx;
        ctx.onPrompt?.();

        return pending.promise;
      };

      const ports =
        stage === 'interpretation'
          ? { interpreter: { interpret: hold } }
          : {
              ranker: {
                rank: (input: SearchRequest, _candidates: unknown, ctx: ModelOperationContext) =>
                  hold(input, ctx),
              },
            };
      const { engine } = setup({ ...ports, policy: { modelTimeoutMs: 10 } });
      const run = engine.search(request('authentication'), context());
      await vi.advanceTimersByTimeAsync(10);
      const result = await run;
      expect(result.description?.execution?.[stage]).toEqual({ status: 'timeout', promptCalls: 1 });
      expect(result.description?.strategy).toBe('keyword-topic-fallback');
      abandoned?.onPrompt?.();
      expect(result.description?.execution?.[stage]?.promptCalls).toBe(1);
      pending.resolve({});
      await Promise.resolve();
    },
  );
});
