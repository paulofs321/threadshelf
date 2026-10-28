import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessBroker } from '../../src/platform/broker';
import { AccessClient } from '../../src/platform/client';
import { operationTimeoutMs } from '../../src/platform/protocol';
import type { SessionScope } from '../../src/contracts';
import { brokerHarness, deferred, event } from './helpers';

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};

function fixture(withSessions = true) {
  let id = 0;
  const base = brokerHarness();
  const connection = {
    postMessage: vi.fn((message: unknown) => broker.receive(message)),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  const inspect = vi.fn<(scope: SessionScope, signal: AbortSignal) => Promise<unknown>>(
    async (scope) => ({ status: 'ready', scope }),
  );
  const signIn = vi.fn().mockResolvedValue(null);
  const broker = new AccessBroker(
    base.port,
    (message) => connection.onMessage.emit(message),
    () => {},
    () => `fiction-scope-${++id}`,
    withSessions ? { inspect, signIn } : undefined,
  );
  const client = new AccessClient(connection, () => `fiction-operation-${++id}`);
  const controller = new AbortController();

  const connect = async () => {
    const reply = await client.connect('chatgpt', controller.signal);

    if (reply.status !== 'connected' && reply.status !== 'selected') throw new Error('Fixture');

    return reply.scope;
  };

  return {
    broker,
    client,
    connection,
    inspect,
    signIn,
    controller,
    connect,
    close: () => {
      client.close();
      broker.close();
      base.broker.close();
    },
  };
}

afterEach(() => vi.useRealTimers());
describe('narrow post-ranking session protocol', () => {
  it('never allows sign-in progress to extend a final verification deadline', async () => {
    const h = fixture();
    const scope = await h.connect();
    h.connection.postMessage.mockImplementation(() => {});
    const result = h.client.verify(scope, h.controller.signal);
    const request = h.connection.postMessage.mock.lastCall?.[0] as { requestId: string };
    h.connection.onMessage.emit({
      kind: 'connection-progress',
      requestId: request.requestId,
      provider: 'chatgpt',
      status: 'waiting-for-sign-in',
    });
    expect((await result).status).toBe('interrupted');
    h.close();
  });
  it('verifies the same pinned scope without rotating it, navigating or opening login', async () => {
    const h = fixture();
    const scope = await h.connect();
    expect(await h.client.verify(scope, h.controller.signal)).toMatchObject({
      status: 'verified',
      scope,
    });
    expect(h.broker.bindSelectedDocument(scope)).not.toBeNull();
    expect(h.signIn).not.toHaveBeenCalled();
    h.close();
  });
  it.each(['login-expired', 'wrong-scope', 'malformed', 'throw', 'unavailable-boundary'] as const)(
    'fails closed on %s without automatic authentication redirects',
    async (kind) => {
      const h = fixture(kind !== 'unavailable-boundary');
      const scope = await h.connect();
      h.inspect.mockImplementation(async () => {
        if (kind === 'throw') throw new Error('fiction-private');

        if (kind === 'malformed') return {};

        if (kind === 'wrong-scope') return { status: 'ready', scope: { ...scope, generation: 99 } };

        return { status: 'login-expired', provider: 'chatgpt', generation: scope.generation };
      });
      const result = await h.client.verify(scope, h.controller.signal);
      expect(result.status).toBe(
        kind === 'login-expired'
          ? 'login-expired'
          : kind === 'throw'
            ? 'unavailable'
            : 'scope-changed',
      );
      expect(h.broker.bindSelectedDocument(scope)).toBeNull();
      expect(h.signIn).not.toHaveBeenCalled();
      h.close();
    },
  );
  it.each(['timeout', 'cancel', 'invalidate'] as const)(
    'rejects late verification after %s',
    async (kind) => {
      vi.useFakeTimers();
      const h = fixture();
      const scope = await h.connect();
      const pending = deferred<unknown>();
      h.inspect.mockReturnValueOnce(pending.promise);
      const result = h.client.verify(scope, h.controller.signal);
      await flush();

      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(operationTimeoutMs);

      if (kind === 'cancel') h.controller.abort();

      if (kind === 'invalidate') h.broker.invalidate('chatgpt', 'scope-changed');

      expect((await result).status).toBe(
        kind === 'invalidate' ? 'scope-changed' : kind === 'cancel' ? 'cancelled' : 'timeout',
      );
      pending.resolve({ status: 'ready', scope });
      await flush();
      expect(h.broker.bindSelectedDocument(scope)).toBeNull();
      h.close();
    },
  );
  it('a late rejected verifier cannot invalidate a newer connection', async () => {
    const h = fixture();
    const scope = await h.connect();
    const pending = deferred<unknown>();
    h.inspect.mockReturnValueOnce(pending.promise);
    const result = h.client.verify(scope, h.controller.signal);
    await flush();
    h.broker.invalidate('chatgpt', 'scope-changed');
    await result;
    const fresh = await h.connect();
    pending.reject(new Error('fiction-private'));
    await flush();
    expect(h.broker.bindSelectedDocument(fresh)).not.toBeNull();
    h.close();
  });
  it.each(['wrong-scope', 'wrong-operation', 'wrong-reply', 'obsolete-generation'] as const)(
    'client rejects %s verification messages',
    async (kind) => {
      const h = fixture();
      const scope = await h.connect();
      h.connection.postMessage.mockImplementation(() => {});
      const result =
        kind === 'wrong-operation'
          ? h.client.connect('chatgpt', h.controller.signal)
          : h.client.verify(scope, h.controller.signal);
      const request = h.connection.postMessage.mock.lastCall?.[0] as { requestId: string };

      if (kind === 'obsolete-generation')
        h.connection.onMessage.emit({
          kind: 'invalidated',
          provider: 'chatgpt',
          status: 'scope-changed',
          generation: scope.generation + 1,
        });

      h.connection.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: kind === 'wrong-reply' ? 'connected' : 'verified',
        session: 'authenticated',
        scope: kind === 'wrong-scope' ? { ...scope, partition: 'fiction-other' } : scope,
      });
      expect((await result).status).toBe(
        kind === 'obsolete-generation' ? 'scope-changed' : 'interrupted',
      );
      h.close();
    },
  );
});
