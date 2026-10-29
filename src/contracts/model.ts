import * as v from 'valibot';
import { CandidateListSchema } from './conversation';
import type { Candidate } from './conversation';
import {
  boundedArray,
  boundedText,
  CandidateIdSchema,
  EvidenceIdSchema,
  limits,
  RequestIdSchema,
  CountSchema,
  unique,
} from './primitives';
import {
  DateRangeSchema,
  isRequestedScope,
  matchesDateRange,
  ProviderSelectionSchema,
  SearchRequestSchema,
} from './query';
import type { SearchRequest } from './query';
import { requireValid } from './validation';

const TermsSchema = v.pipe(
  boundedArray(
    v.pipe(
      boundedText(limits.term),
      v.check((term) => !/\p{Cc}/u.test(term)),
    ),
    limits.planTerms,
  ),
  v.check(unique, 'Duplicate model terms.'),
);

export const ModelPlanSchema = v.strictObject({
  requestId: RequestIdSchema,
  topics: v.pipe(TermsSchema, v.minLength(1)),
  keywords: TermsSchema,
  proposedProviders: v.exactOptional(ProviderSelectionSchema),
  proposedDateRange: v.exactOptional(DateRangeSchema),
});

export const ModelRankingSchema = v.strictObject({
  requestId: RequestIdSchema,
  selections: v.pipe(
    boundedArray(
      v.strictObject({
        candidateId: CandidateIdSchema,
        score: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
        evidenceIds: v.pipe(
          boundedArray(EvidenceIdSchema, limits.evidencePerCandidate),
          v.minLength(1),
          v.check(unique, 'Duplicate evidence references.'),
        ),
        spans: v.exactOptional(
          v.pipe(
            boundedArray(
              v.strictObject({
                evidenceId: EvidenceIdSchema,
                start: CountSchema,
                end: CountSchema,
              }),
              limits.evidencePerCandidate,
            ),
            v.minLength(1),
            v.check((spans) => unique(spans.map((span) => span.evidenceId))),
          ),
        ),
      }),
      limits.candidates,
    ),
    v.check(
      (selections) => unique(selections.map((selection) => selection.candidateId)),
      'Duplicate selections.',
    ),
  ),
});

export type ModelPlan = v.InferOutput<typeof ModelPlanSchema>;
export type ModelRanking = v.InferOutput<typeof ModelRankingSchema>;

// Allowlisted diagnostics only: browser exception messages and model responses may contain data.
export const ModelApiErrorNameSchema = v.picklist([
  'AbortError',
  'InvalidStateError',
  'NotAllowedError',
  'NotSupportedError',
  'OperationError',
  'QuotaExceededError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'UnknownError',
]);
export const ModelFailureSchema = v.strictObject({
  phase: v.picklist(['prepare', 'measure', 'prompt', 'parse', 'validate']),
  code: v.picklist([
    'unavailable',
    'busy',
    'prompt-limit',
    'context-limit',
    'timeout',
    'cancelled',
    'api-error',
    'response-limit',
    'invalid-json',
    'invalid-output',
  ]),
  apiError: v.exactOptional(ModelApiErrorNameSchema),
});
export type ModelFailure = v.InferOutput<typeof ModelFailureSchema>;

// Offsets use UTF-16, like String.slice; reject splits inside a surrogate pair.
export function rankingReferencesCandidates(
  ranking: Pick<ModelRanking, 'selections'>,
  candidates: readonly Candidate[],
): boolean {
  return ranking.selections.every((selection) => {
    const candidate = candidates.find((item) => item.id === selection.candidateId);

    return (
      candidate !== undefined &&
      selection.evidenceIds.every((id) => candidate.evidence.some((item) => item.id === id)) &&
      (selection.spans === undefined ||
        selection.spans.every((span) => {
          const evidence = candidate.evidence.find((item) => item.id === span.evidenceId);

          return (
            selection.evidenceIds.includes(span.evidenceId) &&
            evidence !== undefined &&
            span.start < span.end &&
            span.end <= evidence.text.length &&
            !/[\uDC00-\uDFFF]/u.test(evidence.text.charAt(span.start)) &&
            !/[\uDC00-\uDFFF]/u.test(evidence.text.charAt(span.end))
          );
        }))
    );
  });
}

export const DescriptionReportSchema = v.strictObject({
  strategy: v.picklist(['keyword-topic-fallback', 'model-assisted']),
  terms: v.pipe(
    boundedArray(boundedText(limits.term), limits.planTerms * 2),
    v.minLength(1),
    v.check(unique),
  ),
  notices: v.pipe(
    boundedArray(
      v.picklist([
        'literal-keywords',
        'ambiguous-date',
        'explicit-date-precedence',
        'model-unavailable',
        'invalid-model-output',
        'model-timeout',
      ]),
      6,
    ),
    v.check(unique),
  ),
  dateRange: v.exactOptional(DateRangeSchema),
  ranking: ModelRankingSchema,
  execution: v.exactOptional(
    v.strictObject({
      interpretation: v.strictObject({
        status: v.picklist(['unavailable', 'completed', 'failed', 'timeout']),
        promptCalls: CountSchema,
        failure: v.exactOptional(ModelFailureSchema),
      }),
      matching: v.strictObject({
        status: v.picklist(['unavailable', 'completed', 'failed', 'timeout', 'no-candidates']),
        promptCalls: CountSchema,
        failure: v.exactOptional(ModelFailureSchema),
      }),
      candidates: v.pipe(CountSchema, v.maxValue(limits.candidates)),
      messageCandidates: v.pipe(CountSchema, v.maxValue(limits.candidates)),
    }),
  ),
});
export type DescriptionReport = v.InferOutput<typeof DescriptionReportSchema>;

export function modelPlanSchemaFor(requestInput: SearchRequest) {
  const request = requireValid(SearchRequestSchema, requestInput);

  return v.pipe(
    ModelPlanSchema,
    v.check((plan) => {
      const date = request.query.dateRange;
      const proposedDate = plan.proposedDateRange;
      const providers = plan.proposedProviders;

      return (
        request.query.mode === 'description' &&
        plan.requestId === request.requestId &&
        (!providers ||
          (providers.length === request.query.providers.length &&
            providers.every((provider) => request.query.providers.includes(provider)))) &&
        (!date ||
          !proposedDate ||
          (date.start === proposedDate.start && date.end === proposedDate.end))
      );
    }, 'Model suggestions cannot replace explicit filters or the active request.'),
  );
}

export function modelRankingSchemaFor(
  requestInput: SearchRequest,
  candidateInput: readonly Candidate[],
) {
  const request = requireValid(SearchRequestSchema, requestInput);
  const candidates = requireValid(CandidateListSchema, candidateInput);

  if (
    !candidates.every(
      (candidate) =>
        isRequestedScope(request, candidate.scope) &&
        matchesDateRange(candidate, request.query.dateRange),
    )
  ) {
    throw new Error('Invalid contract context.');
  }

  return v.pipe(
    ModelRankingSchema,
    v.check(
      (ranking) =>
        request.query.mode === 'description' &&
        ranking.requestId === request.requestId &&
        rankingReferencesCandidates(ranking, candidates),
      'Model selections must reference retrieved candidates and their own evidence.',
    ),
  );
}
