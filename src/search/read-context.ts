import { matchesDateRange, limits } from '../contracts';
import type {
  ConversationContextPort,
  LinkVerifiers,
  OperationContext,
  ProviderOutcome,
  ProviderRequest,
} from '../contracts';
import { normalizeProviderOutcome } from './normalize';
import { contextDeadlineMs, contextReadLimit } from './context';
import { descriptionWords } from './terms';

/** The trusted worker chooses targets only from this request's validated native result inventory. */
export async function readProviderContext(
  port: Partial<ConversationContextPort>,
  request: ProviderRequest,
  input: unknown,
  description: string,
  verifiers: LinkVerifiers,
  context: OperationContext,
  visited = new Set<string>(),
): Promise<ProviderOutcome> {
  const original = normalizeProviderOutcome(input, request, verifiers);

  if (original.status !== 'success' || original.candidates.length === 0) return original;

  const candidates = structuredClone(original.candidates);
  const terms = new Set(descriptionWords(description));
  const words = candidates.map(
    (candidate) => new Set(candidate.evidence.flatMap((item) => descriptionWords(item.text))),
  );
  const weights = new Map(
    [...terms].map((term) => [term, 1 / Math.max(1, words.filter((set) => set.has(term)).length)]),
  );
  const score = (candidate: (typeof candidates)[number]) =>
    [...terms].reduce(
      (total, term) =>
        total + (words[candidates.indexOf(candidate)]?.has(term) ? (weights.get(term) ?? 0) : 0),
      0,
    );
  const selected = candidates
    .filter(
      (candidate) =>
        matchesDateRange(candidate, request.query.dateRange) &&
        !visited.has(candidate.conversationId),
    )
    .toSorted((a, b) => score(b) - score(a))
    .slice(0, contextReadLimit);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context.signal.addEventListener('abort', cancel, { once: true });
  const interrupted = new Promise<undefined>((resolve) => {
    controller.signal.onabort = () => resolve(undefined);
  });
  const timer = setTimeout(cancel, contextDeadlineMs);
  const result = {
    ...original,
    candidates,
    coverage: {
      extent: original.coverage.extent === 'unknown' ? ('unknown' as const) : ('partial' as const),
      reasons: [...new Set([...original.coverage.reasons, 'missing-evidence' as const])],
    },
  };

  try {
    for (const candidate of selected) {
      if (context.signal.aborted || controller.signal.aborted || !port.readContext) break;

      visited.add(candidate.conversationId);
      let raw: unknown;

      try {
        raw = await Promise.race([
          port.readContext(structuredClone(request), candidate.conversationId, description, {
            signal: controller.signal,
          }),
          interrupted,
        ]);
      } catch {
        continue;
      }

      if (controller.signal.aborted) break;

      const outcome = normalizeProviderOutcome(raw, request, verifiers);

      if (outcome.status !== 'success') {
        if (['scope-changed', 'login-expired', 'permission-needed'].includes(outcome.status))
          return outcome;

        if (outcome.status === 'rate-limited')
          result.rateLimit =
            outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs };

        if (outcome.status === 'rate-limited') break;

        continue;
      }

      const enriched = outcome.candidates[0];

      if (
        outcome.candidates.length !== 1 ||
        !enriched ||
        ['id', 'conversationId', 'title', 'date', 'originalUrl'].some(
          (field) =>
            JSON.stringify(enriched[field as keyof typeof enriched]) !==
            JSON.stringify(candidate[field as keyof typeof candidate]),
        )
      )
        break;

      // A context read can add messages and the unchanged title, never relabel invented snippets.
      if (
        enriched.evidence.some(
          (item) =>
            item.source === 'native-snippet' &&
            !candidate.evidence.some(
              (existing) =>
                existing.source === item.source &&
                existing.id === item.id &&
                existing.text === item.text,
            ),
        )
      )
        break;

      candidates[candidates.indexOf(candidate)] = enriched;
    }

    if (context.signal.aborted)
      return { requestId: request.requestId, scope: request.scope, status: 'cancelled' };

    // Give read targets their evidence budget first, retaining original inventory order/metadata.
    const targets = new Set(selected.map((item) => item.id));
    let remaining = limits.totalEvidence;

    for (const candidate of candidates.toSorted(
      (a, b) => Number(targets.has(b.id)) - Number(targets.has(a.id)),
    ))
      candidate.evidence = candidate.evidence.filter((item) => {
        if (item.text.length > remaining) return false;

        remaining -= item.text.length;

        return true;
      });

    return result;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', cancel);
    controller.signal.onabort = null;
  }
}
