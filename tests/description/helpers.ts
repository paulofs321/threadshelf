import { vi } from 'vitest';
import { KeywordSearch } from '../../src/search';
import { DescriptionSearch } from '../../src/description';
import type { Candidate, ModelRanking, SearchPort, SearchRequest } from '../../src/contracts';
import { corpus, linkVerifiers, now } from '../fixtures/description/corpus';
import { providerPort } from '../fixtures/search/providers';

export const context = () => ({ signal: new AbortController().signal });

export function setup(
  options: Partial<ConstructorParameters<typeof DescriptionSearch>[0]> = {},
  candidates: readonly Candidate[] = corpus,
) {
  const chat = providerPort(
    'chatgpt',
    candidates.filter((item) => item.scope.provider === 'chatgpt'),
  );
  const google = providerPort(
    'google-ai-mode',
    candidates.filter((item) => item.scope.provider === 'google-ai-mode'),
  );
  const native = new KeywordSearch({ providers: [chat, google], linkVerifiers });
  const retrieval = {
    search: vi.fn<SearchPort['search']>((input, ctx) => native.search(input, ctx)),
    invalidate: vi.fn((scope) => native.invalidate(scope)),
  };
  let serial = 0;
  const engine = new DescriptionSearch({
    retrieval,
    linkVerifiers,
    now: () => now,
    freshId: () => `fiction-topic-${++serial}`,
    ...options,
  });

  return { engine, retrieval, chat, google, native };
}

export function ranking(input: SearchRequest, candidates: readonly Candidate[]): ModelRanking {
  return {
    requestId: input.requestId,
    selections: candidates.slice(0, 1).map((item) => ({
      candidateId: item.id,
      score: 0.9,
      evidenceIds: item.evidence.map((part) => part.id),
    })),
  };
}
