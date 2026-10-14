import * as v from 'valibot';
import { acceptsOriginalLink, CandidateListSchema, conversationKey } from './conversation';
import type { LinkVerifiers } from './conversation';
import {
  boundedArray,
  CandidateIdSchema,
  CountSchema,
  limits,
  RequestIdSchema,
  unique,
} from './primitives';
import {
  isRequestedScope,
  matchesDateRange,
  ProviderRequestSchema,
  SearchRequestSchema,
} from './query';
import type { ProviderRequest, SearchRequest } from './query';
import { sameScope, SessionScopeSchema } from './session';
import { requireValid } from './validation';

export const CoverageReasonSchema = v.picklist([
  'unknown-reach',
  'result-limit',
  'query-budget',
  'missing-evidence',
  'unknown-dates',
  'provider-failure',
]);

export const CoverageSchema = v.pipe(
  v.strictObject({
    extent: v.picklist(['complete', 'partial', 'unknown']),
    reasons: boundedArray(CoverageReasonSchema, 6),
  }),
  v.check((coverage) => unique(coverage.reasons), 'Duplicate coverage reasons.'),
  v.check(
    (coverage) => (coverage.extent === 'complete') === (coverage.reasons.length === 0),
    'Incomplete/unknown coverage needs an explicit reason; complete coverage cannot have limits.',
  ),
);

const outcomeEntries = { requestId: RequestIdSchema, scope: SessionScopeSchema };
const SuccessSchema = v.pipe(
  v.strictObject({
    ...outcomeEntries,
    status: v.literal('success'),
    candidates: CandidateListSchema,
    coverage: CoverageSchema,
  }),
  v.check(
    (outcome) => outcome.candidates.every((candidate) => sameScope(candidate.scope, outcome.scope)),
    'Candidates must belong to the outcome scope and generation.',
  ),
);

export const ProviderOutcomeSchema = v.variant('status', [
  SuccessSchema,
  v.strictObject({
    ...outcomeEntries,
    status: v.picklist([
      'login-expired',
      'permission-needed',
      'unavailable',
      'schema-changed',
      'timeout',
      'cancelled',
      'scope-changed',
      'interrupted',
    ]),
  }),
  v.strictObject({
    ...outcomeEntries,
    status: v.literal('rate-limited'),
    retryAfterMs: v.exactOptional(v.pipe(CountSchema, v.maxValue(limits.retryAfterMs))),
  }),
]);

export type Coverage = v.InferOutput<typeof CoverageSchema>;
export type ProviderOutcome = v.InferOutput<typeof ProviderOutcomeSchema>;

export function providerOutcomeSchemaFor(requestInput: ProviderRequest, verifiers: LinkVerifiers) {
  const request = requireValid(ProviderRequestSchema, requestInput);
  return v.pipe(
    ProviderOutcomeSchema,
    v.check(
      (outcome) =>
        outcome.requestId === request.requestId && sameScope(outcome.scope, request.scope),
      'Obsolete or out-of-scope provider outcome.',
    ),
    v.check(
      (outcome) =>
        outcome.status !== 'success' ||
        outcome.candidates.every((candidate) => acceptsOriginalLink(candidate, verifiers)),
      'Original links must pass the adapter policy.',
    ),
  );
}

export const SearchOutcomeSchema = v.pipe(
  v.strictObject({
    requestId: RequestIdSchema,
    state: v.picklist(['success', 'partial', 'failure', 'cancelled']),
    // IDs refer to unchanged candidates in successful provider outcomes.
    results: v.pipe(boundedArray(CandidateIdSchema, limits.candidates * 2), v.check(unique)),
    outcomes: v.pipe(boundedArray(ProviderOutcomeSchema, 2), v.minLength(1)),
    coverage: CoverageSchema,
  }),
  v.check(
    (aggregate) =>
      aggregate.outcomes.every((outcome) => outcome.requestId === aggregate.requestId) &&
      unique(aggregate.outcomes.map((outcome) => outcome.scope.provider)),
    'Independent provider outcomes must have one request ID and unique providers.',
  ),
  v.check((aggregate) => {
    const candidates = aggregate.outcomes.flatMap((outcome) =>
      outcome.status === 'success' ? outcome.candidates : [],
    );
    return (
      unique(candidates.map((candidate) => candidate.id)) &&
      unique(candidates.map(conversationKey)) &&
      aggregate.results.every((id) => candidates.some((candidate) => candidate.id === id))
    );
  }, 'Results must reference unique retrieved candidates.'),
  v.check((aggregate) => {
    const successes = aggregate.outcomes.filter((outcome) => outcome.status === 'success').length;
    const allCancelled = aggregate.outcomes.every((outcome) => outcome.status === 'cancelled');
    if (aggregate.state === 'cancelled') return allCancelled && aggregate.results.length === 0;
    if (aggregate.state === 'failure') return successes === 0 && !allCancelled;
    if (aggregate.state === 'partial')
      return successes > 0 && successes < aggregate.outcomes.length;
    return successes === aggregate.outcomes.length;
  }, 'Terminal state must reflect actual provider success/failure.'),
  v.check((aggregate) => {
    const failures = aggregate.outcomes.some((outcome) => outcome.status !== 'success');
    const reasons = aggregate.outcomes.flatMap((outcome) =>
      outcome.status === 'success' ? outcome.coverage.reasons : ['provider-failure' as const],
    );
    return (
      reasons.every((reason) => aggregate.coverage.reasons.includes(reason)) &&
      (!failures || aggregate.coverage.extent !== 'complete')
    );
  }, 'Aggregate coverage cannot hide provider failures or reported limits.'),
);

export type SearchOutcome = v.InferOutput<typeof SearchOutcomeSchema>;

export function searchOutcomeSchemaFor(requestInput: SearchRequest, verifiers: LinkVerifiers) {
  const request = requireValid(SearchRequestSchema, requestInput);
  return v.pipe(
    SearchOutcomeSchema,
    v.check(
      (aggregate) =>
        aggregate.requestId === request.requestId &&
        aggregate.outcomes.length === request.scopes.length &&
        aggregate.outcomes.every((outcome) => isRequestedScope(request, outcome.scope)),
      'All selected provider scopes/generations must report an outcome for this request.',
    ),
    v.check((aggregate) => {
      const candidates = aggregate.outcomes.flatMap((outcome) =>
        outcome.status === 'success' ? outcome.candidates : [],
      );
      const selected = new Set(aggregate.results);
      const unknownDates =
        request.query.dateRange && candidates.some((candidate) => !candidate.date);
      return (
        candidates.every((candidate) => acceptsOriginalLink(candidate, verifiers)) &&
        candidates.every(
          (candidate) =>
            !selected.has(candidate.id) || matchesDateRange(candidate, request.query.dateRange),
        ) &&
        (!unknownDates || aggregate.coverage.reasons.includes('unknown-dates'))
      );
    }, 'Results must obey link/date policies and disclose excluded unknown dates.'),
  );
}
