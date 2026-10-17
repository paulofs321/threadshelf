import type { Candidate, ModelRanking, SearchRequest } from '../contracts';
import { descriptionWords, isContentWord } from './interpret';

const negation = /\b(?:no|not|never|without|excluding|except|cannot|[\p{L}]+n't)\b/iu;
const precedingNegation =
  /\b(?:no|not|never|without|excluding|except|cannot|[\p{L}]+n't)\s+(?:any\s+)?$/iu;
const followingNegation =
  /^\s+(?:(?:is|are|was|were)\s+(?:not|never)|(?:isn|aren|wasn|weren)'t)\b/iu;

/** With no semantic judge, require all literal constraints together; ambiguous passages abstain. */
function supportingSpan(
  text: string,
  required: ReadonlySet<string>,
  allowNegation: boolean,
  joiners: ReadonlySet<string>,
): { start: number; end: number } | undefined {
  for (const passage of text.matchAll(/[^.!?;,\r\n]+/gu)) {
    const found = new Set<string>();
    let start = 0;

    for (const token of passage[0].matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = token[0].toLowerCase();

      if ((word === 'and' || word === 'or') && !joiners.has(word)) {
        found.clear();
        continue;
      }

      if (!isContentWord(word)) continue;

      // Do not join unrelated subjects across intervening content, even in one sentence.
      if (!required.has(word)) {
        found.clear();
        continue;
      }

      if (found.size === 0) start = passage.index + token.index;

      found.add(word);

      if (found.size === required.size) {
        const end = passage.index + token.index + token[0].length;

        if (
          !allowNegation &&
          (precedingNegation.test(passage[0].slice(0, start - passage.index)) ||
            followingNegation.test(passage[0].slice(end - passage.index)))
        )
          continue;

        return { start, end };
      }
    }
  }

  return undefined;
}

export function rankKeywords(
  request: SearchRequest,
  candidates: readonly Candidate[],
): ModelRanking {
  const required = new Set(descriptionWords(request.query.text));
  const allowNegation = negation.test(request.query.text);
  const joiners = new Set(request.query.text.toLowerCase().match(/\b(?:and|or)\b/gu) ?? []);
  const selections = candidates.flatMap((candidate) => {
    const evidence = candidate.evidence.flatMap((item) => {
      const span = supportingSpan(item.text, required, allowNegation, joiners);

      return span ? [{ item, span }] : [];
    });
    const score = evidence.reduce(
      (total, match) => total + (match.item.source === 'title' ? 1 : 2),
      0,
    );

    return score === 0
      ? []
      : [
          {
            candidateId: candidate.id,
            score: Math.min(1, score / 3),
            evidenceIds: evidence.map(({ item }) => item.id),
            spans: evidence.map(({ item, span }) => ({ evidenceId: item.id, ...span })),
          },
        ];
  });

  return { requestId: request.requestId, selections: selections.sort((a, b) => b.score - a.score) };
}
