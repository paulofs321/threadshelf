import { describe, expect, it } from 'vitest';
import {
  CoverageReasonSchema,
  limits,
  providerOutcomeSchemaFor,
  searchOutcomeSchemaFor,
  requireValid,
  SearchRequestSchema,
  validate,
} from '../../src/contracts';
import type { ProviderOutcome } from '../../src/contracts';
import { chatRequest, chatScope, googleScope, linkVerifiers, request } from '../fixtures/contracts';

const failures = [
  'login-expired',
  'permission-needed',
  'unavailable',
  'schema-changed',
  'rate-limited',
  'timeout',
  'cancelled',
  'scope-changed',
  'interrupted',
] as const;
const statuses = ['success', ...failures] as const;
function outcome(status: ProviderOutcome['status'], scope: typeof chatScope) {
  return status === 'success'
    ? {
        status,
        requestId: request.requestId,
        scope,
        candidates: [],
        coverage: { extent: 'complete', reasons: [] },
      }
    : { status, requestId: request.requestId, scope };
}

describe('aggregate completion truth table for every provider status', () => {
  const schema = searchOutcomeSchemaFor(request, linkVerifiers);
  // Exhaustive specification table: all successes => success, mixed => partial,
  // all cancellations => cancelled, remaining failures => failure.
  const cases = [
    { left: 'success', right: 'success', state: 'success' },
    ...failures.flatMap((failure) => [
      { left: 'success', right: failure, state: 'partial' },
      { left: failure, right: 'success', state: 'partial' },
    ]),
    ...failures.flatMap((left) =>
      failures.map((right) => ({
        left,
        right,
        state: left === 'cancelled' && right === 'cancelled' ? 'cancelled' : 'failure',
      })),
    ),
  ];
  it.each(cases)('$left + $right must produce $state', ({ left, right, state }) => {
    const aggregate = {
      requestId: request.requestId,
      state,
      results: [],
      outcomes: [
        outcome(left as ProviderOutcome['status'], chatScope),
        outcome(right as ProviderOutcome['status'], googleScope),
      ],
      coverage:
        state === 'success'
          ? { extent: 'complete', reasons: [] }
          : { extent: 'unknown', reasons: ['provider-failure'] },
    };
    expect(validate(schema, aggregate).ok).toBe(true);
    for (const alternative of ['success', 'partial', 'failure', 'cancelled']) {
      if (alternative !== state)
        expect(validate(schema, { ...aggregate, state: alternative }).ok).toBe(false);
    }
    if (state !== 'success')
      expect(
        validate(schema, { ...aggregate, coverage: { extent: 'complete', reasons: [] } }).ok,
      ).toBe(false);
  });
  it.each(statuses)('also validates one selected provider with status %s', (status) => {
    const one = requireValid(SearchRequestSchema, {
      ...request,
      query: { ...request.query, providers: ['chatgpt'] },
      scopes: [chatScope],
    });
    const aggregate = {
      requestId: one.requestId,
      state: status === 'success' ? 'success' : status === 'cancelled' ? 'cancelled' : 'failure',
      results: [],
      outcomes: [outcome(status, chatScope)],
      coverage:
        status === 'success'
          ? { extent: 'complete', reasons: [] }
          : { extent: 'unknown', reasons: ['provider-failure'] },
    };
    expect(validate(searchOutcomeSchemaFor(one, linkVerifiers), aggregate).ok).toBe(true);
    expect(validate(schema, aggregate).ok).toBe(false); // Missing the requested second provider.
  });
});

describe('coverage and retry-hint integrity', () => {
  it.each([
    'unknown-reach',
    'result-limit',
    'query-budget',
    'missing-evidence',
    'unknown-dates',
    'provider-failure',
  ] as const)('cannot hide the reported coverage reason %s', (reason) => {
    expect(validate(CoverageReasonSchema, reason).ok).toBe(true);
    const aggregate = {
      requestId: request.requestId,
      state: 'success',
      results: [],
      outcomes: [
        { ...outcome('success', chatScope), coverage: { extent: 'partial', reasons: [reason] } },
        outcome('success', googleScope),
      ],
      coverage: { extent: 'partial', reasons: [reason] },
    };
    const schema = searchOutcomeSchemaFor(request, linkVerifiers);
    expect(validate(schema, aggregate).ok).toBe(true);
    expect(
      validate(schema, { ...aggregate, coverage: { extent: 'complete', reasons: [] } }).ok,
    ).toBe(false);
  });
  it('keeps optional retry hints absent and accepts zero and maximum delay only for rate limiting', () => {
    const schema = providerOutcomeSchemaFor(chatRequest, linkVerifiers);
    const input = outcome('rate-limited', chatScope);
    expect(requireValid(schema, input)).not.toHaveProperty('retryAfterMs');
    for (const retryAfterMs of [0, limits.retryAfterMs])
      expect(validate(schema, { ...input, retryAfterMs }).ok).toBe(true);
    for (const retryAfterMs of [undefined, null, NaN, '100', limits.retryAfterMs + 1])
      expect(validate(schema, { ...input, retryAfterMs }).ok).toBe(false);
  });
});
