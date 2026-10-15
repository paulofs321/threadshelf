import * as v from 'valibot';
import { boundedText, limits } from '../../contracts/primitives';
import type { OperationContext } from '../../contracts/ports';

export const ChatGptConversationIdSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u),
);
export const ChatGptOperationSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('inspect') }),
  v.strictObject({ kind: v.literal('search'), query: boundedText(limits.query) }),
  v.strictObject({ kind: v.literal('list') }),
  v.strictObject({ kind: v.literal('messages'), conversationId: ChatGptConversationIdSchema }),
]);
export type ChatGptOperation = v.InferOutput<typeof ChatGptOperationSchema>;
export const ChatGptReadResultSchema = v.variant('status', [
  v.strictObject({
    status: v.literal('success'),
    identityBefore: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    identityAfter: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    body: v.unknown(),
  }),
  v.strictObject({
    status: v.picklist([
      'login-expired',
      'permission-needed',
      'unavailable',
      'schema-changed',
      'timeout',
      'cancelled',
      'scope-changed',
      'interrupted',
    ]),
  }),
  v.strictObject({
    status: v.literal('rate-limited'),
    retryAfterMs: v.exactOptional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(limits.retryAfterMs)),
    ),
  }),
]);
export type ChatGptReadResult = v.InferOutput<typeof ChatGptReadResultSchema>;

// Trusted in-process capability. No URL, headers, credential or executable arguments.
export interface ChatGptReadPort {
  read(
    operation: ChatGptOperation,
    expectedIdentity: string | undefined,
    context: OperationContext,
  ): Promise<unknown>;
}
