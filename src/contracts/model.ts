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
  boundedArray(boundedText(limits.term), limits.planTerms),
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

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  return v.pipe(
    ModelRankingSchema,
    v.check(
      (ranking) =>
        request.query.mode === 'description' &&
        ranking.requestId === request.requestId &&
        ranking.selections.every((selection) => {
          const candidate = byId.get(selection.candidateId);

          return (
            candidate !== undefined &&
            selection.evidenceIds.every((id) =>
              candidate.evidence.some((evidence) => evidence.id === id),
            )
          );
        }),
      'Model selections must reference retrieved candidates and their own evidence.',
    ),
  );
}
