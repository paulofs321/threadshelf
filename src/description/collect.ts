import { conversationKey, limits } from '../contracts';
import type {
  Candidate,
  Coverage,
  LinkVerifiers,
  ProviderOutcome,
  ProviderRequest,
} from '../contracts';
import { normalizeProviderOutcome } from '../search/normalize';

export function limitedCoverage(coverage: Coverage, reason: Coverage['reasons'][number]): Coverage {
  return {
    extent: coverage.extent === 'unknown' ? 'unknown' : 'partial',
    reasons: [...new Set([...coverage.reasons, reason])],
  };
}

/** Repeated native searches keep the first stable candidate ID and merge only scoped evidence. */
export function collect(
  previous: ProviderOutcome | undefined,
  incoming: ProviderOutcome,
  request: ProviderRequest,
  verifiers: LinkVerifiers,
): ProviderOutcome {
  const next = { ...incoming, requestId: request.requestId };

  if (!previous || previous.status !== 'success') return next;

  if (next.status !== 'success') {
    if (['scope-changed', 'login-expired', 'permission-needed'].includes(next.status)) return next;

    return { ...previous, coverage: limitedCoverage(previous.coverage, 'provider-failure') };
  }

  const candidates: Candidate[] = structuredClone(previous.candidates);
  let coverage: Coverage = {
    extent:
      previous.coverage.extent === 'unknown' || next.coverage.extent === 'unknown'
        ? 'unknown'
        : previous.coverage.extent === 'partial' || next.coverage.extent === 'partial'
          ? 'partial'
          : 'complete',
    reasons: [...new Set([...previous.coverage.reasons, ...next.coverage.reasons])],
  };

  for (const candidate of next.candidates) {
    const existing = candidates.findIndex(
      (item) => conversationKey(item) === conversationKey(candidate),
    );
    const collision = candidates.find((item) => item.id === candidate.id);

    if (collision && conversationKey(collision) !== conversationKey(candidate))
      return { requestId: request.requestId, scope: request.scope, status: 'schema-changed' };

    if (existing >= 0) {
      const original = candidates[existing];
      const merged = normalizeProviderOutcome(
        { ...next, candidates: [original, candidate] },
        request,
        verifiers,
      );

      if (merged.status !== 'success') return merged;

      for (const replacement of merged.candidates) {
        const size =
          candidates.reduce(
            (sum, item, index) =>
              sum +
              (index === existing ? 0 : item.evidence.reduce((n, part) => n + part.text.length, 0)),
            0,
          ) + replacement.evidence.reduce((sum, item) => sum + item.text.length, 0);

        if (size <= limits.totalEvidence) candidates[existing] = replacement;
        else coverage = limitedCoverage(coverage, 'missing-evidence');
      }

      for (const reason of merged.coverage.reasons) coverage = limitedCoverage(coverage, reason);
    } else {
      const size = [...candidates, candidate].reduce(
        (sum, item) => sum + item.evidence.reduce((n, part) => n + part.text.length, 0),
        0,
      );

      if (candidates.length >= limits.candidates || size > limits.totalEvidence)
        coverage = limitedCoverage(coverage, 'result-limit');
      else candidates.push(candidate);
    }
  }

  return { ...next, candidates, coverage };
}
