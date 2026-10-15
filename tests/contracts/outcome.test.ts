import { describe, expect, it } from 'vitest';
import {
  CoverageSchema,
  limits,
  ProviderOutcomeSchema,
  providerOutcomeSchemaFor,
  requireValid,
  SearchOutcomeSchema,
  searchOutcomeSchemaFor,
  SearchRequestSchema,
  validate,
} from '../../src/contracts';
import {
  chatCandidate,
  chatRequest,
  chatScope,
  chatSuccess,
  completeCoverage,
  googleCandidate,
  googleFailure,
  googleScope,
  linkVerifiers,
  request,
  unknownCoverage,
} from '../fixtures/contracts';

const aggregate = {
  requestId: request.requestId,
  state: 'partial',
  results: [chatCandidate.id],
  outcomes: [chatSuccess, googleFailure],
  coverage: { extent: 'partial', reasons: ['unknown-reach', 'provider-failure'] },
};

describe('provider outcomes', () => {
  const schema = providerOutcomeSchemaFor(chatRequest, linkVerifiers);

  it('keeps successful empty results separate from failure', () => {
    const empty = requireValid(schema, { ...chatSuccess, candidates: [] });
    expect(empty.status).toBe('success');
    if (empty.status === 'success') expect(empty.candidates).toEqual([]);
  });

  it.each([
    'login-expired',
    'permission-needed',
    'unavailable',
    'schema-changed',
    'rate-limited',
    'timeout',
    'cancelled',
    'scope-changed',
    'interrupted',
  ])('validates %s without inventing empty results', (status) => {
    const outcome = { status, requestId: request.requestId, scope: chatScope };
    expect(validate(schema, outcome).ok).toBe(true);
    expect(validate(schema, { ...outcome, candidates: [] }).ok).toBe(false);
    expect(validate(schema, { ...outcome, coverage: completeCoverage }).ok).toBe(false);
  });

  it.each([
    { status: 'ok' },
    { candidates: undefined },
    { coverage: undefined },
    { status: 'success', retryAfterMs: 1 },
    { rawBody: 'fictional-provider-payload' },
  ])('rejects missing/mixed/unknown outcome fields %#', (changes) => {
    expect(validate(ProviderOutcomeSchema, { ...chatSuccess, ...changes }).ok).toBe(false);
  });

  it('bounds retry hints and restricts them to rate limiting', () => {
    const rateLimited = { status: 'rate-limited', requestId: request.requestId, scope: chatScope };
    expect(validate(schema, { ...rateLimited, retryAfterMs: limits.retryAfterMs }).ok).toBe(true);
    [-1, 1.5, Infinity, limits.retryAfterMs + 1].forEach((retryAfterMs) => {
      expect(validate(schema, { ...rateLimited, retryAfterMs }).ok).toBe(false);
    });
  });

  it('rejects obsolete request IDs, account/workspace changes and generations', () => {
    const scopes = [
      { ...chatScope, generation: 2 },
      { ...chatScope, accountPartition: 'fictional-other-account' },
      { ...chatScope, workspacePartition: 'fictional-other-workspace' },
    ];
    expect(validate(schema, { ...chatSuccess, requestId: 'fictional-old-request' }).ok).toBe(false);

    for (const scope of scopes) {
      expect(validate(schema, { ...chatSuccess, scope, candidates: [] }).ok).toBe(false);
      expect(
        validate(schema, { ...chatSuccess, candidates: [{ ...chatCandidate, scope }] }).ok,
      ).toBe(false);
    }

    expect(validate(schema, { ...chatSuccess, candidates: [googleCandidate] }).ok).toBe(false);
  });

  it('requires a verified link policy at the output boundary', () => {
    expect(validate(schema, chatSuccess).ok).toBe(true);
    expect(validate(providerOutcomeSchemaFor(chatRequest, {}), chatSuccess).ok).toBe(false);
    expect(
      validate(schema, {
        ...chatSuccess,
        candidates: [{ ...chatCandidate, originalUrl: 'https://evil.invalid/' }],
      }).ok,
    ).toBe(false);
  });

  it.each([
    { extent: 'complete', reasons: ['unknown-reach'] },
    { extent: 'unknown', reasons: [] },
    { extent: 'partial', reasons: [] },
    { extent: 'partial', reasons: ['result-limit', 'result-limit'] },
    { extent: 'all-history', reasons: [] },
  ])('rejects misleading coverage %#', (coverage) => {
    expect(validate(CoverageSchema, coverage).ok).toBe(false);
  });
});

describe('aggregate outcome invariants', () => {
  const schema = searchOutcomeSchemaFor(request, linkVerifiers);

  it('preserves useful results and independent failure/coverage information', () => {
    expect(validate(schema, aggregate).ok).toBe(true);
    expect(validate(schema, { ...aggregate, results: [] }).ok).toBe(true);
    expect(validate(schema, { ...aggregate, state: 'success' }).ok).toBe(false);
    expect(validate(schema, { ...aggregate, coverage: completeCoverage }).ok).toBe(false);
    expect(validate(schema, { ...aggregate, coverage: unknownCoverage }).ok).toBe(false);
  });

  it('accepts genuine successful no-matches with unknown reach', () => {
    expect(
      validate(schema, {
        ...aggregate,
        state: 'success',
        results: [],
        coverage: unknownCoverage,
        outcomes: [
          { ...chatSuccess, candidates: [] },
          { ...chatSuccess, scope: googleScope, candidates: [] },
        ],
      }).ok,
    ).toBe(true);
  });

  it('requires failure when no provider succeeded', () => {
    const failed = {
      ...aggregate,
      state: 'failure',
      results: [],
      outcomes: [googleFailure, { ...googleFailure, scope: chatScope }],
      coverage: { extent: 'unknown', reasons: ['provider-failure'] },
    };
    expect(validate(schema, failed).ok).toBe(true);
    expect(validate(schema, { ...failed, state: 'success' }).ok).toBe(false);
  });

  it('requires cancellation outcomes and no displayed results for cancelled searches', () => {
    const cancelled = {
      ...aggregate,
      state: 'cancelled',
      results: [],
      outcomes: request.scopes.map((scope) => ({
        status: 'cancelled',
        requestId: request.requestId,
        scope,
      })),
      coverage: { extent: 'unknown', reasons: ['provider-failure'] },
    };
    expect(validate(schema, cancelled).ok).toBe(true);
    expect(validate(schema, { ...cancelled, state: 'failure' }).ok).toBe(false);
    expect(validate(schema, { ...aggregate, state: 'cancelled' }).ok).toBe(false);
  });

  it.each([
    { outcomes: [] },
    { outcomes: [chatSuccess] },
    { outcomes: [chatSuccess, chatSuccess] },
    { outcomes: [chatSuccess, { ...googleFailure, scope: { ...googleScope, generation: 2 } }] },
    { outcomes: [chatSuccess, { ...googleFailure, requestId: 'fictional-stale-request' }] },
    { requestId: 'fictional-stale-request' },
    { results: ['fictional-invented-candidate'] },
    { results: [chatCandidate.id, chatCandidate.id] },
  ])('rejects missing/duplicate/stale/out-of-scope references %#', (changes) => {
    expect(validate(schema, { ...aggregate, ...changes }).ok).toBe(false);
  });

  it('prevents candidate ID collisions across providers without merging matching titles', () => {
    const both = {
      ...aggregate,
      state: 'success',
      results: [chatCandidate.id, googleCandidate.id],
      coverage: unknownCoverage,
      outcomes: [
        chatSuccess,
        { ...chatSuccess, scope: googleScope, candidates: [googleCandidate] },
      ],
    };
    expect(validate(schema, both).ok).toBe(true);
    expect(
      validate(SearchOutcomeSchema, {
        ...both,
        outcomes: [
          chatSuccess,
          {
            ...chatSuccess,
            scope: googleScope,
            candidates: [{ ...googleCandidate, id: chatCandidate.id }],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('enforces explicit date filters and discloses excluded unknown dates', () => {
    const datedRequest = requireValid(SearchRequestSchema, {
      ...request,
      query: {
        ...request.query,
        dateRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      },
    });
    const datedSchema = searchOutcomeSchemaFor(datedRequest, linkVerifiers);
    const both = {
      ...aggregate,
      state: 'success',
      results: [chatCandidate.id],
      outcomes: [
        chatSuccess,
        { ...chatSuccess, scope: googleScope, candidates: [googleCandidate] },
      ],
      coverage: { extent: 'partial', reasons: ['unknown-reach', 'unknown-dates'] },
    };
    expect(validate(datedSchema, both).ok).toBe(true);
    expect(validate(datedSchema, { ...both, coverage: unknownCoverage }).ok).toBe(false);
    expect(validate(datedSchema, { ...both, results: [googleCandidate.id] }).ok).toBe(false);
    const endExcluded = {
      ...chatCandidate,
      date: { ...chatCandidate.date, at: '2026-10-01T00:00:00.000Z' },
    };
    expect(
      validate(datedSchema, {
        ...both,
        outcomes: [{ ...chatSuccess, candidates: [endExcluded] }, both.outcomes[1]],
      }).ok,
    ).toBe(false);
  });
});
