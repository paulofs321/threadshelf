import { expect, it, vi } from 'vitest';
import {
  requireValid,
  SearchRequestSchema,
  searchOutcomeSchemaFor,
  validate,
} from '../../src/contracts';
import { KeywordSearch } from '../../src/search';
import { DescriptionSearch } from '../../src/description';
import { ChatGptProvider } from '../../src/providers/chatgpt/adapter';
import { verifyChatGptOriginalLink } from '../../src/providers/chatgpt/wire';
import { selectedChatGptScope } from '../fixtures/chatgpt/requests';
import {
  readResult,
  searchBody,
  searchItem,
  conversationId,
  otherConversationId,
} from '../fixtures/chatgpt/wire';

it('collects real ChatGPT response-local IDs across reordered keyword results and changing exact snippets', async () => {
  const scope = selectedChatGptScope();
  const third = '33333333-3333-3333-3333-333333333333';
  const row = (id: string, text: string) => ({
    ...searchItem(id),
    title: `Fictional orchard ${id.slice(0, 1)}`,
    snippet: text,
  });
  const batches = [
    [
      row(conversationId, 'Orchard cultivation first excerpt.'),
      row(otherConversationId, 'Orchard pruning first excerpt.'),
    ],
    [
      row(otherConversationId, 'Cultivation alternate exact excerpt.'),
      row(third, 'Orchard cultivation third thread.'),
      row(conversationId, 'Cultivation different first-thread excerpt.'),
    ],
    [
      row(conversationId, 'Pruning exact new first-thread excerpt.'),
      row(third, 'Pruning third-thread excerpt.'),
    ],
  ];
  const read = vi.fn();

  for (const batch of batches) read.mockResolvedValueOnce(readResult(searchBody(batch)));

  const native = new KeywordSearch({
    providers: [new ChatGptProvider(scope, { read })],
    linkVerifiers: { chatgpt: verifyChatGptOriginalLink },
  });
  let serial = 0;
  const verifiers = { chatgpt: verifyChatGptOriginalLink };
  const engine = new DescriptionSearch({
    retrieval: native,
    linkVerifiers: verifiers,
    now: () => '2026-10-17T10:00:00.000Z',
    freshId: () => `fiction-multi-${++serial}`,
    interpreter: {
      interpret: async (input) => ({
        requestId: input.requestId,
        topics: ['orchard', 'cultivation', 'pruning'],
        keywords: [],
      }),
    },
  });
  const input = requireValid(SearchRequestSchema, {
    requestId: 'fiction-multi-description',
    query: {
      text: 'orchard',
      mode: 'description',
      providers: ['chatgpt'],
      timeZone: 'Europe/Zurich',
    },
    scopes: [scope],
  });
  const result = await engine.search(input, { signal: new AbortController().signal });
  expect(result.state).toBe('success');
  expect(result.results).toHaveLength(3);
  expect(read).toHaveBeenCalledTimes(3);
  expect(validate(searchOutcomeSchemaFor(input, verifiers), result).ok).toBe(true);
  const outcome = result.outcomes[0];

  if (outcome?.status !== 'success') throw new Error('Expected synthetic ChatGPT success');

  expect(new Set(outcome.candidates.map((item) => item.id)).size).toBe(3);

  for (const item of outcome.candidates) {
    expect(item.originalUrl).toBe(`https://chatgpt.com/c/${item.conversationId}`);
    expect(item.title).toBe(`Fictional orchard ${item.conversationId.slice(0, 1)}`);
    expect(item.evidence.map((e) => e.text)).toEqual(
      batches.flatMap((batch) =>
        batch
          .filter((row) => row.payload.conversation_id === item.conversationId)
          .map((row) => row.snippet),
      ),
    );
    expect(new Set(item.evidence.map((e) => e.id)).size).toBe(item.evidence.length);
  }
});
