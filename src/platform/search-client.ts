import { limits, requireValid, sameScope, searchOutcomeSchemaFor, validate } from '../contracts';
import type {
  LinkVerifiers,
  SearchOutcome,
  SearchPort,
  SearchRequest,
  SessionScope,
} from '../contracts';
import { aggregateSearch } from '../search/aggregate';
import { KeywordRequestSchema, SearchReplySchema, searchClientTimeoutMs } from './search-protocol';
import type { SearchCommand } from './search-protocol';
import { heartbeatIntervalMs, maximumRequestsPerPort } from './protocol';

interface SearchConnection {
  postMessage(command: SearchCommand | { operation: 'keepalive' }): void;
  disconnect(): void;
  onMessage: {
    addListener(callback: (input: unknown) => void): void;
    removeListener(callback: (input: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
    removeListener(callback: () => void): void;
  };
}
interface Pending {
  request: SearchRequest;
  finish(outcome: SearchOutcome): void;
  stop(status: 'cancelled' | 'timeout' | 'interrupted' | 'scope-changed'): void;
}

/** Shares the trusted access connection; only normalized keyword requests cross it. */
export class PanelSearchClient implements SearchPort {
  private pending: Pending | undefined;
  private closed = false;
  private readonly seen = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly connection: SearchConnection,
    private readonly verifiers: LinkVerifiers,
    private readonly closeTransport: () => void = () => connection.disconnect(),
  ) {
    connection.onMessage.addListener(this.receive);
    connection.onDisconnect.addListener(this.close);
  }

  search(input: SearchRequest, { signal }: { signal: AbortSignal }): Promise<SearchOutcome> {
    const request = requireValid(KeywordRequestSchema, input);

    if (this.seen.size >= maximumRequestsPerPort) {
      this.close();
      this.closeTransport();
    }

    if (this.seen.has(request.requestId) || this.seen.size >= maximumRequestsPerPort)
      throw new Error('Search connection request limit reached. Reconnect.');

    this.seen.add(request.requestId);
    this.pending?.stop('cancelled');

    return new Promise((resolve) => {
      const finish = (outcome: SearchOutcome) => {
        if (this.pending !== pending) return;

        this.pending = undefined;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(outcome);
      };

      const stop: Pending['stop'] = (status) => {
        finish(
          aggregateSearch(
            request,
            request.scopes.map((scope) => ({ requestId: request.requestId, scope, status })),
            this.verifiers,
            limits.candidates * 2,
            [],
          ),
        );

        if (!this.closed) {
          try {
            this.connection.postMessage({
              operation: 'cancel-search',
              requestId: request.requestId,
            });
          } catch {
            this.close();
            this.closeTransport();
          }
        }
      };

      const cancel = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), searchClientTimeoutMs);
      const pending: Pending = { request, finish, stop };
      this.pending = pending;
      signal.addEventListener('abort', cancel, { once: true });

      if (signal.aborted || this.closed) {
        stop(signal.aborted ? 'cancelled' : 'interrupted');

        return;
      }

      try {
        this.connection.postMessage({ operation: 'keyword-search', request });
      } catch {
        this.close();
        this.closeTransport();
      }
    });
  }

  invalidate(scope: SessionScope): void {
    if (this.pending?.request.scopes.some((current) => sameScope(scope, current)))
      this.pending.stop('scope-changed');
  }

  keepAlive(enabled: boolean): void {
    if (!enabled) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;

      return;
    }

    if (this.closed || this.heartbeat !== undefined) return;

    // Only a connected, mounted panel sends these local messages. They perform no provider reads.
    this.heartbeat = setInterval(() => {
      try {
        this.connection.postMessage({ operation: 'keepalive' });
      } catch {
        this.close();
        this.closeTransport();
      }
    }, heartbeatIntervalMs);
  }

  readonly close = (): void => {
    if (this.closed) return;

    this.closed = true;
    this.keepAlive(false);
    this.connection.onMessage.removeListener(this.receive);
    this.connection.onDisconnect.removeListener(this.close);
    this.pending?.stop('interrupted');
  };

  private readonly receive = (input: unknown): void => {
    // Access replies are independently validated by AccessClient on this same port.
    if (
      typeof input !== 'object' ||
      input === null ||
      !('kind' in input) ||
      input.kind !== 'search-result'
    )
      return;

    const reply = validate(SearchReplySchema, input);

    if (!reply.ok) {
      this.close();
      this.closeTransport();

      return;
    }

    const pending = this.pending;

    if (!pending || reply.value.outcome.requestId !== pending.request.requestId) return;

    const result = validate(
      searchOutcomeSchemaFor(pending.request, this.verifiers),
      reply.value.outcome,
    );

    if (!result.ok) {
      this.close();
      this.closeTransport();

      return;
    }

    pending.finish(result.value);
  };
}
