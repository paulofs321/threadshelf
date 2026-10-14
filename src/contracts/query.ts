import * as v from 'valibot';
import type { Candidate } from './conversation';
import {
  boundedArray,
  boundedText,
  limits,
  ProviderIdSchema,
  RequestIdSchema,
  TimestampSchema,
  TimeZoneSchema,
  unique,
} from './primitives';
import { SessionScopeSchema, sameScope } from './session';
import type { SessionScope } from './session';

export const ProviderSelectionSchema = v.pipe(
  boundedArray(ProviderIdSchema, 2),
  v.minLength(1),
  v.check(unique, 'Duplicate providers.'),
);

export const DateRangeSchema = v.pipe(
  v.strictObject({ start: TimestampSchema, end: TimestampSchema }),
  v.check((range) => range.start < range.end, 'Date interval must have a positive duration.'),
);

export const QuerySchema = v.strictObject({
  text: v.pipe(
    boundedText(limits.query),
    v.check(
      (text) => !Array.from(text).some((char) => /\p{Cc}/u.test(char) && !/\s/u.test(char)),
      'Query contains unsupported control characters.',
    ),
    v.trim(),
  ),
  mode: v.picklist(['keyword', 'description']),
  providers: ProviderSelectionSchema,
  timeZone: TimeZoneSchema,
  dateRange: v.exactOptional(DateRangeSchema),
});

export const SearchRequestSchema = v.pipe(
  v.strictObject({
    requestId: RequestIdSchema,
    query: QuerySchema,
    scopes: boundedArray(SessionScopeSchema, 2),
  }),
  v.check(
    (request) =>
      unique(request.scopes.map((scope) => scope.provider)) &&
      request.scopes.length === request.query.providers.length &&
      request.scopes.every((scope) => request.query.providers.includes(scope.provider)),
    'Exactly one current scope is required per selected provider.',
  ),
);

export const ProviderRequestSchema = v.pipe(
  v.strictObject({ requestId: RequestIdSchema, query: QuerySchema, scope: SessionScopeSchema }),
  v.check(
    (request) => request.query.providers.includes(request.scope.provider),
    'Provider must be explicitly selected.',
  ),
);

export type Query = v.InferOutput<typeof QuerySchema>;
export type DateRange = v.InferOutput<typeof DateRangeSchema>;
export type SearchRequest = v.InferOutput<typeof SearchRequestSchema>;
export type ProviderRequest = v.InferOutput<typeof ProviderRequestSchema>;

export function isRequestedScope(request: SearchRequest, scope: SessionScope): boolean {
  return request.scopes.some((current) => sameScope(current, scope));
}

// Only known available dates can satisfy [start, end). Meaning/provenance must still be displayed.
export function matchesDateRange(candidate: Candidate, range: DateRange | undefined): boolean {
  if (!range) return true;
  return (
    candidate.date !== undefined &&
    candidate.date.at >= range.start &&
    candidate.date.at < range.end
  );
}
