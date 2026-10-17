import * as v from 'valibot';
import { boundedArray, boundedText, TimestampSchema } from '../../contracts/primitives';
import type { OperationContext } from '../../contracts/ports';
import type { Candidate } from '../../contracts/conversation';
import { GoogleHttpResponseSchema } from './wire';

const identity = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const GoogleReadOperationSchema = v.variant('kind', [
  v.strictObject({ kind: v.picklist(['inspect', 'list']) }),
  v.strictObject({ kind: v.literal('search'), query: boundedText(1024) }),
  v.strictObject({ kind: v.literal('messages'), conversationId: boundedText(256) }),
]);
export type GoogleReadOperation = v.InferOutput<typeof GoogleReadOperationSchema>;

export const GoogleReadResultSchema = v.variant('status', [
  v.strictObject({
    status: v.literal('success'),
    identityBefore: identity,
    identityAfter: identity,
    response: v.exactOptional(GoogleHttpResponseSchema),
    dateLabel: v.exactOptional(
      v.strictObject({
        conversationId: boundedText(256),
        text: boundedText(80),
        observedAt: TimestampSchema,
      }),
    ),
    rendered: v.exactOptional(v.pipe(boundedArray(boundedText(2000), 4), v.minLength(1))),
  }),
  v.strictObject({
    status: v.picklist([
      'login-expired',
      'permission-needed',
      'unavailable',
      'schema-changed',
      'rate-limited',
      'timeout',
      'cancelled',
      'scope-changed',
      'interrupted',
    ]),
  }),
]);

// Implementations own a pinned Chrome document. No URLs, credentials or executable input.
export interface GoogleAiModeReadPort {
  read(
    operation: GoogleReadOperation,
    expectedIdentity: string | undefined,
    context: OperationContext,
  ): Promise<unknown>;
  // Internal adapter-to-host call for an already retrieved, scoped candidate. No message accepts a URL.
  openEvidence?(
    candidate: Candidate,
    expectedIdentity: string,
    context: OperationContext,
  ): Promise<unknown>;
}
