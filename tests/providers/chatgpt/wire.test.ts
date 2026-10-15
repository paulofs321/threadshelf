import { describe, expect, it } from 'vitest';
import {
  parseChatGptCandidates,
  parseChatGptMessages,
  verifyChatGptOriginalLink,
} from '../../../src/providers/chatgpt/wire';
import { CandidateListSchema, requireValid } from '../../../src/contracts';
import type { ConversationId } from '../../../src/contracts';
import { selectedChatGptScope } from '../../fixtures/chatgpt/requests';
import {
  conversationId,
  otherConversationId,
  searchBody,
  searchItem,
  listBody,
  listItem,
  messagesBody,
  message,
} from '../../fixtures/chatgpt/wire';

const scope = selectedChatGptScope();

describe('ChatGPT verified keyword/list normalization', () => {
  it('uses payload conversation ID, exact native snippet, provider UTC updated date and original link', () => {
    const result = parseChatGptCandidates(searchBody(), scope, 'search');
    expect(result.candidates[0]).toMatchObject({
      conversationId,
      originalUrl: `https://chatgpt.com/c/${conversationId}`,
      title: 'Fictional project',
      date: {
        at: '2025-10-09T08:53:20.125Z',
        meaning: 'conversation-updated',
        source: 'provider-metadata',
      },
      evidence: [{ text: '  Exact fictional prototype excerpt.  ', source: 'native-snippet' }],
    });
    expect(result.coverage).toEqual({ extent: 'unknown', reasons: ['unknown-reach'] });
  });
  it('keeps successful no-match distinct from schema failures and never claims full history', () => {
    expect(parseChatGptCandidates(searchBody([]), scope, 'search')).toEqual({
      candidates: [],
      coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
    });
    expect(() =>
      parseChatGptCandidates({ ...searchBody([]), source_statuses: [] }, scope, 'search'),
    ).toThrow();
  });
  it('deduplicates by conversation ID and retains distinct exact snippets, never titles as IDs', () => {
    const a = searchItem(),
      b = { ...searchItem(), snippet: 'Another exact excerpt.' };
    const result = parseChatGptCandidates(
      searchBody([a, a, b, searchItem(otherConversationId)]),
      scope,
      'search',
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.evidence).toHaveLength(2);
  });
  it('strips additive wire fields while rejecting missing/wrong required fields', () => {
    const item = searchItem();
    expect(
      parseChatGptCandidates({ ...searchBody(), extra: 'ignored' }, scope, 'search').candidates,
    ).toHaveLength(1);
    for (const bad of [
      null,
      [],
      {},
      { ...searchBody(), items: null },
      {
        ...searchBody(),
        items: [{ ...item, payload: { ...item.payload, conversation_id: '../escape' } }],
      },
      { ...searchBody(), items: [{ ...item, source_type: 'file' }] },
      { ...searchBody(), items: [{ ...item, snippet: 3 }] },
      { ...searchBody(), partial_results: 'false' },
      { ...searchBody(), cursor: '' },
      { ...searchBody(), items: [{ ...searchItem(), update_time: NaN }] },
      { ...searchBody(), items: Array.from({ length: 31 }, () => item) },
    ])
      expect(() => parseChatGptCandidates(bad, scope, 'search')).toThrow();
  });
  it.each([null, -1, Infinity, 253_402_300_800])(
    'omits unknown/unrepresentable seconds date %s',
    (value) => {
      const row = { ...searchItem(), update_time: value };
      expect(
        parseChatGptCandidates(searchBody([row]), scope, 'search').candidates[0],
      ).not.toHaveProperty('date');
    },
  );
  it.each([
    { cursor: 'synthetic-cursor' },
    { partial_results: true },
    { source_statuses: [{ source_type: 'conversation', status: 'ok', has_more: true }] },
  ])('discloses observed incompleteness %j', (patch) => {
    expect(parseChatGptCandidates({ ...searchBody(), ...patch }, scope, 'search').coverage).toEqual(
      { extent: 'partial', reasons: ['unknown-reach', 'result-limit'] },
    );
  });
  it('bounds title/snippet/evidence without whitespace rewriting or exceeding the total budget', () => {
    const rows = Array.from({ length: 30 }, (_, n) => ({
      ...searchItem(`${n.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`),
      title: 'T'.repeat(500),
      snippet: ' '.repeat(3) + 'x'.repeat(3_000),
    }));
    const result = parseChatGptCandidates(searchBody(rows), scope, 'search');
    expect(result.candidates[0]?.title).toHaveLength(300);
    expect(result.candidates[0]?.evidence[0]?.text).toHaveLength(2_000);
    expect(result.candidates[0]?.evidence[0]?.text.startsWith('   ')).toBe(true);
    expect(() => requireValid(CandidateListSchema, result.candidates)).not.toThrow();
    expect(result.coverage.reasons).toContain('result-limit');
  });
  it('bounds duplicate enrichment, falls back to exact title, and discloses missing evidence', () => {
    const rows = Array.from({ length: 12 }, (_, n) => ({
      ...searchItem(),
      snippet: `Excerpt ${n}`,
    }));
    expect(
      parseChatGptCandidates(searchBody(rows), scope, 'search').candidates[0]?.evidence,
    ).toHaveLength(8);
    const result = parseChatGptCandidates(
      searchBody([
        { ...searchItem(), snippet: ' ', title: ' Exact title ' },
        { ...searchItem(otherConversationId), title: ' ', snippet: '' },
      ]),
      scope,
      'search',
    );
    expect(result.candidates[0]?.evidence[0]).toMatchObject({
      source: 'title',
      text: ' Exact title ',
    });
    expect(result.coverage.reasons).toContain('missing-evidence');
  });
  it('normalizes UTC list metadata and omits temporary chats', () => {
    const result = parseChatGptCandidates(
      listBody([listItem(), { ...listItem(otherConversationId), is_temporary_chat: true }]),
      scope,
      'list',
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.date?.at).toBe('2025-10-09T08:53:20.125Z');
    expect(result.candidates[0]?.evidence[0]?.source).toBe('title');
  });
  it.each([null, 'unknown', '2025-02-30T08:00:00.000Z', '2025-99-99T00:00:00Z', '2025-10-09'])(
    'omits unknown/invalid list date %s',
    (update_time) => {
      expect(
        parseChatGptCandidates(listBody([{ ...listItem(), update_time }]), scope, 'list')
          .candidates[0],
      ).not.toHaveProperty('date');
    },
  );
  it('handles canonical Z dates and discloses bounded listing', () => {
    const body = listBody([{ ...listItem(), update_time: '2025-10-09T08:53:20Z' }]);
    body.total = 300;
    expect(parseChatGptCandidates(body, scope, 'list').coverage.reasons).toContain('result-limit');
    expect(
      parseChatGptCandidates({ ...body, total: 1, limit: 1 }, scope, 'list').coverage.reasons,
    ).toContain('result-limit');
  });
  it.each([
    { offset: 1 },
    { total: 0 },
    { limit: 0 },
    { limit: 1, items: [listItem(), listItem(otherConversationId)] },
    { items: [{ ...listItem(), workspace_id: 'unverified-workspace' }] },
  ])('rejects inconsistent/out-of-scope listing %j', (patch) => {
    expect(() => parseChatGptCandidates({ ...listBody(), ...patch }, scope, 'list')).toThrow();
  });
  it.each([
    'http://chatgpt.com/c/ID',
    'https://chatgpt.com.evil.invalid/c/ID',
    'https://chatgpt.com/c/ID?x=1',
    'https://chatgpt.com/c/ID#x',
    'https://chatgpt.com/g/ID',
    'https://u:p@chatgpt.com/c/ID',
    'https://chatgpt.com:444/c/ID',
    'https://chatgpt.com/c/%49D',
  ])('rejects unsafe/unobserved link %s', (url) => {
    expect(
      verifyChatGptOriginalLink(
        new URL(url.replace('ID', conversationId)),
        conversationId as ConversationId,
      ),
    ).toBe(false);
  });
  it('accepts only an exact canonical link with a verified ID shape', () => {
    expect(
      verifyChatGptOriginalLink(
        new URL(`https://chatgpt.com/c/${conversationId}`),
        conversationId as ConversationId,
      ),
    ).toBe(true);
    expect(
      verifyChatGptOriginalLink(new URL('https://chatgpt.com/c/bad'), 'bad' as ConversationId),
    ).toBe(false);
  });
});

describe('ChatGPT active-branch exact message evidence', () => {
  it('reads ordered active-branch user/assistant text parts exactly', () => {
    expect(parseChatGptMessages(messagesBody(), conversationId)).toEqual([
      'Synthetic question?',
      '  Exact fictional message.  ',
    ]);
  });
  it('excludes other branches, hidden/system/tool/analysis and unsupported content', () => {
    for (const patch of [
      { author: { role: 'system' } },
      { author: { role: 'tool' } },
      { channel: 'analysis' },
      { metadata: { is_visually_hidden_from_conversation: true } },
      { content: { content_type: 'multimodal_text', parts: [{}] } },
    ]) {
      const b = messagesBody();
      b.mapping.answer.message = { ...message(), ...patch } as typeof b.mapping.answer.message;
      expect(parseChatGptMessages(b, conversationId)).toEqual(['Synthetic question?']);
    }

    const b = messagesBody();
    b.mapping.answer.message = { ...message(), channel: 'final' };
    Object.assign(b.mapping, {
      inactive: {
        id: 'inactive',
        parent: 'root',
        children: [],
        message: message('Unselected branch'),
      },
    });
    expect(parseChatGptMessages(b, conversationId)).toEqual([
      'Synthetic question?',
      '  Exact fictional message.  ',
    ]);
  });
  it('bounds excerpts and preserves separate parts without inventing separators', () => {
    const b = messagesBody();
    b.mapping.answer.message.content.parts = [
      '',
      ' ',
      ...Array.from({ length: 8 }, (_, n) => `${n}` + 'x'.repeat(3_000)),
    ];
    const result = parseChatGptMessages(b, conversationId);
    expect(result).toHaveLength(4);
    expect(result[1]).toHaveLength(2_000);
  });
  it.each([
    'cycle',
    'dangling',
    'node-id',
    'wrong-conversation',
    'temporary',
    'bad-parts',
    'missing-parts',
    'bad-message',
    'oversized-graph',
  ])('rejects %s', (kind) => {
    const b = messagesBody();
    if (kind === 'cycle') b.mapping.root.parent = 'answer';
    if (kind === 'dangling') b.current_node = 'absent';
    if (kind === 'node-id') b.mapping.answer.id = 'wrong';
    if (kind === 'wrong-conversation') b.conversation_id = otherConversationId;
    if (kind === 'temporary') b.is_temporary_chat = true;
    if (kind === 'bad-parts') b.mapping.answer.message.content.parts = [{}];
    if (kind === 'missing-parts')
      b.mapping.answer.message.content = {} as typeof b.mapping.answer.message.content;
    if (kind === 'bad-message') b.mapping.root.message = {};
    if (kind === 'oversized-graph')
      Object.assign(
        b.mapping,
        Object.fromEntries(Array.from({ length: 2_049 }, (_, n) => [`node-${n}`, {}])),
      );
    expect(() => parseChatGptMessages(b, conversationId)).toThrow();
  });
});
