import * as v from 'valibot';
import { GenerationSchema, PartitionIdSchema, ProviderIdSchema } from './primitives';

const scopeEntries = { provider: ProviderIdSchema, generation: GenerationSchema };

export const VerifiedScopeSchema = v.strictObject({
  ...scopeEntries,
  kind: v.literal('verified'),
  accountPartition: PartitionIdSchema,
  // null means the provider has no workspace. Unknown workspace identity uses an ephemeral scope.
  workspacePartition: v.nullable(PartitionIdSchema),
});

export const EphemeralScopeSchema = v.strictObject({
  ...scopeEntries,
  kind: v.literal('ephemeral'),
  // Fresh local partition for one selected context; never reused or persisted.
  partition: PartitionIdSchema,
});

export const SessionScopeSchema = v.variant('kind', [VerifiedScopeSchema, EphemeralScopeSchema]);
export type SessionScope = v.InferOutput<typeof SessionScopeSchema>;
export type VerifiedScope = v.InferOutput<typeof VerifiedScopeSchema>;

export function scopeKey(scope: SessionScope): string {
  return JSON.stringify(
    scope.kind === 'verified'
      ? [
          scope.provider,
          scope.kind,
          scope.accountPartition,
          scope.workspacePartition,
          scope.generation,
        ]
      : [scope.provider, scope.kind, scope.partition, scope.generation],
  );
}

export function sameScope(left: SessionScope, right: SessionScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

export const SessionOutcomeSchema = v.variant('status', [
  v.strictObject({ status: v.literal('ready'), scope: SessionScopeSchema }),
  v.strictObject({
    status: v.picklist([
      'login-expired',
      'permission-needed',
      'unavailable',
      'scope-changed',
      'schema-changed',
      'rate-limited',
      'timeout',
      'cancelled',
      'interrupted',
    ]),
    ...scopeEntries,
  }),
]);
export type SessionOutcome = v.InferOutput<typeof SessionOutcomeSchema>;
