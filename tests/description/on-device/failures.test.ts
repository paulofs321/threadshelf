import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelOperationContext, SearchRequest, Candidate } from '../../../src/contracts';
import { candidate, request } from '../../fixtures/description/corpus';
import { context, setup } from '../helpers';
import { fixture } from './helpers';

afterEach(() => vi.useRealTimers());

const terms = { topics: ['origami'], keywords: [] };
const item = candidate('paper', 'Notes', 'Fold paper animals.');
const selection = { candidateId: item.id, score: 0.9, evidenceIds: [item.evidence[1]?.id] };
const modelContext = () => ({ ...context(), onPrompt: vi.fn(), onFailure: vi.fn() });

describe('local structured-output compatibility', () => {
  it.each(['measure', 'prompt'] as const)(
    'retries unsupported %s constraints once with a fresh clone and explicit JSON instructions',
    async (phase) => {
      const f = fixture(terms);
      await f.ready();
      const first = { ...f.session, destroy: vi.fn() };

      if (phase === 'measure')
        first.measureContextUsage = vi
          .fn()
          .mockRejectedValue(new DOMException('private error', 'NotSupportedError'));
      else
        first.prompt = vi
          .fn()
          .mockRejectedValue(new DOMException('private error', 'NotSupportedError'));

      f.base.clone.mockResolvedValueOnce(first).mockResolvedValueOnce(f.session);
      const ctx = modelContext();
      const input = request('paper animals');
      const result = await f.model.interpret(input, ctx);
      expect(result).toMatchObject(terms);
      expect(f.base.clone).toHaveBeenCalledTimes(2);
      expect(first.destroy).toHaveBeenCalledOnce();
      expect(f.session.destroy).toHaveBeenCalledOnce();
      expect(ctx.onPrompt).toHaveBeenCalledTimes(phase === 'measure' ? 1 : 2);
      expect(ctx.onFailure).not.toHaveBeenCalled();
      expect(f.session.prompt.mock.calls[0]?.[1]).not.toHaveProperty('responseConstraint');
      expect(f.session.prompt.mock.calls[0]?.[0]).toContain(
        'Return exactly one JSON object shaped',
      );
      expect(f.session.prompt.mock.calls[0]?.[0]).toContain(input.query.text);
    },
  );

  it('still grounds the plain-JSON ranking in owned candidate/evidence IDs', async () => {
    for (const valid of [true, false]) {
      const f = fixture({
        selections: [{ ...selection, ...(valid ? {} : { evidenceIds: ['invented'] }) }],
      });
      await f.ready();
      f.session.prompt.mockRejectedValueOnce(
        new DOMException('private error', 'NotSupportedError'),
      );
      const ctx = modelContext();
      const run = f.model.rank(request(), [item], ctx);

      if (valid) await expect(run).resolves.toMatchObject({ selections: [selection] });
      else {
        await expect(run).rejects.toThrow();
        expect(ctx.onFailure).toHaveBeenLastCalledWith({
          phase: 'validate',
          code: 'invalid-output',
        });
      }

      expect(f.session.prompt).toHaveBeenCalledTimes(2);
      expect(f.session.prompt.mock.calls[1]?.[1]).not.toHaveProperty('responseConstraint');
    }
  });

  it('stops after the compatibility attempt if plain prompting is also unsupported', async () => {
    const f = fixture();
    await f.ready();
    f.session.prompt.mockRejectedValue(new DOMException('private error', 'NotSupportedError'));
    const ctx = modelContext();
    await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
    expect(f.session.prompt).toHaveBeenCalledTimes(2);
    expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({
      phase: 'prompt',
      code: 'api-error',
      apiError: 'NotSupportedError',
    });
    expect(f.session.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not retry unsupported clone creation as if it were a response-constraint error', async () => {
    const f = fixture();
    await f.ready();
    f.base.clone.mockRejectedValue(new DOMException('private error', 'NotSupportedError'));
    const ctx = modelContext();
    await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
    expect(f.base.clone).toHaveBeenCalledOnce();
    expect(ctx.onPrompt).not.toHaveBeenCalled();
    expect(ctx.onFailure).toHaveBeenCalledWith({
      phase: 'prepare',
      code: 'api-error',
      apiError: 'NotSupportedError',
    });
  });

  it('shares the nine-second deadline across both attempts and ignores late completion', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.ready();
    let call = 0;
    f.session.prompt.mockImplementation(async () => {
      const attempt = ++call;
      await new Promise((resolve) => setTimeout(resolve, 6000));

      if (attempt === 1) throw new DOMException('private error', 'NotSupportedError');

      return JSON.stringify(terms);
    });
    const ctx = modelContext();
    const run = f.model.interpret(request(), ctx);
    const failure = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(9000);
    await failure;
    expect(ctx.onPrompt).toHaveBeenCalledTimes(2);
    expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: 'prompt', code: 'timeout' });
    expect(f.session.destroy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctx.onFailure).toHaveBeenCalledOnce();
  });
});

describe('safe local inference failure reasons', () => {
  it.each([
    ['TypeError', 'api-error'],
    ['SyntaxError', 'api-error'],
    ['InvalidStateError', 'api-error'],
    ['NotAllowedError', 'api-error'],
    ['OperationError', 'api-error'],
    ['UnknownError', 'api-error'],
    ['QuotaExceededError', 'context-limit'],
    ['AbortError', 'cancelled'],
    ['TimeoutError', 'timeout'],
  ] as const)('reports %s without raw messages or a compatibility retry', async (name, code) => {
    const f = fixture();
    await f.ready();
    f.session.prompt.mockRejectedValue(
      new DOMException('private error and conversation content', name),
    );
    const ctx = modelContext();
    await expect(f.model.interpret(request(), ctx)).rejects.toThrow('Local inference failed.');
    expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({
      phase: 'prompt',
      code,
      apiError: name,
    });
    expect(f.session.prompt).toHaveBeenCalledOnce();
    expect(JSON.stringify(ctx.onFailure.mock.calls)).not.toContain('private');
  });

  it.each([new Error('private error'), 'private error'])(
    'drops unrecognized exception names and values %#',
    async (error) => {
      const f = fixture();
      await f.ready();
      f.session.prompt.mockRejectedValue(error);
      const ctx = modelContext();
      await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
      expect(ctx.onFailure).toHaveBeenCalledWith({ phase: 'prompt', code: 'api-error' });
    },
  );

  it.each([
    { response: 'not JSON', failure: { phase: 'parse', code: 'invalid-json' } },
    {
      response: '```json\n{}\n```\n```json\n{}\n```',
      failure: { phase: 'parse', code: 'invalid-json' },
    },
    { response: 'Here is JSON: {}', failure: { phase: 'parse', code: 'invalid-json' } },
    { response: 'x'.repeat(32001), failure: { phase: 'parse', code: 'response-limit' } },
    { response: '{}', failure: { phase: 'validate', code: 'invalid-output' } },
  ])(
    'distinguishes response failure %# without preserving the response',
    async ({ response, failure }) => {
      const f = fixture();
      await f.ready();
      f.session.prompt.mockResolvedValue(response);
      const ctx = modelContext();
      await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
      expect(ctx.onFailure).toHaveBeenCalledWith(failure);
      expect(f.session.prompt).toHaveBeenCalledOnce();
    },
  );

  it.each(['json', ''])(
    'accepts one enclosing %s code fence, followed by strict validation',
    async (language) => {
      const f = fixture();
      await f.ready();
      f.session.prompt.mockResolvedValue(
        ` \n\x60\x60\x60${language}\n${JSON.stringify(terms)}\n\x60\x60\x60\n`,
      );
      await expect(f.model.interpret(request(), context())).resolves.toMatchObject(terms);
    },
  );

  it('reports a context preflight failure without claiming a model prompt was sent', async () => {
    const f = fixture();
    await f.ready();
    f.session.measureContextUsage.mockResolvedValue(9000);
    const ctx = modelContext();
    await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
    expect(ctx.onFailure).toHaveBeenCalledWith({ phase: 'measure', code: 'context-limit' });
    expect(ctx.onPrompt).not.toHaveBeenCalled();
  });
  it('reports an oversized serialized prompt before inference, even within the evidence-text budget', async () => {
    const f = fixture();
    await f.ready();
    const huge = candidate('large', 'Notes', '"'.repeat(2000));
    huge.evidence.push(
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `part-${i}` as (typeof huge.evidence)[number]['id'],
        source: 'provider-message' as const,
        text: '"'.repeat(2000),
      })),
    );
    const ctx = modelContext();
    await expect(f.model.rank(request(), [huge], ctx)).rejects.toThrow();
    expect(ctx.onFailure).toHaveBeenCalledWith({ phase: 'prepare', code: 'prompt-limit' });
    expect(ctx.onPrompt).not.toHaveBeenCalled();
  });
});

describe('failure diagnostics reach only the active search', () => {
  it('labels the internal inference deadline as timeout rather than invalid model output', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.ready();
    f.session.prompt.mockReturnValue(new Promise(() => {}));
    const { engine } = setup({ model: () => f.model, policy: { modelTimeoutMs: 10_000 } }, []);
    const run = engine.search(request(), context());
    await vi.advanceTimersByTimeAsync(9000);
    const result = await run;
    expect(result.description?.execution?.interpretation).toEqual({
      status: 'timeout',
      promptCalls: 1,
      failure: { phase: 'prompt', code: 'timeout' },
    });
    expect(result.description?.notices).toContain('model-timeout');
  });

  it.each(['interpretation', 'matching'] as const)(
    'validates %s diagnostics and ignores callbacks after cancellation',
    async (stage) => {
      vi.useFakeTimers();
      let abandoned: ModelOperationContext | undefined;

      const hold = async (_input: SearchRequest, ctx: ModelOperationContext) => {
        abandoned = ctx;
        ctx.onFailure?.({ phase: 'prompt', code: 'api-error', message: 'private payload' });

        return new Promise(() => {});
      };

      const ports =
        stage === 'interpretation'
          ? { interpreter: { interpret: hold } }
          : {
              ranker: {
                rank: (
                  input: SearchRequest,
                  _items: readonly Candidate[],
                  ctx: ModelOperationContext,
                ) => hold(input, ctx),
              },
            };
      const { engine } = setup({ ...ports, policy: { modelTimeoutMs: 10 } });
      const run = engine.search(request('authentication'), context());
      await vi.advanceTimersByTimeAsync(10);
      const result = await run;
      expect(result.description?.execution?.[stage]).not.toHaveProperty('failure');
      abandoned?.onFailure?.({ phase: 'prompt', code: 'api-error' });
      expect(result.description?.execution?.[stage]).not.toHaveProperty('failure');
      expect(JSON.stringify(result)).not.toContain('private payload');
    },
  );

  it('does not keep obsolete failure details after validated stage success', async () => {
    const notify = (ctx: ModelOperationContext) =>
      ctx.onFailure?.({ phase: 'prompt', code: 'api-error' });
    const result = await setup(
      {
        interpreter: {
          interpret: async (input, ctx) => {
            notify(ctx);

            return { requestId: input.requestId, ...terms };
          },
        },
        ranker: {
          rank: async (input, _candidates, ctx) => {
            notify(ctx);

            return { requestId: input.requestId, selections: [] };
          },
        },
      },
      [item],
    ).engine.search(request(), context());
    expect(result.description?.execution?.interpretation).not.toHaveProperty('failure');
    expect(result.description?.execution?.matching).not.toHaveProperty('failure');
  });
});
