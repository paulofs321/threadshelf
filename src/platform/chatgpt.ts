import { browser } from 'wxt/browser';
import type { OperationContext } from '../contracts/ports';
import { ChatGptProvider } from '../providers/chatgpt/adapter';
import { abortChatGptDocumentRead, readChatGptDocument } from '../providers/chatgpt/document-read';
import { ChatGptOperationSchema, ChatGptReadResultSchema } from '../providers/chatgpt/transport';
import type {
  ChatGptOperation,
  ChatGptReadPort,
  ChatGptReadResult,
} from '../providers/chatgpt/transport';
import { validate } from '../contracts/validation';
import type { SelectedDocumentBinding } from './broker';
import { inspectSelectedDocument } from './document-probe';
import { providerPermission, validateProbe } from './policy';

const failure = (
  status: Exclude<ChatGptReadResult['status'], 'success' | 'rate-limited'>,
): ChatGptReadResult => ({ status });

export function createChatGptProvider(binding: SelectedDocumentBinding): ChatGptProvider {
  return new ChatGptProvider(binding.scope, new ChromeChatGptReadPort(binding));
}

// Privileged caller supplies only a live broker capability; no new runtime message operation.
export class ChromeChatGptReadPort implements ChatGptReadPort {
  private readonly salt = crypto.randomUUID();
  constructor(private readonly binding: SelectedDocumentBinding) {}

  async read(
    operation: ChatGptOperation,
    expectedIdentity: string | undefined,
    context: OperationContext,
  ): Promise<ChatGptReadResult> {
    const parsed = validate(ChatGptOperationSchema, operation);
    if (!parsed.ok) return failure('unavailable');
    if (context.signal.aborted) return failure('cancelled');
    const controller = new AbortController();
    let status: 'cancelled' | 'scope-changed' | 'permission-needed' | 'timeout' | undefined;
    let stopped: (value: ChatGptReadResult) => void;
    const interruption = new Promise<ChatGptReadResult>((resolve) => {
      stopped = resolve;
    });
    const stop = (reason: typeof status) => {
      status ??= reason;
      controller.abort();
      stopped(failure(status ?? 'unavailable'));
    };
    const cancel = () => stop('cancelled');
    const changed = (tabId: number, change?: { status?: string; url?: string }) => {
      if (
        tabId === this.binding.tab.id &&
        (!change || change.status === 'loading' || change.url !== undefined)
      )
        stop('scope-changed');
    };
    const removed = (tabId: number) => changed(tabId);
    const replaced = (_added: number, old: number) => changed(old);
    const activated = () => stop('scope-changed');
    const permission = (removed: { origins?: string[]; permissions?: string[] }) => {
      if (
        removed.permissions?.includes('scripting') ||
        removed.origins?.includes('https://chatgpt.com/*')
      )
        stop('permission-needed');
    };
    const timer = setTimeout(() => stop('timeout'), 9_500);
    context.signal.addEventListener('abort', cancel, { once: true });
    browser.tabs.onUpdated.addListener(changed);
    browser.tabs.onRemoved.addListener(removed);
    browser.tabs.onReplaced.addListener(replaced);
    browser.tabs.onActivated.addListener(activated);
    browser.windows.onFocusChanged.addListener(activated);
    browser.permissions.onRemoved.addListener(permission);
    try {
      const action = async (): Promise<ChatGptReadResult> => {
        const before = await this.source(controller.signal);
        if (before) return before;
        const result = await this.execute(parsed.value, expectedIdentity, controller.signal);

        return (await this.source(controller.signal)) ?? result;
      };
      const result = await Promise.race([action(), interruption]);

      return status ? failure(status) : result;
    } catch {
      return failure(status ?? 'unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
      context.signal.removeEventListener('abort', cancel);
      browser.tabs.onUpdated.removeListener(changed);
      browser.tabs.onRemoved.removeListener(removed);
      browser.tabs.onReplaced.removeListener(replaced);
      browser.tabs.onActivated.removeListener(activated);
      browser.windows.onFocusChanged.removeListener(activated);
      browser.permissions.onRemoved.removeListener(permission);
    }
  }

  private async source(signal: AbortSignal): Promise<ChatGptReadResult | undefined> {
    const b = this.binding;
    if (
      signal.aborted ||
      !b.isCurrent() ||
      b.scope.provider !== 'chatgpt' ||
      b.scope.kind !== 'ephemeral'
    )
      return failure('scope-changed');
    if ((await b.ownerWindow()) !== b.tab.windowId) return failure('interrupted');
    if (!(await browser.permissions.contains(providerPermission('chatgpt'))))
      return failure('permission-needed');
    const tabs = await browser.tabs.query({ active: true, windowId: b.tab.windowId });
    const tab = tabs[0];
    if (
      tabs.length !== 1 ||
      !tab ||
      tab.id !== b.tab.id ||
      tab.windowId !== b.tab.windowId ||
      tab.incognito ||
      !tab.active ||
      tab.status !== 'complete' ||
      tab.pendingUrl !== undefined ||
      tab.url !== b.tab.url
    )
      return failure('scope-changed');
    if (signal.aborted) return failure('cancelled');
    const result = await browser.scripting.executeScript({
      target: { tabId: b.tab.id, documentIds: [b.documentId] },
      world: 'ISOLATED',
      func: inspectSelectedDocument,
      args: ['https://chatgpt.com'],
    });
    if (
      result.length !== 1 ||
      !validateProbe('chatgpt', result[0], b.documentId) ||
      !b.isCurrent() ||
      signal.aborted
    )
      return failure('scope-changed');
  }

  private async execute(
    operation: ChatGptOperation,
    expectedIdentity: string | undefined,
    signal: AbortSignal,
  ): Promise<ChatGptReadResult> {
    if (signal.aborted) return failure('cancelled');
    const operationId = crypto.randomUUID();
    const target = { tabId: this.binding.tab.id, documentIds: [this.binding.documentId] };
    const abort = () => {
      void browser.scripting
        .executeScript({
          target,
          world: 'ISOLATED',
          func: abortChatGptDocumentRead,
          args: [operationId],
        })
        .catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const results = await browser.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: readChatGptDocument,
        args:
          expectedIdentity === undefined
            ? [operation, operationId, this.salt]
            : [operation, operationId, this.salt, expectedIdentity],
      });
      if (
        results.length !== 1 ||
        results[0]?.frameId !== 0 ||
        results[0]?.documentId !== this.binding.documentId
      )
        return failure('scope-changed');
      const parsed = validate(ChatGptReadResultSchema, results[0].result);

      return parsed.ok ? parsed.value : failure('schema-changed');
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
