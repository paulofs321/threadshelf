import { browser } from 'wxt/browser';
import { AccessBroker } from './broker';
import { PanelSearchBroker } from './search-broker';
import { createChatGptProvider } from './chatgpt';
import { SignInTabs } from './sign-in';
import { createGoogleAiModeProvider } from './google-ai-mode';
import { ProviderTabs } from './provider-tabs';
import { HeartbeatCommandSchema } from './protocol';
import type { SelectedTabAccessPort } from './broker';
import { inspectSelectedDocument } from './document-probe';
import { validate } from '../contracts/validation';
import {
  panelWindowId,
  PanelWindowSchema,
  providerOrigins,
  providerPermission,
  validatePanelContext,
  validatePanelSource,
} from './policy';

export function registerChromeAccess(): void {
  const brokers = new Set<AccessBroker>();
  const signIn = new SignInTabs();
  browser.runtime.onConnect.addListener((connection) => {
    const sender = validatePanelSource(connection.sender, browser.runtime.id);
    let documentId = sender?.documentId;
    const needsLookup = documentId === undefined;
    const windowId = panelWindowId(connection.name);

    if (windowId === null || !sender || brokers.size >= 4) {
      connection.disconnect();

      return;
    }

    const providerTabs = new ProviderTabs();
    const access: SelectedTabAccessPort = {
      async ownerWindow() {
        const window = validate(
          PanelWindowSchema,
          await browser.windows.get(windowId, { populate: false }).catch(() => null),
        );

        if (!window.ok || window.value.id !== windowId) return null;

        const contexts = await browser.runtime.getContexts(
          needsLookup
            ? {
                // Include TAB and other types: a tab at the same URL must make this ambiguous/invalid.
                documentUrls: [sender.url],
              }
            : { contextTypes: ['SIDE_PANEL'], documentIds: [documentId as string] },
        );

        if (contexts.length !== 1) return null;

        const candidateId = documentId ?? contexts[0]?.documentId;

        if (
          !candidateId ||
          !validatePanelContext(contexts[0], candidateId, browser.runtime.id, windowId)
        )
          return null;

        documentId = candidateId;

        return windowId;
      },
      hasPermission: (provider) => browser.permissions.contains(providerPermission(provider)),
      selectedTab: (windowId, provider, signal, pinnedId) =>
        providerTabs.select(windowId, provider, signal, pinnedId),
      release: (provider) => {
        void providerTabs.release(provider);
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
        if (message.kind === 'invalidated') search.invalidate(message.provider);

        try {
          connection.postMessage(message);
        } catch {
          broker.close();
        }
      },
      () => {
        search.close();
        providerTabs.close();
        brokers.delete(broker);
        connection.onMessage.removeListener(receive);
        connection.onDisconnect.removeListener(disconnect);
        browser.windows.onRemoved.removeListener(windowRemoved);
        connection.disconnect();
      },
      () => crypto.randomUUID(),
      {
        inspect: (scope, signal) => search.inspectSession(scope, signal),
        signIn: (provider, windowId, signal) => signIn.wait(provider, windowId, signal),
      },
    );
    const search = new PanelSearchBroker(
      broker,
      {
        chatgpt: createChatGptProvider,
        'google-ai-mode': createGoogleAiModeProvider,
      },
      (message) => {
        try {
          connection.postMessage(message);
        } catch {
          broker.close();
        }
      },
    );

    const receive = (message: unknown) => {
      if (validate(HeartbeatCommandSchema, message).ok) {
        try {
          connection.postMessage({ kind: 'alive' });
          void search.recheckSessions();
        } catch {
          broker.close();
        }
      } else if (!search.receive(message)) broker.receive(message);
    };

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
