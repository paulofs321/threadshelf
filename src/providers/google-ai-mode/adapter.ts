import * as v from 'valibot';
import { ProviderOutcomeSchema } from '../../contracts/outcome';
import type { ProviderOutcome } from '../../contracts/outcome';
import type { OperationContext, ProviderPort } from '../../contracts/ports';
import { ProviderRequestSchema } from '../../contracts/query';
import type { ProviderRequest } from '../../contracts/query';
import { sameScope, SessionScopeSchema } from '../../contracts/session';
import type { SessionOutcome, SessionScope } from '../../contracts/session';
import { requireValid } from '../../contracts/validation';
import { googleAiModeAvailability } from './availability';

const GoogleAiModeScopeSchema = v.pipe(
  SessionScopeSchema,
  v.check((scope) => scope.provider === 'google-ai-mode'),
);
const GoogleAiModeRequestSchema = v.pipe(
  ProviderRequestSchema,
  v.check((request) => request.scope.provider === 'google-ai-mode'),
);

// Historical endpoint names/counts do not establish current schemas or account ownership.
// Keep transport unavailable until native and actual extension reads have been verified.
export class GoogleAiModeProvider implements ProviderPort {
  readonly provider = 'google-ai-mode' as const;
  readonly availability = googleAiModeAvailability;
  private readonly selectedScope: SessionScope;
  private invalidated = false;

  constructor(scope: SessionScope) {
    // Parsing snapshots the normalized selection; caller mutation cannot rebind this instance.
    this.selectedScope = requireValid(GoogleAiModeScopeSchema, scope);
  }

  async inspectSession(_context: OperationContext): Promise<SessionOutcome> {
    return {
      status: this.invalidated ? 'scope-changed' : 'unavailable',
      provider: this.provider,
      generation: this.selectedScope.generation,
    };
  }

  async search(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    const request = requireValid(GoogleAiModeRequestSchema, input);
    const status = context.signal.aborted
      ? 'cancelled'
      : this.invalidated || !sameScope(request.scope, this.selectedScope)
        ? 'scope-changed'
        : 'unavailable';
    // A failure preserves correlation without fabricating snippets, URLs, dates or coverage.
    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      status,
    });
  }

  // Lifecycle owners must retire this instance on account/document changes and create a new one.
  // This is an invalidation seam, not an observer of the Google account or browser context.
  invalidate(): void {
    this.invalidated = true;
  }
}
