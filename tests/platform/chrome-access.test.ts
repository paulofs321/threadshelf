import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../../src/contracts/primitives';
import type { AccessMessage } from '../../src/platform/protocol';
import { panelPortName } from '../../src/platform/protocol';
import { registerChromeAccess } from '../../src/platform/chrome-access';
import { deferred, event, probe, tab } from './helpers';
import { SearchRequestSchema, requireValid } from '../../src/contracts';
import type { SearchReply } from '../../src/platform/search-protocol';
import { readResult, searchBody } from '../fixtures/chatgpt/wire';
import { googleJson, googleMatch } from '../fixtures/google-ai-mode/wire';

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
      create: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      onUpdated: channel<[number, { status?: string; url?: string }]>(),
      onRemoved: channel<[number]>(),
      onReplaced: channel<[number, number]>(),
      onActivated: channel<[]>(),
    },
    windows: { get: vi.fn(), onFocusChanged: channel<[]>(), onRemoved: channel<[number]>() },
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
  windowId: -1,
};

function connection(patch = {}, name: string = panelPortName(3)) {
  const port = {
    name,
    sender: { ...sender, ...patch },
    postMessage: vi.fn<(message: AccessMessage | SearchReply) => void>(),
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
    tab: { ...tab, id: 8, url: 'https://www.google.com/search?udm=50' },
    probe: {
      ...probe,
      documentId: 'fiction-google-document',
      result: { origin: 'https://www.google.com', topLevel: true },
    },
  },
};

function useSite(provider: ProviderId) {
  chrome.tabs.query.mockResolvedValue([sites[provider].tab]);
  chrome.scripting.executeScript.mockImplementation(
    async ({ func }: { func: { name: string } }) => [
      {
        ...sites[provider].probe,
        result:
          func.name === 'readChatGptDocument' || func.name === 'readGoogleDocument'
            ? {
                status: 'success',
                identityBefore: 'a'.repeat(64),
                identityAfter: 'a'.repeat(64),
                ...(provider === 'chatgpt' ? { body: null } : {}),
              }
            : sites[provider].probe.result,
      },
    ],
  );
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
      expect.objectContaining({ requestId, status: 'connected' }),
    ),
  );
  const reply = port.postMessage.mock.lastCall?.[0];

  if (reply?.kind !== 'reply' || reply.status !== 'connected') {
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
  chrome.windows.onRemoved.clear();
  chrome.windows.get.mockResolvedValue({ id: 3, incognito: false });
  chrome.runtime.getContexts.mockResolvedValue([context]);
  chrome.tabs.create.mockRejectedValue(new Error('fiction-no-background-page'));
  chrome.tabs.get.mockResolvedValue(tab);
  chrome.tabs.remove.mockResolvedValue(undefined);
  chrome.permissions.contains.mockResolvedValue(true);
  chrome.tabs.query.mockResolvedValue([tab]);
  chrome.scripting.executeScript.mockImplementation(
    async ({ func }: { func: { name: string } }) => [
      {
        ...probe,
        result:
          func.name === 'readChatGptDocument'
            ? {
                status: 'success',
                body: null,
                identityBefore: 'a'.repeat(64),
                identityAfter: 'a'.repeat(64),
              }
            : probe.result,
      },
    ],
  );
  registerChromeAccess();
});

describe('Chrome lifecycle composition (mocked, not a browser probe)', () => {
  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'waits for a dedicated %s sign-in tab and injects only after a supported return',
    async (provider) => {
      const port = connection();
      useSite(provider);
      const metadata = sites[provider].probe;
      chrome.scripting.executeScript.mockImplementation(
        async ({ func }: { func: { name: string } }) => [
          {
            ...metadata,
            result:
              func.name === 'inspectSelectedDocument'
                ? metadata.result
                : { status: 'login-expired' },
          },
        ],
      );
      chrome.tabs.create.mockResolvedValue({ id: 19 });
      chrome.tabs.get.mockResolvedValue({
        id: 19,
        windowId: 3,
        incognito: false,
        status: 'complete',
        url: provider === 'chatgpt' ? 'https://chatgpt.com/auth/login' : undefined,
      });
      port.onMessage.emit({ operation: 'connect', provider, requestId: 'fiction-sign-in' });
      await vi.waitFor(() =>
        expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: true })),
      );
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'waiting-for-sign-in' }),
      );
      expect(
        chrome.scripting.executeScript.mock.calls.every(([call]) => call.target.tabId !== 19),
      ).toBe(true);
      const returned = { ...sites[provider].tab, id: 19 };
      chrome.tabs.get.mockResolvedValue(returned);
      chrome.tabs.query.mockResolvedValue([sites[provider].tab, returned]);
      chrome.scripting.executeScript.mockImplementation(
        async ({ func, target }: { func: { name: string }; target: { tabId: number } }) => [
          {
            ...metadata,
            documentId: target.tabId === 19 ? 'fiction-returned-document' : metadata.documentId,
            result:
              func.name === 'inspectSelectedDocument'
                ? metadata.result
                : {
                    status: 'success',
                    identityBefore: 'a'.repeat(64),
                    identityAfter: 'a'.repeat(64),
                    ...(provider === 'chatgpt' ? { body: null } : {}),
                  },
          },
        ],
      );
      chrome.tabs.onUpdated.emit(19, { status: 'complete' });
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'connected',
            scope: expect.objectContaining({ generation: 3 }),
          }),
        ),
      );
      expect(chrome.tabs.create).toHaveBeenCalledOnce();
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
      port.onMessage.emit({ operation: 'keepalive' });
      await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ kind: 'alive' }));
      port.onDisconnect.emit();
    },
  );
  it('acknowledges strictly allowlisted keepalive messages without browser/provider access', () => {
    const port = connection();
    port.onMessage.emit({ operation: 'keepalive' });
    expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'alive' });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    port.onMessage.emit({ operation: 'keepalive', url: 'https://evil.invalid' });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
  it('tears down both capabilities if heartbeat delivery fails', () => {
    const port = connection();
    port.postMessage.mockImplementation(() => {
      throw new Error('fiction-port');
    });
    port.onMessage.emit({ operation: 'keepalive' });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
  it('retains both provider selections while switching tabs or window focus', async () => {
    const port = connection();
    const chatScope = await select(port);
    const googleScope = await select(port, 'google-ai-mode');
    port.postMessage.mockClear();
    chrome.tabs.onActivated.emit();
    chrome.windows.onFocusChanged.emit();
    expect(port.postMessage).not.toHaveBeenCalled();
    useSite('chatgpt');
    port.onMessage.emit({
      operation: 'inspect-context',
      provider: 'chatgpt',
      requestId: 'fiction-retained-chat',
      scope: chatScope,
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'fiction-retained-chat', status: 'connected' }),
      ),
    );
    useSite('google-ai-mode');
    port.onMessage.emit({
      operation: 'inspect-context',
      provider: 'google-ai-mode',
      requestId: 'fiction-retained-google',
      scope: googleScope,
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'fiction-retained-google', status: 'connected' }),
      ),
    );
    port.onDisconnect.emit();
  });

  it('connects ChatGPT from another site with multiple inactive tabs while retaining Google', async () => {
    const port = connection();
    const googleScope = await select(port, 'google-ai-mode');
    port.postMessage.mockClear();
    const existing = [
      { ...tab, active: false },
      { ...tab, id: 9, active: false },
    ];
    const landing = { ...tab, id: 10, active: false };
    let created = false;
    chrome.tabs.query.mockImplementation(async ({ url }: { url: string }) =>
      url === 'https://chatgpt.com/*'
        ? [...existing, ...(created ? [landing] : [])]
        : [sites['google-ai-mode'].tab],
    );
    chrome.tabs.create.mockImplementation(async () => {
      created = true;

      return landing;
    });
    chrome.tabs.get.mockResolvedValue(landing);
    chrome.scripting.executeScript.mockImplementation(
      async (options: { args: [string]; func: { name: string } }) => {
        const metadata =
          options.args[0] === 'https://www.google.com' || options.func.name === 'readGoogleDocument'
            ? sites['google-ai-mode'].probe
            : probe;

        return [
          {
            ...metadata,
            result:
              options.func.name === 'readChatGptDocument' ||
              options.func.name === 'readGoogleDocument'
                ? {
                    status: 'success',
                    ...(options.func.name === 'readChatGptDocument' ? { body: null } : {}),
                    identityBefore: 'a'.repeat(64),
                    identityAfter: 'a'.repeat(64),
                  }
                : metadata.result,
          },
        ];
      },
    );
    port.onMessage.emit({
      operation: 'connect',
      provider: 'chatgpt',
      requestId: 'fiction-background-chat',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'fiction-background-chat',
          status: 'connected',
          session: 'authenticated',
        }),
      ),
    );
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
      windowId: 3,
      active: false,
      url: 'https://chatgpt.com/',
    });
    port.onMessage.emit({
      operation: 'inspect-context',
      provider: 'google-ai-mode',
      requestId: 'fiction-google-still-connected',
      scope: googleScope,
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'fiction-google-still-connected',
          status: 'connected',
        }),
      ),
    );
    expect(
      port.postMessage.mock.calls.some(
        ([message]) => message.kind === 'invalidated' && message.provider === 'chatgpt',
      ),
    ).toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    port.onDisconnect.emit();
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(10));
  });

  it('targets only the selected panel window/top-level document in the isolated world', async () => {
    const port = connection();
    await select(port);
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 3, url: 'https://chatgpt.com/*' });
    expect(chrome.windows.get).toHaveBeenCalledWith(3, { populate: false });
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
    { contexts: [{ ...context, windowId: 4 }] },
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
  it.each(['navigation', 'removed', 'replaced', 'permission'] as const)(
    'invalidates selected scope on %s',
    async (change) => {
      const port = connection();
      await select(port);

      if (change === 'navigation') chrome.tabs.onUpdated.emit(7, { status: 'loading' });
      else if (change === 'removed') chrome.tabs.onRemoved.emit(7);
      else if (change === 'replaced') chrome.tabs.onReplaced.emit(8, 7);
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
  it.each([
    { id: -1, incognito: false },
    { id: 4, incognito: false },
    { id: 3, incognito: true },
    { incognito: false },
  ])('refuses an invalid/mismatched/incognito bound window %j', async (window) => {
    chrome.windows.get.mockResolvedValue(window);
    const port = connection();
    port.onMessage.emit({ operation: 'connect', provider: 'chatgpt', requestId: 'fiction-window' });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: 'reply',
        requestId: 'fiction-window',
        status: 'interrupted',
      }),
    );
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    port.onDisconnect.emit();
  });
  it('rejects a window that disappears before the final owner recheck', async () => {
    chrome.windows.get
      .mockResolvedValueOnce({ id: 3, incognito: false })
      .mockRejectedValueOnce(new Error('fiction-private-window-error'));
    const port = connection();
    port.onMessage.emit({ operation: 'connect', provider: 'chatgpt', requestId: 'fiction-window' });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: 'reply',
        requestId: 'fiction-window',
        status: 'interrupted',
      }),
    );
    port.onDisconnect.emit();
  });
  it('pins simultaneous panels to their own windows despite unknown runtime window IDs and focus changes', async () => {
    chrome.windows.get.mockImplementation(async (id: number) => ({ id, incognito: false }));
    chrome.runtime.getContexts.mockImplementation(async (filter: { documentIds: string[] }) => [
      { ...context, documentId: filter.documentIds[0] },
    ]);
    chrome.tabs.query.mockImplementation(async ({ windowId }: { windowId: number }) => [
      { ...tab, id: windowId === 3 ? 7 : 8, windowId },
    ]);
    const first = connection();
    const second = connection({ documentId: 'fiction-second-panel' }, panelPortName(4));

    for (const port of [first, second]) {
      port.onMessage.emit({
        operation: 'connect',
        provider: 'chatgpt',
        requestId: 'fiction-select',
      });
    }

    await vi.waitFor(() => {
      for (const port of [first, second]) {
        expect(port.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'connected' }),
        );
      }
    });
    expect(chrome.tabs.query.mock.calls.map(([query]) => query.windowId)).toEqual(
      expect.arrayContaining([3, 4]),
    );
    chrome.windows.onFocusChanged.emit();
    first.postMessage.mockClear();
    first.onMessage.emit({ operation: 'connect', provider: 'chatgpt', requestId: 'fiction-retry' });
    await vi.waitFor(() =>
      expect(first.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'connected' }),
      ),
    );
    expect(chrome.tabs.query).toHaveBeenLastCalledWith({
      windowId: 3,
      url: 'https://chatgpt.com/*',
    });
    chrome.windows.onRemoved.emit(3);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).not.toHaveBeenCalled();
    second.onDisconnect.emit();
  });
  it('discards a pending document probe when its owning window closes', async () => {
    const held = deferred<unknown>();
    chrome.scripting.executeScript.mockReturnValueOnce(held.promise);
    const port = connection();
    port.onMessage.emit({ operation: 'connect', provider: 'chatgpt', requestId: 'fiction-window' });
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledOnce());
    chrome.windows.onRemoved.emit(3);
    expect(port.disconnect).toHaveBeenCalledOnce();
    held.resolve([probe]);
    await held.promise;
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.onMessage.size()).toBe(0);
    expect(port.onDisconnect.size()).toBe(0);
  });
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
            status: 'connected',
            scope: expect.objectContaining({ provider, generation: 1 }),
          }),
        ),
      );
      port.onDisconnect.emit();
    },
  );
  it('uses the separate exact Google origin/permission and authenticates before reporting connected', async () => {
    chrome.tabs.query.mockResolvedValue([{ ...tab, url: 'https://www.google.com/search?udm=50' }]);
    chrome.scripting.executeScript.mockImplementation(
      async ({ func }: { func: { name: string } }) => [
        {
          ...probe,
          result:
            func.name === 'readGoogleDocument'
              ? { status: 'success', identityBefore: 'a'.repeat(64), identityAfter: 'a'.repeat(64) }
              : { origin: 'https://www.google.com', topLevel: true },
        },
      ],
    );
    const port = connection();
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-google',
      provider: 'google-ai-mode',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'connected',
          session: 'authenticated',
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
  it('resolves omitted sender document metadata only from one canonical SIDE_PANEL context', async () => {
    const port = connection({ documentId: undefined, documentLifecycle: undefined });
    await select(port);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' }));
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ documentUrls: [sender.url] });
    port.onDisconnect.emit();
  });
  it.each([
    { name: 'tab only', contexts: [{ ...context, contextType: 'TAB', tabId: 7 }] },
    { name: 'panel plus tab', contexts: [context, { ...context, contextType: 'TAB', tabId: 7 }] },
    { name: 'multiple panels', contexts: [context, { ...context, documentId: 'second-panel' }] },
    { name: 'missing identity', contexts: [{ ...context, documentId: undefined }] },
  ])('rejects ambiguous/unproved fallback contexts: $name', async ({ contexts }) => {
    chrome.runtime.getContexts.mockResolvedValue(contexts);
    const port = connection({ documentId: undefined, documentLifecycle: undefined });
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-fallback',
      provider: 'chatgpt',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'interrupted' }),
      ),
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    port.onDisconnect.emit();
  });
  it('pins the independently resolved panel ID and rejects a replacement at the same URL', async () => {
    chrome.runtime.getContexts
      .mockResolvedValueOnce([context])
      .mockResolvedValue([{ ...context, documentId: 'replacement-panel' }]);
    const port = connection({ documentId: undefined, documentLifecycle: undefined });
    useSite('chatgpt');
    port.onMessage.emit({
      operation: 'connect',
      requestId: 'fiction-replacement',
      provider: 'chatgpt',
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'interrupted' }),
      ),
    );
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
    );
    port.onDisconnect.emit();
  });
});

describe('runtime keyword bridge with actual factories and synthetic isolated readers', () => {
  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'routes a scoped %s keyword request through the real adapter and host',
    async (provider) => {
      const port = connection();
      const scope = await select(port, provider);
      const result =
        provider === 'chatgpt'
          ? readResult(searchBody())
          : {
              status: 'success',
              identityBefore: 'a'.repeat(64),
              identityAfter: 'a'.repeat(64),
              response: {
                status: 200,
                contentType: 'application/json',
                retryAfter: null,
                body: googleJson([[googleMatch()]]),
              },
            };
      chrome.scripting.executeScript.mockImplementation(
        async ({ func }: { func: { name: string } }) => [
          {
            ...sites[provider].probe,
            result: func.name === 'inspectSelectedDocument' ? sites[provider].probe.result : result,
          },
        ],
      );
      const request = requireValid(SearchRequestSchema, {
        requestId: `fiction-runtime-${provider}`,
        query: {
          text: 'fictional orchard',
          mode: 'keyword',
          providers: [provider],
          timeZone: 'Europe/Zurich',
        },
        scopes: [scope],
      });
      port.onMessage.emit({ operation: 'keyword-search', request });
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'search-result' }),
        ),
      );
      const reply = port.postMessage.mock.lastCall?.[0];

      if (reply?.kind !== 'search-result') throw new Error('Expected search result');

      expect(reply.outcome.state).toBe('success');
      expect(reply.outcome.results).toHaveLength(1);
      expect(
        chrome.scripting.executeScript.mock.calls.some(
          ([argument]) =>
            argument.func.name ===
            (provider === 'chatgpt' ? 'readChatGptDocument' : 'readGoogleDocument'),
        ),
      ).toBe(true);
      port.onDisconnect.emit();
      expect(port.onMessage.size()).toBe(0);
    },
  );
  it('clears an in-flight search on permission invalidation and discards late provider data', async () => {
    const port = connection();
    const scope = await select(port);
    const pending = deferred<unknown>();
    chrome.scripting.executeScript.mockImplementation(
      async ({ func }: { func: { name: string } }) =>
        func.name === 'readChatGptDocument' ? pending.promise : [probe],
    );
    const request = requireValid(SearchRequestSchema, {
      requestId: 'fiction-runtime-pending',
      query: { text: 'library', mode: 'keyword', providers: ['chatgpt'], timeZone: 'UTC' },
      scopes: [scope],
    });
    port.onMessage.emit({ operation: 'keyword-search', request });
    await vi.waitFor(() =>
      expect(
        chrome.scripting.executeScript.mock.calls.some(
          ([argument]) => argument.func.name === 'readChatGptDocument',
        ),
      ).toBe(true),
    );
    chrome.permissions.onRemoved.emit({ origins: ['https://chatgpt.com/*'] });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'search-result' }),
      ),
    );
    const reply = port.postMessage.mock.lastCall?.[0];

    if (reply?.kind !== 'search-result') throw new Error('Expected result');

    expect(reply.outcome.results).toEqual([]);
    expect(reply.outcome.outcomes[0]?.status).toBe('scope-changed');
    pending.resolve([{ ...probe, result: readResult(searchBody()) }]);
    await Promise.resolve();
    port.onDisconnect.emit();
  });
  it('closes both capabilities when sending a search result fails', async () => {
    const port = connection();
    const scope = await select(port);
    port.postMessage.mockImplementation((message) => {
      if (message.kind === 'search-result') throw new Error('fiction-private-port-error');
    });
    const request = requireValid(SearchRequestSchema, {
      requestId: 'fiction-send-failure',
      query: { text: 'library', mode: 'keyword', providers: ['chatgpt'], timeZone: 'UTC' },
      scopes: [{ ...scope, generation: 99 }],
    });
    port.onMessage.emit({ operation: 'keyword-search', request });
    await vi.waitFor(() => expect(port.disconnect).toHaveBeenCalledOnce());
    expect(port.onMessage.size()).toBe(0);
    expect(port.onDisconnect.size()).toBe(0);
  });
});
