import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessPortName } from '../../src/platform/protocol';
import { registerChromeAccess } from '../../src/platform/chrome-access';
import { event, probe, tab } from './helpers';

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
    permissions: { contains: vi.fn(), onRemoved: channel<[]>() },
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
function connection(patch = {}) {
  const port = {
    name: accessPortName,
    sender: { ...sender, ...patch },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  chrome.runtime.onConnect.emit(port);
  return port;
}
async function select(port: ReturnType<typeof connection>) {
  port.onMessage.emit({
    operation: 'connect',
    requestId: 'fiction-request-one',
    provider: 'chatgpt',
  });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'selected' })),
  );
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
      else chrome.permissions.onRemoved.emit();
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
});
