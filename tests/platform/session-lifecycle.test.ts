import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessClient } from '../../src/platform/client';
import { clientTimeoutMs, operationTimeoutMs, signInTimeoutMs } from '../../src/platform/protocol';
import type { SessionScope } from '../../src/contracts';
import { brokerHarness, deferred, event, probe, tab } from './helpers';

const flush = async () => {
  for (let n = 0; n < 50; n++) await Promise.resolve();
};

function fixture() {
  const inspect = vi.fn<(scope: SessionScope, signal: AbortSignal) => Promise<unknown>>(
    async (scope) => ({ status: 'ready', scope }),
  );
  const returned = deferred<number | null>();
  const signIn = vi.fn(() => returned.promise);
  const h = brokerHarness('auth', { inspect, signIn });

  return { ...h, inspect, signIn, returned };
}

afterEach(() => vi.useRealTimers());

describe('authenticated connection lifecycle', () => {
  it('gates authentication on inspectSession and keeps the selection unverified until it settles', async () => {
    const h = fixture();
    const check = deferred<{ status: 'ready'; scope: SessionScope }>();
    h.inspect.mockImplementation((scope) => check.promise.then(() => ({ status: 'ready', scope })));
    const reply = h.connect();
    await flush();
    expect(h.messages.some((m) => m.kind === 'reply')).toBe(false);
    expect(h.messages.at(-1)).toMatchObject({
      kind: 'connection-progress',
      status: 'checking-session',
    });
    check.resolve({ status: 'ready', scope: {} as SessionScope });
    expect(await reply).toMatchObject({ status: 'connected', session: 'authenticated' });
    expect(h.signIn).not.toHaveBeenCalled();
    h.broker.close();
  });

  it.each([
    'unavailable',
    'schema-changed',
    'rate-limited',
    'timeout',
    'cancelled',
    'interrupted',
    'permission-needed',
    'scope-changed',
  ] as const)('never redirects generic/unsupported session failure %s', async (status) => {
    const h = fixture();
    h.inspect.mockImplementation(async (scope) => ({
      status,
      provider: scope.provider,
      generation: scope.generation,
    }));
    expect((await h.connect()).status).toBe(status);
    expect(h.signIn).not.toHaveBeenCalled();
    h.broker.close();
  });

  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'waits beyond read deadlines, rebinds and verifies %s after return',
    async (provider) => {
      vi.useFakeTimers();
      const h = fixture();

      if (provider === 'google-ai-mode') {
        h.port.selectedTab.mockResolvedValue({
          ...tab,
          url: 'https://www.google.com/search?udm=50',
        });
        h.port.inspectDocument.mockResolvedValue({
          ...probe,
          result: { origin: 'https://www.google.com', topLevel: true },
        });
      }

      h.inspect.mockImplementationOnce(async (scope) => ({
        status: 'login-expired',
        provider,
        generation: scope.generation,
      }));
      const reply = h.replyFor('fiction-auth');
      h.broker.receive({ operation: 'connect', requestId: 'fiction-auth', provider });
      await flush();
      expect(h.signIn).toHaveBeenCalledOnce();
      expect(h.messages.at(-1)).toMatchObject({ status: 'waiting-for-sign-in' });
      const old = h.inspect.mock.calls[0]?.[0];

      if (!old) throw new Error('Missing scope');

      expect(h.broker.bindSelectedDocument(old)).toBeNull();
      await vi.advanceTimersByTimeAsync(clientTimeoutMs * 3);
      h.broker.tabChanged(tab.id); // Old source navigation cannot revive the retired selection.
      h.broker.receive({ operation: 'connect', requestId: 'fiction-duplicate', provider });
      expect(h.messages.at(-1)).toMatchObject({ status: 'busy' });
      h.returned.resolve(tab.id);
      expect(await reply).toMatchObject({
        status: 'connected',
        scope: { provider, generation: 3 },
        session: 'authenticated',
      });
      const fresh = h.inspect.mock.calls[1]?.[0];
      expect(fresh).not.toEqual(old);
      expect(h.port.selectedTab).toHaveBeenCalledWith(3, provider, expect.any(AbortSignal), tab.id);
      expect(h.inspect).toHaveBeenCalledTimes(2);
      h.broker.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('never repeats a login redirect when the returned session is still signed out', async () => {
    const h = fixture();
    h.inspect.mockImplementation(async (scope) => ({
      status: 'login-expired',
      provider: scope.provider,
      generation: scope.generation,
    }));
    const reply = h.connect();
    await flush();
    h.returned.resolve(tab.id);
    expect((await reply).status).toBe('login-expired');
    expect(h.signIn).toHaveBeenCalledOnce();
    h.broker.close();
  });

  it.each(['cancel', 'permission', 'deadline', 'panel', 'tab'] as const)(
    'settles %s and ignores late returns',
    async (reason) => {
      vi.useFakeTimers();
      const h = fixture();
      h.inspect.mockImplementationOnce(async (scope) => ({
        status: 'login-expired',
        provider: scope.provider,
        generation: scope.generation,
      }));
      const reply = h.connect();
      await flush();

      if (reason === 'cancel')
        h.broker.receive({ operation: 'cancel', requestId: 'fiction-request-one' });

      if (reason === 'permission') h.broker.invalidate('chatgpt', 'permission-needed');

      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(signInTimeoutMs);

      if (reason === 'panel') h.broker.close();

      if (reason === 'tab') h.returned.resolve(null);

      if (reason !== 'panel')
        expect((await reply).status).toBe(
          reason === 'permission'
            ? 'permission-needed'
            : reason === 'deadline'
              ? 'expired-wait'
              : 'cancelled',
        );

      h.returned.resolve(tab.id);
      await flush();
      expect(h.inspect).toHaveBeenCalledOnce();
      expect(h.messages.some((m) => m.kind === 'reply' && m.status === 'connected')).toBe(false);
      h.broker.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['malformed', 'wrong-scope', 'wrong-provider', 'throw', 'rebind-timeout'] as const)(
    'rejects %s authentication evidence',
    async (kind) => {
      vi.useFakeTimers();
      const h = fixture();
      h.inspect.mockImplementation(async (scope) => {
        if (kind === 'throw') throw new Error('fiction-private-details');

        if (kind === 'malformed') return { status: 'ready', scope, password: 'fiction' };

        if (kind === 'wrong-scope')
          return { status: 'ready', scope: { ...scope, generation: scope.generation + 1 } };

        return {
          status: 'login-expired',
          provider: kind === 'wrong-provider' ? 'google-ai-mode' : 'chatgpt',
          generation: scope.generation,
        };
      });
      const reply = h.connect();
      await flush();

      if (kind === 'rebind-timeout') {
        h.port.ownerWindow.mockReturnValue(new Promise(() => {}));
        h.returned.resolve(tab.id);
        await flush();
        await vi.advanceTimersByTimeAsync(operationTimeoutMs);
      }

      expect((await reply).status).toBe(
        kind === 'malformed' || kind === 'throw'
          ? 'unavailable'
          : kind === 'rebind-timeout'
            ? 'timeout'
            : 'scope-changed',
      );
      h.broker.close();
    },
  );
});

describe('panel-owned sign-in watchdog', () => {
  function clientFixture() {
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: event<[unknown]>(),
      onDisconnect: event<[]>(),
    };
    const client = new AccessClient(port, () => 'fiction-client-auth');
    const controller = new AbortController();
    const progress = vi.fn();
    client.subscribeProgress(progress);
    const result = client.connect('chatgpt', controller.signal);
    const emit = (status: string, provider = 'chatgpt') =>
      port.onMessage.emit({
        kind: 'connection-progress',
        requestId: 'fiction-client-auth',
        provider,
        status,
      });

    return { port, client, controller, progress, result, emit };
  }

  it('allows human sign-in beyond 12 seconds, rejects duplicate extension of the absolute wait, and ignores late success', async () => {
    vi.useFakeTimers();
    const h = clientFixture();
    h.emit('checking-session');
    h.emit('waiting-for-sign-in');
    await vi.advanceTimersByTimeAsync(signInTimeoutMs - 1);
    h.emit('waiting-for-sign-in');
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.result).status).toBe('expired-wait');
    h.port.onMessage.emit({
      kind: 'reply',
      requestId: 'fiction-client-auth',
      status: 'connected',
      session: 'authenticated',
      scope: { kind: 'ephemeral', provider: 'chatgpt', generation: 5, partition: 'fiction-late' },
    });
    h.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds returned verification separately and duplicate progress never extends it', async () => {
    vi.useFakeTimers();
    const h = clientFixture();
    h.emit('waiting-for-sign-in');
    await vi.advanceTimersByTimeAsync(30_000);
    h.emit('verifying-session');
    await vi.advanceTimersByTimeAsync(clientTimeoutMs - 1);
    h.emit('verifying-session');
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.result).status).toBe('timeout');
    h.client.close();
  });

  it.each(['cancel', 'disconnect', 'wrong-provider', 'out-of-order'] as const)(
    'interrupts %s without leaked listeners or timers',
    async (kind) => {
      vi.useFakeTimers();
      const h = clientFixture();
      h.emit('waiting-for-sign-in');

      if (kind === 'cancel') h.controller.abort();

      if (kind === 'disconnect') h.port.onDisconnect.emit();

      if (kind === 'wrong-provider') h.emit('waiting-for-sign-in', 'google-ai-mode');

      if (kind === 'out-of-order') {
        h.client.close();
        const other = clientFixture();
        other.emit('verifying-session');
        expect((await other.result).status).toBe('interrupted');
      }

      expect((await h.result).status).toBe(kind === 'cancel' ? 'cancelled' : 'interrupted');
      h.client.close();
      expect(h.port.onMessage.size()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('correlates progress, ignores obsolete IDs, and unsubscribes independently', async () => {
    const h = clientFixture();
    const listener = vi.fn();
    const unsubscribe = h.client.subscribeProgress(listener);
    h.port.onMessage.emit({
      kind: 'connection-progress',
      provider: 'chatgpt',
      requestId: 'fiction-obsolete',
      status: 'waiting-for-sign-in',
    });
    expect(listener).not.toHaveBeenCalled();
    h.emit('checking-session');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    h.emit('checking-session');
    expect(listener).toHaveBeenCalledOnce();
    h.controller.abort();
    await h.result;
    h.client.close();
  });
  it('rejects a return to waiting after verification instead of resetting the short deadline', async () => {
    const h = clientFixture();
    h.emit('waiting-for-sign-in');
    h.emit('verifying-session');
    h.emit('waiting-for-sign-in');
    expect((await h.result).status).toBe('interrupted');
    h.client.close();
  });
});
