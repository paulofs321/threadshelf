import { browser } from 'wxt/browser';
import * as v from 'valibot';
import { CandidateSchema, acceptsOriginalLink } from '../contracts/conversation';
import type { Candidate } from '../contracts/conversation';
import { sameScope } from '../contracts/session';
import type { OperationContext } from '../contracts/ports';
import { validate } from '../contracts/validation';
import { GoogleAiModeProvider } from '../providers/google-ai-mode/adapter';
import {
  abortGoogleDocumentRead,
  readGoogleDocument,
} from '../providers/google-ai-mode/document-read';
import {
  GoogleReadOperationSchema,
  GoogleReadResultSchema,
} from '../providers/google-ai-mode/transport';
import type {
  GoogleAiModeReadPort,
  GoogleReadOperation,
} from '../providers/google-ai-mode/transport';
import { verifyGoogleOriginalLink } from '../providers/google-ai-mode/wire';
import type { SelectedDocumentBinding } from './broker';
import { descriptionWords } from '../search/terms';
import { inspectSelectedDocument } from './document-probe';
import { permittedUrl, providerOrigins, providerPermission, validateProbe } from './policy';

type ReadResult = v.InferOutput<typeof GoogleReadResultSchema>;
const failure = (status: Exclude<ReadResult['status'], 'success'>): ReadResult => ({ status });

// Only trusted composition can obtain this binding from AccessBroker. No runtime URL bridge.
export function createGoogleAiModeProvider(binding: SelectedDocumentBinding): GoogleAiModeProvider {
  return new GoogleAiModeProvider(binding.scope, new ChromeGoogleAiModeReadPort(binding));
}

export class ChromeGoogleAiModeReadPort implements GoogleAiModeReadPort {
  constructor(private readonly binding: SelectedDocumentBinding) {}

  read(
    operation: GoogleReadOperation,
    expectedIdentity: string | undefined,
    context: OperationContext,
  ) {
    const parsed = validate(GoogleReadOperationSchema, operation);

    if (!parsed.ok || parsed.value.kind === 'messages')
      return Promise.resolve(failure('unavailable'));

    return this.run(context, async (signal) => {
      const before = await this.source(signal);

      if (before) return before;

      const result = await this.execute(
        this.binding.tab.id,
        this.binding.documentId,
        parsed.value,
        expectedIdentity,
        signal,
      );

      return (await this.source(signal)) ?? result;
    });
  }

  openEvidence(
    candidate: Candidate,
    expectedIdentity: string,
    context: OperationContext,
    description?: string,
  ) {
    const parsed = validate(CandidateSchema, candidate);

    if (
      !parsed.ok ||
      !sameScope(parsed.value.scope, this.binding.scope) ||
      !parsed.value.originalUrl ||
      !acceptsOriginalLink(parsed.value, { 'google-ai-mode': verifyGoogleOriginalLink })
    )
      return Promise.resolve(failure('unavailable'));

    candidate = parsed.value;

    return this.run(context, async (signal) => {
      let tabId: number | undefined;
      let owned = false;
      let destination = candidate.originalUrl;

      try {
        const before = await this.confirmSource(expectedIdentity, signal);

        if (before) return before;

        if (signal.aborted) return failure('cancelled');

        const existing = (
          await browser.tabs.query({
            windowId: this.binding.tab.windowId,
            url: 'https://www.google.com/*',
          })
        ).find((tab) => {
          if (
            tab.incognito ||
            tab.windowId !== this.binding.tab.windowId ||
            tab.status !== 'complete' ||
            tab.pendingUrl !== undefined ||
            !tab.url ||
            !permittedUrl('google-ai-mode', tab.url)
          )
            return false;

          const url = new URL(tab.url);

          return (
            url.origin === 'https://www.google.com' &&
            url.pathname === '/search' &&
            url.searchParams.get('udm') === '50' &&
            !url.searchParams.has('authuser') &&
            url.searchParams.get('mtid') === candidate.conversationId
          );
        });

        if (signal.aborted) return failure('cancelled');

        if (existing) {
          tabId = existing.id;
          destination = existing.url;
        } else {
          owned = true;
          const tab = await browser.tabs.create({
            windowId: this.binding.tab.windowId,
            active: false,
            url: candidate.originalUrl,
          });
          tabId = tab.id;
        }

        if (tabId === undefined) return failure('unavailable');

        // Reuse an already rendered matching thread when possible. Never navigate or close user tabs.
        for (;;) {
          if (signal.aborted) return failure('cancelled');

          const current = await browser.tabs.get(tabId);

          if (current.incognito || current.windowId !== this.binding.tab.windowId)
            return failure('scope-changed');

          if (current.status === 'complete') {
            if (current.url !== destination || current.pendingUrl !== undefined) {
              return failure('scope-changed');
            }

            break;
          }

          await new Promise<void>((resolve) => {
            const stop = () => {
              clearTimeout(timer);
              resolve();
            };

            const timer = setTimeout(() => {
              signal.removeEventListener('abort', stop);
              resolve();
            }, 100);
            signal.addEventListener('abort', stop, { once: true });
          });
        }

        const documentId = await this.probe(tabId);

        if (!documentId || signal.aborted) return failure('scope-changed');

        const result = await this.execute(
          tabId,
          documentId,
          {
            kind: 'messages',
            conversationId: candidate.conversationId,
            ...(description === undefined
              ? {}
              : { query: descriptionWords(description).join(' ') || description }),
          },
          expectedIdentity,
          signal,
        );
        const reopened = await browser.tabs.get(tabId);

        if (
          reopened.url !== destination ||
          reopened.pendingUrl !== undefined ||
          !(await this.probe(tabId, documentId))
        )
          return failure('scope-changed');

        const after = await this.confirmSource(expectedIdentity, signal);

        if (after) return after;

        return result;
      } finally {
        if (owned && tabId !== undefined) {
          const current = await browser.tabs.get(tabId).catch(() => undefined);

          if (
            current &&
            current.windowId === this.binding.tab.windowId &&
            !current.incognito &&
            !current.active &&
            current.url === destination &&
            current.pendingUrl === undefined
          )
            await browser.tabs.remove(tabId).catch(() => {});
        }
      }
    });
  }

  private async confirmSource(
    expectedIdentity: string,
    signal: AbortSignal,
  ): Promise<ReadResult | undefined> {
    const source = await this.source(signal);

    if (source) return source;

    const identity = await this.execute(
      this.binding.tab.id,
      this.binding.documentId,
      { kind: 'inspect' },
      expectedIdentity,
      signal,
    );

    if (identity.status !== 'success') return identity;

    if (identity.identityBefore !== expectedIdentity || identity.identityAfter !== expectedIdentity)
      return failure('scope-changed');
  }

  private async source(signal: AbortSignal): Promise<ReadResult | undefined> {
    const { binding } = this;

    if (
      signal.aborted ||
      !binding.isCurrent() ||
      binding.scope.kind !== 'ephemeral' ||
      binding.scope.provider !== 'google-ai-mode'
    )
      return failure('scope-changed');

    if ((await binding.ownerWindow()) !== binding.tab.windowId) return failure('interrupted');

    if (!(await browser.permissions.contains(providerPermission('google-ai-mode'))))
      return failure('permission-needed');

    const tabs = (
      await browser.tabs.query({ windowId: binding.tab.windowId, url: 'https://www.google.com/*' })
    ).filter((tab) => tab.id === binding.tab.id);
    const tab = tabs[0];

    if (
      tabs.length !== 1 ||
      !tab ||
      tab.id !== binding.tab.id ||
      tab.windowId !== binding.tab.windowId ||
      tab.incognito ||
      tab.status !== 'complete' ||
      tab.pendingUrl !== undefined ||
      tab.url !== binding.tab.url
    )
      return failure('scope-changed');

    if (!(await this.probe(tab.id, binding.documentId))) return failure('scope-changed');

    if (!binding.isCurrent() || signal.aborted) return failure('scope-changed');
  }

  private async probe(tabId: number, documentId?: string): Promise<string | null> {
    const results = await browser.scripting.executeScript({
      target:
        documentId === undefined ? { tabId, frameIds: [0] } : { tabId, documentIds: [documentId] },
      world: 'ISOLATED',
      func: inspectSelectedDocument,
      args: ['https://www.google.com'],
    });

    return results.length === 1 ? validateProbe('google-ai-mode', results[0], documentId) : null;
  }

  private async execute(
    tabId: number,
    documentId: string,
    operation: GoogleReadOperation,
    expectedIdentity: string | undefined,
    signal: AbortSignal,
  ): Promise<ReadResult> {
    if (signal.aborted) return failure('cancelled');

    const operationId = crypto.randomUUID();
    const target = { tabId, documentIds: [documentId] };

    const abort = () => {
      void browser.scripting
        .executeScript({
          target,
          world: 'ISOLATED',
          func: abortGoogleDocumentRead,
          args: [operationId],
        })
        .catch(() => {});
    };

    signal.addEventListener('abort', abort, { once: true });

    try {
      const scope = this.binding.scope;

      if (scope.kind !== 'ephemeral') return failure('scope-changed');

      const results = await browser.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: readGoogleDocument,
        args: [
          {
            operation,
            operationId,
            partition: scope.partition,
            ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
          },
        ],
      });

      if (
        results.length !== 1 ||
        results[0]?.frameId !== 0 ||
        results[0]?.documentId !== documentId
      )
        return failure('scope-changed');

      const result = validate(GoogleReadResultSchema, results[0].result);

      return result.ok ? result.value : failure('schema-changed');
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private async run(
    context: OperationContext,
    action: (signal: AbortSignal) => Promise<ReadResult>,
  ): Promise<ReadResult> {
    if (context.signal.aborted) return failure('cancelled');

    const controller = new AbortController();
    let status: 'cancelled' | 'scope-changed' | 'permission-needed' | 'timeout' | undefined;
    let stopped: (result: ReadResult) => void;
    const interruption = new Promise<ReadResult>((resolve) => {
      stopped = resolve;
    });

    const stop = (reason: 'cancelled' | 'scope-changed' | 'permission-needed' | 'timeout') => {
      status ??= reason;
      controller.abort();
      stopped(failure(status));
    };

    const cancel = () => stop('cancelled');

    const changed = (id: number, change?: { status?: string; url?: string }) => {
      if (
        id === this.binding.tab.id &&
        (change === undefined || change.status === 'loading' || change.url !== undefined)
      )
        stop('scope-changed');
    };

    const replaced = (_added: number, removed: number) => changed(removed);
    const removed = (id: number) => changed(id);

    const permission = (removed: { permissions?: string[]; origins?: string[] }) => {
      if (
        removed.permissions?.includes('scripting') ||
        removed.origins?.includes(`${providerOrigins['google-ai-mode']}/*`)
      )
        stop('permission-needed');
    };

    const timer = setTimeout(() => stop('timeout'), 9500);
    context.signal.addEventListener('abort', cancel, { once: true });
    browser.tabs.onUpdated.addListener(changed);
    browser.tabs.onRemoved.addListener(removed);
    browser.tabs.onReplaced.addListener(replaced);
    browser.permissions.onRemoved.addListener(permission);

    try {
      const result = await Promise.race([action(controller.signal), interruption]);

      return status ? failure(status) : result;
    } catch {
      return failure(status ?? 'unavailable');
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
      browser.tabs.onUpdated.removeListener(changed);
      browser.tabs.onRemoved.removeListener(removed);
      browser.tabs.onReplaced.removeListener(replaced);
      browser.permissions.onRemoved.removeListener(permission);
    }
  }
}
