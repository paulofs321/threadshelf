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

/** The trusted worker chooses targets only from this request's validated native result inventory. */
export async function readProviderContext(
  port: Partial<ConversationContextPort>,
  request: ProviderRequest,
  input: unknown,
  description: string,
  verifiers: LinkVerifiers,
  context: OperationContext,
): Promise<ProviderOutcome> {
  const original = normalizeProviderOutcome(input, request, verifiers);

  if (original.status !== 'success' || original.candidates.length === 0) return original;

  const candidates = structuredClone(original.candidates);
  const selected = candidates
    .filter((candidate) => matchesDateRange(candidate, request.query.dateRange))
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

      let raw: unknown;

      try {
        raw = await Promise.race([
          port.readContext(structuredClone(request), candidate.conversationId, description, {
            signal: controller.signal,
          }),
          interrupted,
        ]);
      } catch {
        break;
      }

      if (controller.signal.aborted) break;

      const outcome = normalizeProviderOutcome(raw, request, verifiers);

      if (outcome.status !== 'success') {
        if (['scope-changed', 'login-expired', 'permission-needed'].includes(outcome.status))
          return outcome;

        if (outcome.status === 'rate-limited')
          result.rateLimit =
            outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs };

        break;
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
