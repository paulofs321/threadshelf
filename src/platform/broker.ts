import { requireValid, validate } from '../contracts/validation';
import { EphemeralScopeSchema, sameScope } from '../contracts/session';
import type { ProviderId, RequestId } from '../contracts/primitives';
import type { SessionScope } from '../contracts/session';
import { AccessRequestSchema, maximumRequestsPerPort, operationTimeoutMs } from './protocol';
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
  selectedTab(windowId: number): Promise<unknown>;
  inspectDocument(provider: ProviderId, target: ProbeTarget, signal: AbortSignal): Promise<unknown>;
}

interface Selection {
  tab: SelectedTab;
  documentId: string;
  scope: SessionScope;
}
interface Pending {
  request: AccessOperation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  tabId?: number;
  generation: number;
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
  ) {}

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

    // Unknown identity never shares an earlier operation's partition, even in the same document.
    this.selected.delete(request.provider);
    const generation = this.nextGeneration(request.provider);
    const pending: Pending = {
      request,
      generation,
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
          (item) =>
            item.request.provider === provider &&
            (item.tabId === undefined || item.tabId === tabId),
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
    this.send({ kind: 'reply', requestId: item.request.requestId, status });
  }

  private async run(item: Pending, previous?: Selection): Promise<void> {
    const provider = item.request.provider;
    const windowId = await this.port.ownerWindow();
    if (!this.current(item)) return;
    if (windowId === null) return this.fail(item, 'interrupted');
    if (!(await this.port.hasPermission(provider))) return this.fail(item, 'permission-needed');
    if (!this.current(item)) return;
    const tabResult = validate(SelectedTabSchema, await this.port.selectedTab(windowId));
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
    const after = validate(SelectedTabSchema, await this.port.selectedTab(windowId));
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
    this.pending.delete(item.request.requestId);
    clearTimeout(item.timer);
    this.send({
      kind: 'reply',
      requestId: item.request.requestId,
      status: 'selected',
      scope,
      session: 'unverified',
    });
  }
}
