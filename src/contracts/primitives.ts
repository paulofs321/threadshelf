import * as v from 'valibot';

// Counts are per operation; text limits use UTF-16 code units, as String.length does.
export const limits = Object.freeze({
  id: 256,
  query: 1_024,
  title: 300,
  url: 2_048,
  candidates: 100,
  evidencePerCandidate: 8,
  excerpt: 2_000,
  totalEvidence: 64_000,
  planTerms: 8,
  term: 128,
  retryAfterMs: 300_000,
  cacheTtlMs: 86_400_000,
});

export function boundedText(maximum: number) {
  return v.pipe(
    v.string(),
    v.maxLength(maximum),
    v.check((text) => text.trim().length > 0, 'Text must not be blank.'),
  );
}

// Check the outer array before traversing its untrusted members.
export function boundedArray<T extends v.GenericSchema>(item: T, maximum: number) {
  return v.pipe(
    v.custom<unknown[]>(
      (input) => Array.isArray(input) && input.length <= maximum,
      'Expected a bounded array.',
    ),
    v.array(item),
  );
}

export function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

const opaqueIdSchema = v.pipe(
  boundedText(limits.id),
  v.check(
    (id) => id === id.trim() && !Array.from(id).some((char) => /\p{Cc}/u.test(char)),
    'Expected an opaque identifier without surrounding whitespace or controls.',
  ),
);

export const ProviderIdSchema = v.picklist(['chatgpt', 'google-ai-mode']);
export const RequestIdSchema = v.pipe(opaqueIdSchema, v.brand('RequestId'));
export const PartitionIdSchema = v.pipe(opaqueIdSchema, v.brand('PartitionId'));
export const ConversationIdSchema = v.pipe(opaqueIdSchema, v.brand('ConversationId'));
export const CandidateIdSchema = v.pipe(opaqueIdSchema, v.brand('CandidateId'));
export const EvidenceIdSchema = v.pipe(opaqueIdSchema, v.brand('EvidenceId'));
export const GenerationSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
export const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const TimestampSchema = v.pipe(
  v.string(),
  v.check((value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
    const milliseconds = Date.parse(value);

    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }, 'Expected a real canonical UTC timestamp.'),
);

export const TimeZoneSchema = v.pipe(
  boundedText(128),
  v.check((timeZone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone });

      return true;
    } catch {
      return false;
    }
  }, 'Expected a supported timezone.'),
);

// This establishes URL safety only. Provider ownership/path/ID checks are injected separately.
export const OriginalUrlSchema = v.pipe(
  boundedText(limits.url),
  v.check((value) => {
    try {
      const url = new URL(value);

      return (
        value === url.href &&
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.port === ''
      );
    } catch {
      return false;
    }
  }, 'Expected a canonical HTTPS URL without credentials or a custom port.'),
);

export type ProviderId = v.InferOutput<typeof ProviderIdSchema>;
export type RequestId = v.InferOutput<typeof RequestIdSchema>;
export type ConversationId = v.InferOutput<typeof ConversationIdSchema>;
export type CandidateId = v.InferOutput<typeof CandidateIdSchema>;
export type EvidenceId = v.InferOutput<typeof EvidenceIdSchema>;
