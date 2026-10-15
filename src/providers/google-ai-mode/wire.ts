import * as v from 'valibot';
import {
  limits,
  requireValid,
  CandidateListSchema,
  CandidateSchema,
  ConversationIdSchema,
  EvidenceSchema,
} from '../../contracts';
import type { Candidate, Coverage, OriginalLinkVerifier, ProviderRequest } from '../../contracts';

export const googleAiModeOrigin = 'https://www.google.com';
export const googleResponseLimit = 3_000_000;

export const GoogleHttpResponseSchema = v.strictObject({
  status: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(599)),
  contentType: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  retryAfter: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  body: v.pipe(v.string(), v.maxLength(googleResponseLimit)),
});
export type GoogleHttpResponse = v.InferOutput<typeof GoogleHttpResponseSchema>;
export type GoogleReadKind = 'search' | 'list';

// Exact forms observed in native Search AI Mode on October 15, 2026. No inferred cursor.
export function googleReadUrl(kind: GoogleReadKind, query: string): string {
  const url = new URL(
    `/httpservice/web/AimThreadsService/${kind === 'search' ? 'SearchThreads' : 'ListThreads'}`,
    googleAiModeOrigin,
  );
  url.searchParams.set('udm', '50');
  url.searchParams.set(
    'reqpld',
    JSON.stringify(kind === 'search' ? [query, 30, null, 2, null, 0] : [null, null, 0]),
  );
  return url.href;
}

function invalid(): never {
  throw new Error('Invalid Google AI Mode response.');
}

function tuple(input: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) invalid();
  return input;
}

function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input.length || input.length > maximum) invalid();
  return input;
}

const linkKeys = ['mtid', 'csuir', 'mstk', 'udm'] as const;

export const verifyGoogleOriginalLink: OriginalLinkVerifier = (url, conversationId) =>
  url.origin === googleAiModeOrigin &&
  url.pathname === '/search' &&
  !url.username &&
  !url.password &&
  !url.port &&
  !url.hash &&
  [...url.searchParams.keys()].length === 4 &&
  linkKeys.every((key) => url.searchParams.getAll(key).length === 1) &&
  url.searchParams.get('mtid') === conversationId &&
  url.searchParams.get('udm') === '50' &&
  url.searchParams.get('csuir') === '1' &&
  /^[A-Za-z0-9_-]{1,1024}$/.test(url.searchParams.get('mstk') ?? '');

function originalLink(row: unknown[], id: string): string {
  const pairs = tuple(row[22], 4, 4);
  const url = new URL('/search', googleAiModeOrigin);
  for (const pair of pairs) {
    const [key, value] = tuple(pair, 2, 2);
    if (typeof key !== 'string' || !linkKeys.some((allowed) => allowed === key)) invalid();
    if (url.searchParams.has(key)) invalid();
    url.searchParams.set(key, text(value, 1024));
  }
  const identifiers = tuple(row[0], 2, 2);
  if (identifiers[0] !== url.searchParams.get('mstk')) invalid();
  // The normalized conversation ID is runtime-validated with the resulting candidate below.
  if (!verifyGoogleOriginalLink(url, requireValid(ConversationIdSchema, id))) invalid();
  return url.href;
}

function excerpt(value: string): string {
  const end = Math.min(value.length, limits.excerpt);
  // Preserve an exact provider substring without splitting a UTF-16 surrogate pair.
  const last = value.charCodeAt(end - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export function parseGoogleRecords(
  body: string,
  kind: GoogleReadKind,
  request: ProviderRequest,
  freshId: () => string,
): { candidates: Candidate[]; coverage: Coverage } {
  if (body.length > googleResponseLimit || !body.startsWith(")]}'")) invalid();
  let root: unknown;
  try {
    root = JSON.parse(body.slice(4).trimStart());
  } catch {
    invalid();
  }
  const envelope = tuple(root, 0, kind === 'search' ? 1 : 6);
  // Native no-match SearchThreads returns [] rather than a missing-result fallback.
  const records =
    kind === 'search' && envelope.length === 0
      ? []
      : tuple(envelope[0], 0, kind === 'search' ? 30 : 300);
  const candidates = new Map<string, Candidate>();
  const titles = new Map<string, string | undefined>();
  const reasons: Coverage['reasons'] = ['unknown-reach'];
  let evidenceLength = 0;
  function limited(reason: Coverage['reasons'][number]): void {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (records.length === (kind === 'search' ? 30 : 300)) limited('result-limit');
  for (const record of records) {
    const match = kind === 'search' ? tuple(record, 16, 16) : undefined;
    const row = tuple(match ? match[15] : record, 25, 28);
    const identifiers = tuple(row[0], 2, 2);
    const id = text(identifiers[1], limits.id);
    const url = originalLink(row, id);
    const title = row[1] == null ? undefined : text(row[1], 8192);
    let candidate = candidates.get(id);
    if (candidate && (candidate.originalUrl !== url || titles.get(id) !== title)) invalid();
    if (!candidate) {
      if (candidates.size >= limits.candidates) {
        limited('result-limit');
        continue;
      }
      candidate = requireValid(CandidateSchema, {
        id: freshId(),
        scope: request.scope,
        conversationId: id,
        originalUrl: url,
        ...(title !== undefined && title.length <= limits.title ? { title } : {}),
        evidence: [],
      });
      if (
        candidate.title !== undefined &&
        evidenceLength + candidate.title.length <= limits.totalEvidence
      ) {
        candidate.evidence.push(
          requireValid(EvidenceSchema, { id: 'title', text: candidate.title, source: 'title' }),
        );
        evidenceLength += candidate.title.length;
      } else limited('missing-evidence');
      candidates.set(id, candidate);
      titles.set(id, title);
    }
    if (match?.[14] != null) {
      const snippet = tuple(match[14], 1, 4);
      const raw = text(snippet[0], 64_000);
      const value = excerpt(raw);
      if (
        !candidate.evidence.some((item) => item.source === 'native-snippet' && item.text === value)
      ) {
        if (
          candidate.evidence.length >= limits.evidencePerCandidate ||
          evidenceLength + value.length > limits.totalEvidence
        )
          limited('missing-evidence');
        else {
          candidate.evidence.push(
            requireValid(EvidenceSchema, {
              id: `snippet-${candidate.evidence.length}`,
              text: value,
              source: 'native-snippet',
            }),
          );
          evidenceLength += value.length;
        }
      }
      if (value.length !== raw.length) limited('missing-evidence');
    } else if (kind === 'search') limited('missing-evidence');
  }
  // The two observed timestamp pairs have no verified creation/update meaning yet.
  // Preserve unknown dates rather than attach a fabricated semantic to a numeric position.
  if (request.query.dateRange !== undefined) limited('unknown-dates');
  return {
    candidates: requireValid(CandidateListSchema, [...candidates.values()]),
    coverage: { extent: reasons.includes('result-limit') ? 'partial' : 'unknown', reasons },
  };
}

export function googleHttpFailure(
  response: GoogleHttpResponse,
  now: number,
): {
  status: 'login-expired' | 'rate-limited' | 'unavailable' | 'schema-changed';
  retryAfterMs?: number;
} | null {
  if (response.status === 401) return { status: 'login-expired' };
  if (response.status === 429) {
    const value = response.retryAfter;
    const milliseconds =
      value === null ? NaN : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return {
      status: 'rate-limited',
      ...(Number.isFinite(milliseconds) && milliseconds > 0
        ? { retryAfterMs: Math.min(milliseconds, limits.retryAfterMs) }
        : {}),
    };
  }
  if (response.status !== 200) return { status: 'unavailable' };
  if (!/^application\/json(?:\s*;|$)/i.test(response.contentType ?? ''))
    return { status: 'schema-changed' };
  return null;
}
