import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeChatGptReadPort, createChatGptProvider } from '../../src/platform/chatgpt';
import type { SelectedDocumentBinding } from '../../src/platform/broker';
import {
  readChatGptDocument,
  abortChatGptDocumentRead,
} from '../../src/providers/chatgpt/document-read';
import { inspectSelectedDocument } from '../../src/platform/document-probe';
import { SelectedTabSchema } from '../../src/platform/policy';
import { requireValid } from '../../src/contracts/validation';
import { selectedChatGptScope } from '../fixtures/chatgpt/requests';
import { identity, readResult, searchBody } from '../fixtures/chatgpt/wire';
import { brokerHarness, deferred, probe, tab } from './helpers';

const chrome = vi.hoisted(() => {
  function event() {
    const listeners = new Set<(...args: unknown[]) => void>();

    return {
      addListener: (f: (...args: unknown[]) => void) => {
        listeners.add(f);
      },
      removeListener: (f: (...args: unknown[]) => void) => {
        listeners.delete(f);
      },
      emit: (...args: unknown[]) => {
        for (const f of listeners) f(...args);
      },
      size: () => listeners.size,
      clear: () => listeners.clear(),
    };
  }

  return {
    permissions: { contains: vi.fn(), onRemoved: event() },
    scripting: { executeScript: vi.fn() },
    tabs: {
      query: vi.fn(),
      onUpdated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onActivated: event(),
    },
    windows: { onFocusChanged: event() },
  };
});
vi.mock('wxt/browser', () => ({ browser: chrome }));
const events = [
  chrome.permissions.onRemoved,
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onReplaced,
  chrome.tabs.onActivated,
  chrome.windows.onFocusChanged,
];
const context = () => ({ signal: new AbortController().signal });
const operation = { kind: 'search' as const, query: 'prototype' };

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};

function setup() {
  const binding: SelectedDocumentBinding = {
    scope: selectedChatGptScope(),
    tab: requireValid(SelectedTabSchema, tab),
    documentId: probe.documentId,
    isCurrent: vi.fn(() => true),
    ownerWindow: vi.fn(async () => 3),
  };
  const port = new ChromeChatGptReadPort(binding);

  return { binding, port };
}

beforeEach(() => {
  chrome.permissions.contains.mockReset().mockResolvedValue(true);
  chrome.tabs.query.mockReset().mockResolvedValue([tab]);
  chrome.scripting.executeScript
    .mockReset()
    .mockImplementation(async (injection) =>
      injection.func === inspectSelectedDocument
        ? [probe]
        : injection.func === abortChatGptDocumentRead
          ? []
          : [{ frameId: 0, documentId: probe.documentId, result: readResult(searchBody()) }],
    );
  for (const e of events) e.clear();
});
afterEach(() => {
  for (const e of events) expect(e.size()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('trusted broker document capabilities', () => {
  it('only binds an existing matching scope and snapshots source metadata', async () => {
    const h = brokerHarness();
    expect(h.broker.bindSelectedDocument(selectedChatGptScope())).toBeNull();
    const reply = await h.connect();
    if (reply.status !== 'selected') throw Error('Expected selection');
    const b = h.broker.bindSelectedDocument(reply.scope);
    if (!b) throw Error('Expected binding');
    expect(b.isCurrent()).toBe(true);
    expect(await b.ownerWindow()).toBe(3);
    expect(b.documentId).toBe(probe.documentId);
    b.scope.generation++;
    b.tab.id = 99;
    expect(h.broker.bindSelectedDocument(reply.scope)?.tab.id).toBe(7);
    expect(
      h.broker.bindSelectedDocument({ ...reply.scope, generation: reply.scope.generation + 1 }),
    ).toBeNull();
    h.broker.invalidate('chatgpt', 'scope-changed');
    expect(b.isCurrent()).toBe(false);
    expect(h.broker.bindSelectedDocument(reply.scope)).toBeNull();
    h.broker.close();
  });
  it('retires capabilities on reconnect and close', async () => {
    const h = brokerHarness();
    const reply = await h.connect();
    if (reply.status !== 'selected') throw Error('Expected selection');
    const b = h.broker.bindSelectedDocument(reply.scope);
    await h.connect('second-selection');
    expect(b?.isCurrent()).toBe(false);
    h.broker.close();
    expect(h.broker.bindSelectedDocument(reply.scope)).toBeNull();
  });
});

describe('concrete Chrome ChatGPT transport', () => {
  it('composes the provider and performs document-pinned isolated reads with all context checks', async () => {
    const { binding, port } = setup();
    expect(createChatGptProvider(binding).provider).toBe('chatgpt');
    expect(await port.read(operation, undefined, context())).toEqual(readResult(searchBody()));
    const injections = chrome.scripting.executeScript.mock.calls.map(([v]) => v);
    expect(injections).toHaveLength(3);

    for (const x of injections) {
      expect(x.target).toEqual({ tabId: 7, documentIds: [probe.documentId] });
      expect(x.world).toBe('ISOLATED');
    }

    const read = injections[1];
    expect(read.func).toBe(readChatGptDocument);
    expect(read.args).toHaveLength(3);
    expect(read.args).not.toContain(undefined);
    expect(read.args[0]).toEqual(operation);
    expect(await port.read(operation, identity, context())).toMatchObject({ status: 'success' });
    expect(
      chrome.scripting.executeScript.mock.calls.findLast(
        ([x]) => x.func === readChatGptDocument,
      )?.[0].args[3],
    ).toBe(identity);
  });
  it('rejects arbitrary URL/header/operation fields before browser work', async () => {
    const { port } = setup();
    expect(
      await port.read(
        { ...operation, url: 'https://evil.invalid' } as typeof operation,
        undefined,
        context(),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('honors an already cancelled read without allocating Chrome work', async () => {
    const { port } = setup();
    const c = new AbortController();
    c.abort();
    expect(await port.read(operation, undefined, { signal: c.signal })).toEqual({
      status: 'cancelled',
    });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
  it.each(['retired', 'wrong-provider', 'verified-scope', 'window', 'permission', 'query-error'])(
    'fails closed for %s',
    async (kind) => {
      const { port, binding } = setup();
      if (kind === 'retired') vi.mocked(binding.isCurrent).mockReturnValue(false);
      if (kind === 'wrong-provider') binding.scope.provider = 'google-ai-mode';
      if (kind === 'verified-scope')
        Object.assign(binding, {
          scope: {
            kind: 'verified',
            provider: 'chatgpt',
            generation: 3,
            accountPartition: 'fiction',
            workspacePartition: null,
          },
        });
      if (kind === 'window') vi.mocked(binding.ownerWindow).mockResolvedValue(null);
      if (kind === 'permission') chrome.permissions.contains.mockResolvedValue(false);
      if (kind === 'query-error') chrome.tabs.query.mockRejectedValue(Error('PRIVATE ERROR'));
      expect(await port.read(operation, undefined, context())).toEqual({
        status:
          kind === 'window'
            ? 'interrupted'
            : kind === 'permission'
              ? 'permission-needed'
              : kind === 'query-error'
                ? 'unavailable'
                : 'scope-changed',
      });
    },
  );
  it.each(
    [
      [],
      [tab, tab],
      [{ ...tab, id: 8 }],
      [{ ...tab, windowId: 4 }],
      [{ ...tab, incognito: true }],
      [{ ...tab, active: false }],
      [{ ...tab, status: 'loading' }],
      [{ ...tab, pendingUrl: tab.url }],
      [{ ...tab, url: 'https://chatgpt.com/c/other' }],
    ].map((tabs) => ({ tabs })),
  )('rejects changed selected tab metadata %j', async ({ tabs }) => {
    const { port } = setup();
    chrome.tabs.query.mockResolvedValue(tabs);
    expect(await port.read(operation, undefined, context())).toEqual({ status: 'scope-changed' });
  });
  it.each(['empty', 'frame', 'document', 'probe', 'retired-after-probe'])(
    'rejects a changed source probe %s',
    async (kind) => {
      const { port, binding } = setup();
      chrome.scripting.executeScript.mockImplementation(async () => {
        if (kind === 'retired-after-probe') vi.mocked(binding.isCurrent).mockReturnValue(false);

        return kind === 'empty'
          ? []
          : [
              {
                ...probe,
                ...(kind === 'frame' ? { frameId: 1 } : {}),
                ...(kind === 'document' ? { documentId: 'other' } : {}),
                ...(kind === 'probe'
                  ? { result: { origin: 'https://evil.invalid', topLevel: true } }
                  : {}),
              },
            ];
      });
      expect(await port.read(operation, undefined, context())).toEqual({ status: 'scope-changed' });
    },
  );
  it.each(['empty', 'frame', 'document', 'schema'])('rejects read reply %s', async (kind) => {
    const { port } = setup();
    chrome.scripting.executeScript.mockImplementation(async (i) =>
      i.func === inspectSelectedDocument
        ? [probe]
        : kind === 'empty'
          ? []
          : [
              {
                frameId: kind === 'frame' ? 1 : 0,
                documentId: kind === 'document' ? 'other' : probe.documentId,
                result: kind === 'schema' ? {} : readResult(),
              },
            ],
    );
    expect(await port.read(operation, undefined, context())).toEqual({
      status: kind === 'schema' ? 'schema-changed' : 'scope-changed',
    });
  });
  it('rechecks source permission/window/document after a successful response', async () => {
    const { port } = setup();
    chrome.permissions.contains.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await port.read(operation, undefined, context())).toEqual({
      status: 'permission-needed',
    });
  });
  it.each([
    'cancel',
    'timeout',
    'updated',
    'removed',
    'replaced',
    'activated',
    'focus',
    'permission',
  ])('interrupts hung injection on %s and discards its late reply', async (kind) => {
    vi.useFakeTimers();
    const { port } = setup();
    const held = deferred<unknown>();
    chrome.scripting.executeScript.mockImplementation(async (i) =>
      i.func === inspectSelectedDocument
        ? [probe]
        : i.func === abortChatGptDocumentRead
          ? []
          : held.promise,
    );
    const c = new AbortController();
    const pending = port.read(operation, undefined, { signal: c.signal });
    await flush();
    if (kind === 'cancel') c.abort();
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(9500);
    if (kind === 'updated') chrome.tabs.onUpdated.emit(7, { status: 'loading' });
    if (kind === 'removed') chrome.tabs.onRemoved.emit(7);
    if (kind === 'replaced') chrome.tabs.onReplaced.emit(99, 7);
    if (kind === 'activated') chrome.tabs.onActivated.emit();
    if (kind === 'focus') chrome.windows.onFocusChanged.emit();
    if (kind === 'permission')
      chrome.permissions.onRemoved.emit({ origins: ['https://chatgpt.com/*'] });
    expect(await pending).toEqual({
      status:
        kind === 'cancel'
          ? 'cancelled'
          : kind === 'timeout'
            ? 'timeout'
            : kind === 'permission'
              ? 'permission-needed'
              : 'scope-changed',
    });
    expect(
      chrome.scripting.executeScript.mock.calls.some(([i]) => i.func === abortChatGptDocumentRead),
    ).toBe(true);
    held.resolve([{ frameId: 0, documentId: probe.documentId, result: readResult() }]);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not interrupt on unrelated permission or tab metadata events', async () => {
    const { port } = setup();
    const held = deferred<unknown>();
    chrome.scripting.executeScript.mockImplementation(async (i) =>
      i.func === inspectSelectedDocument ? [probe] : held.promise,
    );
    const pending = port.read(operation, undefined, context());
    await flush();
    chrome.permissions.onRemoved.emit({ origins: ['https://www.google.com/*'] });
    chrome.permissions.onRemoved.emit({});
    chrome.tabs.onUpdated.emit(99, { status: 'loading' });
    chrome.tabs.onUpdated.emit(7, { title: 'ignored' });
    held.resolve([{ frameId: 0, documentId: probe.documentId, result: readResult() }]);
    expect(await pending).toMatchObject({ status: 'success' });
  });
  it('treats shared scripting revocation as permission loss', async () => {
    const { port } = setup();
    const held = deferred<unknown>();
    chrome.scripting.executeScript.mockImplementation(async (i) =>
      i.func === inspectSelectedDocument
        ? [probe]
        : i.func === abortChatGptDocumentRead
          ? []
          : held.promise,
    );
    const pending = port.read(operation, undefined, context());
    await flush();
    chrome.permissions.onRemoved.emit({ permissions: ['scripting'] });
    expect(await pending).toEqual({ status: 'permission-needed' });
    held.resolve([]);
    await flush();
  });
  it('consumes abort injection errors without logging or leaking details', async () => {
    const { port } = setup();
    const held = deferred<unknown>();
    chrome.scripting.executeScript.mockImplementation(async (i) => {
      if (i.func === inspectSelectedDocument) return [probe];
      if (i.func === abortChatGptDocumentRead) throw Error('PRIVATE');

      return held.promise;
    });
    const c = new AbortController();
    const pending = port.read(operation, undefined, { signal: c.signal });
    await flush();
    c.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    held.resolve([]);
    await flush();
  });
});
