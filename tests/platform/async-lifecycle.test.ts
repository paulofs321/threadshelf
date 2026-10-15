import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessBroker } from '../../src/platform/broker';
import { operationTimeoutMs } from '../../src/platform/protocol';
import { brokerHarness, deferred, probe, selected, tab } from './helpers';

type Harness = ReturnType<typeof brokerHarness>;
interface Stage {
  name: string;
  hold(h: Harness): { release(): void; assertReached(): void };
}
const stages: Stage[] = [
  {
    name: 'owning panel before access',
    hold(h) {
      const pending = deferred<number | null>();
      h.port.ownerWindow.mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(3),
        assertReached: () => expect(h.port.ownerWindow).toHaveBeenCalledTimes(1),
      };
    },
  },
  {
    name: 'permission before access',
    hold(h) {
      const pending = deferred<boolean>();
      h.port.hasPermission.mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(true),
        assertReached: () => expect(h.port.hasPermission).toHaveBeenCalledTimes(1),
      };
    },
  },
  {
    name: 'tab before access',
    hold(h) {
      const pending = deferred<unknown>();
      h.port.selectedTab.mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(tab),
        assertReached: () => expect(h.port.selectedTab).toHaveBeenCalledTimes(1),
      };
    },
  },
  {
    name: 'initial isolated probe',
    hold(h) {
      const pending = deferred<unknown>();
      h.port.inspectDocument.mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(probe),
        assertReached: () => expect(h.port.inspectDocument).toHaveBeenCalledTimes(1),
      };
    },
  },
  {
    name: 'pinned document confirmation',
    hold(h) {
      const pending = deferred<unknown>();
      h.port.inspectDocument.mockResolvedValueOnce(probe).mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(probe),
        assertReached: () => expect(h.port.inspectDocument).toHaveBeenCalledTimes(2),
      };
    },
  },
  {
    name: 'tab after access',
    hold(h) {
      const pending = deferred<unknown>();
      h.port.selectedTab.mockResolvedValueOnce(tab).mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(tab),
        assertReached: () => expect(h.port.selectedTab).toHaveBeenCalledTimes(2),
      };
    },
  },
  {
    name: 'permission after access',
    hold(h) {
      const pending = deferred<boolean>();
      h.port.hasPermission.mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(true),
        assertReached: () => expect(h.port.hasPermission).toHaveBeenCalledTimes(2),
      };
    },
  },
  {
    name: 'owning panel after access',
    hold(h) {
      const pending = deferred<number | null>();
      h.port.ownerWindow.mockResolvedValueOnce(3).mockReturnValueOnce(pending.promise);

      return {
        release: () => pending.resolve(3),
        assertReached: () => expect(h.port.ownerWindow).toHaveBeenCalledTimes(2),
      };
    },
  },
];
const cases = stages.flatMap((stage) =>
  (['cancel', 'timeout', 'revocation'] as const).map((cause) => ({
    stage,
    cause,
    name: stage.name,
  })),
);

afterEach(() => {
  vi.useRealTimers();
});

describe('discard at every asynchronous broker boundary', () => {
  it.each(cases)(
    '$cause while awaiting $name stops all further browser work',
    async ({ stage, cause }) => {
      vi.useFakeTimers();
      const h = brokerHarness();
      const pending = stage.hold(h);
      const reply = h.connect();
      await vi.advanceTimersByTimeAsync(0);
      pending.assertReached();

      if (cause === 'cancel')
        h.broker.receive({ operation: 'cancel', requestId: 'fiction-request-one' });
      else if (cause === 'timeout') await vi.advanceTimersByTimeAsync(operationTimeoutMs);
      else h.broker.invalidateAll('permission-needed');

      expect((await reply).status).toBe(
        cause === 'cancel' ? 'cancelled' : cause === 'timeout' ? 'timeout' : 'permission-needed',
      );
      const counts = Object.values(h.port).map((mock) => mock.mock.calls.length);
      const messages = h.messages.length;
      pending.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(Object.values(h.port).map((mock) => mock.mock.calls.length)).toEqual(counts);
      expect(h.messages).toHaveLength(messages);
      expect(vi.getTimerCount()).toBe(0);
      h.broker.close();
    },
  );
});

describe('broker isolation, recovery and invalidation order', () => {
  it.each([{ id: 8 }, { url: 'https://chatgpt.com/#changed' }])(
    'refuses a changed selected context before inspection touches the new tab',
    async (patch) => {
      const h = brokerHarness();
      const scope = await selected(h);
      h.port.selectedTab.mockResolvedValue({ ...tab, ...patch });
      const reply = h.replyFor('fiction-inspect');
      h.broker.receive({
        operation: 'inspect-context',
        provider: 'chatgpt',
        requestId: 'fiction-inspect',
        scope,
      });
      expect((await reply).status).toBe('scope-changed');
      expect(h.port.inspectDocument).toHaveBeenCalledTimes(2);
      h.broker.close();
    },
  );
  it('ignores cancellation of unknown/completed IDs without clearing a current selection', async () => {
    const h = brokerHarness();
    const scope = await selected(h);
    h.broker.receive({ operation: 'cancel', requestId: 'fiction-unknown' });
    h.broker.receive({ operation: 'cancel', requestId: 'fiction-request-one' });
    expect(h.messages).toHaveLength(1);
    const reply = h.replyFor('fiction-clear');
    h.broker.receive({
      operation: 'disconnect',
      provider: 'chatgpt',
      requestId: 'fiction-clear',
      scope,
    });
    expect((await reply).status).toBe('disconnected');
    h.broker.close();
  });
  it('does not invalidate a bound tab for unrelated tab/provider changes', async () => {
    vi.useFakeTimers();
    const h = brokerHarness();
    const held = deferred<unknown>();
    h.port.inspectDocument.mockReturnValueOnce(held.promise);
    const reply = h.connect();
    await vi.advanceTimersByTimeAsync(0);
    h.broker.tabChanged(8);
    h.broker.invalidate('google-ai-mode', 'scope-changed');
    held.resolve(probe);
    await vi.advanceTimersByTimeAsync(0);
    expect((await reply).status).toBe('selected');
    h.broker.close();
  });
  it('conservatively cancels when navigation occurs before a tab ID is established', async () => {
    const h = brokerHarness();
    const held = deferred<number | null>();
    h.port.ownerWindow.mockReturnValueOnce(held.promise);
    const reply = h.connect();
    h.broker.tabChanged(99);
    expect((await reply).status).toBe('scope-changed');
    held.resolve(3);
    await held.promise;
    expect(h.port.selectedTab).not.toHaveBeenCalled();
    h.broker.close();
  });
  it('publishes invalidation before its terminal reply and supports explicit reconnect after failure', async () => {
    vi.useFakeTimers();
    const h = brokerHarness();
    h.port.ownerWindow.mockReturnValueOnce(new Promise(() => {}));
    const first = h.connect();
    h.broker.invalidate('chatgpt', 'scope-changed');
    expect((await first).status).toBe('scope-changed');
    expect(h.messages.map((message) => message.kind)).toEqual(['invalidated', 'reply']);
    const next = h.connect('fiction-retry');
    await vi.advanceTimersByTimeAsync(0);
    expect((await next).status).toBe('selected');
    h.broker.close();
    h.broker.close();
    expect(h.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['ownerWindow', 'hasPermission', 'selectedTab', 'inspectDocument'] as const)(
    'contains rejected %s calls and recovers with a new request',
    async (method) => {
      const h = brokerHarness();
      h.port[method].mockRejectedValueOnce(new Error('fiction-private-detail'));
      expect((await h.connect()).status).toBe('unavailable');
      expect(JSON.stringify(h.messages)).not.toContain('fiction-private-detail');
      expect((await h.connect('fiction-retry')).status).toBe('selected');
      h.broker.close();
    },
  );
  it('fails closed if the trusted partition factory returns an invalid identifier', async () => {
    const h = brokerHarness();
    const messages: unknown[] = [];
    const next = deferred<unknown>();
    const broker = new AccessBroker(
      h.port,
      (message) => {
        messages.push(message);

        if (message.kind === 'reply') next.resolve(message);
      },
      () => {},
      () => '',
    );
    broker.receive({ operation: 'connect', requestId: 'fiction-request', provider: 'chatgpt' });
    expect(await next.promise).toEqual({
      kind: 'reply',
      requestId: 'fiction-request',
      status: 'unavailable',
    });
    expect(messages).toHaveLength(1);
    broker.close();
    h.broker.close();
  });
});
