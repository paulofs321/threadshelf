import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPanelWindow } from '../../src/platform/panel-window';
import { clientTimeoutMs } from '../../src/platform/protocol';
import { deferred } from './helpers';

const chrome = vi.hoisted(() => ({ windows: { getCurrent: vi.fn() } }));
vi.mock('wxt/browser', () => ({ browser: chrome }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  chrome.windows.getCurrent.mockResolvedValue({ id: 3, incognito: false });
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('panel-owned browser window lookup (mocked Chrome)', () => {
  it('reads the calling panel window without requesting any tabs', async () => {
    expect(await currentPanelWindow(new AbortController().signal)).toBe(3);
    expect(chrome.windows.getCurrent).toHaveBeenCalledWith({ populate: false });
  });
  it.each([
    { id: -1, incognito: false },
    { id: -2, incognito: false },
    { id: 3, incognito: true },
    { incognito: false },
    { id: 3 },
    null,
  ])('rejects missing/invalid/incognito browser window metadata %j', async (window) => {
    chrome.windows.getCurrent.mockResolvedValue(window);
    expect(await currentPanelWindow(new AbortController().signal)).toBeNull();
  });
  it.each(['reject', 'throw'] as const)('contains a browser API %s', async (failure) => {
    const error = new Error('fiction-private-window-error');

    if (failure === 'reject') chrome.windows.getCurrent.mockRejectedValue(error);
    else
      chrome.windows.getCurrent.mockImplementation(() => {
        throw error;
      });

    expect(await currentPanelWindow(new AbortController().signal)).toBeNull();
  });
  it('does not access Chrome after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await currentPanelWindow(controller.signal)).toBeNull();
    expect(chrome.windows.getCurrent).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'timeout'] as const)(
    'bounds a hanging lookup on %s and ignores late metadata',
    async (stop) => {
      const held = deferred<unknown>();
      chrome.windows.getCurrent.mockReturnValue(held.promise);
      const controller = new AbortController();
      const result = currentPanelWindow(controller.signal);

      if (stop === 'cancel') controller.abort();
      else await vi.advanceTimersByTimeAsync(clientTimeoutMs);

      expect(await result).toBeNull();
      held.resolve({ id: 4, incognito: false });
      await held.promise;
      expect(await result).toBeNull();
    },
  );
});
