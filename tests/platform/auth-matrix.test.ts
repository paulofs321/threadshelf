import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId, SessionScope } from '../../src/contracts';
import { signInTimeoutMs } from '../../src/platform/protocol';
import { brokerHarness, deferred, probe, tab } from './helpers';

async function flush() {
  for (let n = 0; n < 50; n++) await Promise.resolve();
}

function fixture(provider: ProviderId) {
  const inspect = vi.fn<(scope: SessionScope) => Promise<unknown>>(async (scope) => ({
    status: 'ready',
    scope,
  }));
  const returned = deferred<number | null>();
  const signIn = vi.fn(() => returned.promise);
  const h = brokerHarness(`matrix-${provider}`, { inspect, signIn });
  const origin = provider === 'chatgpt' ? 'https://chatgpt.com' : 'https://www.google.com';
  h.port.selectedTab.mockResolvedValue({
    ...tab,
    url: provider === 'chatgpt' ? `${origin}/` : `${origin}/search?udm=50`,
  });
  h.port.inspectDocument.mockResolvedValue({ ...probe, result: { origin, topLevel: true } });

  const connect = (id = 'fiction-auth-matrix') => {
    const reply = h.replyFor(id);
    h.broker.receive({ operation: 'connect', provider, requestId: id });

    return reply;
  };

  return { ...h, inspect, returned, signIn, connect };
}

afterEach(() => vi.useRealTimers());

describe.each(['chatgpt', 'google-ai-mode'] as const)(
  '%s authentication acceptance matrix',
  (provider) => {
    it.each([
      'unavailable',
      'schema-changed',
      'rate-limited',
      'timeout',
      'permission-needed',
      'scope-changed',
    ] as const)('never starts login for %s and permits an explicit retry', async (status) => {
      const h = fixture(provider);
      h.inspect.mockImplementationOnce(async (scope) => ({
        status,
        provider,
        generation: scope.generation,
      }));
      expect((await h.connect()).status).toBe(status);
      expect(h.signIn).not.toHaveBeenCalled();
      expect(await h.connect('fiction-retry')).toMatchObject({
        status: 'connected',
        session: 'authenticated',
      });
      h.broker.close();
    });

    it.each(['cancel', 'deadline', 'tab-close', 'panel-close', 'permission'] as const)(
      'retires %s sign-in and ignores a subsequent return',
      async (reason) => {
        vi.useFakeTimers();
        const h = fixture(provider);
        h.inspect.mockImplementationOnce(async (scope) => ({
          status: 'login-expired',
          provider,
          generation: scope.generation,
        }));
        const reply = h.connect();
        await flush();
        expect(h.messages.at(-1)).toMatchObject({ status: 'waiting-for-sign-in' });

        if (reason === 'cancel')
          h.broker.receive({ operation: 'cancel', requestId: 'fiction-auth-matrix' });

        if (reason === 'deadline') await vi.advanceTimersByTimeAsync(signInTimeoutMs);

        if (reason === 'tab-close') h.returned.resolve(null);

        if (reason === 'panel-close') h.broker.close();

        if (reason === 'permission') h.broker.invalidate(provider, 'permission-needed');

        if (reason !== 'panel-close')
          expect((await reply).status).toBe(
            reason === 'deadline'
              ? 'expired-wait'
              : reason === 'permission'
                ? 'permission-needed'
                : 'cancelled',
          );

        h.returned.resolve(tab.id);
        await flush();
        expect(h.inspect).toHaveBeenCalledOnce();
        expect(
          h.messages.some((item) => item.kind === 'reply' && item.status === 'connected'),
        ).toBe(false);
        h.broker.close();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('rejects stale or changed account evidence on returned verification', async () => {
      const h = fixture(provider);
      h.inspect.mockImplementationOnce(async (scope) => ({
        status: 'login-expired',
        provider,
        generation: scope.generation,
      }));
      h.inspect.mockImplementationOnce(async (scope) => ({
        status: 'ready',
        scope: { ...scope, generation: scope.generation - 1 },
      }));
      const reply = h.connect();
      await flush();
      h.returned.resolve(tab.id);
      expect((await reply).status).toBe('scope-changed');
      expect(h.signIn).toHaveBeenCalledOnce();
      h.broker.close();
    });
  },
);
