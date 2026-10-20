import type { Candidate } from './conversation';
import type { SearchOutcome } from './outcome';
import type { ProviderId } from './primitives';
import type { ProviderRequest, SearchRequest } from './query';
import type { SessionScope } from './session';
import type { CacheEntry, CacheKey } from './storage';

export interface OperationContext {
  readonly signal: AbortSignal;
}

export interface ModelOperationContext extends OperationContext {
  /** Notify immediately before each actual model prompt, including failed calls. No prompt text. */
  readonly onPrompt?: () => void;
}

// Boundary outputs remain unknown until the caller applies the contextual runtime schema.
// Interfaces do not implement transport, cancellation, model consent, or storage opt-in policy.
export interface ProviderPort {
  readonly provider: ProviderId;
  inspectSession(context: OperationContext): Promise<unknown>;
  search(request: ProviderRequest, context: OperationContext): Promise<unknown>;
}

export interface SearchPort {
  search(request: SearchRequest, context: OperationContext): Promise<SearchOutcome>;
  invalidate(scope: SessionScope): void;
}

export interface ContextRetrievalPort {
  searchWithContext(
    request: SearchRequest,
    description: string,
    context: OperationContext,
    groupId?: SearchRequest['requestId'],
  ): Promise<SearchOutcome>;
  releaseContext?(groupId: SearchRequest['requestId']): void;
}

export interface ConversationContextPort {
  readContext(
    request: ProviderRequest,
    conversationId: string,
    description: string,
    context: OperationContext,
  ): Promise<unknown>;
}

export interface InterpreterPort {
  interpret(request: SearchRequest, context: ModelOperationContext): Promise<unknown>;
}

export interface RankerPort {
  rank(
    request: SearchRequest,
    candidates: readonly Candidate[],
    context: ModelOperationContext,
  ): Promise<unknown>;
}

export interface ModelPort extends InterpreterPort, RankerPort {}

// No browser storage implementation or persistence is enabled by this port.
export interface StoragePort {
  read(key: CacheKey, context: OperationContext): Promise<unknown>;
  write(entry: CacheEntry, context: OperationContext): Promise<void>;
  clear(scope: CacheKey['scope'], context: OperationContext): Promise<void>;
}
