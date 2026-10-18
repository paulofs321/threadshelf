import { limits, requireValid, CandidateSchema } from '../contracts';
import type { Candidate, Evidence } from '../contracts';
import { descriptionWords } from './terms';

export const contextReadLimit = 2;
export const contextDeadlineMs = 6000;
const scanLimit = 128_000;
const windowSize = 800;

/** Exact, bounded windows from existing messages; no topic expansion or generated quotations. */
export function selectMessageContext(parts: readonly string[], description: string): string[] {
  const terms = new Set(descriptionWords(description));
  const windows: { text: string; score: number; part: number; start: number }[] = [];
  let remaining = scanLimit;

  for (const [part, text] of parts.entries()) {
    const length = Math.min(text.length, remaining);
    remaining -= length;

    for (let start = 0; start < length; start += 600) {
      let begin = start;
      let end = Math.min(start + windowSize, length);

      if (/[\uDC00-\uDFFF]/u.test(text.charAt(begin))) begin++;

      if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;

      while (
        begin < end &&
        begin > 0 &&
        /[\p{L}\p{N}]/u.test(text.charAt(begin - 1)) &&
        /[\p{L}\p{N}]/u.test(text.charAt(begin))
      )
        begin++;

      while (
        end > begin &&
        end < text.length &&
        /[\p{L}\p{N}]/u.test(text.charAt(end - 1)) &&
        /[\p{L}\p{N}]/u.test(text.charAt(end))
      )
        end--;

      const value = text.slice(begin, end);

      if (!value.trim()) continue;

      const found = new Set(
        (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => terms.has(word)),
      );
      windows.push({ text: value, score: found.size, part, start: begin });
    }

    if (remaining === 0) break;
  }

  const selected: typeof windows = [];
  const ranked = windows.toSorted((a, b) => b.score - a.score);
  // Keep recent context as well as lexical hits so paraphrases are still available to the model.
  const choices = [
    ...ranked.filter((item) => item.score > 0).slice(0, 2),
    ...windows.toReversed().slice(0, 2),
    ...ranked,
  ];

  for (const window of choices) {
    if (
      selected.some(
        (item) =>
          item.text === window.text ||
          (item.part === window.part && Math.abs(item.start - window.start) < windowSize),
      )
    )
      continue;

    selected.push(window);

    if (selected.length === 4) break;
  }

  return selected.toSorted((a, b) => a.part - b.part || a.start - b.start).map((item) => item.text);
}

export function attachMessageContext(
  candidate: Candidate,
  texts: readonly string[],
  source: 'provider-message' | 'rendered-message',
): Candidate {
  const value = structuredClone(candidate);
  const evidence: Evidence[] = value.evidence.slice(0, 2);
  const used = new Set<string>(value.evidence.map((item) => item.id));
  let ordinal = 0;

  const nextId = () => {
    while (used.has(`context:${ordinal}`)) ordinal++;

    const id = `context:${ordinal++}` as Evidence['id'];
    used.add(id);

    return id;
  };

  if (value.title && !evidence.some((item) => item.source === 'title'))
    evidence.push({ id: nextId(), source: 'title', text: value.title });

  for (const text of texts) {
    if (evidence.length === limits.evidencePerCandidate) break;

    if (!text.trim() || evidence.some((item) => item.text === text)) continue;

    evidence.push({ id: nextId(), source, text });
  }

  return requireValid(CandidateSchema, { ...value, evidence });
}
