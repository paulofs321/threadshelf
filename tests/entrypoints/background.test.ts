import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chrome = vi.hoisted(() => ({
  sidePanel: { setPanelBehavior: vi.fn() },
  runtime: { onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } },
}));
const register = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({ browser: chrome }));
vi.mock('../../src/platform/chrome-access', () => ({ registerChromeAccess: register }));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  chrome.sidePanel.setPanelBehavior.mockResolvedValue(undefined);
  vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('background composition (mocked Chrome)', () => {
  it('registers access and enables toolbar opening on initialization, installation and startup', async () => {
    const definition = (await import('../../src/entrypoints/background')).default;
    definition.main?.();
    expect(register).toHaveBeenCalledOnce();
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
    const installed: () => void = chrome.runtime.onInstalled.addListener.mock.calls[0]?.[0];
    const startup: () => void = chrome.runtime.onStartup.addListener.mock.calls[0]?.[0];
    installed();
    startup();
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledTimes(3);
  });
  it('contains toolbar API rejection without logging private exception text or preventing broker startup', async () => {
    chrome.sidePanel.setPanelBehavior.mockRejectedValue(
      new Error('fiction-private-browser-detail'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const definition = (await import('../../src/entrypoints/background')).default;
      expect(() => definition.main?.()).not.toThrow();
      await Promise.resolve();
      expect(register).toHaveBeenCalledOnce();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
