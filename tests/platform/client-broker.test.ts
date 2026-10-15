import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessBroker } from '../../src/platform/broker';
import { AccessClient } from '../../src/platform/client';
import type { AccessMessage, AccessRequest } from '../../src/platform/protocol';
import { clientTimeoutMs, operationTimeoutMs } from '../../src/platform/protocol';
import { brokerHarness, deferred, event, probe } from './helpers';

let panelCounter = 0;

function connectedPair() {
  const panel = ++panelCounter;
  const h = brokerHarness();
  let requestCounter = 0;
  let scopeCounter = 0;
  const requests: AccessRequest[] = [];
  const replies: AccessMessage[] = [];
  const connection = {
    postMessage: (request: AccessRequest) => {
      requests.push(request);
    },
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
    disconnect: () => broker.close(),
  };
  const broker = new AccessBroker(
    h.port,
    (reply) => {
      replies.push(reply);
    },
    () => {
      connection.onDisconnect.emit();
    },
    () => `fiction-panel-${panel}-partition-${++scopeCounter}`,
  );
  const client = new AccessClient(connection, () => `fiction-request-${++requestCounter}`);
  const events = vi.fn();
  client.subscribe(events);

  function deliverRequests() {
    for (const request of requests.splice(0)) broker.receive(request);
  }

  function deliverReplies() {
    for (const reply of replies.splice(0)) connection.onMessage.emit(reply);
  }

  async function exchange() {
    deliverRequests();
    await vi.advanceTimersByTimeAsync(0);
    deliverReplies();
  }

  function close() {
    client.close();
    broker.close();
    h.broker.close();
  }

  return {
    client,
    broker,
    port: h.port,
    connection,
    events,
    requests,
    replies,
    deliverRequests,
    deliverReplies,
    exchange,
    close,
  };
}

const resources: ReturnType<typeof connectedPair>[] = [];

function pair() {
  const resource = connectedPair();
  resources.push(resource);

  return resource;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
  vi.useRealTimers();
});

describe('real client + real broker with queued synthetic Chrome transport', () => {
  it('connects, rotates an unknown scope on inspection, clears it and refuses reuse', async () => {
    const h = pair();
    const signal = new AbortController().signal;
    const connect = h.client.connect('chatgpt', signal);
    await h.exchange();
    const first = await connect;
    if (first.status !== 'selected') throw new Error('Expected synthetic selection.');
    expect(first.session).toBe('unverified');
    const inspect = h.client.inspect('chatgpt', first.scope, signal);
    await h.exchange();
    const second = await inspect;
    if (second.status !== 'selected') throw new Error('Expected new synthetic selection.');
    expect(second.scope.partition).not.toBe(first.scope.partition);
    expect(second.scope.generation).toBeGreaterThan(first.scope.generation);
    const disconnect = h.client.disconnectSelection('chatgpt', second.scope, signal);
    await h.exchange();
    expect((await disconnect).status).toBe('disconnected');
    const stale = h.client.inspect('chatgpt', second.scope, signal);
    await h.exchange();
    expect((await stale).status).toBe('scope-changed');
    expect(h.port.inspectDocument).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels and reconnects while the previous document probe and invalidation delivery are late', async () => {
    const h = pair();
    const held = deferred<unknown>();
    const controller = new AbortController();
    h.port.inspectDocument.mockReturnValueOnce(held.promise);
    const first = h.client.connect('chatgpt', controller.signal);
    h.deliverRequests();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.port.inspectDocument).toHaveBeenCalledOnce();
    controller.abort();
    expect((await first).status).toBe('cancelled');
    const retry = h.client.connect('chatgpt', new AbortController().signal);
    await h.exchange();
    const result = await retry;
    expect(result.status).toBe('selected');
    expect(h.port.inspectDocument.mock.calls[0]?.[2].aborted).toBe(true);
    const count = h.port.inspectDocument.mock.calls.length;
    held.resolve(probe);
    await vi.advanceTimersByTimeAsync(0);
    h.deliverReplies();
    expect(h.port.inspectDocument).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses worker timeout first, clears both deadlines and discards late data', async () => {
    const h = pair();
    const held = deferred<unknown>();
    h.port.inspectDocument.mockReturnValueOnce(held.promise);
    const request = h.client.connect('chatgpt', new AbortController().signal);
    h.deliverRequests();
    await vi.advanceTimersByTimeAsync(operationTimeoutMs);
    h.deliverReplies();
    expect((await request).status).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(probe);
    await h.exchange();
    expect(h.replies).toEqual([]);
    expect(h.port.inspectDocument).toHaveBeenCalledOnce();
  });
  it('bounds a suspended worker before request delivery and safely retries when it resumes', async () => {
    const h = pair();
    const request = h.client.connect('chatgpt', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(clientTimeoutMs);
    expect((await request).status).toBe('timeout');
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
    await h.exchange(); // Obsolete connect and cancel arrive together after suspension.
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
    const retry = h.client.connect('chatgpt', new AbortController().signal);
    await h.exchange();
    expect((await retry).status).toBe('selected');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['permission', 'navigation', 'session'] as const)(
    'clears a selected scope after %s and rejects its next inspection',
    async (change) => {
      const h = pair();
      const signal = new AbortController().signal;
      const pending = h.client.connect('chatgpt', signal);
      await h.exchange();
      const reply = await pending;
      if (reply.status !== 'selected') throw new Error('Expected synthetic selection.');
      if (change === 'permission') h.broker.invalidateAll('permission-needed');
      else if (change === 'navigation') h.broker.tabChanged(7);
      else h.broker.invalidate('chatgpt', 'scope-changed');
      h.deliverReplies();
      expect(h.events).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'chatgpt', kind: 'invalidated' }),
      );
      const inspect = h.client.inspect('chatgpt', reply.scope, signal);
      await h.exchange();
      expect((await inspect).status).toBe('scope-changed');
      expect(h.port.inspectDocument).toHaveBeenCalledTimes(2);
    },
  );
  it('settles work as interrupted on worker disconnection and tears down every pending timer/listener', async () => {
    const h = pair();
    h.port.ownerWindow.mockReturnValueOnce(new Promise(() => {}));
    const pending = h.client.connect('chatgpt', new AbortController().signal);
    h.deliverRequests();
    h.broker.close();
    expect((await pending).status).toBe('interrupted');
    expect(h.client.isClosed).toBe(true);
    expect(h.connection.onMessage.size()).toBe(0);
    expect(h.connection.onDisconnect.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps request IDs and unknown partitions independent between two connected panels', async () => {
    const a = pair();
    const b = pair();
    const signal = new AbortController().signal;
    const first = a.client.connect('chatgpt', signal);
    const second = b.client.connect('chatgpt', signal);
    a.deliverRequests();
    b.deliverRequests();
    a.broker.receive({ operation: 'cancel', requestId: 'fiction-request-1' });
    await vi.advanceTimersByTimeAsync(0);
    a.deliverReplies();
    b.deliverReplies();
    expect((await first).status).toBe('cancelled');
    const bSelection = await second;
    expect(bSelection.status).toBe('selected');
    expect(a.port.inspectDocument).not.toHaveBeenCalled();
    expect(b.port.inspectDocument).toHaveBeenCalledTimes(2);
    const retry = a.client.connect('chatgpt', signal);
    await a.exchange();
    const aSelection = await retry;
    if (aSelection.status !== 'selected' || bSelection.status !== 'selected')
      throw new Error('Expected synthetic selections.');
    expect(aSelection.scope.partition).not.toBe(bSelection.scope.partition);
    const crossPanel = b.client.inspect('chatgpt', aSelection.scope, signal);
    await b.exchange();
    expect((await crossPanel).status).toBe('scope-changed');
    expect(b.port.inspectDocument).toHaveBeenCalledTimes(2);
  });
});
