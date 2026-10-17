import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelSearchClient } from '../../src/platform/search-client';
import { AccessClient } from '../../src/platform/client';
import { heartbeatIntervalMs, maximumRequestsPerPort } from '../../src/platform/protocol';
import { searchClientTimeoutMs } from '../../src/platform/search-protocol';
import { aggregateSearch } from '../../src/search/aggregate';
import type { SearchOutcome } from '../../src/contracts';
import {
  searchRequest,
  providerPort,
  linkVerifiers,
  chatScope,
} from '../fixtures/search/providers';
import { event } from './helpers';

const resources: PanelSearchClient[] = [];

function harness(closeTransport?: () => void) {
  const connection = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  const client = new PanelSearchClient(connection, linkVerifiers, closeTransport);
  resources.push(client);
  const controller = new AbortController();
  const request = searchRequest();

  return {
    connection,
    client,
    controller,
    request,
    run: () => client.search(request, { signal: controller.signal }),
  };
}

async function success(request = searchRequest()): Promise<SearchOutcome> {
  const outcomes = await Promise.all(
    request.scopes.map((scope) =>
      providerPort(scope.provider).search(
        { requestId: request.requestId, query: request.query, scope },
        { signal: new AbortController().signal },
      ),
    ),
  );

  return aggregateSearch(request, outcomes as SearchOutcome['outcomes'], linkVerifiers, 200, []);
}

afterEach(() => {
  resources.splice(0).forEach((client) => client.close());
  vi.useRealTimers();
});
describe('panel-owned validated keyword transport', () => {
  it('keeps a connected panel worker alive with local messages, without provider reads or request IDs', async () => {
    vi.useFakeTimers();
    const { client, connection } = harness();
    client.keepAlive(true);
    client.keepAlive(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 2);
    expect(connection.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { operation: 'keepalive' },
      { operation: 'keepalive' },
    ]);
    client.keepAlive(false);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
    client.keepAlive(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes both capabilities if a heartbeat cannot reach the worker', async () => {
    vi.useFakeTimers();
    const { client, connection } = harness();
    client.keepAlive(true);
    connection.postMessage.mockImplementation(() => {
      throw new Error('fiction-interrupted-port');
    });
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs);
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes only a normalized search, validates output and shares access messages without ending access', async () => {
    const { connection, client, request, run } = harness();
    const access = new AccessClient(connection, () => 'fiction-access');
    const pending = run();
    expect(connection.postMessage).toHaveBeenCalledWith({ operation: 'keyword-search', request });

    for (const input of [null, 12, {}, { kind: 'reply' }]) connection.onMessage.emit(input);

    // Invalid access input belongs to AccessClient and closes its own capability.
    expect(access.isClosed).toBe(true);
    const output = await success(request);
    connection.onMessage.emit({ kind: 'search-result', outcome: output });
    expect(await pending).toEqual(output);
    client.close();
    expect(connection.onMessage.size()).toBe(0);
    expect(connection.onDisconnect.size()).toBe(0);
  });
  it('allows legitimate search replies through the existing AccessClient listener', async () => {
    const { connection, request, run } = harness();
    const access = new AccessClient(connection, () => 'fiction-access');
    connection.onMessage.emit({ kind: 'alive' });
    expect(access.isClosed).toBe(false);
    const pending = run();
    const output = await success(request);
    connection.onMessage.emit({ kind: 'search-result', outcome: output });
    expect(await pending).toEqual(output);
    expect(access.isClosed).toBe(false);
    access.close();
  });
  it.each(['cancel', 'timeout', 'disconnect', 'invalidate'] as const)(
    'settles %s independently of a silent worker and discards delayed success',
    async (stop) => {
      vi.useFakeTimers();
      const { connection, client, controller, request, run } = harness();
      const pending = run();

      if (stop === 'cancel') controller.abort();
      else if (stop === 'timeout') await vi.advanceTimersByTimeAsync(searchClientTimeoutMs);
      else if (stop === 'disconnect') connection.onDisconnect.emit();
      else {
        client.invalidate({ ...chatScope, generation: 30 });
        client.invalidate(chatScope);
      }

      const outcome = await pending;
      expect(outcome.outcomes.map((item) => item.status)).toEqual(
        Array(2).fill(
          {
            cancel: 'cancelled',
            timeout: 'timeout',
            disconnect: 'interrupted',
            invalidate: 'scope-changed',
          }[stop],
        ),
      );
      expect(outcome.results).toEqual([]);
      connection.onMessage.emit({ kind: 'search-result', outcome: await success(request) });
      expect(outcome.results).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      if (stop !== 'disconnect')
        expect(connection.postMessage).toHaveBeenLastCalledWith({
          operation: 'cancel-search',
          requestId: request.requestId,
        });
    },
  );
  it('rejects invalid and description requests before replacing good work, and rejects reused IDs', async () => {
    const { client, connection, request, run } = harness();
    const pending = run();
    expect(() =>
      client.search(
        { ...request, query: { ...request.query, mode: 'description' } },
        { signal: new AbortController().signal },
      ),
    ).toThrow();
    expect(() => run()).toThrow(/request limit/);
    expect(connection.postMessage).toHaveBeenCalledOnce();
    client.close();
    expect((await pending).state).toBe('failure');
  });
  it('cancels the previous run and ignores obsolete reply IDs during query replacement', async () => {
    const { client, connection, request, run } = harness();
    const old = run();
    const newer = searchRequest({ requestId: 'fiction-new-request' as typeof request.requestId });
    const pending = client.search(newer, { signal: new AbortController().signal });
    expect((await old).state).toBe('cancelled');
    connection.onMessage.emit({ kind: 'search-result', outcome: await success(request) });
    const output = await success(newer);
    connection.onMessage.emit({ kind: 'search-result', outcome: output });
    expect(await pending).toEqual(output);
    connection.onMessage.emit({ kind: 'search-result', outcome: output });
    expect(connection.disconnect).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'scope', 'link', 'date'] as const)(
    'fails closed on %s reply data',
    async (kind) => {
      const { connection, request, run } = harness();
      const pending = run();
      const output = await success(request);

      if (kind === 'malformed') Object.assign(output, { extra: true });
      else if (kind === 'scope')
        output.outcomes.forEach((item) => {
          item.scope.generation = 20;

          if (item.status === 'success')
            item.candidates.forEach((candidate) => {
              candidate.scope.generation = 20;
            });
        });
      else if (kind === 'link') {
        const item = output.outcomes[0];

        if (item?.status === 'success' && item.candidates[0])
          item.candidates[0].originalUrl = 'https://evil.invalid/thread';
      } else {
        // A syntactically valid response cannot override this request's date filter.
        const dated = harness();
        const ranged = {
          ...dated.request,
          query: {
            ...dated.request.query,
            dateRange: { start: '2027-01-01T00:00:00.000Z', end: '2028-01-01T00:00:00.000Z' },
          },
        };
        const datePending = dated.client.search(ranged, { signal: dated.controller.signal });
        dated.connection.onMessage.emit({ kind: 'search-result', outcome: output });
        expect((await datePending).state).toBe('failure');
        expect(dated.connection.disconnect).toHaveBeenCalledOnce();
        connection.onMessage.emit({ kind: 'search-result', outcome: output });
        await pending;

        return;
      }

      connection.onMessage.emit({ kind: 'search-result', outcome: output });
      expect((await pending).state).toBe('failure');
      expect(connection.disconnect).toHaveBeenCalledOnce();
    },
  );
  it.each(['already aborted', 'closed', 'send throws', 'cancel send throws'] as const)(
    'settles when %s without leaking timers or private errors',
    async (cause) => {
      vi.useFakeTimers();
      const { connection, client, controller, run } = harness();

      if (cause === 'already aborted') controller.abort();

      if (cause === 'closed') client.close();

      if (cause === 'send throws')
        connection.postMessage.mockImplementation(() => {
          throw new Error('fiction-private-error');
        });

      const pending = run();

      if (cause === 'cancel send throws') {
        connection.postMessage.mockImplementation(() => {
          throw new Error('fiction-private-error');
        });
        controller.abort();
      }

      const output = await pending;
      expect(output.results).toEqual([]);
      expect(JSON.stringify(output)).not.toContain('fiction-private-error');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('closes exhausted shared transport, interrupts pending work and permits a fresh connection', async () => {
    vi.useFakeTimers();
    let access: AccessClient;
    const closeTransport = vi.fn(() => access.close());
    const { connection, request, client } = harness(closeTransport);
    access = new AccessClient(connection, () => 'fiction-access-budget');
    const invalidations = vi.fn();
    access.subscribe(invalidations);
    client.keepAlive(true);

    for (let index = 0; index < maximumRequestsPerPort - 1; index++) {
      const next = searchRequest({
        requestId: `fiction-budget-${index}` as typeof request.requestId,
      });
      const pending = client.search(next, { signal: new AbortController().signal });
      connection.onMessage.emit({
        kind: 'search-result',
        outcome: aggregateSearch(
          next,
          next.scopes.map((scope) => ({ requestId: next.requestId, scope, status: 'unavailable' })),
          linkVerifiers,
          200,
          [],
        ),
      });
      await pending;
    }

    const pending = client.search(request, { signal: new AbortController().signal });
    expect(() =>
      client.search(
        searchRequest({ requestId: 'fiction-over-budget' as typeof request.requestId }),
        { signal: new AbortController().signal },
      ),
    ).toThrow(/request limit/);
    expect(access.isClosed).toBe(true);
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect((await pending).outcomes.every((item) => item.status === 'interrupted')).toBe(true);
    expect(invalidations.mock.calls.map(([event]) => event.provider)).toEqual([
      'chatgpt',
      'google-ai-mode',
    ]);
    expect(connection.onMessage.size()).toBe(0);
    expect(connection.onDisconnect.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const fresh = harness();
    const recovered = fresh.run();
    fresh.connection.onMessage.emit({
      kind: 'search-result',
      outcome: await success(fresh.request),
    });
    expect((await recovered).state).toBe('success');
  });
  it('bounds the number of unique requests per connection', async () => {
    const { client, request } = harness();
    const controller = new AbortController();
    controller.abort();

    for (let index = 0; index < maximumRequestsPerPort; index++)
      await client.search(
        { ...request, requestId: `fiction-${index}` as typeof request.requestId },
        { signal: controller.signal },
      );

    expect(() => client.search(request, { signal: controller.signal })).toThrow(/request limit/);
  });
});
