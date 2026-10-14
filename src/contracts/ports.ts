import type { Candidate } from './conversation';
import type { SearchOutcome } from './outcome';
import type { ProviderId } from './primitives';
import type { ProviderRequest, SearchRequest } from './query';
import type { SessionScope } from './session';
import type { CacheEntry, CacheKey } from './storage';

export interface OperationContext {
  readonly signal: AbortSignal;
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

export interface ModelPort {
  interpret(request: SearchRequest, context: OperationContext): Promise<unknown>;
  rank(
    request: SearchRequest,
    candidates: readonly Candidate[],
    context: OperationContext,
  ): Promise<unknown>;
}

// No browser storage implementation or persistence is enabled by this port.
export interface StoragePort {
  read(key: CacheKey, context: OperationContext): Promise<unknown>;
  write(entry: CacheEntry, context: OperationContext): Promise<void>;
  clear(scope: CacheKey['scope'], context: OperationContext): Promise<void>;
}
