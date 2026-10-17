import type { Candidate, ModelPlan, ModelRanking, SearchRequest } from '../contracts';

export function termSpan(text: string, term: string): { start: number; end: number } | undefined {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').exec(text);

  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

export function rankKeywords(
  request: SearchRequest,
  candidates: readonly Candidate[],
  plan: ModelPlan,
): ModelRanking {
  const terms = [...new Set([...plan.topics, ...plan.keywords])];
  const selections = candidates.flatMap((candidate) => {
    const evidence = candidate.evidence.flatMap((item) => {
      const spans = terms.flatMap((term) => {
        const span = termSpan(item.text, term);

        return span ? [span] : [];
      });

      return spans.length ? [{ item, spans }] : [];
    });
    const score = evidence.reduce(
      (total, match) => total + match.spans.length * (match.item.source === 'title' ? 1 : 2),
      0,
    );

    return score === 0
      ? []
      : [
          {
            candidateId: candidate.id,
            score: Math.min(1, score / (terms.length * 3)),
            evidenceIds: evidence.map(({ item }) => item.id),
            spans: evidence.flatMap(({ item, spans }) =>
              spans.slice(0, 1).map((span) => ({ evidenceId: item.id, ...span })),
            ),
          },
        ];
  });

  return { requestId: request.requestId, selections: selections.sort((a, b) => b.score - a.score) };
}
