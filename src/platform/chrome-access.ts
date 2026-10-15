import { browser } from 'wxt/browser';
import { AccessBroker } from './broker';
import type { SelectedTabAccessPort } from './broker';
import { inspectSelectedDocument } from './document-probe';
import { validate } from '../contracts/validation';
import {
  panelWindowId,
  PanelWindowSchema,
  providerOrigins,
  providerPermission,
  validatePanelContext,
  validatePanelSender,
} from './policy';

export function registerChromeAccess(): void {
  const brokers = new Set<AccessBroker>();
  browser.runtime.onConnect.addListener((connection) => {
    const documentId = validatePanelSender(connection.sender, browser.runtime.id);
    const windowId = panelWindowId(connection.name);

    if (windowId === null || !documentId || brokers.size >= 4) {
      connection.disconnect();

      return;
    }

    const access: SelectedTabAccessPort = {
      async ownerWindow() {
        const window = validate(
          PanelWindowSchema,
          await browser.windows.get(windowId, { populate: false }).catch(() => null),
        );

        if (!window.ok || window.value.id !== windowId) return null;

        const contexts = await browser.runtime.getContexts({
          contextTypes: ['SIDE_PANEL'],
          documentIds: [documentId],
        });

        if (contexts.length !== 1) return null;

        return validatePanelContext(contexts[0], documentId, browser.runtime.id, windowId)
          ? windowId
          : null;
      },
      hasPermission: (provider) => browser.permissions.contains(providerPermission(provider)),
      async selectedTab(windowId) {
        const tabs = await browser.tabs.query({ active: true, windowId });
        const tab = tabs.length === 1 ? tabs[0] : undefined;

        if (!tab || tab.pendingUrl !== undefined) return null;

        // Exclude titles, favicons and unrelated browser properties at the boundary.
        return {
          id: tab.id,
          windowId: tab.windowId,
          active: tab.active,
          incognito: tab.incognito,
          status: tab.status,
          url: tab.url,
        };
      },
      async inspectDocument(provider, target, signal) {
        if (signal.aborted) return null;

        const results = await browser.scripting.executeScript({
          target:
            target.documentId === undefined
              ? { tabId: target.tabId, frameIds: [0] }
              : { tabId: target.tabId, documentIds: [target.documentId] },
          world: 'ISOLATED',
          func: inspectSelectedDocument,
          args: [providerOrigins[provider]],
        });

        return signal.aborted || results.length !== 1 ? null : results[0];
      },
    };
    const broker = new AccessBroker(
      access,
      (message) => {
        try {
          connection.postMessage(message);
        } catch {
          broker.close();
        }
      },
      () => {
        brokers.delete(broker);
        connection.onMessage.removeListener(receive);
        connection.onDisconnect.removeListener(disconnect);
        browser.windows.onRemoved.removeListener(windowRemoved);
        connection.disconnect();
      },
      () => crypto.randomUUID(),
    );
    const receive = (message: unknown) => broker.receive(message);

    const disconnect = () => {
      // Consume Chrome's error without logging any browser/provider details.
      void browser.runtime.lastError;
      broker.close();
    };

    const windowRemoved = (removedId: number) => {
      if (removedId === windowId) broker.close();
    };

    brokers.add(broker);
    connection.onMessage.addListener(receive);
    connection.onDisconnect.addListener(disconnect);
    browser.windows.onRemoved.addListener(windowRemoved);
  });

  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading' || change.url !== undefined) {
      for (const broker of brokers) broker.tabChanged(tabId);
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const broker of brokers) broker.tabChanged(tabId);
  });
  browser.tabs.onReplaced.addListener((_added, removed) => {
    for (const broker of brokers) broker.tabChanged(removed);
  });
  browser.tabs.onActivated.addListener(() => {
    for (const broker of brokers) broker.invalidateAll('scope-changed');
  });
  browser.windows.onFocusChanged.addListener(() => {
    for (const broker of brokers) broker.invalidateAll('scope-changed');
  });
  browser.permissions.onRemoved.addListener((removed) => {
    for (const broker of brokers) {
      for (const provider of ['chatgpt', 'google-ai-mode'] as const) {
        if (
          removed.permissions?.includes('scripting') ||
          removed.origins?.includes(`${providerOrigins[provider]}/*`)
        ) {
          broker.invalidate(provider, 'permission-needed');
        }
      }
    }
  });
}
