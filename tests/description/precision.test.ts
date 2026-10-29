import { afterEach, describe, expect, it, vi } from 'vitest';
import { rankKeywords } from '../../src/description';
import { modelRankingSchemaFor, searchOutcomeSchemaFor, validate } from '../../src/contracts';
import type { Candidate, SearchRequest } from '../../src/contracts';
import { candidate, googleScope, linkVerifiers, request } from '../fixtures/description/corpus';
import { context, setup } from './helpers';

afterEach(() => vi.useRealTimers());

const examples = [
  {
    description: 'Conversations where I talked about switzerland jobs',
    matching: 'We compared jobs in Switzerland.',
    unrelated: [
      'Jobs in Canada.',
      'Switzerland holiday routes.',
      'Jobs in Canada. We visited Switzerland.',
      'Jobs in Canada; Switzerland holidays followed.',
      'Jobs in Canada\nSwitzerland holiday routes.',
      'We visited Switzerland on holiday while applying for jobs in Canada.',
      'There were no jobs in Switzerland.',
      'There were not jobs in Switzerland.',
      "Jobs in Switzerland weren't discussed.",
      'Jobs in Switzerlandia.',
      'Jobs and Switzerland.',
      'Jobs or Switzerland.',
      'Jobs, Switzerland.',
    ],
  },
  {
    description: 'Which conversations were about food without dairy?',
    matching: 'We chose food without dairy.',
    unrelated: ['Food with dairy.', 'Dairy farms.', 'Food notes. A recipe without dairy.'],
  },
  {
    description: 'What TV show was I looking for about space travel before?',
    matching: 'The TV show about space travel had a spaceship crew.',
    unrelated: [
      'A TV show about cooking.',
      'Space travel research.',
      'A TV show about cooking. We studied space travel.',
    ],
  },
  {
    description: 'Which sessions talked about cobalt ceramic glaze?',
    matching: 'We tried cobalt ceramic glaze.',
    unrelated: [
      'Cobalt pigments.',
      'Ceramic bowls with a clear glaze.',
      'Cobalt prices. Ceramic glaze.',
    ],
  },
];

describe('complete-description literal fallback', () => {
  it.each(examples)('requires connected evidence for $description', async (example) => {
    const items = [
      candidate('connected', 'Research notes', example.matching),
      ...example.unrelated.map((text, i) => candidate(`unrelated-${i}`, 'Other notes', text)),
    ];
    const input = request(example.description);
    const { engine, chat, google } = setup({}, items);

    // Native search is intentionally broad. The final ranking must narrow this union.
    for (const port of [chat, google])
      port.search.mockImplementation(async (call) => ({
        requestId: call.requestId,
        scope: call.scope,
        status: 'success',
        candidates: items.filter(
          (item) =>
            item.scope.provider === port.provider &&
            item.evidence.some((part) => part.text.toLowerCase().includes(call.query.text)),
        ),
        coverage: { extent: 'complete', reasons: [] },
      }));

    const result = await engine.search(input, context());
    expect(result.results).toEqual(['connected']);
    expect(result.description?.ranking.selections[0]?.evidenceIds).toEqual(['connected-excerpt']);
    expect(validate(searchOutcomeSchemaFor(input, linkVerifiers), result).ok).toBe(true);
  });

  it('does not join independent title, snippet, message or provider evidence', async () => {
    const split = candidate('split', 'Switzerland', 'Jobs in Canada');
    split.evidence.push({
      id: 'split-message' as (typeof split.evidence)[number]['id'],
      source: 'rendered-message',
      text: 'More Switzerland holiday notes.',
    });
    const items = [split, candidate('jobs', 'Jobs', 'Jobs in Canada', googleScope)];
    const result = await setup({}, items).engine.search(request('Switzerland jobs'), context());
    expect(result.results).toEqual([]);
    expect(result.state).toBe('success');
  });

  it('keeps exact Unicode offsets, reversed word order and complete title-only evidence', () => {
    const input = request('CÉRAMIQUE café céramique');
    const items = [
      candidate('body', 'Notes', '😀 Notes. Café with céramique.'),
      candidate('title', 'Céramique café', 'Unrelated notes.'),
      candidate('substring', 'Notes', 'Céramique caféine.'),
    ];
    const result = rankKeywords(input, items);
    expect(result.selections.map((item) => item.candidateId)).toEqual(['body', 'title']);
    const span = result.selections[0]?.spans?.[0];
    expect(items[0]?.evidence[1]?.text.slice(span?.start, span?.end)).toBe('Café with céramique');
    expect(validate(modelRankingSchemaFor(input, items), result).ok).toBe(true);
  });

  it('retains substantive show wording while removing a leading search command', async () => {
    const items = [
      candidate('tv', 'TV show', 'TV show recommendations.'),
      candidate('hardware', 'TV', 'TV hardware recommendations.'),
    ];
    const result = await setup({}, items).engine.search(
      request('Show me conversations about a TV show'),
      context(),
    );
    expect(result.results).toEqual(['tv']);
  });

  it('retains an explicitly requested conjunction in literal evidence', () => {
    const input = request('red and blue yarn');
    const item = candidate('yarn', 'Notes', 'Red and blue yarn.');
    expect(
      rankKeywords(input, [item]).selections.map((selection) => selection.candidateId),
    ).toEqual(['yarn']);
  });

  it('does not weaken constraints beyond the retrieval-plan term budget', async () => {
    const text = Array.from({ length: 17 }, (_, i) => `constraint${i}`).join(' ');
    const items = [
      candidate('all', 'Notes', text),
      candidate('partial', 'Notes', text.replace('constraint16', 'different')),
    ];
    const result = await setup({}, items).engine.search(request(text), context());
    expect(result.results).toEqual(['all']);
    expect(result.coverage.reasons).toContain('query-budget');
  });

  it.each(['where did I discuss', '???'])(
    'abstains when there are no content words: %s',
    (text) => {
      expect(rankKeywords(request(text), [candidate('empty', text, text)]).selections).toEqual([]);
    },
  );
});

describe('fallback after AI retrieval expansion', () => {
  const interpreter = {
    interpret: async (input: SearchRequest) => ({
      requestId: input.requestId,
      topics: ['careers'],
      keywords: ['travel'],
    }),
  };
  const items = [
    candidate('connected', 'Notes', 'Jobs in Switzerland.'),
    candidate('jobs', 'Notes', 'Jobs in Canada.'),
    candidate('place', 'Notes', 'Switzerland holidays.'),
  ];

  it.each(['absent', 'throwing', 'invalid'])(
    'uses original constraints when the ranker is %s',
    async (status) => {
      const ranker =
        status === 'absent'
          ? undefined
          : {
              rank: async () => {
                if (status === 'throwing') throw new Error('Synthetic model failure');

                return { selections: [] };
              },
            };
      const result = await setup(
        { interpreter, ...(ranker ? { ranker } : {}) },
        items,
      ).engine.search(request('Switzerland jobs'), context());
      expect(result.results).toEqual(['connected']);
      expect(result.description?.terms).toEqual(['careers', 'travel']);
      expect(result.description?.notices).toContain('literal-keywords');

      if (ranker) expect(result.description?.notices).toContain('invalid-model-output');
    },
  );

  it('keeps all original constraints after a ranking timeout', async () => {
    vi.useFakeTimers();
    const ranker = { rank: vi.fn(() => new Promise<unknown>(() => {})) };
    const { engine } = setup({ interpreter, ranker, policy: { modelTimeoutMs: 10 } }, items);
    const run = engine.search(request('Switzerland jobs'), context());
    await vi.advanceTimersByTimeAsync(10);
    const result = await run;
    expect(result.results).toEqual(['connected']);
    expect(result.description?.notices).toContain('model-timeout');
  });

  it('lets the semantic ranker select paraphrases that have no literal matches', async () => {
    const semantic = candidate('semantic', 'Notes', 'Hiring opportunities around Zürich.');
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) => ({
        requestId: input.requestId,
        selections: [
          { candidateId: 'semantic', score: 0.95, evidenceIds: [candidates[0]?.evidence[1]?.id] },
        ],
      })),
    };
    const input = request('Switzerland jobs');
    const result = await setup({ interpreter, ranker }, [semantic]).engine.search(input, context());
    expect(result.results).toEqual(['semantic']);
    expect(ranker.rank.mock.calls[0]?.[0].query.text).toBe(input.query.text);
  });
});
