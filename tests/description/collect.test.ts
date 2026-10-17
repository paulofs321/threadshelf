import { describe, expect, it } from 'vitest';
import { collect } from '../../src/description/collect';
import type { Candidate, ProviderOutcome, ProviderRequest } from '../../src/contracts';
import { request, candidate, chatScope, linkVerifiers } from '../fixtures/description/corpus';

const query = request();
const providerRequest: ProviderRequest = {
  requestId: query.requestId,
  query: query.query,
  scope: chatScope,
};

function success(
  candidates: Candidate[],
  coverage: {
    extent: 'complete' | 'partial' | 'unknown';
    reasons: ('unknown-reach' | 'query-budget')[];
  } = { extent: 'complete', reasons: [] },
): ProviderOutcome {
  return { requestId: query.requestId, scope: chatScope, status: 'success', candidates, coverage };
}

function combine(a: ProviderOutcome | undefined, b: ProviderOutcome) {
  return collect(a, b, providerRequest, linkVerifiers);
}

const original = candidate('first', 'Authentication', 'Login security');

describe('cross-query collection budgets and scoped deduplication', () => {
  it('retains first stable ID and merges distinct exact evidence without mutating inputs', () => {
    const repeat = structuredClone(original);
    repeat.id = 'another-id' as typeof repeat.id;
    repeat.evidence = [
      {
        id: 'extra' as (typeof repeat.evidence)[number]['id'],
        source: 'native-snippet',
        text: 'OAuth credentials',
      },
    ];
    const a = success([original]);
    const b = success([repeat]);
    const before = JSON.stringify([a, b]);
    const result = combine(a, b);
    expect(result.status).toBe('success');

    if (result.status === 'success') {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.id).toBe(original.id);
      expect(result.candidates[0]?.evidence).toHaveLength(3);
    }

    expect(JSON.stringify([a, b])).toBe(before);
  });
  it.each(['title', 'date', 'id', 'evidence'] as const)(
    'fails closed on conflicting %s',
    (field) => {
      const repeat = structuredClone(original);

      if (field === 'title') {
        repeat.title = 'Different';
        repeat.evidence = repeat.evidence.filter((item) => item.source !== 'title');
      }

      if (field === 'id') repeat.conversationId = 'other' as typeof repeat.conversationId;

      if (field === 'evidence' && repeat.evidence[1]) repeat.evidence[1].text = 'Different';

      const first = structuredClone(original);

      if (field === 'date') {
        first.date = {
          at: '2026-01-01T00:00:00.000Z',
          meaning: 'conversation-updated',
          source: 'provider-metadata',
        };
        repeat.date = { ...first.date, at: '2026-02-01T00:00:00.000Z' };
      }

      expect(combine(success([first]), success([repeat])).status).toBe('schema-changed');
    },
  );
  it('fills absent metadata and propagates partial/unknown coverage', () => {
    const blank = structuredClone(original);
    delete blank.title;
    delete blank.originalUrl;
    blank.evidence = [];
    const a = combine(
      success([blank], { extent: 'partial', reasons: ['query-budget'] }),
      success([original]),
    );
    expect(a.status).toBe('success');

    if (a.status === 'success') {
      expect(a.candidates[0]?.title).toBe(original.title);
      expect(a.coverage.extent).toBe('partial');
    }

    const b = combine(
      success([original]),
      success([original], { extent: 'partial', reasons: ['query-budget'] }),
    );

    if (b.status === 'success') expect(b.coverage.extent).toBe('partial');

    const unknown = success([original], { extent: 'unknown', reasons: ['unknown-reach'] });

    for (const result of [
      combine(unknown, success([original])),
      combine(success([original]), unknown),
      combine(unknown, { requestId: query.requestId, scope: chatScope, status: 'unavailable' }),
    ]) {
      if (result.status === 'success') expect(result.coverage.extent).toBe('unknown');
    }
  });
  it('keeps evidence bounded while disclosing omitted excerpts', () => {
    const first = structuredClone(original);
    first.evidence = Array.from({ length: 8 }, (_, i) => ({
      id: `a-${i}` as (typeof original.evidence)[number]['id'],
      text: `auth ${i}`,
      source: 'native-snippet' as const,
    }));
    const extra = structuredClone(original);
    extra.evidence = [
      {
        id: 'extra' as (typeof original.evidence)[number]['id'],
        text: 'more auth',
        source: 'native-snippet',
      },
    ];
    const result = combine(success([first]), success([extra]));

    if (result.status === 'success') {
      expect(result.candidates[0]?.evidence).toHaveLength(8);
      expect(result.coverage.reasons).toContain('missing-evidence');
    }
  });
  it('bounds unique candidate counts', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      candidate(`item-${i}`, 'Authentication', 'Login'),
    );
    const result = combine(success(many), success([original]));

    if (result.status === 'success') {
      expect(result.candidates).toHaveLength(100);
      expect(result.coverage.reasons).toContain('result-limit');
    }
  });
  it('bounds combined text during insertion and enrichment', () => {
    const large = Array.from({ length: 4 }, (_, i) => {
      const value = candidate(`large-${i}`, 'Auth', 'Login');
      value.evidence = Array.from({ length: 8 }, (_, n) => ({
        id: `${i}-${n}` as (typeof original.evidence)[number]['id'],
        source: 'native-snippet' as const,
        text: `${i}${n}` + 'x'.repeat(1998),
      }));

      return value;
    });
    const insert = combine(success(large), success([original]));

    if (insert.status === 'success') {
      expect(insert.candidates).toHaveLength(4);
      expect(insert.coverage.reasons).toContain('result-limit');
    }

    const partial = structuredClone(large);

    if (partial[0]) partial[0].evidence = partial[0].evidence.slice(0, 7);

    const repeat = structuredClone(large[0]);

    if (!repeat) throw new Error('Fixture');

    repeat.evidence = [
      {
        id: 'enrichment' as (typeof original.evidence)[number]['id'],
        text: 'x'.repeat(2000),
        source: 'native-snippet',
      },
      {
        id: 'overflow' as (typeof original.evidence)[number]['id'],
        text: 'y'.repeat(2000),
        source: 'native-snippet',
      },
    ];
    // Fill the remaining byte budget with another short candidate before enrichment.
    const extra = candidate('short', 'Auth', 'z'.repeat(1500));
    const merged = combine(success([...partial, extra]), success([repeat]));

    if (merged.status === 'success') expect(merged.coverage.reasons).toContain('missing-evidence');
  });
  it('allows recovery from an earlier non-success in the pure collector', () => {
    expect(
      combine(
        { requestId: query.requestId, scope: chatScope, status: 'unavailable' },
        success([original]),
      ).status,
    ).toBe('success');
  });
});

it('appends distinct scoped conversations within budgets', () => {
  const other = candidate('second', 'Database', 'SQL');
  const result = combine(success([original]), success([other]));

  if (result.status === 'success')
    expect(result.candidates.map((item) => item.id)).toEqual(['first', 'second']);
});
