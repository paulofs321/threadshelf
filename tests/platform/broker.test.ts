import { requireValid, PartitionIdSchema } from '../../src/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maximumRequestsPerPort, operationTimeoutMs } from '../../src/platform/protocol';
import { brokerHarness, deferred, probe, selected, tab } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('selected-tab broker', () => {
  it('pins two isolated document checks and creates only an ephemeral, unverified scope', async () => {
    const h = brokerHarness();
    const reply = await h.connect();
    expect(reply).toMatchObject({
      status: 'selected',
      session: 'unverified',
      scope: { kind: 'ephemeral', provider: 'chatgpt' },
    });
    expect(h.port.inspectDocument.mock.calls.map((call) => call[1])).toEqual([
      { tabId: 7 },
      { tabId: 7, documentId: probe.documentId },
    ]);
    h.broker.close();
  });
  it('gives every check a fresh partition and generation, including unknown same-document account/workspace changes', async () => {
    const h = brokerHarness();
    const first = await selected(h);
    const next = h.replyFor('fiction-next');
    h.broker.receive({
      operation: 'inspect-context',
      requestId: 'fiction-next',
      provider: 'chatgpt',
      scope: first,
    });
    const reply = await next;
    expect(reply.status).toBe('selected');

    if (reply.status !== 'selected' || first.kind !== 'ephemeral')
      throw new Error('Expected ephemeral scope.');

    expect(reply.scope.partition).not.toBe(first.partition);
    expect(reply.scope.generation).toBeGreaterThan(first.generation);
    const stale = h.replyFor('fiction-stale');
    h.broker.receive({
      operation: 'inspect-context',
      requestId: 'fiction-stale',
      provider: 'chatgpt',
      scope: first,
    });
    expect((await stale).status).toBe('scope-changed');
    expect(h.port.inspectDocument).toHaveBeenCalledTimes(4);
    h.broker.close();
  });
  it('keeps scopes independent between panels/tabs and after reconnect', async () => {
    const a = brokerHarness();
    const b = brokerHarness('two');
    b.port.selectedTab.mockResolvedValue({ ...tab, id: 8 });
    const first = await selected(a);
    const second = await selected(b);
    expect(second).not.toEqual(first);
    const crossPanel = b.replyFor('fiction-cross-panel');
    b.broker.receive({
      operation: 'inspect-context',
      requestId: 'fiction-cross-panel',
      provider: 'chatgpt',
      scope: first,
    });
    expect((await crossPanel).status).toBe('scope-changed');
    const reconnect = a.replyFor('fiction-reconnect');
    a.broker.receive({ operation: 'connect', requestId: 'fiction-reconnect', provider: 'chatgpt' });
    const result = await reconnect;
    expect(result.status).toBe('selected');

    if (result.status !== 'selected' || first.kind !== 'ephemeral')
      throw new Error('Expected selection.');

    expect(result.scope.partition).not.toBe(first.partition);
    expect(second.kind).toBe('ephemeral');
    a.broker.close();
    b.broker.close();
  });
  it('does not execute without permission or a live owning panel', async () => {
    const h = brokerHarness();
    h.port.hasPermission.mockResolvedValue(false);
    expect((await h.connect()).status).toBe('permission-needed');
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
    h.port.ownerWindow.mockResolvedValue(null);
    expect((await h.connect('fiction-next')).status).toBe('interrupted');
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
    h.broker.close();
  });
  it.each([
    { ...tab, url: 'https://accounts.google.com/' },
    { ...tab, active: false },
    { ...tab, incognito: true },
    { ...tab, status: 'loading' },
    { ...tab, windowId: 4 },
    { ...tab, id: undefined },
    null,
  ])('refuses another origin/window or unready/malformed tab', async (input) => {
    const h = brokerHarness();
    h.port.selectedTab.mockResolvedValue(input);
    expect((await h.connect()).status).toBe('unavailable');
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
    h.broker.close();
  });
  it.each([
    { ...probe, frameId: 2 },
    { ...probe, result: { origin: 'https://accounts.google.com', topLevel: true } },
    { ...probe, result: null },
    { ...probe, documentId: undefined },
  ])('fails closed for redirect, wrong-frame, or malformed document output', async (input) => {
    const h = brokerHarness();
    h.port.inspectDocument.mockResolvedValue(input);
    expect((await h.connect()).status).toBe('scope-changed');
    h.broker.close();
  });
  it('rejects a same-URL new document between probes', async () => {
    const h = brokerHarness();
    h.port.inspectDocument
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce({ ...probe, documentId: 'fiction-reloaded-document' });
    expect((await h.connect()).status).toBe('scope-changed');
    h.broker.close();
  });
  it.each([
    { ...tab, id: 8 },
    { ...tab, url: 'https://chatgpt.com/#changed' },
    { ...tab, url: 'https://login.invalid/' },
  ])('discards output when tab/URL changes after probing', async (after) => {
    const h = brokerHarness();
    h.port.selectedTab.mockResolvedValueOnce(tab).mockResolvedValueOnce(after);
    expect((await h.connect()).status).toBe('scope-changed');
    h.broker.close();
  });
  it('rechecks permission and owner before returning selection', async () => {
    const h = brokerHarness();
    h.port.hasPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await h.connect()).status).toBe('permission-needed');
    h.port.hasPermission.mockResolvedValue(true);
    h.port.ownerWindow.mockResolvedValueOnce(3).mockResolvedValueOnce(null);
    expect((await h.connect('fiction-next')).status).toBe('interrupted');
    h.broker.close();
  });
  it.each(['navigation', 'permission', 'cancel', 'session'] as const)(
    'aborts %s and ignores late output',
    async (change) => {
      const h = brokerHarness();
      const held = deferred<unknown>();
      h.port.inspectDocument.mockReturnValueOnce(held.promise);
      const reply = h.connect();
      await vi.waitFor(() => expect(h.port.inspectDocument).toHaveBeenCalledOnce());

      if (change === 'navigation') h.broker.tabChanged(7);
      else if (change === 'permission') h.broker.invalidateAll('permission-needed');
      else if (change === 'session') h.broker.invalidate('chatgpt', 'scope-changed');
      else h.broker.receive({ operation: 'cancel', requestId: 'fiction-request-one' });

      expect((await reply).status).toBe(
        change === 'permission'
          ? 'permission-needed'
          : change === 'cancel'
            ? 'cancelled'
            : 'scope-changed',
      );
      expect(h.port.inspectDocument.mock.calls[0]?.[2].aborted).toBe(true);
      const count = h.messages.length;
      held.resolve(probe);
      await held.promise;
      expect(h.messages).toHaveLength(count);
      expect(h.port.inspectDocument).toHaveBeenCalledOnce();
      h.broker.close();
    },
  );
  it('bounds hung operations, aborts at timeout and ignores a late result', async () => {
    vi.useFakeTimers();
    const h = brokerHarness();
    const held = deferred<unknown>();
    h.port.inspectDocument.mockReturnValueOnce(held.promise);
    const reply = h.connect();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(operationTimeoutMs);
    expect((await reply).status).toBe('timeout');
    held.resolve(probe);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      h.messages.some((message) => message.kind === 'reply' && message.status === 'selected'),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.broker.close();
  });
  it('does not continue work after cancellation during owner/permission checks', async () => {
    const h = brokerHarness();
    const held = deferred<number | null>();
    h.port.ownerWindow.mockReturnValueOnce(held.promise);
    const reply = h.connect();
    h.broker.receive({ operation: 'cancel', requestId: 'fiction-request-one' });
    expect((await reply).status).toBe('cancelled');
    held.resolve(3);
    await held.promise;
    expect(h.port.hasPermission).not.toHaveBeenCalled();
    h.broker.close();
  });
  it('limits concurrency, rejects replays/unknown commands, and cleans up disconnection', async () => {
    const h = brokerHarness();
    h.port.ownerWindow.mockReturnValue(new Promise(() => {}));
    h.broker.receive({ operation: 'connect', requestId: 'fiction-first', provider: 'chatgpt' });
    const busy = h.replyFor('fiction-second');
    h.broker.receive({ operation: 'connect', requestId: 'fiction-second', provider: 'chatgpt' });
    expect((await busy).status).toBe('busy');
    h.broker.receive({ operation: 'connect', requestId: 'fiction-first', provider: 'chatgpt' });
    expect(h.close).toHaveBeenCalledOnce();
    h.broker.receive({ operation: 'fetch', url: 'https://chatgpt.com/' });
    expect(h.port.inspectDocument).not.toHaveBeenCalled();
  });
  it('bounds retained request IDs and refuses arbitrary commands before browser access', () => {
    const h = brokerHarness();
    h.broker.receive({
      operation: 'fetch',
      requestId: 'fiction-request',
      url: 'https://chatgpt.com/',
    });
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.port.ownerWindow).not.toHaveBeenCalled();
    const bounded = brokerHarness();

    for (let i = 0; i <= maximumRequestsPerPort; i++) {
      bounded.broker.receive({
        operation: 'inspect-context',
        requestId: `fiction-${i}`,
        provider: 'chatgpt',
        scope: {
          kind: 'ephemeral',
          provider: 'chatgpt',
          partition: 'fiction-scope',
          generation: 1,
        },
      });
    }

    expect(bounded.close).toHaveBeenCalledOnce();
    expect(bounded.port.ownerWindow).not.toHaveBeenCalled();
  });
  it('rejects another provider/scope, clears selection, and prevents reuse after invalidation', async () => {
    const h = brokerHarness();
    const scope = await selected(h);
    const wrong = h.replyFor('fiction-wrong');
    h.broker.receive({
      operation: 'inspect-context',
      requestId: 'fiction-wrong',
      provider: 'google-ai-mode',
      scope,
    });
    expect((await wrong).status).toBe('scope-changed');
    const clear = h.replyFor('fiction-clear');
    h.broker.receive({
      operation: 'disconnect',
      requestId: 'fiction-clear',
      provider: 'chatgpt',
      scope,
    });
    expect((await clear).status).toBe('disconnected');
    const stale = h.replyFor('fiction-stale');
    h.broker.receive({
      operation: 'inspect-context',
      requestId: 'fiction-stale',
      provider: 'chatgpt',
      scope,
    });
    expect((await stale).status).toBe('scope-changed');
    expect(h.port.inspectDocument).toHaveBeenCalledTimes(2);
    h.broker.close();
  });
  it('returns a generic unavailable status for browser errors without exception text', async () => {
    const h = brokerHarness();
    h.port.inspectDocument.mockRejectedValue(new Error('fiction private browser detail'));
    expect(await h.connect()).toEqual({
      kind: 'reply',
      requestId: 'fiction-request-one',
      status: 'unavailable',
    });
    expect(JSON.stringify(h.messages)).not.toContain('fiction private');
    h.broker.close();
  });
});

describe('trusted selected-document binding', () => {
  it('binds only the current scope, snapshots metadata and retires the capability on replacement/close', async () => {
    const h = brokerHarness();
    const scope = await selected(h);
    expect(h.broker.bindSelectedDocument({ ...scope, generation: 999 })).toBeNull();
    const binding = h.broker.bindSelectedDocument(scope);
    if (!binding) throw new Error('Expected selected binding');
    expect(binding.tab.id).toBe(tab.id);
    expect(binding.documentId).toBe(probe.documentId);
    expect(binding.isCurrent()).toBe(true);
    expect(await binding.ownerWindow()).toBe(3);
    Object.assign(binding.scope, { generation: 999 });
    Object.assign(binding.tab, { id: 999 });
    expect(h.broker.bindSelectedDocument(scope)?.tab.id).toBe(tab.id);
    const replacement = await h.connect('fiction-replacement');
    expect(replacement.status).toBe('selected');
    expect(binding.isCurrent()).toBe(false);
    expect(h.broker.bindSelectedDocument(scope)).toBeNull();
    if (replacement.status !== 'selected') throw new Error('Expected replacement');
    const next = h.broker.bindSelectedDocument(replacement.scope);
    h.broker.close();
    expect(next?.isCurrent()).toBe(false);
    expect(h.broker.bindSelectedDocument(replacement.scope)).toBeNull();
  });
  it('cannot bind a provider that has never been selected', () => {
    const h = brokerHarness();
    expect(
      h.broker.bindSelectedDocument({
        kind: 'ephemeral',
        provider: 'chatgpt',
        generation: 1,
        partition: requireValid(PartitionIdSchema, 'fiction-partition'),
      }),
    ).toBeNull();
    h.broker.close();
  });
});
