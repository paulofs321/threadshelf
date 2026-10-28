import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInTabs, signInUrls, supportedReturn } from '../../src/platform/sign-in';
import { deferred, event } from './helpers';

const chrome = vi.hoisted(() => ({
  tabs: {
    create: vi.fn(),
    get: vi.fn(),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    onReplaced: { addListener: vi.fn(), removeListener: vi.fn() },
  },
}));
vi.mock('wxt/browser', () => ({ browser: chrome }));
const updated = event<[number]>();
const removed = event<[number]>();
const replaced = event<[number, number]>();

const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

beforeEach(() => {
  vi.resetAllMocks();
  chrome.tabs.onUpdated = updated;
  chrome.tabs.onRemoved = removed;
  chrome.tabs.onReplaced = replaced;
  chrome.tabs.create.mockResolvedValue({ id: 17 });
  chrome.tabs.get.mockResolvedValue({ id: 17, windowId: 3, incognito: false, status: 'complete' });
});
afterEach(() => {
  expect(updated.size()).toBe(0);
  expect(removed.size()).toBe(0);
  expect(replaced.size()).toBe(0);
});

describe('fixed sign-in and return boundary', () => {
  it.each([
    ['chatgpt', 'https://chatgpt.com/', true],
    ['chatgpt', 'https://chatgpt.com/c/fiction', true],
    ['chatgpt', 'https://chatgpt.com/auth/login', false],
    ['chatgpt', 'https://chatgpt.com/api/auth/callback', false],
    ['chatgpt', 'https://auth.openai.com/', false],
    ['chatgpt', 'https://chatgpt.com.evil.invalid/', false],
    ['chatgpt', 'https://x:y@chatgpt.com/', false],
    ['google-ai-mode', 'https://www.google.com/search?udm=50', true],
    ['google-ai-mode', 'https://www.google.com/search?udm=50&authuser=0', false],
    ['google-ai-mode', 'https://www.google.com/search?udm=50&authuser=1', false],
    ['google-ai-mode', 'https://www.google.com/', false],
    ['google-ai-mode', 'https://accounts.google.com/ServiceLogin', false],
    ['google-ai-mode', 'https://gemini.google.com/', false],
    ['google-ai-mode', 'invalid', false],
  ] as const)('validates %s return %s', (provider, url, expected) => {
    expect(supportedReturn(provider, url)).toBe(expected);
  });

  it.each(['chatgpt', 'google-ai-mode'] as const)(
    'opens one foreground %s login page, waits for supported return without scripting and keeps user tabs',
    async (provider) => {
      const manager = new SignInTabs();
      const controller = new AbortController();
      const result = manager.wait(provider, 3, controller.signal);
      await flush();
      expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        windowId: 3,
        active: true,
        url: signInUrls[provider],
      });
      expect(await manager.wait(provider, 3, new AbortController().signal)).toBeNull();
      updated.emit(99);
      expect(chrome.tabs.get).toHaveBeenCalledOnce();
      chrome.tabs.get.mockResolvedValue({
        windowId: 3,
        status: 'complete',
        incognito: false,
        url:
          provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://www.google.com/search?udm=50',
      });
      updated.emit(17);
      expect(await result).toBe(17);
      expect(chrome.tabs.create).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'abort',
    'removed',
    'replaced',
    'wrong-window',
    'incognito',
    'get-rejected',
    'create-rejected',
    'create-threw',
    'missing-id',
  ] as const)(
    'settles %s and cleans listeners without closing user sign-in pages',
    async (kind) => {
      const manager = new SignInTabs();
      const controller = new AbortController();

      if (kind === 'create-rejected')
        chrome.tabs.create.mockRejectedValue(new Error('fiction-private'));

      if (kind === 'create-threw')
        chrome.tabs.create.mockImplementation(() => {
          throw new Error('fiction-private');
        });

      if (kind === 'missing-id') chrome.tabs.create.mockResolvedValue({});

      const result = manager.wait('chatgpt', 3, controller.signal);
      await flush();

      if (kind === 'abort') controller.abort();

      if (kind === 'removed') {
        removed.emit(98);
        removed.emit(17);
      }

      if (kind === 'replaced') replaced.emit(18, 17);

      if (kind === 'wrong-window' || kind === 'incognito') {
        chrome.tabs.get.mockResolvedValue({
          windowId: kind === 'wrong-window' ? 4 : 3,
          incognito: kind === 'incognito',
        });
        updated.emit(17);
      }

      if (kind === 'get-rejected') {
        chrome.tabs.get.mockRejectedValue(new Error('fiction-private'));
        updated.emit(17);
      }

      expect(await result).toBeNull();
    },
  );

  it('keeps independent provider attempts, preserves a late foreground creation after cancellation, and skips pre-aborted attempts', async () => {
    const manager = new SignInTabs();
    const a = new AbortController();
    const b = new AbortController();
    const creation = deferred<{ id: number }>();
    chrome.tabs.create.mockReturnValueOnce(creation.promise);
    const first = manager.wait('chatgpt', 3, a.signal);
    const second = manager.wait('google-ai-mode', 3, b.signal);
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    a.abort();
    await first;
    creation.resolve({ id: 19 });
    await flush();
    b.abort();
    await second;
    expect(await manager.wait('chatgpt', 3, a.signal)).toBeNull();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('coalesces updates during a slow tab lookup and rechecks the latest document', async () => {
    const manager = new SignInTabs();
    const controller = new AbortController();
    const lookup = deferred<unknown>();
    chrome.tabs.get.mockReturnValueOnce(lookup.promise);
    const result = manager.wait('chatgpt', 3, controller.signal);
    await flush();
    updated.emit(17);
    updated.emit(17);
    chrome.tabs.get.mockResolvedValue({
      windowId: 3,
      incognito: false,
      status: 'complete',
      url: 'https://chatgpt.com/',
    });
    lookup.resolve({ windowId: 3, status: 'loading', pendingUrl: 'https://chatgpt.com/' });
    expect(await result).toBe(17);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
  });

  it('ignores lookup completion after cancellation and never treats unrelated navigation as authentication', async () => {
    const manager = new SignInTabs();
    const controller = new AbortController();
    const lookup = deferred<unknown>();
    chrome.tabs.get.mockReturnValueOnce(lookup.promise);
    const result = manager.wait('chatgpt', 3, controller.signal);
    await flush();
    controller.abort();
    lookup.resolve({ windowId: 3, status: 'complete', url: 'https://chatgpt.com/' });
    await flush();
    expect(await result).toBeNull();
    const next = new AbortController();
    chrome.tabs.get.mockResolvedValue({
      windowId: 3,
      status: 'complete',
      url: 'https://evil.invalid/',
    });
    const waiting = manager.wait('chatgpt', 3, next.signal);
    await flush();
    next.abort();
    expect(await waiting).toBeNull();
  });
});
