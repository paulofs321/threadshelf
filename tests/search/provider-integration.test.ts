import { describe, expect, it, vi } from 'vitest';
import { requireValid, SearchRequestSchema } from '../../src/contracts';
import { KeywordSearch, calendarDateRange } from '../../src/search';
import { ChatGptProvider } from '../../src/providers/chatgpt/adapter';
import { GoogleAiModeProvider } from '../../src/providers/google-ai-mode/adapter';
import { verifyChatGptOriginalLink } from '../../src/providers/chatgpt/wire';
import { verifyGoogleOriginalLink } from '../../src/providers/google-ai-mode/wire';
import { selectedChatGptScope } from '../fixtures/chatgpt/requests';
import { selectedGoogleAiModeScope } from '../fixtures/google-ai-mode/requests';
import { readResult, searchBody, searchItem } from '../fixtures/chatgpt/wire';
import { googleJson, googleMatch, googleThread } from '../fixtures/google-ai-mode/wire';

// Real adapters/parsers with handwritten transport responses. No Chrome or live account access.
function harness(dated = true) {
  const chatScope = selectedChatGptScope();
  const googleScope = selectedGoogleAiModeScope();
  const chatRead = vi.fn().mockResolvedValue(readResult(searchBody()));
  const row = googleThread();

  if (!dated) row[5] = null;

  const googleRead = vi.fn().mockResolvedValue({
    status: 'success',
    identityBefore: 'a'.repeat(64),
    identityAfter: 'a'.repeat(64),
    response: {
      status: 200,
      contentType: 'application/json',
      retryAfter: null,
      body: googleJson([[googleMatch(row)]]),
    },
  });
  const chat = new ChatGptProvider(chatScope, { read: chatRead });
  const google = new GoogleAiModeProvider(
    googleScope,
    { read: googleRead },
    { freshId: () => 'fictional-google-candidate' },
  );
  const engine = new KeywordSearch({
    providers: [chat, google],
    linkVerifiers: {
      chatgpt: verifyChatGptOriginalLink,
      'google-ai-mode': verifyGoogleOriginalLink,
    },
  });
  const request = requireValid(SearchRequestSchema, {
    requestId: 'fictional-adapter-integration',
    query: {
      text: 'imaginary orchard',
      mode: 'keyword',
      providers: ['chatgpt', 'google-ai-mode'],
      timeZone: 'Europe/Zurich',
    },
    scopes: [chatScope, googleScope],
  });

  return { chatRead, googleRead, engine, request };
}

describe('real normalized adapters composed into the pure search engine', () => {
  it('aggregates exact snippets, safe original links and native coverage limits', async () => {
    const { engine, request, chatRead, googleRead } = harness();
    const result = await engine.search(request, { signal: new AbortController().signal });
    expect(result.state).toBe('success');
    expect(result.results).toHaveLength(2);
    expect(result.coverage).toEqual({ extent: 'unknown', reasons: ['unknown-reach'] });

    for (const outcome of result.outcomes) {
      if (outcome.status !== 'success') throw new Error('Expected fictional adapter success.');

      expect(outcome.candidates[0]?.originalUrl).toMatch(/^https:/u);
      expect(
        outcome.candidates[0]?.evidence.some((evidence) => evidence.source === 'native-snippet'),
      ).toBe(true);
    }

    expect(chatRead).toHaveBeenCalledOnce();
    expect(googleRead).toHaveBeenCalledOnce();
  });

  it('excludes real-adapter unknown dates and preserves available update semantics', async () => {
    const { engine, request } = harness(false);
    request.query.dateRange = calendarDateRange('2025-10-01', '2025-11-01', request.query.timeZone);
    const result = await engine.search(request, { signal: new AbortController().signal });
    expect(result.results).toEqual(['chatgpt:0']);
    expect(result.coverage.reasons).toContain('unknown-dates');
    expect(result.outcomes[0]).toMatchObject({
      candidates: [{ date: { meaning: 'conversation-updated', source: 'provider-metadata' } }],
    });
    expect(result.outcomes[1]).toMatchObject({
      candidates: [{ scope: selectedGoogleAiModeScope() }],
    });
  });

  it('filters native Google record dates with their generic meaning and no unknown-date exclusion', async () => {
    const { engine, request, googleRead } = harness();
    request.query.dateRange = calendarDateRange('2026-10-01', '2026-11-01', request.query.timeZone);
    const result = await engine.search(request, { signal: new AbortController().signal });
    expect(result.results).toEqual(['fictional-google-candidate']);
    expect(result.coverage.reasons).not.toContain('unknown-dates');
    expect(result.outcomes[1]).toMatchObject({
      candidates: [
        {
          date: {
            meaning: 'provider-record',
            source: 'provider-metadata',
          },
        },
      ],
    });
    expect(googleRead).toHaveBeenCalledOnce();
  });

  it('keeps a real-adapter empty response partial when the other transport expires', async () => {
    const { engine, request, chatRead, googleRead } = harness();
    chatRead.mockResolvedValue(readResult(searchBody([])));
    googleRead.mockResolvedValue({ status: 'login-expired' });
    expect(await engine.search(request, { signal: new AbortController().signal })).toMatchObject({
      state: 'partial',
      results: [],
      outcomes: [{ status: 'success' }, { status: 'login-expired' }],
    });
  });

  it('preserves parser deduplication and rejects malformed transport success', async () => {
    const { engine, request, chatRead, googleRead } = harness();
    chatRead.mockResolvedValue(readResult(searchBody([searchItem(), searchItem()])));
    googleRead.mockResolvedValue({
      status: 'success',
      identityBefore: 'a'.repeat(64),
      identityAfter: 'a'.repeat(64),
      response: {
        status: 200,
        contentType: 'application/json',
        retryAfter: null,
        body: 'fictional malformed response',
      },
    });
    expect(await engine.search(request, { signal: new AbortController().signal })).toMatchObject({
      state: 'partial',
      results: ['chatgpt:0'],
      outcomes: [{ status: 'success' }, { status: 'schema-changed' }],
    });
  });
});
