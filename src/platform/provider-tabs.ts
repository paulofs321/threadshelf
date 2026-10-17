import { browser } from 'wxt/browser';
import type { ProviderId } from '../contracts';
import { permittedUrl, providerOrigins, SelectedTabSchema } from './policy';
import { validate } from '../contracts';

const landingUrls: Record<ProviderId, string> = {
  chatgpt: 'https://chatgpt.com/',
  'google-ai-mode': 'https://www.google.com/search?udm=50',
};

function supportedProviderUrl(provider: ProviderId, value: string): boolean {
  if (!permittedUrl(provider, value)) return false;

  if (provider !== 'google-ai-mode') return true;

  const url = new URL(value);

  return (
    url.pathname === '/search' &&
    url.searchParams.get('udm') === '50' &&
    !url.searchParams.has('authuser')
  );
}

/** Panel-owned provider documents. No URL/tab selector comes from a runtime message. */
export class ProviderTabs {
  private readonly owned = new Map<ProviderId, number>();
  private readonly selected = new Map<ProviderId, number>();
  private readonly releasing = new Map<ProviderId, Promise<void>>();
  private closed = false;

  async select(
    windowId: number,
    provider: ProviderId,
    signal: AbortSignal,
    pinnedId?: number,
  ): Promise<unknown> {
    if (this.closed || signal.aborted) return null;

    // A released owned page may still exist until Chrome completes its removal. Do not rebind it.
    await this.releasing.get(provider);

    if (this.closed || signal.aborted) return null;

    const tabs = await browser.tabs.query({ windowId, url: `${providerOrigins[provider]}/*` });

    if (this.closed || signal.aborted) return null;

    const pinned = pinnedId ?? this.selected.get(provider);
    const matching = tabs.filter(
      (tab) =>
        tab.windowId === windowId &&
        !tab.incognito &&
        tab.url &&
        supportedProviderUrl(provider, tab.url),
    );
    const active = matching.filter((tab) => tab.active);
    const candidates =
      pinned !== undefined
        ? matching.filter((tab) => tab.id === pinned)
        : matching.length === 1
          ? matching
          : active;
    let tab = candidates.length === 1 ? candidates[0] : undefined;

    // Never silently substitute another document/account when an established binding disappears.
    if (pinned !== undefined && !tab) return null;

    if (!tab) {
      // A fresh landing document resolves ambiguous inactive pages without choosing an account tab.
      // This applies only to initial selection; a missing pinned source must still fail above.
      tab = await browser.tabs.create({ windowId, active: false, url: landingUrls[provider] });

      if (tab.id === undefined) return null;

      this.owned.set(provider, tab.id);

      if (this.closed || signal.aborted) {
        await this.release(provider);

        return null;
      }
    }

    const id = tab.id;

    if (id === undefined) return null;

    // The broker's deadline/cancellation bounds loading. Owned pages stay passive.
    while (tab.status === 'loading') {
      await new Promise<void>((resolve) => {
        const abort = () => {
          clearTimeout(timer);
          resolve();
        };

        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 100);
        signal.addEventListener('abort', abort, { once: true });
      });

      if (this.closed || signal.aborted) return null;

      tab = await browser.tabs.get(id);
    }

    if (this.closed || signal.aborted || tab.pendingUrl !== undefined) return null;

    const normalized = {
      id: tab.id,
      windowId: tab.windowId,
      active: tab.active,
      incognito: tab.incognito,
      status: tab.status,
      url: tab.url,
    };
    const parsed = validate(SelectedTabSchema, normalized);

    if (
      !parsed.ok ||
      parsed.value.windowId !== windowId ||
      !supportedProviderUrl(provider, parsed.value.url)
    )
      return null;

    this.selected.set(provider, id);

    return parsed.value;
  }

  async release(provider: ProviderId): Promise<void> {
    this.selected.delete(provider);
    const pending = this.releasing.get(provider);

    if (pending) return pending;

    const id = this.owned.get(provider);
    this.owned.delete(provider);

    if (id === undefined) return;

    const cleanup = (async () => {
      try {
        const tab = await browser.tabs.get(id);

        // Preserve pages the user activated/navigated; never close an existing user tab.
        if (!tab.active && tab.url === landingUrls[provider] && tab.pendingUrl === undefined)
          await browser.tabs.remove(id);
      } catch {
        // The tab may already have closed or lost host access. No browser details enter logs.
      }
    })().finally(() => this.releasing.delete(provider));
    this.releasing.set(provider, cleanup);

    return cleanup;
  }

  close(): void {
    this.closed = true;

    for (const provider of ['chatgpt', 'google-ai-mode'] as const) void this.release(provider);
  }
}
