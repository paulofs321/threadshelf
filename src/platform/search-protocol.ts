import * as v from 'valibot';
import { RequestIdSchema, SearchOutcomeSchema, SearchRequestSchema } from '../contracts';

export const KeywordRequestSchema = v.pipe(
  SearchRequestSchema,
  v.check((request) => request.query.mode === 'keyword'),
);
export const SearchCommandSchema = v.variant('operation', [
  v.strictObject({ operation: v.literal('keyword-search'), request: KeywordRequestSchema }),
  v.strictObject({ operation: v.literal('cancel-search'), requestId: RequestIdSchema }),
]);
export type SearchCommand = v.InferOutput<typeof SearchCommandSchema>;
export const SearchReplySchema = v.strictObject({
  kind: v.literal('search-result'),
  outcome: SearchOutcomeSchema,
});
export type SearchReply = v.InferOutput<typeof SearchReplySchema>;
export const searchClientTimeoutMs = 27_000;
