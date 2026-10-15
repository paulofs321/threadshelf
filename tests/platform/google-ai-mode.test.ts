import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeGoogleAiModeReadPort,
  createGoogleAiModeProvider,
} from '../../src/platform/google-ai-mode';
import type { SelectedDocumentBinding } from '../../src/platform/broker';
import { CandidateSchema, requireValid } from '../../src/contracts';
import {
  readGoogleDocument,
  abortGoogleDocumentRead,
} from '../../src/providers/google-ai-mode/document-read';
import { inspectSelectedDocument } from '../../src/platform/document-probe';
import {
  googleAiModeRequest,
  verifiedGoogleAiModeScope,
} from '../fixtures/google-ai-mode/requests';
import { googleJson, googleMatch } from '../fixtures/google-ai-mode/wire';
import { deferred } from './helpers';

interface ScriptOptions {
  target: { tabId: number };
  func: unknown;
  args: [{ operation: { kind: string } }];
}
const chrome = vi.hoisted(() => {
  function event() {
    const callbacks = new Set<(...args: unknown[]) => void>();

    return {
      addListener: vi.fn((f: (...args: unknown[]) => void) => callbacks.add(f)),
      removeListener: vi.fn((f: (...args: unknown[]) => void) => callbacks.delete(f)),
      emit: (...args: unknown[]) => {
        for (const f of callbacks) f(...args);
      },
      size: () => callbacks.size,
    };
  }

  return {
    permissions: { contains: vi.fn(), onRemoved: event() },
    scripting: { executeScript: vi.fn<(options: ScriptOptions) => Promise<unknown[]>>() },
    tabs: {
      query: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      onUpdated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onActivated: event(),
    },
    windows: { onFocusChanged: event() },
  };
});
vi.mock('wxt/browser', () => ({ browser: chrome }));
const identity = 'a'.repeat(64);
const success = { status: 'success', identityBefore: identity, identityAfter: identity };
const request = googleAiModeRequest();
const tab = {
  id: 7,
  windowId: 3,
  active: true as const,
  incognito: false as const,
  status: 'complete' as const,
  url: 'https://www.google.com/search?udm=50',
};
const candidate = () =>
  requireValid(CandidateSchema, {
    id: 'fiction-candidate',
    scope: request.scope,
    conversationId: 'fictional-thread-1',
    originalUrl:
      'https://www.google.com/search?mtid=fictional-thread-1&csuir=1&mstk=synthetic_state_fictional-thread-1&udm=50',
    evidence: [],
  });
const context = () => ({ signal: new AbortController().signal });
let binding: SelectedDocumentBinding;
let port: ChromeGoogleAiModeReadPort;
const events = [
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onReplaced,
  chrome.tabs.onActivated,
  chrome.windows.onFocusChanged,
  chrome.permissions.onRemoved,
];

async function script(options: ScriptOptions): Promise<unknown[]> {
  const documentId = options.target.tabId === 7 ? 'fiction-source' : 'fiction-evidence';

  if (options.func === abortGoogleDocumentRead) return [];

  if (options.func === inspectSelectedDocument)
    return [
      { frameId: 0, documentId, result: { origin: 'https://www.google.com', topLevel: true } },
    ];

  const operation = options.args[0].operation;

  return [
    {
      frameId: 0,
      documentId,
      result:
        operation.kind === 'inspect'
          ? success
          : operation.kind === 'messages'
            ? { ...success, rendered: ['An exact fictional rendered turn.'] }
            : {
                ...success,
                response: {
                  status: 200,
                  contentType: 'application/json',
                  retryAfter: null,
                  body: googleJson([[googleMatch()]]),
                },
              },
    },
  ];
}

beforeEach(() => {
  vi.resetAllMocks();
  binding = {
    scope: request.scope,
    tab: { ...tab },
    documentId: 'fiction-source',
    isCurrent: vi.fn(() => true),
    ownerWindow: vi.fn(async () => 3),
  };
  port = new ChromeGoogleAiModeReadPort(binding);
  chrome.permissions.contains.mockResolvedValue(true);
  chrome.tabs.query.mockResolvedValue([{ ...tab }]);
  chrome.tabs.create.mockResolvedValue({ id: 8 });
  chrome.tabs.get.mockResolvedValue({
    id: 8,
    windowId: 3,
    status: 'complete',
    incognito: false,
    url: candidate().originalUrl,
  });
  chrome.tabs.remove.mockResolvedValue(undefined);
  chrome.scripting.executeScript.mockImplementation(script);
});
afterEach(() => {
  for (const e of events) expect(e.size()).toBe(0);

  vi.useRealTimers();
});
const read = () => port.read({ kind: 'search', query: 'authentication' }, identity, context());
describe('Chrome Google selected-document transport', () => {
  it('composes the real adapter, pins Chrome document/frame metadata, and normalizes the response', async () => {
    const provider = createGoogleAiModeProvider(binding);
    const result = await provider.search(request, context());
    expect(result.status).toBe('success');
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['fiction-source'] },
        world: 'ISOLATED',
        func: readGoogleDocument,
        args: [
          expect.objectContaining({
            partition: request.scope.kind === 'ephemeral' ? request.scope.partition : '',
          }),
        ],
      }),
    );
  });
  it('reopens only a scoped validated candidate, checks identities, and closes its own passive tab', async () => {
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      ...success,
      rendered: ['An exact fictional rendered turn.'],
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      windowId: 3,
      active: false,
      url: candidate().originalUrl,
    });
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(8);
    const reads = chrome.scripting.executeScript.mock.calls
      .filter(([o]) => o.func === readGoogleDocument)
      .map(([o]) => o.args[0].operation.kind);
    expect(reads).toEqual(['inspect', 'messages', 'inspect']);
  });
  it.each([
    { kind: 'messages', conversationId: 'fictional-thread-1' },
    { kind: 'search', query: '' },
    { kind: 'list', url: 'https://evil.invalid' },
  ])('rejects a generic message read or extra arguments: %j', async (operation) => {
    expect(await port.read(operation as never, identity, context())).toEqual({
      status: 'unavailable',
    });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...candidate(), scope: { ...request.scope, generation: 99 } },
    { ...candidate(), originalUrl: undefined },
    { ...candidate(), originalUrl: 'https://evil.invalid/' },
  ])('rejects unscoped or unsafe evidence input', async (c) => {
    expect(await port.openEvidence(c as never, identity, context())).toEqual({
      status: 'unavailable',
    });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('accepts initial identity establishment without an expected identity', async () => {
    expect((await port.read({ kind: 'inspect' }, undefined, context())).status).toBe('success');
  });
  it('returns permission-needed without reading data', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    expect(await read()).toEqual({ status: 'permission-needed' });
  });
  it('refuses a closed, replaced, wrong-provider or non-ephemeral binding', async () => {
    for (const scope of [{ ...request.scope, provider: 'chatgpt' }, verifiedGoogleAiModeScope()]) {
      Object.assign(binding, { scope });
      expect(await read()).toEqual({ status: 'scope-changed' });
    }

    Object.assign(binding, { scope: request.scope });
    vi.mocked(binding.isCurrent).mockReturnValue(false);
    expect(await read()).toEqual({ status: 'scope-changed' });
  });
  it('returns interrupted when its validated panel window is gone', async () => {
    vi.mocked(binding.ownerWindow).mockResolvedValue(null);
    expect(await read()).toEqual({ status: 'interrupted' });
  });
  it.each(
    [
      [],
      [{ ...tab, id: 9 }],
      [{ ...tab, windowId: 4 }],
      [{ ...tab, incognito: true }],
      [{ ...tab, active: false }],
      [{ ...tab, status: 'loading' }],
      [{ ...tab, pendingUrl: tab.url }],
      [{ ...tab, url: tab.url + '&q=changed' }],
      [tab, tab],
    ].map((tabs) => ({ tabs })),
  )('rejects changed source metadata', async ({ tabs }) => {
    chrome.tabs.query.mockResolvedValue(tabs);
    expect(await read()).toEqual({ status: 'scope-changed' });
  });
  it('rejects missing, foreign or duplicate Chrome source probe results', async () => {
    for (const results of [
      [],
      [
        {
          frameId: 0,
          documentId: 'foreign',
          result: { origin: 'https://www.google.com', topLevel: true },
        },
      ],
      [{}, {}],
    ]) {
      chrome.scripting.executeScript.mockResolvedValue(results);
      expect(await read()).toEqual({ status: 'scope-changed' });
    }
  });
  it('discards a binding invalidated during the source probe', async () => {
    chrome.scripting.executeScript.mockImplementation(async () => {
      vi.mocked(binding.isCurrent).mockReturnValue(false);

      return [
        {
          frameId: 0,
          documentId: 'fiction-source',
          result: { origin: 'https://www.google.com', topLevel: true },
        },
      ];
    });
    expect(await read()).toEqual({ status: 'scope-changed' });
  });
  it.each(
    [
      [],
      [{ frameId: 1, documentId: 'fiction-source', result: success }],
      [{ frameId: 0, documentId: 'other', result: success }],
      [{ frameId: 0, documentId: 'fiction-source', result: { status: 'surprise' } }],
    ].map((results) => ({ results })),
  )('validates read reply metadata and data', async ({ results }) => {
    const original = script;
    chrome.scripting.executeScript.mockImplementation(async (o) =>
      o.func === readGoogleDocument ? results : original(o),
    );
    expect((await read()).status).toBe(
      results[0]?.result?.status === 'surprise' ? 'schema-changed' : 'scope-changed',
    );
  });
  it('rechecks the source after a successful read', async () => {
    chrome.tabs.query.mockResolvedValueOnce([tab]).mockResolvedValue([]);
    expect(await read()).toEqual({ status: 'scope-changed' });
  });
  it('handles browser exceptions without leaking details', async () => {
    chrome.tabs.query.mockRejectedValue(new Error('fictional private error'));
    expect(await read()).toEqual({ status: 'unavailable' });
  });
  it('never creates an evidence tab after a failed source check', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'permission-needed',
    });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'login-expired' },
    { ...success, identityBefore: 'b'.repeat(64) },
    { ...success, identityAfter: 'b'.repeat(64) },
  ])('checks source identity before opening evidence', async (result) => {
    const original = script;
    chrome.scripting.executeScript.mockImplementation(async (o) =>
      o.func === readGoogleDocument
        ? [{ frameId: 0, documentId: 'fiction-source', result }]
        : original(o),
    );
    expect((await port.openEvidence(candidate(), identity, context())).status).toBe(
      result.status === 'login-expired' ? 'login-expired' : 'scope-changed',
    );
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('handles an uncreated tab', async () => {
    chrome.tabs.create.mockResolvedValue({});
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'unavailable',
    });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it.each([
    { incognito: true },
    { windowId: 99 },
    { url: 'https://evil.invalid/' },
    { pendingUrl: 'https://www.google.com/' },
  ])('closes evidence tabs whose metadata changes: %j', async (patch) => {
    chrome.tabs.get.mockResolvedValue({
      windowId: 3,
      status: 'complete',
      url: candidate().originalUrl,
      ...patch,
    });
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'scope-changed',
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it('closes a tab after a thrown read or failed removal', async () => {
    chrome.tabs.get.mockRejectedValue(new Error('private'));
    chrome.tabs.remove.mockRejectedValue(new Error('already closed'));
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'unavailable',
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it('rejects an evidence document probe with missing metadata', async () => {
    const original = script;
    chrome.scripting.executeScript.mockImplementation(async (o) =>
      o.target.tabId === 8 ? [] : original(o),
    );
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'scope-changed',
    });
  });
  it('discards rendered evidence if the source changes while it loads', async () => {
    chrome.tabs.query.mockResolvedValueOnce([tab]).mockResolvedValue([]);
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'scope-changed',
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it.each([
    { status: 'login-expired' },
    { ...success, identityBefore: 'b'.repeat(64) },
    { ...success, identityAfter: 'b'.repeat(64) },
  ])('rechecks source identity after rendering', async (result) => {
    const original = script;
    let inspect = 0;
    chrome.scripting.executeScript.mockImplementation(async (o) =>
      o.func === readGoogleDocument && o.args[0].operation.kind === 'inspect' && ++inspect === 2
        ? [{ frameId: 0, documentId: 'fiction-source', result }]
        : original(o),
    );
    expect((await port.openEvidence(candidate(), identity, context())).status).toBe(
      result.status === 'login-expired' ? 'login-expired' : 'scope-changed',
    );
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it('rejects a reopened thread that changes URL or document after rendering', async () => {
    chrome.tabs.get
      .mockResolvedValueOnce({ windowId: 3, status: 'complete', url: candidate().originalUrl })
      .mockResolvedValue({ url: 'https://www.google.com/search?udm=50' });
    expect(await port.openEvidence(candidate(), identity, context())).toEqual({
      status: 'scope-changed',
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });

  it('waits for an owned evidence tab to finish loading', async () => {
    vi.useFakeTimers();
    chrome.tabs.get.mockResolvedValueOnce({ windowId: 3, status: 'loading' });
    const pending = port.openEvidence(candidate(), identity, context());
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe('success');
  });
  it('cancels and closes a loading evidence tab', async () => {
    vi.useFakeTimers();
    chrome.tabs.get.mockResolvedValue({ windowId: 3, status: 'loading' });
    const controller = new AbortController();
    const pending = port.openEvidence(candidate(), identity, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it('times out and closes a stuck evidence tab', async () => {
    vi.useFakeTimers();
    chrome.tabs.get.mockResolvedValue({ windowId: 3, status: 'loading' });
    const pending = port.openEvidence(candidate(), identity, context());
    await vi.advanceTimersByTimeAsync(9500);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
  it('does nothing after caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await port.read({ kind: 'inspect' }, identity, { signal: controller.signal })).toEqual({
      status: 'cancelled',
    });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
  it.each(['update', 'remove', 'replace', 'activate', 'focus', 'permission', 'cancel'] as const)(
    'aborts the isolated read and discards a late result after %s',
    async (event) => {
      const data = deferred<unknown[]>();
      const original = script;
      chrome.scripting.executeScript.mockImplementation(async (o) =>
        o.func === readGoogleDocument ? data.promise : original(o),
      );
      const controller = new AbortController();
      const pending = port.read({ kind: 'list' }, identity, { signal: controller.signal });
      await vi.waitFor(() =>
        expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
          expect.objectContaining({ func: readGoogleDocument }),
        ),
      );

      if (event === 'update') chrome.tabs.onUpdated.emit(7, { status: 'loading' });

      if (event === 'remove') chrome.tabs.onRemoved.emit(7, {});

      if (event === 'replace') chrome.tabs.onReplaced.emit(9, 7);

      if (event === 'activate') chrome.tabs.onActivated.emit({});

      if (event === 'focus') chrome.windows.onFocusChanged.emit(3);

      if (event === 'permission')
        chrome.permissions.onRemoved.emit({ origins: ['https://www.google.com/*'] });

      if (event === 'cancel') controller.abort();

      data.resolve([{ frameId: 0, documentId: 'fiction-source', result: success }]);
      expect(await pending).toEqual({
        status:
          event === 'permission'
            ? 'permission-needed'
            : event === 'cancel'
              ? 'cancelled'
              : 'scope-changed',
      });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          func: abortGoogleDocumentRead,
          world: 'ISOLATED',
          target: { tabId: 7, documentIds: ['fiction-source'] },
        }),
      );
    },
  );
  it('ignores unrelated navigation and source title/status updates', async () => {
    chrome.tabs.query.mockImplementation(async () => {
      chrome.tabs.onUpdated.emit(8, { url: 'https://www.google.com/' });
      chrome.tabs.onUpdated.emit(7, { status: 'complete' });

      return [tab];
    });
    expect((await read()).status).toBe('success');
  });
  it('settles promptly when Chrome never answers and consumes an abort-injection rejection', async () => {
    vi.useFakeTimers();
    const data = deferred<unknown[]>();
    chrome.scripting.executeScript.mockImplementation(async (o) => {
      if (o.func === abortGoogleDocumentRead) throw new Error('document gone');

      return o.func === readGoogleDocument ? data.promise : script(o);
    });
    const pending = read();
    await vi.advanceTimersByTimeAsync(9500);
    expect(await pending).toEqual({ status: 'timeout' });
    data.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
  });
  it('closes a tab whose creation finishes after cancellation', async () => {
    const tabCreation = deferred<{ id: number }>();
    chrome.tabs.create.mockReturnValue(tabCreation.promise);
    const controller = new AbortController();
    const pending = port.openEvidence(candidate(), identity, { signal: controller.signal });
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    tabCreation.resolve({ id: 8 });
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledWith(8));
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });
});
