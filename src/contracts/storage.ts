import * as v from 'valibot';
import { acceptsOriginalLink, CandidateSchema } from './conversation';
import type { LinkVerifiers } from './conversation';
import { limits, TimestampSchema } from './primitives';
import { sameScope, VerifiedScopeSchema } from './session';
import type { VerifiedScope } from './session';
import { requireValid } from './validation';

export const CacheKeySchema = v.strictObject({
  version: v.literal(1),
  scope: VerifiedScopeSchema,
});

export const CacheEntrySchema = v.pipe(
  v.strictObject({
    key: CacheKeySchema,
    candidate: CandidateSchema,
    cachedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  }),
  v.check((entry) => sameScope(entry.key.scope, entry.candidate.scope), 'Cache scope mismatch.'),
  v.check((entry) => {
    const ttl = Date.parse(entry.expiresAt) - Date.parse(entry.cachedAt);

    return ttl > 0 && ttl <= limits.cacheTtlMs;
  }, 'Cache lifetime must be positive and bounded.'),
);

export type CacheKey = v.InferOutput<typeof CacheKeySchema>;
export type CacheEntry = v.InferOutput<typeof CacheEntrySchema>;

// A future opt-in cache must validate reads against current scope and a caller-supplied clock.
export function cacheEntrySchemaFor(
  scopeInput: VerifiedScope,
  nowInput: string,
  verifiers: LinkVerifiers,
) {
  const scope = requireValid(VerifiedScopeSchema, scopeInput);
  const now = requireValid(TimestampSchema, nowInput);

  return v.pipe(
    CacheEntrySchema,
    v.check(
      (entry) =>
        sameScope(entry.key.scope, scope) &&
        entry.cachedAt <= now &&
        entry.expiresAt > now &&
        acceptsOriginalLink(entry.candidate, verifiers),
      'Cache entry is stale, expired, from the future, or has an unverified link.',
    ),
  );
}
