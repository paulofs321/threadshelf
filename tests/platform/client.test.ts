import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessClient } from '../../src/platform/client';
import type { AccessReply, AccessRequest } from '../../src/platform/protocol';
import { clientTimeoutMs, maximumRequestsPerPort } from '../../src/platform/protocol';
import { event } from './helpers';

function harness(freshId?: () => string) {
  let counter = 0;
  const connection = {
    postMessage: vi.fn<(request: AccessRequest) => void>(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  const client = new AccessClient(connection, freshId ?? (() => `fiction-request-${++counter}`));
  const signal = new AbortController();
  const subscriber = vi.fn();
  client.subscribe(subscriber);

  return { client, connection, signal, subscriber };
}

function selection(
  requestId = 'fiction-request-1',
  generation = 1,
  partition = 'fiction-partition-one',
) {
  return {
    kind: 'reply',
    requestId,
    status: 'selected',
    session: 'unverified',
    scope: {
      kind: 'ephemeral',
      provider: 'chatgpt',
      generation,
      partition,
    },
  };
}

async function connect(h: ReturnType<typeof harness>) {
  const promise = h.client.connect('chatgpt', h.signal.signal);
  h.connection.onMessage.emit(selection());
  const reply = await promise;
  if (reply.status !== 'selected') throw new Error('Expected synthetic selection.');

  return reply.scope;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('panel-owned access lifecycle', () => {
  it('correlates replies, ignores unknown IDs and exposes only unverified selection', async () => {
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    h.connection.onMessage.emit(selection('fiction-another-request'));
    h.connection.onMessage.emit(selection());
    expect(await promise).toMatchObject({ status: 'selected', session: 'unverified' });
    expect(h.connection.postMessage).toHaveBeenCalledWith({
      operation: 'connect',
      requestId: 'fiction-request-1',
      provider: 'chatgpt',
    });
    h.client.close();
  });
  it('cancels promptly and rejects late success without restoring display', async () => {
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    h.signal.abort();
    expect((await promise).status).toBe('cancelled');
    expect(h.connection.postMessage).toHaveBeenLastCalledWith({
      operation: 'cancel',
      requestId: 'fiction-request-1',
    });
    h.connection.onMessage.emit(selection());
    expect(h.subscriber).toHaveBeenCalledOnce();
    expect(h.subscriber).toHaveBeenCalledWith({
      kind: 'invalidated',
      provider: 'chatgpt',
      generation: 1,
      status: 'scope-changed',
    });
    h.client.close();
  });
  it('does no work for an already aborted request', async () => {
    const h = harness();
    h.signal.abort();
    expect((await h.client.connect('chatgpt', h.signal.signal)).status).toBe('cancelled');
    expect(h.connection.postMessage).not.toHaveBeenCalled();
    h.client.close();
  });
  it('times out a silent/suspended worker and ignores its later reply', async () => {
    vi.useFakeTimers();
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    await vi.advanceTimersByTimeAsync(clientTimeoutMs);
    expect((await promise).status).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
    h.connection.onMessage.emit(selection());
    expect(h.subscriber).toHaveBeenCalledOnce();
    h.client.close();
  });
  it('worker disconnection clears both providers and settles pending work as interrupted', async () => {
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    const google = h.client.connect('google-ai-mode', h.signal.signal);
    h.connection.onDisconnect.emit();
    expect((await promise).status).toBe('interrupted');
    expect((await google).status).toBe('interrupted');
    expect(h.subscriber.mock.calls.map(([event]) => event.provider)).toEqual([
      'chatgpt',
      'google-ai-mode',
    ]);
    expect(h.client.isClosed).toBe(true);
    expect(h.connection.onMessage.size()).toBe(0);
    expect(h.connection.onDisconnect.size()).toBe(0);
    expect((await h.client.connect('chatgpt', h.signal.signal)).status).toBe('interrupted');
  });
  it('discards a selected reply after revocation/navigation invalidation while preserving explicit terminal failures', async () => {
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    h.connection.onMessage.emit({
      kind: 'invalidated',
      provider: 'chatgpt',
      generation: 2,
      status: 'permission-needed',
    });
    h.connection.onMessage.emit(selection());
    expect((await promise).status).toBe('scope-changed');
    const next = h.client.connect('chatgpt', h.signal.signal);
    h.connection.onMessage.emit({
      kind: 'invalidated',
      provider: 'chatgpt',
      generation: 3,
      status: 'scope-changed',
    });
    h.connection.onMessage.emit({
      kind: 'reply',
      requestId: 'fiction-request-2',
      status: 'timeout',
    });
    expect((await next).status).toBe('timeout');
    h.client.close();
  });
  it.each([
    { status: 'ready' },
    {
      scope: {
        kind: 'verified',
        provider: 'chatgpt',
        generation: 1,
        accountPartition: 'fiction-account',
        workspacePartition: null,
      },
    },
    {
      scope: {
        kind: 'ephemeral',
        provider: 'google-ai-mode',
        generation: 1,
        partition: 'fiction-partition',
      },
    },
    { candidates: [] },
    { session: 'authenticated' },
  ])('rejects malformed, fabricated, or cross-provider success', async (patch) => {
    const h = harness();
    const promise = h.client.connect('chatgpt', h.signal.signal);
    h.connection.onMessage.emit({ ...selection(), ...patch });
    expect((await promise).status).toBe('interrupted');
    expect(h.client.isClosed).toBe(true);
  });
  it.each([
    { generation: 1, partition: 'fiction-fresh' },
    { generation: 2, partition: 'fiction-partition-one' },
  ])(
    'rejects reused unknown partitions/generations on inspection',
    async ({ generation, partition }) => {
      const h = harness();
      const scope = await connect(h);
      const promise = h.client.inspect('chatgpt', scope, h.signal.signal);
      h.connection.onMessage.emit(selection('fiction-request-2', generation, partition));
      expect((await promise).status).toBe(generation === 1 ? 'scope-changed' : 'interrupted');
      h.client.close();
    },
  );
  it('accepts a fresh inspection and explicit disconnect only for the matching operation', async () => {
    const h = harness();
    const scope = await connect(h);
    const inspect = h.client.inspect('chatgpt', scope, h.signal.signal);
    h.connection.onMessage.emit(selection('fiction-request-2', 2, 'fiction-fresh-partition'));
    const reply = await inspect;
    if (reply.status !== 'selected') throw new Error('Expected synthetic selection.');
    const disconnect = h.client.disconnectSelection('chatgpt', reply.scope, h.signal.signal);
    h.connection.onMessage.emit({
      kind: 'reply',
      requestId: 'fiction-request-3',
      status: 'disconnected',
    });
    expect((await disconnect).status).toBe('disconnected');
    h.client.close();
  });
  it('accepts a fresh retry despite a delayed cancellation event and ignores old events after selection', async () => {
    const h = harness();
    const first = h.client.connect('chatgpt', h.signal.signal);
    h.signal.abort();
    expect((await first).status).toBe('cancelled');
    const next = h.client.connect('chatgpt', new AbortController().signal);
    h.connection.onMessage.emit({
      kind: 'invalidated',
      provider: 'chatgpt',
      status: 'scope-changed',
      generation: 2,
    });
    h.connection.onMessage.emit(selection('fiction-request-2', 3, 'fiction-new-partition'));
    expect((await next).status).toBe('selected');
    const count = h.subscriber.mock.calls.length;
    h.connection.onMessage.emit({
      kind: 'invalidated',
      provider: 'chatgpt',
      status: 'scope-changed',
      generation: 2,
    });
    expect(h.subscriber).toHaveBeenCalledTimes(count);
    h.client.close();
  });
  it('limits concurrent and lifetime requests', async () => {
    const h = harness();
    const pending = h.client.connect('chatgpt', h.signal.signal);
    expect((await h.client.connect('chatgpt', h.signal.signal)).status).toBe('busy');
    h.connection.onMessage.emit(selection());
    await pending;
    h.connection.postMessage.mockImplementation((request) => {
      h.connection.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: 'unavailable',
      });
    });

    for (let i = 2; i < maximumRequestsPerPort; i++) {
      expect((await h.client.connect('chatgpt', h.signal.signal)).status).toBe('unavailable');
    }

    expect((await h.client.connect('chatgpt', h.signal.signal)).status).toBe('interrupted');
    expect(h.client.isClosed).toBe(true);
  });
  it('turns transport exceptions into interruption without leaking exception text', async () => {
    const h = harness();
    h.connection.postMessage.mockImplementation(() => {
      throw new Error('fiction private error');
    });
    const reply: AccessReply = await h.client.connect('chatgpt', h.signal.signal);
    expect(reply.status).toBe('interrupted');
    expect(JSON.stringify(reply)).not.toContain('fiction private');
  });
  it('removes abort subscriptions after success so a later abort cannot cancel completed work', async () => {
    const h = harness();
    const remove = vi.spyOn(h.signal.signal, 'removeEventListener');
    await connect(h);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    h.signal.abort();
    expect(h.connection.postMessage).toHaveBeenCalledOnce();
    expect(h.subscriber).not.toHaveBeenCalled();
    h.client.close();
  });
  it('unsubscribes event consumers and closes idempotently without duplicate notifications', () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.client.subscribe(listener);
    unsubscribe();
    h.client.close();
    h.client.close();
    expect(listener).not.toHaveBeenCalled();
    expect(h.connection.disconnect).toHaveBeenCalledOnce();
    expect(h.subscriber).toHaveBeenCalledTimes(2);
  });
  it('rejects disconnected replies to connect operations and selected replies to disconnect operations', async () => {
    const first = harness();
    const pending = first.client.connect('chatgpt', first.signal.signal);
    first.connection.onMessage.emit({
      kind: 'reply',
      requestId: 'fiction-request-1',
      status: 'disconnected',
    });
    expect((await pending).status).toBe('interrupted');
    const second = harness();
    const scope = await connect(second);
    const disconnect = second.client.disconnectSelection('chatgpt', scope, second.signal.signal);
    second.connection.onMessage.emit(selection('fiction-request-2', 2, 'fiction-new-partition'));
    expect((await disconnect).status).toBe('interrupted');
  });
  it('fails closed on duplicate pending IDs even when the provider differs', async () => {
    const h = harness(() => 'fiction-reused-id');
    const first = h.client.connect('chatgpt', h.signal.signal);
    const second = h.client.connect('google-ai-mode', h.signal.signal);
    expect((await first).status).toBe('interrupted');
    expect((await second).status).toBe('interrupted');
    expect(h.connection.postMessage).toHaveBeenCalledOnce();
  });
  it('preserves cancellation but interrupts other work if cancellation cannot reach the worker', async () => {
    const h = harness();
    const other = new AbortController();
    const chat = h.client.connect('chatgpt', h.signal.signal);
    const google = h.client.connect('google-ai-mode', other.signal);
    h.connection.postMessage.mockImplementation(() => {
      throw new Error('fiction-private-cancel-detail');
    });
    h.signal.abort();
    expect((await chat).status).toBe('cancelled');
    expect((await google).status).toBe('interrupted');
    expect(h.client.isClosed).toBe(true);
    expect(h.connection.onMessage.size()).toBe(0);
  });
  it.each([
    null,
    {},
    { kind: 'unrecognized' },
    { kind: 'invalidated', provider: 'chatgpt', generation: 0, status: 'scope-changed' },
  ])('closes on malformed protocol messages without exposing raw payloads', async (input) => {
    const h = harness();
    const pending = h.client.connect('chatgpt', h.signal.signal);
    h.connection.onMessage.emit(input);
    expect(await pending).toEqual({
      kind: 'reply',
      requestId: 'fiction-request-1',
      status: 'interrupted',
    });
  });
});
