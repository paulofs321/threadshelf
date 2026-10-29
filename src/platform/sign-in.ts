import { browser } from 'wxt/browser';
import type { ProviderId } from '../contracts';
import { permittedUrl } from './policy';

// Public provider entry points. Neither destinations nor return URLs come from messages/pages.
export const signInUrls: Readonly<Record<ProviderId, string>> = Object.freeze({
  chatgpt: 'https://chatgpt.com/auth/login',
  'google-ai-mode':
    'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fudm%3D50',
});

export function supportedReturn(provider: ProviderId, value: string): boolean {
  if (!permittedUrl(provider, value)) return false;

  const url = new URL(value);

  return provider === 'chatgpt'
    ? !/^\/(?:auth|api)(?:\/|$)/.test(url.pathname)
    : url.pathname === '/search' &&
        url.searchParams.get('udm') === '50' &&
        !url.searchParams.has('authuser');
}

/** Event-driven, ephemeral intent only. Never inspect, inject into or read a login document. */
export class SignInTabs {
  private readonly pending = new Set<ProviderId>();

  async wait(provider: ProviderId, windowId: number, signal: AbortSignal): Promise<number | null> {
    if (signal.aborted || this.pending.has(provider)) return null;

    this.pending.add(provider);

    try {
      return await new Promise<number | null>((resolve) => {
        let tabId: number | undefined;
        let settled = false;
        let checking = false;
        let dirty = false;

        const finish = (value: number | null) => {
          if (settled) return;

          settled = true;
          signal.removeEventListener('abort', cancel);
          browser.tabs.onUpdated.removeListener(updated);
          browser.tabs.onRemoved.removeListener(removed);
          browser.tabs.onReplaced.removeListener(replaced);
          resolve(value);
        };

        const cancel = () => finish(null);

        const check = async () => {
          if (settled || tabId === undefined) return;

          if (checking) {
            dirty = true;

            return;
          }

          checking = true;
          dirty = false;

          try {
            const tab = await browser.tabs.get(tabId);

            if (settled) return;

            if (tab.windowId !== windowId || tab.incognito) return finish(null);

            // Without login-host access, URL is normally absent there. Absence is never a return.
            if (
              tab.status === 'complete' &&
              !tab.pendingUrl &&
              tab.url &&
              supportedReturn(provider, tab.url)
            )
              finish(tabId);
          } catch {
            finish(null);
          } finally {
            checking = false;

            if (dirty) void check();
          }
        };

        const updated = (id: number) => {
          if (id === tabId) void check();
        };

        const removed = (id: number) => {
          if (id === tabId) finish(null);
        };

        const replaced = (_added: number, removedId: number) => removed(removedId);
        signal.addEventListener('abort', cancel, { once: true });
        browser.tabs.onUpdated.addListener(updated);
        browser.tabs.onRemoved.addListener(removed);
        browser.tabs.onReplaced.addListener(replaced);

        void (async () => {
          try {
            const tab = await browser.tabs.create({
              windowId,
              active: true,
              url: signInUrls[provider],
            });

            // All sign-in pages are foreground/user-owned once opened. Even a late creation is
            // preserved on cancellation; never close a page containing user-entered credentials.
            if (settled) return;

            if (tab.id === undefined) return finish(null);

            tabId = tab.id;
            void check();
          } catch {
            finish(null);
          }
        })();
      });
    } finally {
      this.pending.delete(provider);
    }
  }
}
