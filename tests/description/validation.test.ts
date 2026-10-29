import { describe, expect, it } from 'vitest';
import {
  EvidenceIdSchema,
  requireValid,
  modelRankingSchemaFor,
  rankingReferencesCandidates,
  searchOutcomeSchemaFor,
  validate,
} from '../../src/contracts';
import type { ModelRanking, SearchOutcome } from '../../src/contracts';
import { request, candidate, linkVerifiers } from '../fixtures/description/corpus';
import { setup, context } from './helpers';

const item = candidate('span', 'Authentication 😀', 'prefix 😀 authentication suffix');
const input = request();
const excerptId = requireValid(EvidenceIdSchema, 'span-excerpt');

function selection(start = 10, end = 24): ModelRanking {
  return {
    requestId: input.requestId,
    selections: [
      {
        candidateId: item.id,
        score: 0.8,
        evidenceIds: [excerptId],
        spans: [{ evidenceId: excerptId, start, end }],
      },
    ],
  };
}

describe('exact evidence spans and contextual outcome validation', () => {
  it('accepts exact UTF-16 spans and whole evidence references', () => {
    const schema = modelRankingSchemaFor(input, [item]);
    expect(validate(schema, selection()).ok).toBe(true);
    expect(item.evidence[1]?.text.slice(10, 24)).toBe('authentication');
    const output = selection();
    delete output.selections[0]?.spans;
    expect(validate(schema, output).ok).toBe(true);
    expect(validate(schema, selection(7, 9)).ok).toBe(true);
    expect(validate(schema, selection(0, item.evidence[1]?.text.length)).ok).toBe(true);
  });
  it.each([
    [10, 10],
    [11, 10],
    [-1, 5],
    [0, 100],
    [8, 9],
    [7, 8],
    [1.5, 3],
    [0, Infinity],
  ])('rejects invalid span [%s,%s)', (start, end) => {
    expect(validate(modelRankingSchemaFor(input, [item]), selection(start, end)).ok).toBe(false);
  });
  it('rejects unknown, cross-candidate, uncited and duplicate spans or invented quote keys', () => {
    for (const changes of [
      { evidenceId: 'unknown', start: 0, end: 1 },
      { evidenceId: item.evidence[0]?.id, start: 0, end: 1 },
      { evidenceId: item.evidence[1]?.id, start: 0, end: 1, quote: 'fabricated' },
    ]) {
      const output = selection();
      const first = output.selections[0];

      if (first) Object.assign(first, { spans: [changes] });

      expect(validate(modelRankingSchemaFor(input, [item]), output).ok).toBe(false);
    }

    const duplicate = selection();
    const first = duplicate.selections[0];

    if (first?.spans) first.spans.push(...first.spans);

    expect(validate(modelRankingSchemaFor(input, [item]), duplicate).ok).toBe(false);
    expect(
      rankingReferencesCandidates(
        {
          selections: [
            {
              candidateId: item.id,
              score: 1,
              evidenceIds: [],
              spans: [
                { evidenceId: 'missing' as (typeof item.evidence)[number]['id'], start: 0, end: 1 },
              ],
            },
          ],
        },
        [item],
      ),
    ).toBe(false);
  });
  it('accepts model dates only when equal to the effective filter', async () => {
    const interpreter = {
      interpret: async (value: typeof input) => ({
        requestId: value.requestId,
        topics: ['authentication'],
        keywords: [],
        proposedDateRange: value.query.dateRange,
      }),
    };
    const result = await setup({ interpreter }).engine.search(
      request('authentication last month'),
      context(),
    );
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(result.description?.execution?.interpretation.status).toBe('completed');
  });
  it.each([
    'keyword-mode',
    'request-id',
    'result-order',
    'unknown-evidence',
    'explicit-omitted',
    'explicit-changed',
    'outside-date',
    'unknown-date-hidden',
  ] as const)('rejects a tampered report: %s', async (change) => {
    const query = request('authentication');

    if (change.startsWith('explicit'))
      query.query.dateRange = {
        start: '2026-08-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
      };

    const value: SearchOutcome = await setup().engine.search(query, context());
    const report = value.description;

    if (!report) throw new Error('Missing fixture report');

    if (change === 'keyword-mode') query.query.mode = 'keyword';

    if (change === 'request-id') report.ranking.requestId = 'obsolete' as typeof query.requestId;

    if (change === 'result-order') {
      expect(value.results.length).toBeGreaterThan(1);
      value.results.reverse();
    }

    if (change === 'unknown-evidence')
      report.ranking.selections[0]?.evidenceIds.push(
        'unretrieved' as (typeof item.evidence)[number]['id'],
      );

    if (change === 'explicit-omitted') delete report.dateRange;

    if (change === 'explicit-changed' || change === 'outside-date')
      report.dateRange = { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' };

    if (change === 'unknown-date-hidden') {
      report.dateRange = { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' };
      value.results = [];
      report.ranking.selections = [];
    }

    expect(validate(searchOutcomeSchemaFor(query, linkVerifiers), value).ok).toBe(false);
  });
  it('accepts an inferred filter with explicitly disclosed unknown dates', async () => {
    const result = await setup().engine.search(request('authentication last month'), context());
    expect(
      validate(searchOutcomeSchemaFor(request('authentication last month'), linkVerifiers), result)
        .ok,
    ).toBe(true);
  });
});
