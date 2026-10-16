import { matchesDateRange, requireValid, searchOutcomeSchemaFor } from '../contracts';
import type {
  Coverage,
  LinkVerifiers,
  ProviderOutcome,
  SearchOutcome,
  SearchRequest,
} from '../contracts';

// Provider order, then native result order. Arrival order never changes the output.
export function aggregateSearch(
  request: SearchRequest,
  outcomes: ProviderOutcome[],
  verifiers: LinkVerifiers,
  maxResults: number,
  extraReasons: Coverage['reasons'],
): SearchOutcome {
  const ids = new Set<string>();
  const independent = outcomes.map((outcome): ProviderOutcome => {
    if (outcome.status !== 'success') return outcome;

    // IDs are opaque references. Never let one provider alias another provider's evidence.
    if (outcome.candidates.some((candidate) => ids.has(candidate.id)))
      return { requestId: request.requestId, scope: outcome.scope, status: 'schema-changed' };

    outcome.candidates.forEach((candidate) => ids.add(candidate.id));

    return outcome;
  });
  const successes = independent.filter((outcome) => outcome.status === 'success');
  const candidates = successes.flatMap((outcome) => outcome.candidates);
  const matching = candidates.filter((candidate) =>
    matchesDateRange(candidate, request.query.dateRange),
  );
  const reasons = new Set<Coverage['reasons'][number]>(extraReasons);

  for (const outcome of independent) {
    if (outcome.status === 'success')
      outcome.coverage.reasons.forEach((reason) => reasons.add(reason));
    else reasons.add('provider-failure');
  }

  if (request.query.dateRange && candidates.some((candidate) => candidate.date === undefined))
    reasons.add('unknown-dates');

  if (matching.length > maxResults) reasons.add('result-limit');

  const allSucceeded = successes.length === independent.length;
  const allCancelled = independent.every((outcome) => outcome.status === 'cancelled');
  const extent: Coverage['extent'] =
    reasons.size === 0
      ? 'complete'
      : independent.some(
            (outcome) => outcome.status === 'success' && outcome.coverage.extent === 'unknown',
          )
        ? 'unknown'
        : 'partial';

  return requireValid(searchOutcomeSchemaFor(request, verifiers), {
    requestId: request.requestId,
    state: allCancelled
      ? 'cancelled'
      : allSucceeded
        ? 'success'
        : successes.length
          ? 'partial'
          : 'failure',
    results: matching.slice(0, maxResults).map((candidate) => candidate.id),
    outcomes: independent,
    coverage: { extent, reasons: [...reasons] },
  });
}
