import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import {
  CandidateIdSchema,
  CandidateListSchema,
  CandidateSchema,
  ConversationIdSchema,
  CountSchema,
  CoverageSchema,
  EvidenceIdSchema,
  GenerationSchema,
  limits,
  ModelPlanSchema,
  ModelRankingSchema,
  PartitionIdSchema,
  QuerySchema,
  RequestIdSchema,
  SearchOutcomeSchema,
  SearchRequestSchema,
  SessionOutcomeSchema,
  TimestampSchema,
  TimeZoneSchema,
  validate,
  requireValid,
  acceptsOriginalLink,
} from '../../src/contracts';
import { chatCandidate, chatScope, request } from '../fixtures/contracts';

const ids = [
  RequestIdSchema,
  PartitionIdSchema,
  ConversationIdSchema,
  CandidateIdSchema,
  EvidenceIdSchema,
];

describe('primitive exact boundaries and hostile inputs', () => {
  it.each(ids.map((schema, index) => ({ schema, index })))(
    'checks opaque identifier boundaries for ID kind $index',
    ({ schema }) => {
      for (const id of ['fiction-🪁', 'a'.repeat(limits.id)])
        expect(validate(schema, id).ok).toBe(true);
      for (const id of [
        null,
        3,
        '',
        ' ',
        ' fiction',
        'fiction ',
        'fiction\n',
        'f\u007f',
        'x'.repeat(limits.id + 1),
      ]) {
        expect(validate(schema, id).ok).toBe(false);
      }
    },
  );
  it('measures text budgets in UTF-16 units and preserves internal whitespace', () => {
    expect(
      validate(QuerySchema, { ...request.query, text: '🪁'.repeat(limits.query / 2) }).ok,
    ).toBe(true);
    expect(
      validate(QuerySchema, { ...request.query, text: '🪁'.repeat(limits.query / 2 + 1) }).ok,
    ).toBe(false);
    const result = requireValid(QuerySchema, { ...request.query, text: '  paper\n\twings  ' });
    expect(result.text).toBe('paper\n\twings');
  });
  it('accepts safe numeric endpoints and refuses coercion/nonfinite values', () => {
    expect(validate(GenerationSchema, 1).ok).toBe(true);
    expect(validate(GenerationSchema, Number.MAX_SAFE_INTEGER).ok).toBe(true);
    expect(validate(CountSchema, 0).ok).toBe(true);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(validate(GenerationSchema, value).ok).toBe(false);
      expect(validate(CountSchema, value).ok).toBe(false);
    }
    expect(validate(GenerationSchema, 0).ok).toBe(false);
  });
  it.each([
    { at: '2024-02-29T23:59:59.999Z', valid: true },
    { at: '2026-02-29T00:00:00.000Z', valid: false },
    { at: '2026-13-01T00:00:00.000Z', valid: false },
    { at: '2026-09-12T24:00:00.000Z', valid: false },
    { at: '2026-09-12T10:00:00Z', valid: false },
    { at: '2026-09-12T10:00:00.0000Z', valid: false },
    { at: '2026-09-12T10:00:00.000+00:00', valid: false },
    { at: 'not-an-instant', valid: false },
  ])('validates canonical real UTC instant $at', ({ at, valid }) => {
    expect(validate(TimestampSchema, at).ok).toBe(valid);
  });
  it('validates supported timezone identifiers without guessing or trimming', () => {
    expect(validate(TimeZoneSchema, 'UTC').ok).toBe(true);
    expect(validate(TimeZoneSchema, 'Europe/Zurich').ok).toBe(true);
    for (const zone of ['', ' Europe/Zurich ', 'fiction/zone', null])
      expect(validate(TimeZoneSchema, zone).ok).toBe(false);
  });
  it('contains schema/Proxy/getter exceptions and emits no sensitive diagnostic detail', () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const input = new Proxy(
        {},
        {
          get: () => {
            throw new Error('fiction-secret');
          },
        },
      );
      expect(validate(QuerySchema, input)).toEqual({ ok: false, code: 'invalid-contract' });
      const schema = v.custom(() => {
        throw new Error('fiction-secret');
      });
      expect(validate(schema, 'fiction-input')).toEqual({ ok: false, code: 'invalid-contract' });
      expect(() => requireValid(schema, 'fiction-input')).toThrow(/^Invalid contract context\.$/);
      expect(logger).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });
});

describe('array preflight rejects before inspecting hostile members', () => {
  const plan = { requestId: request.requestId, topics: ['fiction-topic'], keywords: [] };
  const ranking = { requestId: request.requestId, selections: [] };
  const aggregate = {
    requestId: request.requestId,
    state: 'success',
    results: [],
    outcomes: [],
    coverage: { extent: 'complete', reasons: [] },
  };
  const cases: {
    name: string;
    schema: v.GenericSchema;
    limit: number;
    input(items: unknown[]): unknown;
  }[] = [
    {
      name: 'providers',
      schema: QuerySchema,
      limit: 2,
      input: (items) => ({ ...request.query, providers: items }),
    },
    {
      name: 'scopes',
      schema: SearchRequestSchema,
      limit: 2,
      input: (items) => ({ ...request, scopes: items }),
    },
    {
      name: 'candidates',
      schema: CandidateListSchema,
      limit: limits.candidates,
      input: (items) => items,
    },
    {
      name: 'candidate evidence',
      schema: CandidateSchema,
      limit: limits.evidencePerCandidate,
      input: (items) => ({ ...chatCandidate, evidence: items }),
    },
    {
      name: 'topics',
      schema: ModelPlanSchema,
      limit: limits.planTerms,
      input: (items) => ({ ...plan, topics: items }),
    },
    {
      name: 'keywords',
      schema: ModelPlanSchema,
      limit: limits.planTerms,
      input: (items) => ({ ...plan, keywords: items }),
    },
    {
      name: 'ranked candidates',
      schema: ModelRankingSchema,
      limit: limits.candidates,
      input: (items) => ({ ...ranking, selections: items }),
    },
    {
      name: 'ranked evidence',
      schema: ModelRankingSchema,
      limit: limits.evidencePerCandidate,
      input: (items) => ({
        ...ranking,
        selections: [{ candidateId: chatCandidate.id, score: 1, evidenceIds: items }],
      }),
    },
    {
      name: 'aggregate results',
      schema: SearchOutcomeSchema,
      limit: limits.candidates * 2,
      input: (items) => ({ ...aggregate, results: items }),
    },
    {
      name: 'aggregate outcomes',
      schema: SearchOutcomeSchema,
      limit: 2,
      input: (items) => ({ ...aggregate, outcomes: items }),
    },
    {
      name: 'coverage reasons',
      schema: CoverageSchema,
      limit: 6,
      input: (items) => ({ extent: 'unknown', reasons: items }),
    },
  ];
  it.each(cases)('does not read members of oversized $name', ({ schema, limit, input }) => {
    const member = vi.fn(() => {
      throw new Error('fiction-member-must-not-be-read');
    });
    const items = Array(limit + 1);
    Object.defineProperty(items, 0, { get: member });
    expect(validate(schema, input(items))).toEqual({ ok: false, code: 'invalid-contract' });
    expect(member).not.toHaveBeenCalled();
  });
});

describe('maximum accepted normalized data and exact optional fields', () => {
  it('accepts full candidate/evidence/title budgets and rejects the next unit', () => {
    const candidate = {
      ...chatCandidate,
      title: 'x'.repeat(limits.title),
      evidence: Array.from({ length: limits.evidencePerCandidate }, (_, id) => ({
        id: `fiction-evidence-${id}`,
        source: 'native-snippet',
        text: 'x'.repeat(limits.excerpt),
      })),
    };
    expect(validate(CandidateSchema, candidate).ok).toBe(true);
    expect(validate(CandidateSchema, { ...candidate, title: `${candidate.title}x` }).ok).toBe(
      false,
    );
    const candidates = Array.from({ length: limits.candidates }, (_, id) => ({
      ...chatCandidate,
      id: `fiction-candidate-${id}`,
      conversationId: `fiction-thread-${id}`,
      evidence: [],
    }));
    expect(validate(CandidateListSchema, candidates).ok).toBe(true);
    expect(
      validate(CandidateListSchema, [...candidates, { ...candidates[0], id: 'fiction-overflow' }])
        .ok,
    ).toBe(false);
  });
  it('counts evidence across candidates, accepting exactly 64,000 units', () => {
    const candidates = Array.from({ length: 4 }, (_, id) => ({
      ...chatCandidate,
      id: `fiction-candidate-${id}`,
      conversationId: `fiction-thread-${id}`,
      evidence: Array.from({ length: 8 }, (_, evidence) => ({
        id: `fiction-e-${evidence}`,
        source: 'native-snippet',
        text: 'x'.repeat(2_000),
      })),
    }));
    expect(validate(CandidateListSchema, candidates).ok).toBe(true);
    expect(
      validate(CandidateListSchema, [
        ...candidates,
        {
          ...chatCandidate,
          evidence: [{ id: 'fiction-one-unit', source: 'native-snippet', text: 'x' }],
        },
      ]).ok,
    ).toBe(false);
  });
  it.each(['title', 'date', 'originalUrl'] as const)(
    'rejects explicit undefined/null for optional $0',
    (field) => {
      for (const value of [undefined, null])
        expect(validate(CandidateSchema, { ...chatCandidate, [field]: value }).ok).toBe(false);
    },
  );
  it('allows unknown links without a verifier and catches invalid URLs in direct helper calls', () => {
    const { originalUrl: _url, ...withoutUrl } = chatCandidate;
    expect(acceptsOriginalLink(withoutUrl, {})).toBe(true);
    expect(
      acceptsOriginalLink({ ...chatCandidate, originalUrl: 'not-a-url' }, { chatgpt: () => true }),
    ).toBe(false);
  });
  it.each(['login-expired', 'permission-needed', 'unavailable', 'scope-changed'] as const)(
    'keeps session failure %s separate from ready and rejects mixed metadata',
    (status) => {
      const failure = { status, provider: 'chatgpt', generation: 1 };
      expect(validate(SessionOutcomeSchema, failure).ok).toBe(true);
      expect(validate(SessionOutcomeSchema, { ...failure, scope: chatScope }).ok).toBe(false);
      expect(validate(SessionOutcomeSchema, { ...failure, generation: 0 }).ok).toBe(false);
    },
  );
});
