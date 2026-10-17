import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserLanguageModel, OnDeviceModel } from '../../../src/description/on-device/model';
import type { LocalSession } from '../../../src/description/on-device/types';
import { modelOptions, systemInstruction } from '../../../src/description/on-device/prompts';
import { request, candidate } from '../../fixtures/description/corpus';
import { deferred } from '../../fixtures/search/providers';
import { context, setup } from '../helpers';
import { fixture } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('optional document-local model lifecycle', () => {
  it('detects an absent or present browser API without creating a session', () => {
    vi.stubGlobal('LanguageModel', undefined);
    expect(browserLanguageModel()).toBeUndefined();
    const { factory } = fixture();
    vi.stubGlobal('LanguageModel', factory);
    expect(browserLanguageModel()).toBe(factory);
  });
  it('reports unsupported API and ignores enable without prior supported availability', async () => {
    const publish = vi.fn();
    const model = new OnDeviceModel(() => undefined, publish);
    await model.enable();
    await model.check();
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' });
    expect(model.enabled).toBe(false);
  });
  it.each(['available', 'downloadable', 'downloading', 'unavailable'] as const)(
    'checks %s without downloading',
    async (status) => {
      const { model, factory, publish } = fixture();
      factory.availability.mockResolvedValue(status);
      await model.check();
      expect(publish).toHaveBeenLastCalledWith({
        status: status === 'downloading' ? 'downloadable' : status,
      });
      expect(factory.create).not.toHaveBeenCalled();
      expect(factory.availability).toHaveBeenCalledWith(modelOptions);
    },
  );
  it('creates from the user action synchronously, carries no history and destroys warm session when disabled', async () => {
    const { model, factory, base, publish } = fixture();
    await model.check();
    const pending = model.enable();
    expect(factory.create).toHaveBeenCalledOnce();
    expect(factory.create.mock.calls[0]?.[0]?.initialPrompts).toEqual([
      { role: 'system', content: systemInstruction },
    ]);
    await pending;
    expect(model.enabled).toBe(true);
    expect(publish).toHaveBeenLastCalledWith({ status: 'ready' });
    model.disable();
    expect(model.enabled).toBe(false);
    expect(base.destroy).toHaveBeenCalledOnce();
  });
  it('handles disappearing API, thrown availability and synchronous or rejected creation errors', async () => {
    const { factory, publish } = fixture();
    let present = true;
    const model = new OnDeviceModel(() => (present ? factory : undefined), publish);
    await model.check();
    present = false;
    await model.enable();
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' });
    const x = fixture();
    x.factory.availability.mockRejectedValue(new Error('private'));
    await x.model.check();
    expect(x.publish).toHaveBeenLastCalledWith({ status: 'error' });

    for (const sync of [true, false]) {
      const f = fixture();
      await f.model.check();
      f.factory.create.mockImplementation(() => {
        if (sync) throw new Error('private');

        return Promise.reject(new Error('private'));
      });
      await f.model.enable();
      expect(f.publish).toHaveBeenLastCalledWith({ status: 'error' });
    }
  });
  it('discards stale availability completions or failures', async () => {
    for (const reject of [true, false]) {
      const f = fixture();
      const pending = deferred<Availability>();
      f.factory.availability.mockReturnValue(pending.promise);
      const check = f.model.check();
      f.model.disable();

      if (reject) pending.reject(new Error('late'));
      else pending.resolve('available');

      await check;
      expect(f.publish).toHaveBeenLastCalledWith({ status: 'disabled' });
    }
  });
  it('bounds capability checks and download preparation with independent deadlines', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.factory.availability.mockReturnValue(new Promise(() => {}));
    const check = f.model.check();
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    expect(f.publish).toHaveBeenLastCalledWith({ status: 'error' });
    f.factory.availability.mockResolvedValue('downloadable');
    await f.model.check();
    const late = deferred<LocalSession>();
    f.factory.create.mockReturnValue(late.promise);
    const enabling = f.model.enable();
    await vi.advanceTimersByTimeAsync(120000);
    await enabling;
    expect(f.publish).toHaveBeenLastCalledWith({ status: 'error' });
    expect(f.factory.create.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    late.resolve(f.base);
    await Promise.resolve();
    expect(f.base.destroy).toHaveBeenCalledOnce();
  });
  it('publishes bounded monotonic download progress, supports cancellation and destroys late sessions', async () => {
    const f = fixture();
    f.factory.availability.mockResolvedValue('downloadable');
    await f.model.check();
    const monitor = Object.assign(new EventTarget(), { ondownloadprogress: null });
    const late = deferred<LocalSession>();
    f.factory.create.mockImplementation((options) => {
      options?.monitor?.(monitor);

      return late.promise;
    });
    const enabling = f.model.enable();

    const emit = (loaded: number) => {
      const event = new Event('downloadprogress');
      Object.defineProperty(event, 'loaded', { value: loaded });
      monitor.dispatchEvent(event);
    };

    for (const n of [0, 0.6, 0.2, NaN, -1, 1.1]) emit(n);

    expect(f.publish).toHaveBeenLastCalledWith({ status: 'downloading', progress: 0.6 });
    f.model.disable();
    emit(1);
    await enabling;
    expect(f.publish).toHaveBeenLastCalledWith({ status: 'disabled' });
    late.resolve(f.base);
    await Promise.resolve();
    expect(f.base.destroy).toHaveBeenCalledOnce();
  });
});

describe('bounded on-device inference with grounded unknown-output ports', () => {
  it('expands descriptions through the model with fresh isolated clones', async () => {
    const f = fixture();
    await f.ready();
    const input = request('Which sessions did we talk about jobs?');
    const plan = await f.model.interpret(input, context());
    expect(plan).toEqual({
      requestId: input.requestId,
      topics: ['hiring', 'interviews', 'applications'],
      keywords: ['careers'],
    });
    expect(f.session.prompt.mock.calls[0]?.[0]).toContain(input.query.text);
    expect(f.session.destroy).toHaveBeenCalledOnce();
    expect(f.base.destroy).not.toHaveBeenCalled();
    await f.model.interpret(request('a different topic'), context());
    expect(f.base.clone).toHaveBeenCalledTimes(2);
    expect(f.session.destroy).toHaveBeenCalledTimes(2);
  });
  it('ranks only provided evidence and omits URL, account, scope and dates from prompts', async () => {
    const item = candidate(
      'fiction-hiring',
      'Hiring notebook',
      'Prepare applications and interviews',
    );
    const input = request('jobs');
    const f = fixture({
      selections: [
        { candidateId: item.id, score: 0.9, evidenceIds: item.evidence.map((e) => e.id) },
      ],
    });
    await f.ready();
    const output = await f.model.rank(input, [item], context());
    expect(output).toHaveProperty('requestId', input.requestId);
    const prompt = String(f.session.prompt.mock.calls[0]?.[0]);
    expect(prompt).toContain('fiction-hiring');
    expect(prompt).not.toContain('originalUrl');
    expect(prompt).not.toContain('accountPartition');
    expect(prompt).not.toContain('scope');
  });
  it.each([
    { topics: ['x'], keywords: [], proposedProviders: ['google-ai-mode'] },
    { topics: ['x'], keywords: [], explanation: 'fabricated' },
    { topics: [], keywords: [] },
    { topics: ['x\u0000'], keywords: [] },
  ])('rejects invalid interpretation output: %j', async (output) => {
    const f = fixture(output);
    await f.ready();
    await expect(f.model.interpret(request(), context())).rejects.toThrow();
    expect(f.session.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    { candidateId: 'unknown', score: 0.5, evidenceIds: ['unknown'] },
    { candidateId: 'known', score: NaN, evidenceIds: ['known-title'] },
    { candidateId: 'known', score: 0.5, evidenceIds: ['other-candidate'] },
    { candidateId: 'known', score: 0.5, evidenceIds: ['known-title'], quote: 'fabricated' },
  ])('rejects invalid ranking output: %j', async (selection) => {
    const f = fixture({ selections: [selection] });
    await f.ready();
    await expect(
      f.model.rank(request(), [candidate('known', 'One', 'Two')], context()),
    ).rejects.toThrow();
  });
  it.each(['not JSON', 'x'.repeat(32001)])(
    'rejects malformed or oversized response',
    async (response) => {
      const f = fixture();
      await f.ready();
      f.session.prompt.mockResolvedValue(response);
      await expect(f.model.interpret(request(), context())).rejects.toThrow();
      expect(f.session.destroy).toHaveBeenCalledOnce();
    },
  );
  it('falls back when disabled, aborted or the candidate prompt exceeds the character budget', async () => {
    const f = fixture();
    await expect(f.model.interpret(request(), context())).rejects.toThrow();
    await f.ready();
    const controller = new AbortController();
    controller.abort();
    await expect(f.model.interpret(request(), { signal: controller.signal })).rejects.toThrow();
    const items = Array.from({ length: 12 }, (_, i) =>
      candidate(`large-${i}`, 'One', 'x'.repeat(2000)),
    );
    await expect(f.model.rank(request(), items, context())).rejects.toThrow();
    expect(f.base.clone).not.toHaveBeenCalled();
  });
  it.each([NaN, -1, 9000])('rejects invalid or excessive measured context %s', async (usage) => {
    const f = fixture();
    await f.ready();
    f.session.measureContextUsage.mockResolvedValue(usage);
    await expect(f.model.interpret(request(), context())).rejects.toThrow();
    expect(f.session.prompt).not.toHaveBeenCalled();
    expect(f.session.destroy).toHaveBeenCalledOnce();
  });
  it.each(['contextUsage', 'contextWindow'] as const)(
    'rejects invalid %s metadata',
    async (field) => {
      const f = fixture();
      await f.ready();
      f.session[field] = NaN;
      await expect(f.model.interpret(request(), context())).rejects.toThrow();
    },
  );
  it('destroys the active clone on cancellation and consumes late output without concurrent reuse', async () => {
    const f = fixture();
    await f.ready();
    const pending = deferred<string>();
    f.session.prompt.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const run = f.model.interpret(request(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.session.prompt).toHaveBeenCalled());
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(f.session.destroy).toHaveBeenCalledOnce();
    await expect(f.model.interpret(request(), context())).rejects.toThrow();
    pending.resolve('{}');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.session.destroy).toHaveBeenCalledOnce();
  });
  it('destroys a late clone when the account/model generation changes', async () => {
    const f = fixture();
    await f.ready();
    const pending = deferred<LocalSession>();
    f.base.clone.mockReturnValue(pending.promise);
    const run = f.model.interpret(request(), context());
    f.model.disable();
    await expect(run).rejects.toThrow();
    pending.resolve(f.session);
    await Promise.resolve();
    expect(f.session.destroy).toHaveBeenCalledOnce();
    expect(f.base.destroy).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenLastCalledWith({ status: 'disabled' });
  });
  it('does not prompt after cancellation while measuring context', async () => {
    const f = fixture();
    await f.ready();
    const pending = deferred<number>();
    f.session.measureContextUsage.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const run = f.model.interpret(request(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.session.measureContextUsage).toHaveBeenCalled());
    controller.abort();
    await expect(run).rejects.toThrow();
    pending.resolve(200);
    await Promise.resolve();
    expect(f.session.prompt).not.toHaveBeenCalled();
  });
  it('times out stalled inference and destroys session resources', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.ready();
    f.session.prompt.mockReturnValue(new Promise(() => {}));
    const run = f.model.interpret(request(), context());
    const failure = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(9000);
    await failure;
    expect(f.session.destroy).toHaveBeenCalledOnce();
  });
  it('does not have topic categories: model expansion retrieves unrelated topics by their meanings', async () => {
    for (const example of [
      {
        description: 'Which sessions did we talk about jobs?',
        terms: ['hiring', 'interviews', 'applications'],
        title: 'Interview preparation',
        text: 'Write applications and practice hiring questions',
      },
      {
        description: 'Where did we discuss folding paper animals?',
        terms: ['origami', 'folding', 'crafts'],
        title: 'Origami crane',
        text: 'Fold a crane from a square sheet',
      },
      {
        description: 'Find our chats about objects far beyond the solar system',
        terms: ['galaxies', 'astronomy', 'cosmology'],
        title: 'Galaxy observations',
        text: 'Astronomy and galaxies in the deep field',
      },
    ]) {
      const item = candidate('meaning', example.title, example.text);
      const f = fixture({ topics: example.terms, keywords: [] });
      await f.ready();
      f.session.prompt.mockImplementation(async (prompt) =>
        String(prompt).startsWith('Interpret')
          ? JSON.stringify({ topics: example.terms, keywords: [] })
          : JSON.stringify({
              selections: [
                { candidateId: item.id, score: 0.9, evidenceIds: [item.evidence[1]?.id] },
              ],
            }),
      );
      const { engine, chat } = setup({ model: () => f.model }, [item]);
      chat.search.mockImplementation(async (input) => ({
        requestId: input.requestId,
        scope: input.scope,
        status: 'success',
        candidates: item.evidence.some((e) => e.text.toLowerCase().includes(input.query.text))
          ? [item]
          : [],
        coverage: { extent: 'complete', reasons: [] },
      }));
      const result = await engine.search(request(example.description), context());
      expect(result.results).toEqual(['meaning']);
      expect(result.description?.strategy).toBe('model-assisted');
      expect(result.description?.notices).not.toContain('literal-keywords');
      f.model.disable();
    }
  });
});
