import * as v from 'valibot';
import {
  boundedArray,
  boundedText,
  CandidateIdSchema,
  ConversationIdSchema,
  EvidenceIdSchema,
  limits,
  OriginalUrlSchema,
  TimestampSchema,
  unique,
} from './primitives';
import type { ConversationId, ProviderId } from './primitives';
import { SessionScopeSchema, scopeKey } from './session';

export const EvidenceSchema = v.strictObject({
  id: EvidenceIdSchema,
  text: boundedText(limits.excerpt),
  source: v.picklist(['title', 'native-snippet', 'rendered-message', 'provider-message']),
});

export const ConversationDateSchema = v.pipe(
  v.strictObject({
    at: TimestampSchema,
    meaning: v.picklist(['conversation-created', 'conversation-updated', 'message-sent']),
    source: v.picklist(['provider-metadata', 'rendered-message']),
  }),
  v.check(
    (date) => date.source !== 'rendered-message' || date.meaning === 'message-sent',
    'Rendered messages cannot establish conversation creation/update dates.',
  ),
);

export const CandidateSchema = v.pipe(
  v.strictObject({
    id: CandidateIdSchema,
    scope: SessionScopeSchema,
    conversationId: ConversationIdSchema,
    originalUrl: v.exactOptional(OriginalUrlSchema),
    title: v.exactOptional(boundedText(limits.title)),
    date: v.exactOptional(ConversationDateSchema),
    evidence: boundedArray(EvidenceSchema, limits.evidencePerCandidate),
  }),
  v.check(
    (candidate) => unique(candidate.evidence.map((evidence) => evidence.id)),
    'Duplicate evidence IDs.',
  ),
  v.check((candidate) => {
    const titles = candidate.evidence.filter((evidence) => evidence.source === 'title');

    return titles.length <= 1 && titles.every((evidence) => evidence.text === candidate.title);
  }, 'Title evidence must match the available title exactly.'),
);

export type Candidate = v.InferOutput<typeof CandidateSchema>;
export type Evidence = v.InferOutput<typeof EvidenceSchema>;

// JSON tuple encoding avoids delimiter collisions. Titles and links are never deduplication keys.
export function conversationKey(candidate: Candidate): string {
  return JSON.stringify([scopeKey(candidate.scope), candidate.conversationId]);
}

export const CandidateListSchema = v.pipe(
  boundedArray(CandidateSchema, limits.candidates),
  v.check(
    (candidates) => unique(candidates.map((candidate) => candidate.id)),
    'Duplicate candidate IDs.',
  ),
  v.check(
    (candidates) => unique(candidates.map(conversationKey)),
    'Duplicate scoped conversations.',
  ),
  v.check(
    (candidates) =>
      candidates.reduce(
        (total, candidate) =>
          total + candidate.evidence.reduce((length, evidence) => length + evidence.text.length, 0),
        0,
      ) <= limits.totalEvidence,
    'Evidence text budget exceeded.',
  ),
);

// Adapters supply an observed origin/path/identifier policy; shared code knows no endpoints.
export type OriginalLinkVerifier = (url: URL, conversationId: ConversationId) => boolean;
export type LinkVerifiers = Readonly<Partial<Record<ProviderId, OriginalLinkVerifier>>>;

export function acceptsOriginalLink(candidate: Candidate, verifiers: LinkVerifiers): boolean {
  if (candidate.originalUrl === undefined) return true;

  const verify = verifiers[candidate.scope.provider];

  if (!verify) return false;

  try {
    return verify(new URL(candidate.originalUrl), candidate.conversationId);
  } catch {
    return false;
  }
}
