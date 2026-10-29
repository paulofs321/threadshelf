import { RequestIdSchema } from '../contracts/primitives';
import type { ProviderId, RequestId } from '../contracts/primitives';
import type { SessionScope } from '../contracts/session';
import { sameScope } from '../contracts/session';
import { requireValid, validate } from '../contracts/validation';
import {
  AccessMessageSchema,
  AccessRequestSchema,
  clientTimeoutMs,
  maximumRequestsPerPort,
  HeartbeatReplySchema,
  signInTimeoutMs,
} from './protocol';
import type {
  AccessEvent,
  AccessOperation,
  AccessReply,
  AccessRequest,
  AccessProgress,
} from './protocol';
import { SearchReplySchema } from './search-protocol';

interface Listener<T> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}
export interface AccessConnection {
  postMessage(message: AccessRequest): void;
  disconnect(): void;
  onMessage: Listener<(input: unknown) => void>;
  onDisconnect: Listener<() => void>;
}
interface Pending {
  request: AccessOperation;
  finish(reply: AccessReply): void;
  progress(message: AccessProgress): void;
}

// Panel-owned timers guarantee interruption/timeout even when the MV3 worker stops running.
export class AccessClient {
  private readonly pending = new Map<RequestId, Pending>();
  private readonly subscribers = new Set<(event: AccessEvent) => void>();
  private readonly progressSubscribers = new Set<(event: AccessProgress) => void>();
  private readonly generations = new Map<ProviderId, number>();
  private count = 0;
  private closed = false;

  constructor(
    private readonly connection: AccessConnection,
    private readonly freshId: () => string,
  ) {
    connection.onMessage.addListener(this.receive);
    connection.onDisconnect.addListener(this.onDisconnect);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  subscribe(callback: (event: AccessEvent) => void): () => void {
    this.subscribers.add(callback);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  subscribeProgress(callback: (event: AccessProgress) => void): () => void {
    this.progressSubscribers.add(callback);

    return () => {
      this.progressSubscribers.delete(callback);
    };
  }

  connect(provider: ProviderId, signal: AbortSignal): Promise<AccessReply> {
    return this.request({ operation: 'connect', requestId: this.requestId(), provider }, signal);
  }

  inspect(provider: ProviderId, scope: SessionScope, signal: AbortSignal): Promise<AccessReply> {
    return this.request(
      requireValid(AccessRequestSchema, {
        operation: 'inspect-context',
        requestId: this.requestId(),
        provider,
        scope,
      }) as AccessOperation,
      signal,
    );
  }

  verify(scope: SessionScope, signal: AbortSignal): Promise<AccessReply> {
    return this.request(
      requireValid(AccessRequestSchema, {
        operation: 'verify-session',
        requestId: this.requestId(),
        provider: scope.provider,
        scope,
      }) as AccessOperation,
      signal,
    );
  }

  disconnectSelection(
    provider: ProviderId,
    scope: SessionScope,
    signal: AbortSignal,
  ): Promise<AccessReply> {
    return this.request(
      requireValid(AccessRequestSchema, {
        operation: 'disconnect',
        requestId: this.requestId(),
        provider,
        scope,
      }) as AccessOperation,
      signal,
    );
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.connection.onMessage.removeListener(this.receive);
    this.connection.onDisconnect.removeListener(this.onDisconnect);

    for (const provider of ['chatgpt', 'google-ai-mode'] as const) {
      this.publish({
        kind: 'invalidated',
        provider,
        status: 'interrupted',
        generation: this.nextGeneration(provider),
      });
    }

    for (const item of this.pending.values()) {
      item.finish({ kind: 'reply', requestId: item.request.requestId, status: 'interrupted' });
    }

    this.pending.clear();
    this.subscribers.clear();
    this.progressSubscribers.clear();
    this.connection.disconnect();
  }

  private requestId(): RequestId {
    return requireValid(RequestIdSchema, this.freshId());
  }

  private request(request: AccessOperation, signal: AbortSignal): Promise<AccessReply> {
    const failure = (status: 'interrupted' | 'cancelled' | 'busy'): AccessReply => ({
      kind: 'reply',
      requestId: request.requestId,
      status,
    });

    if (this.closed) return Promise.resolve(failure('interrupted'));

    if (signal.aborted) return Promise.resolve(failure('cancelled'));

    if (++this.count > maximumRequestsPerPort || this.pending.has(request.requestId)) {
      this.close();

      return Promise.resolve(failure('interrupted'));
    }

    if ([...this.pending.values()].some((item) => item.request.provider === request.provider)) {
      return Promise.resolve(failure('busy'));
    }

    return new Promise((resolve) => {
      const finish = (reply: AccessReply) => {
        if (!this.pending.delete(request.requestId)) return;

        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(reply);
      };

      const stop = (status: 'cancelled' | 'timeout' | 'expired-wait') => {
        this.publish({
          kind: 'invalidated',
          provider: request.provider,
          status: 'scope-changed',
          generation: this.nextGeneration(request.provider),
        });
        finish({ kind: 'reply', requestId: request.requestId, status });

        try {
          this.connection.postMessage({ operation: 'cancel', requestId: request.requestId });
        } catch {
          this.close();
        }
      };

      const cancel = () => stop('cancelled');
      let timer = setTimeout(() => stop('timeout'), clientTimeoutMs);
      let signInDeadline: number | undefined;
      let verificationStarted = false;

      const progress = (message: AccessProgress) => {
        if (
          message.provider !== request.provider ||
          request.operation === 'disconnect' ||
          request.operation === 'verify-session'
        )
          return this.close();

        if (message.status === 'waiting-for-sign-in') {
          if (verificationStarted) return this.close();

          signInDeadline ??= Date.now() + signInTimeoutMs;
          clearTimeout(timer);
          timer = setTimeout(() => stop('expired-wait'), Math.max(0, signInDeadline - Date.now()));
        } else if (message.status === 'verifying-session') {
          if (signInDeadline === undefined) return this.close();

          if (!verificationStarted) {
            verificationStarted = true;
            clearTimeout(timer);
            timer = setTimeout(() => stop('timeout'), clientTimeoutMs);
          }
        }

        for (const callback of this.progressSubscribers) callback(message);
      };

      this.pending.set(request.requestId, { request, finish, progress });
      signal.addEventListener('abort', cancel, { once: true });

      try {
        this.connection.postMessage(request);
      } catch {
        this.close();
      }
    });
  }

  private publish(event: AccessEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  private nextGeneration(provider: ProviderId): number {
    const generation = (this.generations.get(provider) ?? 0) + 1;
    this.generations.set(provider, generation);

    return generation;
  }

  private readonly receive = (input: unknown): void => {
    if (this.closed) return;

    if (validate(HeartbeatReplySchema, input).ok) return;

    // The search client validates contextual scope/link/date policies independently.
    if (validate(SearchReplySchema, input).ok) return;

    const result = validate(AccessMessageSchema, input);

    if (!result.ok) return this.close();

    const message = result.value;

    if (message.kind === 'connection-progress') {
      this.pending.get(message.requestId)?.progress(message);

      return;
    }

    if (message.kind === 'invalidated') {
      if (message.generation <= (this.generations.get(message.provider) ?? 0)) return;

      this.generations.set(message.provider, message.generation);
      this.publish(message);

      return;
    }

    const item = this.pending.get(message.requestId);

    if (!item) return; // Obsolete/duplicate replies cannot restore a scope or UI result.

    if (message.status === 'verified') {
      if (
        item.request.operation !== 'verify-session' ||
        !sameScope(item.request.scope, message.scope)
      )
        return this.close();

      if (message.scope.generation < (this.generations.get(message.scope.provider) ?? 0)) {
        item.finish({ kind: 'reply', requestId: message.requestId, status: 'scope-changed' });

        return;
      }
    } else if (message.status === 'selected' || message.status === 'connected') {
      if (item.request.operation === 'verify-session') return this.close();

      if (message.scope.generation <= (this.generations.get(item.request.provider) ?? 0)) {
        item.finish({ kind: 'reply', requestId: message.requestId, status: 'scope-changed' });

        return;
      }

      const previous = 'scope' in item.request ? item.request.scope : undefined;

      if (
        item.request.operation === 'disconnect' ||
        message.scope.provider !== item.request.provider ||
        (previous &&
          (message.scope.generation <= previous.generation ||
            message.scope.partition === previous.partition))
      ) {
        return this.close();
      }

      this.generations.set(message.scope.provider, message.scope.generation);
    } else if (message.status === 'disconnected' && item.request.operation !== 'disconnect') {
      return this.close();
    }

    item.finish(message);
  };

  private readonly onDisconnect = (): void => {
    this.close();
  };
}
