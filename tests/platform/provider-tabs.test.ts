import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderTabs } from '../../src/platform/provider-tabs';
import { deferred, tab } from './helpers';

const chrome = vi.hoisted(() => ({
  tabs: { query: vi.fn(), create: vi.fn(), get: vi.fn(), remove: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: chrome }));
const managers: ProviderTabs[] = [];

function harness() {
  const manager = new ProviderTabs();
  managers.push(manager);
  const controller = new AbortController();

  return { manager, controller, select: () => manager.select(3, 'chatgpt', controller.signal) };
}

beforeEach(() => {
  vi.resetAllMocks();
  chrome.tabs.query.mockResolvedValue([]);
  chrome.tabs.create.mockResolvedValue({ ...tab, active: false });
  chrome.tabs.get.mockResolvedValue({ ...tab, active: false });
  chrome.tabs.remove.mockResolvedValue(undefined);
});
afterEach(async () => {
  managers.splice(0).forEach((m) => m.close());
  await Promise.resolve();
  vi.useRealTimers();
});
describe('independent provider document ownership', () => {
  it('opens supported default AI Mode when other Google pages or account selectors are open', async () => {
    const { manager, controller } = harness();
    const google = { ...tab, id: 8, active: false, url: 'https://www.google.com/search?udm=50' };
    chrome.tabs.query.mockResolvedValue([
      { ...google, url: 'https://www.google.com/' },
      { ...google, id: 9, url: 'https://www.google.com/search?udm=50&authuser=1' },
      { ...google, id: 10, url: 'https://www.google.com/search?q=fiction' },
    ]);
    chrome.tabs.create.mockResolvedValue(google);
    chrome.tabs.get.mockResolvedValue(google);
    expect(await manager.select(3, 'google-ai-mode', controller.signal)).toEqual(google);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      windowId: 3,
      active: false,
      url: google.url,
    });
  });

  it('connects without a manually opened provider tab using only a fixed passive landing URL', async () => {
    const { select, manager } = harness();
    expect(await select()).toEqual({ ...tab, active: false });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 3, url: 'https://chatgpt.com/*' });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      windowId: 3,
      active: false,
      url: 'https://chatgpt.com/',
    });
    await manager.release('chatgpt');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
  });
  it('uses the fixed AI Mode landing page and maintains independent provider sources', async () => {
    const { manager, controller } = harness();
    await manager.select(3, 'chatgpt', controller.signal);
    const google = { ...tab, id: 8, active: false, url: 'https://www.google.com/search?udm=50' };
    chrome.tabs.create.mockResolvedValue(google);
    chrome.tabs.get.mockResolvedValue(google);
    expect(await manager.select(3, 'google-ai-mode', controller.signal)).toEqual(google);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({
      windowId: 3,
      active: false,
      url: google.url,
    });
    chrome.tabs.query.mockResolvedValue([{ ...tab, active: false }, google]);
    expect(await manager.select(3, 'chatgpt', controller.signal, 7)).toEqual({
      ...tab,
      active: false,
    });
  });
  it('reuses an inactive user provider tab and never closes it on disconnect', async () => {
    chrome.tabs.query.mockResolvedValue([{ ...tab, active: false }]);
    const { manager, select } = harness();
    expect(await select()).toEqual({ ...tab, active: false });
    await manager.release('chatgpt');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('prefers the active provider tab among several without creating another page', async () => {
    const { select } = harness();
    chrome.tabs.query.mockResolvedValue([tab, { ...tab, id: 8, active: false }]);
    expect(await select()).toEqual(tab);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'connects to %s from another site when several provider pages are inactive',
    async (provider) => {
      const { manager, controller } = harness();
      const url =
        provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://www.google.com/search?udm=50';
      const existing = [
        { ...tab, url, active: false },
        { ...tab, id: 8, url, active: false },
      ];
      const created = { ...tab, id: 9, url, active: false };
      chrome.tabs.query.mockResolvedValue(existing);
      chrome.tabs.create.mockResolvedValue(created);
      chrome.tabs.get.mockResolvedValue(created);
      expect(await manager.select(3, provider, controller.signal)).toEqual(created);
      expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        windowId: 3,
        active: false,
        url,
      });
      chrome.tabs.query.mockResolvedValue([...existing, created]);
      expect(await manager.select(3, provider, controller.signal, 9)).toEqual(created);
      expect(await manager.select(3, provider, controller.signal)).toEqual(created);
      expect(chrome.tabs.create).toHaveBeenCalledOnce();
      await manager.release(provider);
      expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(9);
    },
  );
  it('never replaces a disappeared pinned source with a new landing or another inactive page', async () => {
    const { manager, controller, select } = harness();
    chrome.tabs.query.mockResolvedValue([tab]);
    await select();
    chrome.tabs.query.mockResolvedValue([
      { ...tab, id: 8, active: false },
      { ...tab, id: 9, active: false },
    ]);
    expect(await manager.select(3, 'chatgpt', controller.signal, 7)).toBeNull();
    expect(await select()).toBeNull();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('pins the source ID through rechecks without substituting another provider document', async () => {
    const { manager, controller, select } = harness();
    chrome.tabs.query.mockResolvedValue([tab]);
    await select();
    chrome.tabs.query.mockResolvedValue([{ ...tab, id: 8 }]);
    expect(await manager.select(3, 'chatgpt', controller.signal, 7)).toBeNull();
    expect(await select()).toBeNull();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it.each(['active', 'navigated', 'pending'] as const)(
    'preserves an owned page that became %s',
    async (kind) => {
      const { select, manager } = harness();
      await select();
      chrome.tabs.get.mockResolvedValue({
        ...tab,
        active: kind === 'active',
        ...(kind === 'navigated' ? { url: 'https://chatgpt.com/c/user-navigation' } : {}),
        ...(kind === 'pending' ? { pendingUrl: 'https://chatgpt.com/c/pending' } : {}),
      });
      await manager.release('chatgpt');
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
    },
  );
  it('absorbs cleanup API errors without exposing browser details', async () => {
    const { select, manager } = harness();
    await select();
    chrome.tabs.get.mockRejectedValue(new Error('fiction-private'));
    await expect(manager.release('chatgpt')).resolves.toBeUndefined();
  });
  it.each(['abort', 'close'] as const)('cleans up late tab creation after %s', async (stop) => {
    const { select, manager, controller } = harness();
    const created = deferred<typeof tab>();
    chrome.tabs.create.mockReturnValue(created.promise);
    const result = select();
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());

    if (stop === 'abort') controller.abort();
    else manager.close();

    created.resolve({ ...tab, active: false });
    expect(await result).toBeNull();
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
  });
  it('waits for passive loading without losing source ownership or leaving polling timers', async () => {
    vi.useFakeTimers();
    const { select } = harness();
    chrome.tabs.create.mockResolvedValue({ ...tab, active: false, status: 'loading' });
    const result = select();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ...tab, active: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts loading promptly and removes its polling timer', async () => {
    vi.useFakeTimers();
    const { select, controller } = harness();
    chrome.tabs.create.mockResolvedValue({ ...tab, active: false, status: 'loading' });
    const result = select();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    'aborted',
    'closed',
    'abort during lookup',
    'missing id',
    'bad window',
    'pending navigation',
    'invalid metadata',
  ] as const)('rejects %s before binding a document', async (cause) => {
    const { manager, controller, select } = harness();

    if (cause === 'aborted') controller.abort();

    if (cause === 'closed') manager.close();

    if (cause === 'missing id') chrome.tabs.create.mockResolvedValue({ ...tab, id: undefined });

    if (cause === 'bad window') chrome.tabs.create.mockResolvedValue({ ...tab, windowId: 4 });

    if (cause === 'pending navigation')
      chrome.tabs.create.mockResolvedValue({ ...tab, pendingUrl: 'https://evil.invalid' });

    if (cause === 'invalid metadata')
      chrome.tabs.create.mockResolvedValue({ ...tab, status: 'unloaded' });

    if (cause === 'abort during lookup')
      chrome.tabs.query.mockImplementation(async () => {
        controller.abort();

        return [tab];
      });

    expect(await select()).toBeNull();
  });
});
