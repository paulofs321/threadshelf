import { describe, expect, it } from 'vitest';
import { candidate, request } from '../../fixtures/description/corpus';
import { context, setup } from '../helpers';
import { fixture } from './helpers';

// Decisions are authored synthetic outputs, not a benchmark of the real browser model.
describe('full-intent model prompt composition', () => {
  it.each([
    {
      description: 'Conversations where I talked about switzerland jobs',
      terms: ['hiring', 'Switzerland', 'applications'],
      evidence: 'Hiring opportunities near Zürich and Lausanne.',
      partial: [
        'Hiring in Canada.',
        'Holidays in Switzerland.',
        'Hiring in Canada. A holiday in Switzerland.',
      ],
    },
    {
      description: 'Which food did we consider without dairy?',
      terms: ['meals', 'dairy', 'recipes'],
      evidence: 'Lentil soup prepared with oat milk.',
      partial: [
        'Meals with cream.',
        'Dairy production.',
        'Meals with cream. A separate dairy-free soap.',
      ],
    },
    {
      description: 'What TV show was I looking for about time travel before?',
      terms: ['series', 'time', 'travel'],
      evidence: 'A series where a detective jumps between decades.',
      partial: ['A cooking series.', 'Travel bookings.', 'A cooking series. Then I booked travel.'],
    },
  ])('carries the complete request through both prompts: $description', async (example) => {
    const matching = candidate('complete', 'Saved notes', example.evidence);
    const items = [
      matching,
      ...example.partial.map((text, i) => candidate(`partial-${i}`, 'Other notes', text)),
    ];
    const f = fixture();
    await f.ready();
    f.session.prompt
      .mockResolvedValueOnce(JSON.stringify({ topics: example.terms, keywords: [] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          selections: [
            { candidateId: matching.id, score: 0.95, evidenceIds: [matching.evidence[1]?.id] },
          ],
        }),
      );
    const input = request(example.description);
    const result = await setup({ model: () => f.model }, items).engine.search(input, context());
    expect(result.results).toEqual(['complete']);
    expect(result.description?.strategy).toBe('model-assisted');
    expect(f.session.prompt).toHaveBeenCalledTimes(2);

    const prompts = f.session.prompt.mock.calls.map(([prompt]) => String(prompt));

    for (const prompt of prompts) {
      const data = JSON.parse(prompt.split('JSON:\n')[1] ?? '{}');
      expect(data.description).toBe(input.query.text);
    }

    // The ranker gets the union, including misleading co-occurrences, and must judge the full intent.
    const ranking = JSON.parse(prompts[1]?.split('JSON:\n')[1] ?? '{}');
    expect(
      ranking.candidates.map((item: { candidateId: string }) => item.candidateId).sort(),
    ).toEqual(items.map((item) => item.id).sort());
    expect(prompts[0]).toContain('Preserve relationships, qualifiers and exclusions');
    expect(prompts[1]).toContain('independently mentioning all words is insufficient');
    expect(f.session.destroy).toHaveBeenCalledTimes(2);
    f.model.disable();
  });

  it('preserves an explicitly requested alternative for the semantic judge', async () => {
    const matching = candidate('one-alternative', 'Food notes', 'We chose lentil soup.');
    const f = fixture();
    await f.ready();
    f.session.prompt
      .mockResolvedValueOnce(JSON.stringify({ topics: ['soup', 'salad'], keywords: [] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          selections: [
            { candidateId: matching.id, score: 0.9, evidenceIds: [matching.evidence[1]?.id] },
          ],
        }),
      );
    const input = request('Which food was soup or salad?');
    const result = await setup({ model: () => f.model }, [matching]).engine.search(
      input,
      context(),
    );
    expect(result.results).toEqual(['one-alternative']);
    expect(String(f.session.prompt.mock.calls[1]?.[0])).toContain(input.query.text);
    expect(String(f.session.prompt.mock.calls[1]?.[0])).toContain(
      'only when the description explicitly requests them',
    );
    f.model.disable();
  });
});
