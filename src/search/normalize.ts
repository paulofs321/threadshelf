import * as v from 'valibot';
import {
  acceptsOriginalLink,
  boundedArray,
  CandidateSchema,
  conversationKey,
  CoverageSchema,
  limits,
  ProviderOutcomeSchema,
  providerOutcomeSchemaFor,
  RequestIdSchema,
  sameScope,
  SessionScopeSchema,
  validate,
} from '../contracts';
import type { Candidate, LinkVerifiers, ProviderOutcome, ProviderRequest } from '../contracts';

// Validate every member and the total text budget before coalescing repeated conversations.
// The public ProviderOutcomeSchema remains stricter: its final inventory must be distinct.
const BatchSchema = v.union([
  v.strictObject({
    requestId: RequestIdSchema,
    scope: SessionScopeSchema,
    status: v.literal('success'),
    candidates: v.pipe(
      boundedArray(CandidateSchema, limits.candidates),
      v.check(
        (candidates) =>
          candidates.reduce(
            (total, candidate) =>
              total + candidate.evidence.reduce((sum, item) => sum + item.text.length, 0),
            0,
          ) <= limits.totalEvidence,
      ),
    ),
    coverage: CoverageSchema,
  }),
  ProviderOutcomeSchema,
]);

export function normalizeProviderOutcome(
  input: unknown,
  request: ProviderRequest,
  verifiers: LinkVerifiers,
): ProviderOutcome {
  const failure: ProviderOutcome = {
    requestId: request.requestId,
    scope: request.scope,
    status: 'schema-changed',
  };
  const parsed = validate(BatchSchema, input);

  if (!parsed.ok) return failure;

  const outcome = parsed.value;

  if (outcome.requestId !== request.requestId || !sameScope(outcome.scope, request.scope))
    return failure;

  if (outcome.status !== 'success') return outcome;

  const conversations = new Map<string, Candidate>();
  const ids = new Map<string, string>();
  let limited = false;

  for (const candidate of outcome.candidates) {
    if (!sameScope(candidate.scope, request.scope) || !acceptsOriginalLink(candidate, verifiers))
      return failure;

    const key = conversationKey(candidate);
    const previousKey = ids.get(candidate.id);

    if (previousKey !== undefined && previousKey !== key) return failure;

    ids.set(candidate.id, key);
    const previous = conversations.get(key);

    if (!previous) {
      conversations.set(key, candidate);

      continue;
    }

    // Missing metadata can be filled from the same scoped conversation; conflicts fail closed.
    for (const field of ['title', 'originalUrl', 'date'] as const) {
      if (
        previous[field] !== undefined &&
        candidate[field] !== undefined &&
        JSON.stringify(previous[field]) !== JSON.stringify(candidate[field])
      )
        return failure;
    }

    if (previous.title === undefined && candidate.title !== undefined)
      previous.title = candidate.title;

    if (previous.originalUrl === undefined && candidate.originalUrl !== undefined)
      previous.originalUrl = candidate.originalUrl;

    if (previous.date === undefined && candidate.date !== undefined) previous.date = candidate.date;

    for (const evidence of candidate.evidence) {
      const sameId = previous.evidence.find((item) => item.id === evidence.id);

      if (sameId && (sameId.source !== evidence.source || sameId.text !== evidence.text))
        return failure;

      if (
        previous.evidence.some(
          (item) => item.source === evidence.source && item.text === evidence.text,
        )
      )
        continue;

      if (previous.evidence.length >= limits.evidencePerCandidate) limited = true;
      else previous.evidence.push(evidence);
    }
  }

  if (limited) {
    outcome.coverage.extent = outcome.coverage.extent === 'unknown' ? 'unknown' : 'partial';

    if (!outcome.coverage.reasons.includes('missing-evidence'))
      outcome.coverage.reasons.push('missing-evidence');
  }

  const normalized = validate(providerOutcomeSchemaFor(request, verifiers), {
    ...outcome,
    candidates: [...conversations.values()],
  });

  return normalized.ok ? normalized.value : failure;
}
