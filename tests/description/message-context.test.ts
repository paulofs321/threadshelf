import { describe, expect, it, vi } from 'vitest';
import { DescriptionSearch } from '../../src/description';
import { aggregateSearch } from '../../src/search/aggregate';
import { readProviderContext } from '../../src/search/read-context';
import { ChatGptProvider } from '../../src/providers/chatgpt/adapter';
import { verifyChatGptOriginalLink } from '../../src/providers/chatgpt/wire';
import { requireValid, SearchRequestSchema } from '../../src/contracts';
import type { Candidate, ProviderRequest, SearchPort, SearchRequest } from '../../src/contracts';
import { selectedChatGptScope } from '../fixtures/chatgpt/requests';
import {
  conversationId,
  otherConversationId,
  message,
  messagesBody,
  readResult,
  searchBody,
  searchItem,
} from '../fixtures/chatgpt/wire';
import { context } from './helpers';

function history(id: string, target: string) {
  const parts = [
    ...Array.from({ length: 12 }, (_, i) => `General discussion about unrelated daily plans ${i}.`),
    target,
    'Back to unrelated daily plans.',
  ];
  const mapping: Record<
    string,
    { id: string; parent: string | null; children: string[]; message: unknown }
  > = {};
  parts.forEach((text, i) => {
    mapping[`turn-${i}`] = {
      id: `turn-${i}`,
      parent: i === 0 ? null : `turn-${i - 1}`,
      children: i === parts.length - 1 ? [] : [`turn-${i + 1}`],
      message: message(text, i % 2 ? 'assistant' : 'user'),
    };
  });

  return {
    conversation_id: id,
    current_node: `turn-${parts.length - 1}`,
    is_temporary_chat: false,
    mapping,
  };
}

function fixture(
  target = 'Jobs in Switzerland, including application requirements.',
  ranker?: ConstructorParameters<typeof DescriptionSearch>[0]['ranker'],
) {
  const scope = selectedChatGptScope();
  const read = vi.fn(async (operation: { kind: string; conversationId?: string }) =>
    readResult(
      operation.kind === 'search'
        ? searchBody(
            [conversationId, otherConversationId].map((id) => ({
              ...searchItem(id),
              title: 'General career and life discussion',
              snippet: 'General career advice and everyday plans.',
            })),
          )
        : history(
            operation.conversationId ?? conversationId,
            operation.conversationId === conversationId
              ? target
              : 'Jobs in Canada. We planned a holiday in Switzerland.',
          ),
    ),
  );
  const provider = new ChatGptProvider(scope, { read });
  const verifiers = { chatgpt: verifyChatGptOriginalLink };

  const native = async (
    input: SearchRequest,
    ctx: ReturnType<typeof context>,
    description?: string,
  ) => {
    const request: ProviderRequest = { requestId: input.requestId, query: input.query, scope };
    const outcome = await provider.search(request, ctx);
    const result =
      description === undefined
        ? outcome
        : await readProviderContext(provider, request, outcome, description, verifiers, ctx);

    return aggregateSearch(input, [result], verifiers, 100, []);
  };

  const retrieval = {
    search: vi.fn<SearchPort['search']>((input, ctx) => native(input, ctx)),
    searchWithContext: vi.fn(
      (input: SearchRequest, description: string, ctx: ReturnType<typeof context>) =>
        native(input, ctx, description),
    ),
    invalidate: () => provider.invalidate(),
  };
  let serial = 0;
  const engine = new DescriptionSearch({
    retrieval,
    linkVerifiers: verifiers,
    now: () => '2026-10-18T08:00:00.000Z',
    freshId: () => `context-query-${++serial}`,
    ...(ranker ? { ranker } : {}),
  });
  const request = (text = 'jobs in Switzerland') =>
    requireValid(SearchRequestSchema, {
      requestId: 'description-with-context',
      query: { text, mode: 'description', providers: ['chatgpt'], timeZone: 'Europe/Paris' },
      scopes: [scope],
    });

  return { provider, retrieval, engine, read, request, scope };
}

describe('retrieve then read message context then rank', () => {
  it.each([
    {
      description: 'jobs in Switzerland',
      target: 'Jobs in Switzerland, including application requirements.',
    },
    { description: 'food without dairy', target: 'Food without dairy includes this lentil soup.' },
    {
      description: 'TV show time travel',
      target: 'A TV show about time travel follows a detective through different decades.',
    },
    {
      description: 'cobalt ceramic glaze',
      target: 'We mixed cobalt ceramic glaze for the next experiment.',
    },
  ])(
    'finds a supported subtopic in a broad conversation: $description',
    async ({ description, target }) => {
      const f = fixture(target);
      const result = await f.engine.search(f.request(description), context());
      expect(result.results).toHaveLength(1);
      const stored = result.outcomes.flatMap((item) =>
        item.status === 'success' ? item.candidates : [],
      );
      const matching = stored.find((item) => item.conversationId === conversationId);
      expect(result.results).toEqual([matching?.id]);
      expect(matching?.title).toBe('General career and life discussion');
      expect(
        matching?.evidence.some(
          (item) => item.source === 'provider-message' && item.text.includes(target),
        ),
      ).toBe(true);
      expect(f.retrieval.search).not.toHaveBeenCalled();
      expect(
        f.retrieval.searchWithContext.mock.calls.every(([, text]) => text === description),
      ).toBe(true);
      expect(
        f.read.mock.calls.filter(([operation]) => operation.kind === 'messages').length,
      ).toBeLessThanOrEqual(6);
      expect(result.coverage.reasons).toContain('missing-evidence');
    },
  );
  it('passes actual retrieved message evidence and the original intent to semantic ranking', async () => {
    const ranker = {
      rank: vi.fn(async (input: SearchRequest, candidates: readonly Candidate[]) => {
        const item = candidates.find((candidate) => candidate.conversationId === conversationId);
        const evidence = item?.evidence.find(
          (part) => part.source === 'provider-message' && part.text.includes('Zürich'),
        );

        return {
          requestId: input.requestId,
          selections:
            item && evidence
              ? [{ candidateId: item.id, score: 0.95, evidenceIds: [evidence.id] }]
              : [],
        };
      }),
    };
    const f = fixture('Hiring opportunities around Zürich and Lausanne.', ranker);
    const result = await f.engine.search(f.request(), context());
    expect(result.results).toHaveLength(1);
    expect(ranker.rank.mock.calls[0]?.[0].query.text).toBe('jobs in Switzerland');
    expect(result.description?.ranking.selections[0]?.evidenceIds[0]).toContain('context:');
  });
  it('does not read any messages for ordinary keyword retrieval', async () => {
    const f = fixture();
    const input = f.request();
    input.query.mode = 'keyword';
    await f.retrieval.search(input, context());
    expect(f.read.mock.calls.every(([operation]) => operation.kind === 'search')).toBe(true);
  });
  it('refuses unrecorded/stale conversations, aborts and invalidated scopes before reading context', async () => {
    const f = fixture();
    const input = f.request();
    const request = {
      requestId: input.requestId,
      query: { ...input.query, mode: 'keyword' as const },
      scope: f.scope,
    };
    expect(
      (await f.provider.readContext(request, conversationId, input.query.text, context())).status,
    ).toBe('scope-changed');
    await f.provider.search(request, context());
    const before = f.read.mock.calls.length;
    expect(
      (await f.provider.readContext(request, 'unknown', input.query.text, context())).status,
    ).toBe('scope-changed');
    expect(
      (
        await f.provider.readContext(
          { ...request, requestId: 'stale' as typeof request.requestId },
          conversationId,
          input.query.text,
          context(),
        )
      ).status,
    ).toBe('scope-changed');
    expect(
      (
        await f.provider.readContext(
          { ...request, query: { ...request.query, text: 'different' } },
          conversationId,
          input.query.text,
          context(),
        )
      ).status,
    ).toBe('scope-changed');
    expect(f.read).toHaveBeenCalledTimes(before);
    f.provider.invalidate();
    expect(
      (await f.provider.readContext(request, conversationId, input.query.text, context())).status,
    ).toBe('scope-changed');
  });
  it('returns explicit failures for malformed messages and terminal provider replies', async () => {
    for (const raw of [
      readResult(messagesBody(otherConversationId)),
      { status: 'login-expired' },
    ]) {
      const f = fixture();
      const input = f.request();
      const request = {
        requestId: input.requestId,
        query: { ...input.query, mode: 'keyword' as const },
        scope: f.scope,
      };
      await f.provider.search(request, context());
      f.read.mockResolvedValueOnce(raw as ReturnType<typeof readResult>);
      expect(
        (await f.provider.readContext(request, conversationId, input.query.text, context())).status,
      ).toBe(raw.status === 'login-expired' ? 'login-expired' : 'schema-changed');
    }
  });
});
