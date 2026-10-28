import {
  CandidateIdSchema,
  EvidenceIdSchema,
  conversationKey,
  limits,
  matchesDateRange,
  requireValid,
} from '../contracts';
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

function unusedId(used: ReadonlySet<string>, prefix: string): string {
  let ordinal = used.size;

  while (used.has(`${prefix}:${ordinal}`)) ordinal++;

  return `${prefix}:${ordinal}`;
}

/** Repeated native searches keep the first stable candidate ID and merge only scoped evidence. */
export function collect(
  previous: ProviderOutcome | undefined,
  incoming: ProviderOutcome,
  request: ProviderRequest,
  verifiers: LinkVerifiers,
): ProviderOutcome {
  const next = { ...incoming, requestId: request.requestId };

  if (next.status === 'success' && request.query.dateRange) {
    if (next.candidates.some((candidate) => candidate.date === undefined))
      next.coverage = limitedCoverage(next.coverage, 'unknown-dates');

    next.candidates = next.candidates.filter((candidate) =>
      matchesDateRange(candidate, request.query.dateRange),
    );
  }

  if (!previous || previous.status !== 'success') return next;

  if (next.status !== 'success') {
    if (['scope-changed', 'login-expired', 'permission-needed'].includes(next.status)) return next;

    return {
      ...previous,
      coverage: limitedCoverage(previous.coverage, 'provider-failure'),
      ...(next.status === 'rate-limited'
        ? { rateLimit: next.retryAfterMs === undefined ? {} : { retryAfterMs: next.retryAfterMs } }
        : {}),
    };
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

  for (const incomingCandidate of next.candidates) {
    const candidate = structuredClone(incomingCandidate);
    const original = candidates.find(
      (item) => conversationKey(item) === conversationKey(candidate),
    );

    // Adapter IDs belong to one keyword response. Reordering/index reuse across searches is valid;
    // canonicalize by scoped conversation before assigning aggregate references.
    if (original) {
      candidate.id = original.id;
      const used = new Set([...original.evidence, ...candidate.evidence].map((item) => item.id));
      candidate.evidence = candidate.evidence.map((item) => {
        const previous = original.evidence.find((part) => part.id === item.id);

        if (!previous || (previous.text === item.text && previous.source === item.source))
          return item;

        const id = requireValid(EvidenceIdSchema, unusedId(used, 'description:evidence'));
        used.add(id);

        return { ...item, id };
      });
    } else if (candidates.some((item) => item.id === candidate.id)) {
      candidate.id = requireValid(
        CandidateIdSchema,
        unusedId(
          new Set(candidates.map((item) => item.id)),
          `description:${request.scope.provider}`,
        ),
      );
    }

    if (original) {
      const existing = candidates.indexOf(original);
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

  const retryAfterMs = Math.max(
    previous.rateLimit?.retryAfterMs ?? 0,
    next.rateLimit?.retryAfterMs ?? 0,
  );

  return {
    ...next,
    candidates,
    coverage,
    ...(previous.rateLimit || next.rateLimit
      ? { rateLimit: retryAfterMs > 0 ? { retryAfterMs } : {} }
      : {}),
  };
}
