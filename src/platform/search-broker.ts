import { sameScope, validate } from '../contracts';
import type { ProviderId, ProviderPort, SearchRequest, SessionScope } from '../contracts';
import { KeywordSearch } from '../search';
import type { AccessBroker, SelectedDocumentBinding } from './broker';
import { providerLinkVerifiers } from './link-verifiers';
import { maximumRequestsPerPort } from './protocol';
import { SearchCommandSchema } from './search-protocol';
import type { SearchReply } from './search-protocol';

interface BoundProvider extends ProviderPort {
  invalidate(): void;
}
type ProviderFactory = (binding: SelectedDocumentBinding) => BoundProvider;

/** One engine per validated panel connection, sharing its in-process document capabilities. */
export class PanelSearchBroker {
  private readonly engine: KeywordSearch;
  private readonly providers = new Map<ProviderId, { scope: SessionScope; port: BoundProvider }>();
  private readonly seen = new Set<string>();
  private active: { request: SearchRequest; controller: AbortController } | undefined;
  private closed = false;

  constructor(
    private readonly access: AccessBroker,
    private readonly factories: Record<ProviderId, ProviderFactory>,
    private readonly send: (reply: SearchReply) => void,
  ) {
    this.engine = new KeywordSearch({
      linkVerifiers: providerLinkVerifiers,
      providers: (['chatgpt', 'google-ai-mode'] as const).map(
        (provider): Pick<ProviderPort, 'provider' | 'search'> => ({
          provider,
          search: async (request, context) => {
            const binding = access.bindSelectedDocument(request.scope);

            if (!binding)
              return {
                requestId: request.requestId,
                scope: request.scope,
                status: 'scope-changed',
              };

            let bound = this.providers.get(provider);

            if (!bound || !sameScope(bound.scope, request.scope)) {
              bound?.port.invalidate();
              bound = { scope: request.scope, port: this.factories[provider](binding) };
              this.providers.set(provider, bound);
            }

            return bound.port.search(request, context);
          },
        }),
      ),
    });
  }

  receive(input: unknown): boolean {
    const parsed = validate(SearchCommandSchema, input);

    if (!parsed.ok) return false;

    if (this.closed) return true;

    const command = parsed.value;

    if (command.operation === 'cancel-search') {
      if (this.active?.request.requestId === command.requestId) this.active.controller.abort();

      return true;
    }

    const request = command.request;

    if (this.seen.has(request.requestId) || this.seen.size >= maximumRequestsPerPort) {
      this.access.close();

      return true;
    }

    this.seen.add(request.requestId);
    this.active?.controller.abort();
    const run = { request, controller: new AbortController() };
    this.active = run;
    void this.engine
      .search(request, { signal: run.controller.signal })
      .then((outcome) => {
        if (this.closed || this.active !== run) return;

        this.active = undefined;
        this.send({ kind: 'search-result', outcome });
      })
      .catch(() => this.access.close());

    return true;
  }

  invalidate(provider: ProviderId): void {
    const bound = this.providers.get(provider);

    if (bound) {
      this.engine.invalidate(bound.scope);
      bound.port.invalidate();
      this.providers.delete(provider);
    }

    const scope = this.active?.request.scopes.find((scope) => scope.provider === provider);

    if (scope) this.engine.invalidate(scope);
  }

  close(): void {
    this.closed = true;
    this.active?.controller.abort();
    this.active = undefined;

    for (const provider of ['chatgpt', 'google-ai-mode'] as const) this.invalidate(provider);

    this.seen.clear();
  }
}
