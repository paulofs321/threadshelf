import * as v from 'valibot';
import { ProviderOutcomeSchema } from '../../contracts/outcome';
import type { ProviderOutcome } from '../../contracts/outcome';
import type { OperationContext, ProviderPort } from '../../contracts/ports';
import { ProviderRequestSchema } from '../../contracts/query';
import type { ProviderRequest } from '../../contracts/query';
import { sameScope, SessionScopeSchema } from '../../contracts/session';
import type { SessionOutcome, SessionScope } from '../../contracts/session';
import { requireValid } from '../../contracts/validation';
import { chatGptAvailability } from './availability';

const ChatGptScopeSchema = v.pipe(
  SessionScopeSchema,
  v.check((scope) => scope.provider === 'chatgpt'),
);
const ChatGptRequestSchema = v.pipe(
  ProviderRequestSchema,
  v.check((request) => request.scope.provider === 'chatgpt'),
);

// A selected browser document and a structurally valid scope do not prove authentication.
// Until live contracts are established this boundary has no network or browser dependency.
export class ChatGptProvider implements ProviderPort {
  readonly provider = 'chatgpt' as const;
  readonly availability = chatGptAvailability;
  private readonly selectedScope: SessionScope;
  private invalidated = false;

  constructor(scope: SessionScope) {
    // Runtime parsing also snapshots the caller's scope; later mutation cannot rebind this instance.
    this.selectedScope = requireValid(ChatGptScopeSchema, scope);
  }

  async inspectSession(_context: OperationContext): Promise<SessionOutcome> {
    return {
      status: this.invalidated ? 'scope-changed' : 'unavailable',
      provider: this.provider,
      generation: this.selectedScope.generation,
    };
  }

  async search(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    const request = requireValid(ChatGptRequestSchema, input);
    const status = context.signal.aborted
      ? 'cancelled'
      : this.invalidated || !sameScope(request.scope, this.selectedScope)
        ? 'scope-changed'
        : 'unavailable';
    // Failure outcomes retain correlation but cannot carry candidates, coverage or private query text.
    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      status,
    });
  }

  // The owner must retire an instance on account/workspace/document changes; reconnect creates a new one.
  invalidate(): void {
    this.invalidated = true;
  }
}
