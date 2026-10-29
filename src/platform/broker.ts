import { requireValid, validate } from '../contracts/validation';
import { EphemeralScopeSchema, sameScope } from '../contracts/session';
import type { ProviderId, RequestId } from '../contracts/primitives';
import type { SessionScope } from '../contracts/session';
import { SessionOutcomeSchema } from '../contracts/session';
import {
  AccessRequestSchema,
  maximumRequestsPerPort,
  operationTimeoutMs,
  signInTimeoutMs,
} from './protocol';
import type { AccessEvent, AccessMessage, AccessOperation, FailureStatus } from './protocol';
import { permittedUrl, SelectedTabSchema, validateProbe } from './policy';
import type { SelectedTab } from './policy';

export interface ProbeTarget {
  readonly tabId: number;
  readonly documentId?: string;
}

// No URL, request body, header, executable code or page-supplied command crosses this port.
export interface SelectedTabAccessPort {
  ownerWindow(): Promise<number | null>;
  hasPermission(provider: ProviderId): Promise<boolean>;
  selectedTab(
    windowId: number,
    provider: ProviderId,
    signal: AbortSignal,
    pinnedId?: number,
  ): Promise<unknown>;
  release?(provider: ProviderId): void;
  inspectDocument(provider: ProviderId, target: ProbeTarget, signal: AbortSignal): Promise<unknown>;
}

export interface SessionAccessPort {
  inspect(scope: SessionScope, signal: AbortSignal): Promise<unknown>;
  signIn(provider: ProviderId, windowId: number, signal: AbortSignal): Promise<number | null>;
}

interface Selection {
  tab: SelectedTab;
  documentId: string;
  scope: SessionScope;
}
// Trusted in-process capability. It is never serialized into a runtime message.
export interface SelectedDocumentBinding {
  readonly scope: SessionScope;
  readonly tab: SelectedTab;
  readonly documentId: string;
  isCurrent(): boolean;
  ownerWindow(): Promise<number | null>;
}
interface Pending {
  request: AccessOperation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  tabId?: number;
  generation: number;
  signInStarted?: boolean;
}

export class AccessBroker {
  private readonly selected = new Map<ProviderId, Selection>();
  private readonly pending = new Map<RequestId, Pending>();
  private readonly generations = new Map<ProviderId, number>();
  private readonly seen = new Set<RequestId>();
  private closed = false;

  constructor(
    private readonly port: SelectedTabAccessPort,
    private readonly send: (message: AccessMessage) => void,
    private readonly closeTransport: () => void,
    private readonly freshId: () => string,
    private readonly sessions?: SessionAccessPort,
  ) {}

  bindSelectedDocument(scope: SessionScope): SelectedDocumentBinding | null {
    const selection = this.selected.get(scope.provider);

    if (this.closed || !selection || !sameScope(selection.scope, scope)) return null;

    return {
      scope: { ...selection.scope },
      tab: { ...selection.tab },
      documentId: selection.documentId,
      isCurrent: () => !this.closed && this.selected.get(scope.provider) === selection,
      ownerWindow: () => this.port.ownerWindow(),
    };
  }

  receive(input: unknown): void {
    if (this.closed) return;

    const parsed = validate(AccessRequestSchema, input);

    if (!parsed.ok) return this.close();

    const request = parsed.value;

    if (request.operation === 'cancel') {
      const pending = this.pending.get(request.requestId);

      if (pending) this.invalidate(pending.request.provider, 'scope-changed', 'cancelled');

      return;
    }

    if (this.seen.has(request.requestId) || this.seen.size >= maximumRequestsPerPort) {
      return this.close();
    }

    this.seen.add(request.requestId);

    if ([...this.pending.values()].some((item) => item.request.provider === request.provider)) {
      this.send({ kind: 'reply', requestId: request.requestId, status: 'busy' });

      return;
    }

    const selection = this.selected.get(request.provider);

    if (
      request.operation !== 'connect' &&
      (!selection ||
        request.scope.provider !== request.provider ||
        !sameScope(selection.scope, request.scope))
    ) {
      this.send({ kind: 'reply', requestId: request.requestId, status: 'scope-changed' });

      return;
    }

    if (request.operation === 'disconnect') {
      this.invalidate(request.provider, 'scope-changed');
      this.send({ kind: 'reply', requestId: request.requestId, status: 'disconnected' });

      return;
    }

    if (request.operation === 'verify-session') {
      const item: Pending = {
        request,
        generation: request.scope.generation,
        controller: new AbortController(),
        timer: setTimeout(
          () => this.invalidate(request.provider, 'scope-changed', 'timeout'),
          operationTimeoutMs,
        ),
      };
      this.pending.set(request.requestId, item);
      void this.verify(item, request.scope).catch(() => {
        if (this.current(item)) this.invalidate(request.provider, 'unavailable');
      });

      return;
    }

    // Unknown identity never shares an earlier operation's partition, even in the same document.
    this.selected.delete(request.provider);
    const generation = this.nextGeneration(request.provider);

    if (selection)
      this.send({
        kind: 'invalidated',
        provider: request.provider,
        status: 'scope-changed',
        generation,
      });

    const pending: Pending = {
      request,
      generation: selection ? this.nextGeneration(request.provider) : generation,
      controller: new AbortController(),
      timer: setTimeout(() => {
        this.invalidate(request.provider, 'scope-changed', 'timeout');
      }, operationTimeoutMs),
    };
    this.pending.set(request.requestId, pending);
    void this.run(pending, request.operation === 'inspect-context' ? selection : undefined).catch(
      () => {
        this.fail(pending, 'unavailable');
      },
    );
  }

  invalidate(
    provider: ProviderId,
    status: AccessEvent['status'],
    pendingStatus: FailureStatus = status,
  ): void {
    const hadSelection = this.selected.delete(provider);
    this.port.release?.(provider);
    const operations = [...this.pending.values()].filter(
      (item) => item.request.provider === provider,
    );
    const generation = this.nextGeneration(provider);

    // Clear displayed scope before publishing any terminal reply.
    if (hadSelection || operations.length)
      this.send({ kind: 'invalidated', provider, status, generation });

    for (const item of operations) this.fail(item, pendingStatus);
  }

  invalidateAll(status: AccessEvent['status']): void {
    for (const provider of ['chatgpt', 'google-ai-mode'] as const)
      this.invalidate(provider, status);
  }

  tabChanged(tabId: number): void {
    for (const provider of ['chatgpt', 'google-ai-mode'] as const) {
      if (
        this.selected.get(provider)?.tab.id === tabId ||
        [...this.pending.values()].some(
          (item) => item.request.provider === provider && item.tabId === tabId,
        )
      )
        this.invalidate(provider, 'scope-changed');
    }
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;

    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.controller.abort();
    }

    this.pending.clear();
    this.selected.clear();

    for (const provider of ['chatgpt', 'google-ai-mode'] as const) this.port.release?.(provider);

    this.seen.clear();
    this.closeTransport();
  }

  private nextGeneration(provider: ProviderId): number {
    const generation = (this.generations.get(provider) ?? 0) + 1;
    this.generations.set(provider, generation);

    return generation;
  }

  private current(item: Pending): boolean {
    return (
      !this.closed &&
      !item.controller.signal.aborted &&
      this.pending.get(item.request.requestId) === item &&
      this.generations.get(item.request.provider) === item.generation
    );
  }

  private fail(item: Pending, status: FailureStatus): void {
    if (this.pending.get(item.request.requestId) !== item) return;

    this.pending.delete(item.request.requestId);
    clearTimeout(item.timer);
    item.controller.abort();
    this.selected.delete(item.request.provider);

    this.port.release?.(item.request.provider);

    this.send({ kind: 'reply', requestId: item.request.requestId, status });
  }

  private async run(item: Pending, previous?: Selection, returnedTabId?: number): Promise<void> {
    const provider = item.request.provider;
    const windowId = await this.port.ownerWindow();

    if (!this.current(item)) return;

    if (windowId === null) return this.fail(item, 'interrupted');

    if (!(await this.port.hasPermission(provider))) return this.fail(item, 'permission-needed');

    if (!this.current(item)) return;

    const tabResult = validate(
      SelectedTabSchema,
      await this.port.selectedTab(
        windowId,
        provider,
        item.controller.signal,
        returnedTabId ?? previous?.tab.id,
      ),
    );

    if (!this.current(item)) return;

    if (
      !tabResult.ok ||
      tabResult.value.windowId !== windowId ||
      !permittedUrl(provider, tabResult.value.url)
    ) {
      return this.fail(item, 'unavailable');
    }

    const tab = tabResult.value;
    item.tabId = tab.id;

    if (previous && (previous.tab.id !== tab.id || previous.tab.url !== tab.url)) {
      return this.fail(item, 'scope-changed');
    }

    const target: ProbeTarget = previous
      ? { tabId: tab.id, documentId: previous.documentId }
      : { tabId: tab.id };
    const probe = await this.port.inspectDocument(provider, target, item.controller.signal);

    if (!this.current(item)) return;

    const documentId = validateProbe(provider, probe, previous?.documentId);

    if (!documentId) return this.fail(item, 'scope-changed');

    // Pin the second check to Chrome's document ID, including same-URL reloads/redirects.
    const confirmation = await this.port.inspectDocument(
      provider,
      { tabId: tab.id, documentId },
      item.controller.signal,
    );

    if (!this.current(item)) return;

    if (!validateProbe(provider, confirmation, documentId)) return this.fail(item, 'scope-changed');

    const after = validate(
      SelectedTabSchema,
      await this.port.selectedTab(windowId, provider, item.controller.signal, tab.id),
    );

    if (!this.current(item)) return;

    if (
      !after.ok ||
      after.value.id !== tab.id ||
      after.value.windowId !== windowId ||
      after.value.url !== tab.url
    ) {
      return this.fail(item, 'scope-changed');
    }

    if (!(await this.port.hasPermission(provider))) return this.fail(item, 'permission-needed');

    if (!this.current(item)) return;

    if ((await this.port.ownerWindow()) !== windowId) return this.fail(item, 'interrupted');

    if (!this.current(item)) return;

    const scope = requireValid(EphemeralScopeSchema, {
      kind: 'ephemeral',
      provider,
      generation: item.generation,
      partition: this.freshId(),
    });
    this.selected.set(provider, { tab, documentId, scope });

    if (this.sessions) {
      this.send({
        kind: 'connection-progress',
        requestId: item.request.requestId,
        provider,
        status: item.signInStarted ? 'verifying-session' : 'checking-session',
      });
      const result = validate(
        SessionOutcomeSchema,
        await this.sessions.inspect(scope, item.controller.signal),
      );

      if (!this.current(item)) return;

      if (!result.ok) return this.fail(item, 'unavailable');

      if (result.value.status === 'ready') {
        if (!sameScope(scope, result.value.scope)) return this.fail(item, 'scope-changed');
      } else {
        if (result.value.provider !== provider || result.value.generation !== scope.generation)
          return this.fail(item, 'scope-changed');

        if (result.value.status !== 'login-expired' || item.signInStarted)
          return this.fail(item, result.value.status);

        // Only an explicit Connect/Recheck request can reach this path. No search opens sign-in.
        // Retire every old capability, retaining only this bounded pending intent.
        this.selected.delete(provider);
        this.port.release?.(provider);
        delete item.tabId;
        item.signInStarted = true;
        const generation = this.nextGeneration(provider);
        this.send({ kind: 'invalidated', provider, status: 'scope-changed', generation });
        item.generation = this.nextGeneration(provider);
        clearTimeout(item.timer);
        item.timer = setTimeout(
          () => this.invalidate(provider, 'scope-changed', 'expired-wait'),
          signInTimeoutMs,
        );
        this.send({
          kind: 'connection-progress',
          requestId: item.request.requestId,
          provider,
          status: 'waiting-for-sign-in',
        });
        const returned = await this.sessions.signIn(provider, windowId, item.controller.signal);

        if (!this.current(item)) return;

        if (returned === null) return this.fail(item, 'cancelled');

        clearTimeout(item.timer);
        item.timer = setTimeout(
          () => this.invalidate(provider, 'scope-changed', 'timeout'),
          operationTimeoutMs,
        );
        this.send({
          kind: 'connection-progress',
          requestId: item.request.requestId,
          provider,
          status: 'verifying-session',
        });
        await this.run(item, undefined, returned);

        return;
      }
    }

    if (!this.current(item)) return;

    this.pending.delete(item.request.requestId);
    clearTimeout(item.timer);
    this.send(
      this.sessions
        ? {
            kind: 'reply',
            requestId: item.request.requestId,
            status: 'connected',
            scope,
            session: 'authenticated',
          }
        : {
            kind: 'reply',
            requestId: item.request.requestId,
            status: 'selected',
            scope,
            session: 'unverified',
          },
    );
  }

  private async verify(
    item: Pending,
    scope: Extract<SessionScope, { kind: 'ephemeral' }>,
  ): Promise<void> {
    const result = validate(
      SessionOutcomeSchema,
      await this.sessions?.inspect(scope, item.controller.signal),
    );

    if (!this.current(item)) return;

    if (!result.ok || result.value.status !== 'ready' || !sameScope(result.value.scope, scope)) {
      this.invalidate(
        scope.provider,
        result.ok && result.value.status === 'login-expired' ? 'login-expired' : 'scope-changed',
      );

      return;
    }

    this.pending.delete(item.request.requestId);
    clearTimeout(item.timer);
    this.send({
      kind: 'reply',
      requestId: item.request.requestId,
      status: 'verified',
      scope,
      session: 'authenticated',
    });
  }
}
