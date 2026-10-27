import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalSession } from '../../../src/description/on-device/types';
import { candidate, request } from '../../fixtures/description/corpus';
import { deferred } from '../../fixtures/search/providers';
import { context, setup } from '../helpers';
import { fixture } from './helpers';

afterEach(() => vi.useRealTimers());

describe('local context budget boundaries', () => {
  it.each([
    { window: 8192, usage: 20, measured: 7660, allowed: true },
    { window: 8192, usage: 20, measured: 7661, allowed: false },
    { window: 732, usage: 20, measured: 200, allowed: true },
    { window: 731, usage: 20, measured: 200, allowed: false },
    { window: 16384, usage: 20, measured: 7660, allowed: true },
    { window: 16384, usage: 20, measured: 7661, allowed: false },
    { window: 512, usage: 0, measured: 0, allowed: true },
    { window: 511, usage: 0, measured: 0, allowed: false },
  ])(
    'includes warm context and output reserve at $window/$usage/$measured (allowed: $allowed)',
    async ({ window, usage, measured, allowed }) => {
      const f = fixture();
      await f.ready();
      f.session.contextWindow = window;
      f.session.contextUsage = usage;
      f.session.measureContextUsage.mockResolvedValue(measured);
      const ctx = { ...context(), onPrompt: vi.fn(), onFailure: vi.fn() };
      const run = f.model.interpret(request(), ctx);

      if (allowed) {
        await expect(run).resolves.toHaveProperty('topics');
        expect(ctx.onPrompt).toHaveBeenCalledOnce();
        expect(ctx.onFailure).not.toHaveBeenCalled();
      } else {
        await expect(run).rejects.toThrow('Local inference failed.');
        expect(ctx.onPrompt).not.toHaveBeenCalled();
        expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({
          phase: 'measure',
          code: 'context-limit',
        });
      }

      expect(f.session.destroy).toHaveBeenCalledOnce();
      expect(f.publish).toHaveBeenLastCalledWith({ status: 'ready' });
    },
  );

  it.each([
    { usage: -1, measured: 7681 },
    { usage: -10000, measured: 9000 },
  ])(
    'rejects negative usage $usage before it can discount the budget',
    async ({ usage, measured }) => {
      const f = fixture();
      await f.ready();
      f.session.contextUsage = usage;
      f.session.measureContextUsage.mockResolvedValue(measured);
      const ctx = { ...context(), onFailure: vi.fn() };
      await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
      expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({
        phase: 'measure',
        code: 'context-limit',
      });
      expect(f.session.prompt).not.toHaveBeenCalled();
      expect(f.session.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([0, -1, Infinity, -Infinity])('rejects invalid context window %s', async (window) => {
    const f = fixture();
    await f.ready();
    f.session.contextWindow = window;
    await expect(f.model.interpret(request(), context())).rejects.toThrow();
    expect(f.session.prompt).not.toHaveBeenCalled();
    expect(f.session.destroy).toHaveBeenCalledOnce();
  });

  it('uses the labeled literal fallback with valid evidence after invalid context metadata', async () => {
    const f = fixture();
    await f.ready();
    f.session.contextUsage = -10000;
    f.session.measureContextUsage.mockResolvedValue(9000);
    const result = await setup({ model: () => f.model }, [
      candidate('paper', 'Notebook', 'Fold paper animals.'),
    ]).engine.search(request('paper animals'), context());
    expect(result.results).toEqual(['paper']);
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.description?.notices).toContain('literal-keywords');
    expect(result.description?.execution?.interpretation).toEqual({
      status: 'failed',
      promptCalls: 0,
      failure: { phase: 'measure', code: 'context-limit' },
    });
    expect(f.session.prompt).not.toHaveBeenCalled();
  });
});

describe('compatibility retry cancellation', () => {
  it.each(['cancel', 'disable'] as const)(
    'destroys a late compatibility clone after %s without prompting it',
    async (action) => {
      const f = fixture();
      await f.ready();
      const first = {
        ...f.session,
        prompt: vi.fn().mockRejectedValue(new DOMException('synthetic', 'NotSupportedError')),
        destroy: vi.fn(),
      };
      const late = deferred<LocalSession>();
      f.base.clone.mockResolvedValueOnce(first).mockReturnValueOnce(late.promise);
      const controller = new AbortController();
      const ctx = { signal: controller.signal, onPrompt: vi.fn(), onFailure: vi.fn() };
      const run = f.model.interpret(request(), ctx);
      await vi.waitFor(() => expect(f.base.clone).toHaveBeenCalledTimes(2));

      if (action === 'disable') f.model.disable();
      else controller.abort();

      await expect(run).rejects.toThrow();
      expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({
        phase: 'prepare',
        code: 'cancelled',
      });
      expect(first.destroy).toHaveBeenCalledOnce();
      late.resolve(f.session);
      await vi.waitFor(() => expect(f.session.destroy).toHaveBeenCalledOnce());
      expect(f.session.measureContextUsage).toHaveBeenCalledOnce();
      expect(f.session.prompt).not.toHaveBeenCalled();
      expect(ctx.onPrompt).toHaveBeenCalledOnce();
      expect(f.model.enabled).toBe(action === 'cancel');
      expect(f.publish).toHaveBeenLastCalledWith({
        status: action === 'cancel' ? 'ready' : 'disabled',
      });
    },
  );

  it('blocks overlapping inference after abort and recovers only after the old prompt settles', async () => {
    const f = fixture();
    await f.ready();
    const late = deferred<string>();
    f.session.prompt.mockReturnValueOnce(late.promise);
    const controller = new AbortController();
    const run = f.model.interpret(request(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.session.prompt).toHaveBeenCalledOnce());
    controller.abort();
    await expect(run).rejects.toThrow();
    const ctx = { ...context(), onFailure: vi.fn() };
    await expect(f.model.interpret(request(), ctx)).rejects.toThrow();
    expect(ctx.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: 'prepare', code: 'busy' });
    expect(f.base.clone).toHaveBeenCalledOnce();
    late.resolve(JSON.stringify({ topics: ['obsolete'], keywords: [] }));
    // Drain the abandoned prompt and its ownership-release continuation.
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    await expect(f.model.interpret(request(), context())).resolves.toMatchObject({
      topics: ['hiring', 'interviews', 'applications'],
    });
    expect(f.base.clone).toHaveBeenCalledTimes(2);
    expect(f.session.destroy).toHaveBeenCalledTimes(2);
  });
});
