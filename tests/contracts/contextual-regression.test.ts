import { describe, expect, it } from 'vitest';
import {
  CacheEntrySchema,
  cacheEntrySchemaFor,
  CandidateSchema,
  limits,
  ModelPlanSchema,
  ModelRankingSchema,
  modelPlanSchemaFor,
  modelRankingSchemaFor,
  providerOutcomeSchemaFor,
  requireValid,
  searchOutcomeSchemaFor,
  SessionScopeSchema,
  validate,
} from '../../src/contracts';
import type { SearchRequest, ProviderRequest, VerifiedScope } from '../../src/contracts';
import {
  chatCandidate,
  chatScope,
  chatRequest,
  chatSuccess,
  descriptionRequest,
  ephemeralScope,
  googleCandidate,
  linkVerifiers,
  request,
} from '../fixtures/contracts';

describe('model limits and contextual grounding', () => {
  const plan = { requestId: request.requestId, topics: ['fiction-topic'], keywords: [] };
  it('accepts exact topic/keyword limits and rejects oversized terms, duplicates, and optional nulls', () => {
    const terms = Array.from(
      { length: limits.planTerms },
      (_, i) => `${i}${'x'.repeat(limits.term - 1)}`,
    );
    expect(validate(ModelPlanSchema, { ...plan, topics: terms, keywords: terms }).ok).toBe(true);
    for (const patch of [
      { topics: [...terms, 'overflow'] },
      { topics: ['x'.repeat(limits.term + 1)] },
      { topics: ['duplicate', 'duplicate'] },
      { keywords: [' '] },
      { proposedProviders: null },
      { proposedDateRange: undefined },
    ])
      expect(validate(ModelPlanSchema, { ...plan, ...patch }).ok).toBe(false);
    expect(
      validate(modelPlanSchemaFor(descriptionRequest), {
        ...plan,
        proposedProviders: ['google-ai-mode', 'chatgpt'],
      }).ok,
    ).toBe(true);
  });
  it('keeps omitted proposed filters absent and only proposes dates when no explicit date conflicts', () => {
    const result = requireValid(modelPlanSchemaFor(descriptionRequest), plan);
    expect(result).not.toHaveProperty('proposedProviders');
    expect(result).not.toHaveProperty('proposedDateRange');
    expect(
      validate(modelPlanSchemaFor(descriptionRequest), {
        ...plan,
        proposedDateRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      }).ok,
    ).toBe(true);
  });
  it('validates 100 grounded selections with eight evidence references and exact score endpoints', () => {
    const candidates = Array.from({ length: limits.candidates }, (_, i) =>
      requireValid(CandidateSchema, {
        ...chatCandidate,
        id: `fiction-candidate-${i}`,
        conversationId: `fiction-thread-${i}`,
        evidence: Array.from({ length: limits.evidencePerCandidate }, (_, e) => ({
          id: `fiction-evidence-${e}`,
          source: 'native-snippet',
          text: 'fiction',
        })),
      }),
    );
    const ranking = {
      requestId: request.requestId,
      selections: candidates.map((candidate, i) => ({
        candidateId: candidate.id,
        score: i % 2,
        evidenceIds: candidate.evidence.map((e) => e.id),
      })),
    };
    expect(validate(modelRankingSchemaFor(descriptionRequest, candidates), ranking).ok).toBe(true);
    expect(
      validate(ModelRankingSchema, {
        ...ranking,
        selections: [
          ...ranking.selections,
          { ...ranking.selections[0], candidateId: 'fiction-overflow' },
        ],
      }).ok,
    ).toBe(false);
    expect(validate(modelRankingSchemaFor(request, candidates), ranking).ok).toBe(false);
  });
  it('refuses stale account/workspace/ephemeral partitions before ranking even syntactically valid model output', () => {
    const variants = [
      { ...chatScope, accountPartition: 'fiction-other-account' },
      { ...chatScope, workspacePartition: null },
      ephemeralScope,
    ];
    for (const scope of variants)
      expect(() =>
        modelRankingSchemaFor(descriptionRequest, [
          { ...chatCandidate, scope: requireValid(SessionScopeSchema, scope) },
        ]),
      ).toThrow(/^Invalid contract context\.$/);
    expect(() =>
      modelRankingSchemaFor(descriptionRequest, [
        chatCandidate,
        { ...googleCandidate, id: chatCandidate.id },
      ]),
    ).toThrow(/^Invalid contract context\.$/);
    expect(() =>
      modelRankingSchemaFor(descriptionRequest, [{ ...chatCandidate, evidence: [] }]),
    ).not.toThrow();
    const empty = modelRankingSchemaFor(descriptionRequest, []);
    expect(validate(empty, { requestId: request.requestId, selections: [] }).ok).toBe(true);
    expect(
      validate(empty, {
        requestId: request.requestId,
        selections: [{ candidateId: chatCandidate.id, score: 1, evidenceIds: ['fiction-title'] }],
      }).ok,
    ).toBe(false);
  });
});

describe('verified cache isolation and clock boundaries', () => {
  const entry = {
    key: { version: 1, scope: chatScope },
    candidate: chatCandidate,
    cachedAt: '2026-10-14T08:00:00.000Z',
    expiresAt: '2026-10-14T08:00:00.001Z',
  };
  it('accepts a one-millisecond TTL at cachedAt and rejects the exclusive expiry instant', () => {
    expect(validate(cacheEntrySchemaFor(chatScope, entry.cachedAt, linkVerifiers), entry).ok).toBe(
      true,
    );
    expect(validate(cacheEntrySchemaFor(chatScope, entry.expiresAt, linkVerifiers), entry).ok).toBe(
      false,
    );
    expect(
      validate(cacheEntrySchemaFor(chatScope, '2026-10-14T07:59:59.999Z', linkVerifiers), entry).ok,
    ).toBe(false);
  });
  it.each([
    { ...chatScope, accountPartition: 'fiction-other-account' },
    { ...chatScope, workspacePartition: 'fiction-other-workspace' },
    { ...chatScope, workspacePartition: null },
    { ...chatScope, generation: 2 },
  ])('rejects a structurally valid entry from another current scope', (scope) => {
    const another = {
      ...entry,
      key: { version: 1, scope },
      candidate: { ...chatCandidate, scope },
    };
    expect(validate(CacheEntrySchema, another).ok).toBe(true);
    expect(
      validate(cacheEntrySchemaFor(chatScope, entry.cachedAt, linkVerifiers), another).ok,
    ).toBe(false);
  });
  it('rejects injected/unsafe cache fields and never needs a link verifier for an unknown link', () => {
    for (const patch of [
      { cookies: 'fiction' },
      { rawResponse: {} },
      { version: 2 },
      { cachedAt: undefined },
    ])
      expect(validate(CacheEntrySchema, { ...entry, ...patch }).ok).toBe(false);
    const { originalUrl: _url, ...candidate } = chatCandidate;
    expect(
      validate(cacheEntrySchemaFor(chatScope, entry.cachedAt, {}), { ...entry, candidate }).ok,
    ).toBe(true);
    expect(
      validate(
        cacheEntrySchemaFor(chatScope, entry.cachedAt, {
          chatgpt: () => {
            throw new Error('fiction-private');
          },
        }),
        entry,
      ).ok,
    ).toBe(false);
  });
});

describe('context builder validation and unsafe retrieved links', () => {
  it('rejects malformed caller contexts using safe errors rather than detailed input issues', () => {
    const bad = { ...request, scopes: [] } as SearchRequest;
    const badProvider = { ...chatRequest, scope: {} } as ProviderRequest;
    const builders = [
      () => modelPlanSchemaFor(bad),
      () => modelRankingSchemaFor(bad, []),
      () => searchOutcomeSchemaFor(bad, {}),
      () => providerOutcomeSchemaFor(badProvider, {}),
      () =>
        cacheEntrySchemaFor(
          ephemeralScope as unknown as VerifiedScope,
          '2026-10-14T08:00:00.000Z',
          {},
        ),
      () => cacheEntrySchemaFor(chatScope, 'not-a-clock', {}),
    ];
    for (const build of builders) expect(build).toThrow(/^Invalid contract context\.$/);
  });
  it('checks unsafe links in every retrieved candidate, including omitted display results', () => {
    const schema = searchOutcomeSchemaFor(request, linkVerifiers);
    const aggregate = {
      requestId: request.requestId,
      state: 'success',
      results: [],
      coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
      outcomes: [
        {
          ...chatSuccess,
          candidates: [{ ...chatCandidate, originalUrl: 'https://evil.invalid/' }],
        },
        { ...chatSuccess, scope: googleCandidate.scope, candidates: [] },
      ],
    };
    expect(validate(schema, aggregate).ok).toBe(false);
  });
});
