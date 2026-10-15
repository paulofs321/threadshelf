import * as v from 'valibot';
import { GenerationSchema, ProviderIdSchema, RequestIdSchema } from '../contracts/primitives';
import { EphemeralScopeSchema } from '../contracts/session';

export const accessPortName = 'threadshelf:selected-tab:v1';
export function panelPortName(windowId: number): string {
  return `${accessPortName}:window:${windowId}`;
}
export const operationTimeoutMs = 10_000;
export const clientTimeoutMs = 12_000;
export const maximumRequestsPerPort = 256;

const requestEntries = { requestId: RequestIdSchema, provider: ProviderIdSchema };
export const AccessRequestSchema = v.variant('operation', [
  v.strictObject({ operation: v.literal('connect'), ...requestEntries }),
  v.strictObject({
    operation: v.literal('inspect-context'),
    ...requestEntries,
    scope: EphemeralScopeSchema,
  }),
  v.strictObject({
    operation: v.literal('disconnect'),
    ...requestEntries,
    scope: EphemeralScopeSchema,
  }),
  v.strictObject({ operation: v.literal('cancel'), requestId: RequestIdSchema }),
]);
export type AccessRequest = v.InferOutput<typeof AccessRequestSchema>;
export type AccessOperation = Exclude<AccessRequest, { operation: 'cancel' }>;

export const FailureStatusSchema = v.picklist([
  'permission-needed',
  'unavailable',
  'scope-changed',
  'timeout',
  'cancelled',
  'interrupted',
  'busy',
]);
export type FailureStatus = v.InferOutput<typeof FailureStatusSchema>;

export const AccessReplySchema = v.variant('status', [
  v.strictObject({
    kind: v.literal('reply'),
    requestId: RequestIdSchema,
    status: v.literal('selected'),
    scope: EphemeralScopeSchema,
    // Document access is not authenticated provider support.
    session: v.literal('unverified'),
  }),
  v.strictObject({
    kind: v.literal('reply'),
    requestId: RequestIdSchema,
    status: v.literal('disconnected'),
  }),
  v.strictObject({
    kind: v.literal('reply'),
    requestId: RequestIdSchema,
    status: FailureStatusSchema,
  }),
]);
export type AccessReply = v.InferOutput<typeof AccessReplySchema>;

export const AccessEventSchema = v.strictObject({
  kind: v.literal('invalidated'),
  provider: ProviderIdSchema,
  generation: GenerationSchema,
  status: v.picklist(['scope-changed', 'permission-needed', 'interrupted']),
});
export type AccessEvent = v.InferOutput<typeof AccessEventSchema>;
export const AccessMessageSchema = v.variant('kind', [AccessReplySchema, AccessEventSchema]);
export type AccessMessage = v.InferOutput<typeof AccessMessageSchema>;
