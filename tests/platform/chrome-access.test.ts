import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../../src/contracts/primitives';
import type { AccessMessage } from '../../src/platform/protocol';
import { accessPortName } from '../../src/platform/protocol';
import { registerChromeAccess } from '../../src/platform/chrome-access';
import { deferred, event, probe, tab } from './helpers';

const chrome = vi.hoisted(() => {
  function channel<Args extends unknown[]>() {
    const listeners = new Set<(...args: Args) => void>();
    return {
      addListener(listener: (...args: Args) => void) {
        listeners.add(listener);
      },
      removeListener(listener: (...args: Args) => void) {
        listeners.delete(listener);
      },
      emit(...args: Args) {
        for (const callback of listeners) callback(...args);
      },
      clear() {
        listeners.clear();
      },
    };
  }
  return {
    runtime: {
      id: 'fiction-extension',
      getContexts: vi.fn(),
      onConnect: channel<[unknown]>(),
      lastError: undefined,
    },
    permissions: {
      contains: vi.fn(),
      onRemoved: channel<[{ permissions?: string[]; origins?: string[] }]>(),
    },
    scripting: { executeScript: vi.fn() },
    tabs: {
      query: vi.fn(),
      onUpdated: channel<[number, { status?: string; url?: string }]>(),
      onRemoved: channel<[number]>(),
      onReplaced: channel<[number, number]>(),
      onActivated: channel<[]>(),
    },
    windows: { onFocusChanged: channel<[]>() },
  };
});
vi.mock('wxt/browser', () => ({ browser: chrome }));

const sender = {
  id: 'fiction-extension',
  origin: 'chrome-extension://fiction-extension',
  url: 'chrome-extension://fiction-extension/sidepanel.html',
  documentId: 'fiction-panel',
  documentLifecycle: 'active',
};
const context = {
  contextType: 'SIDE_PANEL',
  documentId: sender.documentId,
  documentOrigin: sender.origin,
  documentUrl: sender.url,
  incognito: false,
  tabId: -1,
  frameId: 0,
  windowId: 3,
};
function connection(patch = {}, name: string = accessPortName) {
  const port = {
    name,
    sender: { ...sender, ...patch },
    postMessage: vi.fn<(message: AccessMessage) => void>(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  chrome.runtime.onConnect.emit(port);
  return port;
}
const sites = {
  chatgpt: { tab, probe },
  'google-ai-mode': {
    tab: { ...tab, id: 8, url: 'https://www.google.com/' },
    probe: {
      ...probe,
      documentId: 'fiction-google-document',
      result: { origin: 'https://www.google.com', topLevel: true },
    },
  },
};
function useSite(provider: ProviderId) {
  chrome.tabs.query.mockResolvedValue([sites[provider].tab]);
  chrome.scripting.executeScript.mockResolvedValue([sites[provider].probe]);
}
async function select(port: ReturnType<typeof connection>, provider: ProviderId = 'chatgpt') {
  useSite(provider);
  const requestId = `fiction-select-${provider}`;
  port.onMessage.emit({
    operation: 'connect',
    requestId,
    provider,
  });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, status: 'selected' }),
    ),
  );
  const reply = port.postMessage.mock.lastCall?.[0];
  if (reply?.kind !== 'reply' || reply.status !== 'selected') {
    throw new Error('Expected synthetic selection.');
  }
  return reply.scope;
}

beforeEach(() => {
  vi.resetAllMocks();
  chrome.runtime.onConnect.clear();
  chrome.permissions.onRemoved.clear();
  chrome.tabs.onUpdated.clear();
  chrome.tabs.onRemoved.clear();
  chrome.tabs.onReplaced.clear();
  chrome.tabs.onActivated.clear();
  chrome.windows.onFocusChanged.clear();
  chrome.runtime.getContexts.mockResolvedValue([context]);
  chrome.permissions.contains.mockResolvedValue(true);
  chrome.tabs.query.mockResolvedValue([tab]);
  chrome.scripting.executeScript.mockResolvedValue([probe]);
  registerChromeAccess();
});

describe('Chrome lifecycle composition (mocked, not a browser probe)', () => {
  it('targets only the selected panel window/top-level document in the isolated world', async () => {
    const port = connection();
    await select(port);
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['SIDE_PANEL'],
      documentIds: [sender.documentId],
    });
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      permissions: ['scripting'],
      origins: ['https://chatgpt.com/*'],
    });
    expect(chrome.scripting.executeScript.mock.calls[0]?.[0]).toMatchObject({
      world: 'ISOLATED',
      target: { tabId: 7, frameIds: [0] },
      args: ['https://chatgpt.com'],
    });
    expect(chrome.scripting.executeScript.mock.calls[1]?.[0]).toMatchObject({
      world: 'ISOLATED',
      target: { tabId: 7, documentIds: [probe.documentId] },
    });
    port.onDisconnect.emit();
    expect(port.onMessage.size()).toBe(0);
    expect(port.onDisconnect.size()).toBe(0);
  });
  it.each([
    { id: 'another-extension' },
    { tab: tab },
    { frameId: 2 },
    { documentLifecycle: 'cached' },
  ])('closes forged/content-script senders before site access', (patch) => {
    const port = connection(patch);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
  });
  it.each([
    { contexts: [] },
    { contexts: [{ ...context, incognito: true }] },
    { contexts: [{ ...context, documentId: 'another-panel' }] },
    { contexts: [context, context] },
  ])('refuses a disappeared/mismatched/incognito owner', async ({ contexts }) => {
    chrome.runtime.getContexts.mockResolvedValue(contexts);
    const port = connection();
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-request',
      provider: 'chatgpt',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: 'reply',
        requestId: 'fiction-request',
        status: 'interrupted',
      }),
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    port.onDisconnect.emit();
  });
  it.each(['navigation', 'removed', 'replaced', 'activated', 'focus', 'permission'] as const)(
    'invalidates selected scope on %s',
    async (change) => {
      const port = connection();
      await select(port);
      if (change === 'navigation') chrome.tabs.onUpdated.emit(7, { status: 'loading' });
      else if (change === 'removed') chrome.tabs.onRemoved.emit(7);
      else if (change === 'replaced') chrome.tabs.onReplaced.emit(8, 7);
      else if (change === 'activated') chrome.tabs.onActivated.emit();
      else if (change === 'focus') chrome.windows.onFocusChanged.emit();
      else chrome.permissions.onRemoved.emit({ permissions: ['scripting'] });
      expect(port.postMessage).toHaveBeenLastCalledWith({
        kind: 'invalidated',
        provider: 'chatgpt',
        generation: 2,
        status: change === 'permission' ? 'permission-needed' : 'scope-changed',
      });
      port.onDisconnect.emit();
    },
  );
  it('rejects pending navigation and multiple-frame injection output', async () => {
    chrome.tabs.query.mockResolvedValue([{ ...tab, pendingUrl: 'https://chatgpt.com/' }]);
    const port = connection();
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-request',
      provider: 'chatgpt',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: 'reply',
        requestId: 'fiction-request',
        status: 'unavailable',
      }),
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    chrome.tabs.query.mockResolvedValue([tab]);
    chrome.scripting.executeScript.mockResolvedValue([probe, { ...probe, frameId: 1 }]);
    port.onMessage.emit({ operation: 'connect', requestId: 'fiction-next', provider: 'chatgpt' });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: 'reply',
        requestId: 'fiction-next',
        status: 'scope-changed',
      }),
    );
    port.onDisconnect.emit();
  });
  it('bounds open broker connections and releases their listeners', () => {
    const ports = Array.from({ length: 5 }, () => connection());
    expect(ports[4]?.disconnect).toHaveBeenCalledOnce();
    for (const port of ports.slice(0, 4)) port.onDisconnect.emit();
    const next = connection();
    expect(next.disconnect).not.toHaveBeenCalled();
    next.onDisconnect.emit();
  });
  it('refuses the wrong port name before any site or context lookup', () => {
    const port = connection({}, 'fiction-arbitrary-fetch');
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it.each([{ tabs: [] }, { tabs: [tab, { ...tab, id: 8 }] }])(
    'refuses missing/ambiguous active tabs',
    async ({ tabs }) => {
      chrome.tabs.query.mockResolvedValue(tabs);
      const port = connection();
      port.onMessage.emit({
        operation: 'connect',
        requestId: 'fiction-request',
        provider: 'chatgpt',
      });
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith({
          kind: 'reply',
          requestId: 'fiction-request',
          status: 'unavailable',
        }),
      );
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
      port.onDisconnect.emit();
    },
  );
  it('keeps a selected scope for completed non-navigation tab updates', async () => {
    const port = connection();
    await select(port);
    const count = port.postMessage.mock.calls.length;
    chrome.tabs.onUpdated.emit(7, { status: 'complete' });
    chrome.tabs.onUpdated.emit(8, { status: 'loading' });
    expect(port.postMessage).toHaveBeenCalledTimes(count);
    port.onDisconnect.emit();
  });
  it('releases a broker and its listeners if Chrome refuses to send its reply', async () => {
    const port = connection();
    port.postMessage.mockImplementation(() => {
      throw new Error('fiction-private-port-detail');
    });
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-request',
      provider: 'chatgpt',
    });
    await vi.waitFor(() => expect(port.disconnect).toHaveBeenCalledOnce());
    expect(port.onMessage.size()).toBe(0);
    expect(port.onDisconnect.size()).toBe(0);
  });
  it.each([{ permissions: ['scripting'] }, { origins: ['https://chatgpt.com/*'] }])(
    'discards late Chrome injection output after removal of %j',
    async (removed) => {
      const held = deferred<unknown>();
      chrome.scripting.executeScript.mockReturnValueOnce(held.promise);
      const port = connection();
      port.onMessage.emit({
        operation: 'connect',
        requestId: 'fiction-request',
        provider: 'chatgpt',
      });
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledOnce());
      chrome.permissions.onRemoved.emit(removed);
      expect(port.postMessage).toHaveBeenLastCalledWith({
        kind: 'reply',
        requestId: 'fiction-request',
        status: 'permission-needed',
      });
      const count = port.postMessage.mock.calls.length;
      held.resolve([probe]);
      await held.promise;
      expect(port.postMessage).toHaveBeenCalledTimes(count);
      expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
      port.onDisconnect.emit();
    },
  );
  it.each([
    {
      name: 'ChatGPT host',
      removed: { origins: ['https://chatgpt.com/*'] },
      affected: ['chatgpt'],
    },
    {
      name: 'Google host',
      removed: { origins: ['https://www.google.com/*'] },
      affected: ['google-ai-mode'],
    },
    {
      name: 'both hosts',
      removed: { origins: ['https://chatgpt.com/*', 'https://www.google.com/*'] },
      affected: ['chatgpt', 'google-ai-mode'],
    },
    {
      name: 'shared scripting permission',
      removed: { permissions: ['scripting'] },
      affected: ['chatgpt', 'google-ai-mode'],
    },
    {
      name: 'scripting and one host together',
      removed: { permissions: ['scripting'], origins: ['https://chatgpt.com/*'] },
      affected: ['chatgpt', 'google-ai-mode'],
    },
    { name: 'no permission fields', removed: {}, affected: [] },
    { name: 'empty lists', removed: { permissions: [], origins: [] }, affected: [] },
    {
      name: 'unrelated permission and origin',
      removed: { permissions: ['storage'], origins: ['https://fiction.invalid/*'] },
      affected: [],
    },
  ])('invalidates only affected selections when removing $name', async ({ removed, affected }) => {
    const port = connection();
    const scopes = [await select(port), await select(port, 'google-ai-mode')];
    port.postMessage.mockClear();
    chrome.permissions.onRemoved.emit(removed);
    expect(port.postMessage.mock.calls.map(([message]) => message)).toEqual(
      affected.map((provider) => ({
        kind: 'invalidated',
        provider,
        generation: 2,
        status: 'permission-needed',
      })),
    );
    // The original scope must still work for a provider whose permission was retained.
    for (const scope of scopes) {
      const requestId = `fiction-disconnect-${scope.provider}`;
      port.onMessage.emit({
        operation: 'disconnect',
        requestId,
        provider: scope.provider,
        scope,
      });
      expect(port.postMessage).toHaveBeenLastCalledWith({
        kind: 'reply',
        requestId,
        status: affected.some((provider) => provider === scope.provider)
          ? 'scope-changed'
          : 'disconnected',
      });
    }
    port.onDisconnect.emit();
  });
  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'preserves a pending %s operation when the other provider loses host access',
    async (provider) => {
      const other = provider === 'chatgpt' ? 'google-ai-mode' : 'chatgpt';
      const port = connection();
      await select(port, other);
      useSite(provider);
      const held = deferred<unknown>();
      chrome.scripting.executeScript.mockClear().mockReturnValueOnce(held.promise);
      port.postMessage.mockClear();
      port.onMessage.emit({ operation: 'connect', requestId: 'fiction-pending', provider });
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledOnce());
      chrome.permissions.onRemoved.emit({ origins: [`${sites[other].probe.result.origin}/*`] });
      expect(port.postMessage.mock.calls.map(([message]) => message)).toEqual([
        { kind: 'invalidated', provider: other, generation: 2, status: 'permission-needed' },
      ]);
      held.resolve([sites[provider].probe]);
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            requestId: 'fiction-pending',
            status: 'selected',
            scope: expect.objectContaining({ provider, generation: 1 }),
          }),
        ),
      );
      port.onDisconnect.emit();
    },
  );
  it('uses the separate exact Google origin/permission and still labels session access unverified', async () => {
    chrome.tabs.query.mockResolvedValue([{ ...tab, url: 'https://www.google.com/' }]);
    chrome.scripting.executeScript.mockResolvedValue([
      { ...probe, result: { origin: 'https://www.google.com', topLevel: true } },
    ]);
    const port = connection();
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-google',
      provider: 'google-ai-mode',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'selected',
          session: 'unverified',
          scope: expect.objectContaining({ provider: 'google-ai-mode' }),
        }),
      ),
    );
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      permissions: ['scripting'],
      origins: ['https://www.google.com/*'],
    });
    expect(chrome.scripting.executeScript.mock.calls[0]?.[0].args).toEqual([
      'https://www.google.com',
    ]);
    port.onDisconnect.emit();
  });
});
