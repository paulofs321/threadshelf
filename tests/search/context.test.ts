import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachMessageContext,
  contextDeadlineMs,
  selectMessageContext,
} from '../../src/search/context';
import { readProviderContext } from '../../src/search/read-context';
import { limits, providerOutcomeSchemaFor, validate } from '../../src/contracts';
import type {
  Candidate,
  ConversationContextPort,
  ProviderOutcome,
  ProviderRequest,
} from '../../src/contracts';
import { candidate, chatScope, linkVerifiers, request } from '../fixtures/description/corpus';
import { context } from '../description/helpers';
import { deferred } from '../fixtures/search/providers';

const input = request('jobs Switzerland');
const query: ProviderRequest = {
  requestId: input.requestId,
  query: { ...input.query, mode: 'keyword' },
  scope: chatScope,
};
const first = candidate('first', 'General careers', 'Jobs in general.');
const second = candidate('second', 'Other careers', 'Jobs abroad.');
const success = (candidates: readonly Candidate[] = [first, second]): ProviderOutcome => ({
  requestId: query.requestId,
  scope: query.scope,
  status: 'success',
  candidates: structuredClone([...candidates]),
  coverage: { extent: 'complete', reasons: [] },
});
const run = (
  port: Partial<ConversationContextPort>,
  outcome: unknown = success(),
  ctx = context(),
  req = query,
) => readProviderContext(port, req, outcome, input.query.text, linkVerifiers, ctx);

afterEach(() => vi.useRealTimers());

describe('bounded exact message windows', () => {
  it('retrieves later qualifiers past the former prefix limit and preserves neighboring messages', () => {
    const parts = [
      'General engineering opportunities. '.repeat(6000),
      'Please focus on jobs in Switzerland.',
      'We can compare application requirements next.',
    ];
    const selected = selectMessageContext(parts, 'conversations about jobs in Switzerland');
    expect(selected).toContain(parts[1]);
    expect(selected).toContain(parts[2]);
    expect(selected.every((text) => parts.some((part) => part.includes(text)))).toBe(true);
    const recent = selectMessageContext(
      ['Old planning.', 'Other unrelated planning.', 'Hiring opportunities around Zürich.'],
      'jobs Switzerland',
    );
    expect(recent).toContain('Hiring opportunities around Zürich.');
  });
  it('does not create a keyword by cutting inside a larger word', () => {
    const parts = ['x'.repeat(598) + 'nojobs in Switzerland.'];
    const windows = selectMessageContext(parts, 'jobs Switzerland');
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((text) => !/\bjobs\b/iu.test(text))).toBe(true);
  });
  it('finds a later subtopic instead of returning only early general messages', () => {
    const parts = Array.from({ length: 12 }, (_, i) => `General jobs discussion ${i}.`);
    parts.push('We compared jobs in Switzerland, including application requirements.');
    const windows = selectMessageContext(parts, input.query.text);
    expect(windows).toContain(parts.at(-1));
    expect(windows).toHaveLength(5);
    expect(windows.every((text) => parts.some((part) => part.includes(text)))).toBe(true);
    expect(selectMessageContext([], '???')).toEqual([]);
    expect(selectMessageContext(['   ', 'Same', 'Same'], '???')).toEqual(['Same']);
  });
  it('bounds long-message scans, overlapping windows and surrogate boundaries', () => {
    const text =
      'a'.repeat(599) +
      '😀' +
      'b'.repeat(198) +
      '😀' +
      'c'.repeat(1000) +
      ' jobs in Switzerland ' +
      'x'.repeat(140000);
    const windows = selectMessageContext([text, 'Unscanned marker'], input.query.text);
    expect(windows.some((value) => value.includes('jobs in Switzerland'))).toBe(true);
    expect(windows.length).toBeLessThanOrEqual(5);

    for (const value of windows) {
      expect(value.length).toBeLessThanOrEqual(1000);
      expect(value).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      expect([text, 'Unscanned marker'].some((part) => part.includes(value))).toBe(true);
    }

    expect(windows).toContain('Unscanned marker');
  });
  it('attaches source-owned messages and the exact title without ID collisions or mutating inputs', () => {
    const item = structuredClone(first);

    if (item.evidence[1]) item.evidence[1].id = 'context:0' as (typeof item.evidence)[number]['id'];

    item.evidence.reverse();
    item.evidence = item.evidence.filter((part) => part.source !== 'title');
    const before = JSON.stringify(item);
    const enriched = attachMessageContext(
      item,
      [
        '',
        item.evidence[0]?.text ?? '',
        ...Array.from({ length: 10 }, (_, i) => `Exact context ${i}`),
      ],
      'provider-message',
    );
    expect(enriched.evidence).toHaveLength(8);
    expect(new Set(enriched.evidence.map((part) => part.id)).size).toBe(8);
    expect(
      enriched.evidence.some((part) => part.source === 'title' && part.text === item.title),
    ).toBe(true);
    expect(JSON.stringify(item)).toBe(before);
    const untitled = structuredClone(first);
    delete untitled.title;
    untitled.evidence = [];
    expect(attachMessageContext(untitled, ['Exact'], 'rendered-message').evidence[0]?.source).toBe(
      'rendered-message',
    );
    expect(
      attachMessageContext(first, ['Exact'], 'provider-message').evidence.filter(
        (part) => part.source === 'title',
      ),
    ).toHaveLength(1);
  });
});

describe('retrieved-inventory context boundary', () => {
  it('prioritizes a distinctive qualifier beyond the first eight native results', async () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      candidate(`broad-${i}`, 'Engineering job watch', 'Jobs in general.'),
    );
    const target = candidate(
      'qualified',
      'Weekly engineering watch',
      'Focus on jobs in Switzerland.',
    );
    items.push(target);
    const readContext = vi.fn<ConversationContextPort['readContext']>(async (_request, id) => {
      const item = items.find((part) => part.conversationId === id);

      if (!item) throw new Error('Unexpected synthetic candidate');

      return success([
        attachMessageContext(item, ['Exact supporting message.'], 'provider-message'),
      ]);
    });
    const visited = new Set<string>();
    const outcome = success(items);
    await readProviderContext(
      { readContext },
      query,
      outcome,
      input.query.text,
      linkVerifiers,
      context(),
      visited,
    );
    expect(readContext).toHaveBeenCalledTimes(8);
    expect(readContext.mock.calls[0]?.[1]).toBe(target.conversationId);
    await readProviderContext(
      { readContext },
      query,
      outcome,
      input.query.text,
      linkVerifiers,
      context(),
      visited,
    );
    expect(readContext).toHaveBeenCalledTimes(16);
    expect(new Set(readContext.mock.calls.map((call) => call[1])).size).toBe(16);
  });
  it('reads date-eligible candidates beyond the former first two, preserving metadata, quotes and original input', async () => {
    const excluded = candidate(
      'excluded',
      'Old',
      'Old jobs',
      chatScope,
      '2020-01-01T00:00:00.000Z',
    );
    const eligible = [first, second, candidate('third', 'More', 'Jobs')].map((item) => ({
      ...item,
      date: {
        at: '2026-10-01T00:00:00.000Z',
        meaning: 'conversation-updated' as const,
        source: 'provider-metadata' as const,
      },
    }));
    const outcome = success([excluded, ...eligible]);
    const before = JSON.stringify(outcome);
    const req = {
      ...query,
      query: {
        ...query.query,
        dateRange: { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
      },
    };
    const readContext = vi.fn<ConversationContextPort['readContext']>(async (_request, id) => {
      const item = eligible.find((part) => part.conversationId === id);

      if (!item) throw new Error('Unretrieved target');

      return success([attachMessageContext(item, ['Jobs in Switzerland.'], 'provider-message')]);
    });
    const result = await run({ readContext }, outcome, context(), req);
    expect(readContext.mock.calls.map((call) => call[1])).toEqual(['first', 'second', 'third']);
    expect(readContext.mock.calls[0]?.[2]).toBe(input.query.text);
    expect(JSON.stringify(result)).toContain('Jobs in Switzerland.');
    expect(JSON.stringify(outcome)).toBe(before);
    expect(validate(providerOutcomeSchemaFor(req, linkVerifiers), result).ok).toBe(true);
  });
  it('keeps native evidence with an explicit coverage limit when a reader is absent', async () => {
    expect(await run({})).toMatchObject({
      status: 'success',
      candidates: [first, second],
      coverage: { extent: 'partial', reasons: ['missing-evidence'] },
    });
    expect(await run({}, success([]))).toEqual(success([]));
    expect(await run({}, null)).toMatchObject({ status: 'schema-changed' });
  });
  it.each([
    'unavailable',
    'schema-changed',
    'timeout',
    'interrupted',
    'cancelled',
    'rate-limited',
  ] as const)('retains native candidates on context %s', async (status) => {
    const readContext = vi.fn(async () => ({
      requestId: query.requestId,
      scope: query.scope,
      status,
    }));
    const result = await run({ readContext });
    expect(result).toMatchObject({ status: 'success', candidates: [first, second] });
    expect(validate(providerOutcomeSchemaFor(query, linkVerifiers), result).ok).toBe(true);
    expect(readContext).toHaveBeenCalledTimes(status === 'rate-limited' ? 1 : 2);

    if (status === 'rate-limited') expect(result).toHaveProperty('rateLimit', {});
  });
  it('retains a context rate-limit retry hint and throwing-reader failures', async () => {
    expect(
      await run({
        readContext: async () => ({
          requestId: query.requestId,
          scope: query.scope,
          status: 'rate-limited',
          retryAfterMs: 1234,
        }),
      }),
    ).toHaveProperty('rateLimit', { retryAfterMs: 1234 });
    expect(
      await run({
        readContext: async () => {
          throw new Error('Private failure');
        },
      }),
    ).toMatchObject({ candidates: [first, second] });
  });
  it.each(['scope-changed', 'permission-needed', 'login-expired'] as const)(
    'erases native evidence on context %s',
    async (status) => {
      expect(
        await run({
          readContext: async () => ({ requestId: query.requestId, scope: query.scope, status }),
        }),
      ).toEqual({ requestId: query.requestId, scope: query.scope, status });
    },
  );
  it.each([
    'id',
    'conversationId',
    'title',
    'date',
    'originalUrl',
    'extra-candidate',
    'new-native',
    'malformed',
  ] as const)('rejects context metadata or inventory tampering: %s', async (change) => {
    const item = structuredClone(first);

    if (change === 'id') item.id = 'unknown' as typeof item.id;

    if (change === 'conversationId') item.conversationId = 'unknown' as typeof item.conversationId;

    if (change === 'title') {
      item.title = 'Different';
      item.evidence = [];
    }

    if (change === 'date')
      item.date = {
        at: '2026-01-01T00:00:00.000Z',
        meaning: 'conversation-updated',
        source: 'provider-metadata',
      };

    if (change === 'originalUrl') delete item.originalUrl;

    if (change === 'new-native')
      item.evidence.push({
        id: 'new' as (typeof item.evidence)[number]['id'],
        source: 'native-snippet',
        text: 'Invented native snippet',
      });

    const raw =
      change === 'malformed'
        ? null
        : success(change === 'extra-candidate' ? [item, second] : [item]);
    expect(await run({ readContext: async () => raw })).toMatchObject({
      candidates: [first, second],
    });
  });
  it.each(['timeout', 'cancel', 'pre-abort'] as const)(
    'bounds %s and discards late context',
    async (stop) => {
      vi.useFakeTimers();
      const pending = deferred<unknown>();
      const controller = new AbortController();
      const readContext = vi.fn<ConversationContextPort['readContext']>(() => pending.promise);

      if (stop === 'pre-abort') controller.abort();

      const resultPromise = run({ readContext }, success(), { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);

      if (stop === 'timeout') await vi.advanceTimersByTimeAsync(contextDeadlineMs);
      else controller.abort();

      const result = await resultPromise;
      expect(result.status).toBe(stop === 'timeout' ? 'success' : 'cancelled');

      if (stop !== 'pre-abort') expect(readContext.mock.calls[0]?.[3].signal.aborted).toBe(true);

      if (stop === 'pre-abort') pending.resolve(null);
      else pending.reject(new Error('Late private context'));

      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('keeps aggregate evidence bounded while prioritizing read targets', async () => {
    const items = [
      first,
      second,
      ...Array.from({ length: 4 }, (_, i) => {
        const item = candidate(`large-${i}`, 'Large', 'Snippet');
        item.evidence = Array.from({ length: 8 }, (_, n) => ({
          id: `part-${n}` as (typeof item.evidence)[number]['id'],
          source: 'native-snippet',
          text: `${n}` + 'x'.repeat(1899),
        }));

        return item;
      }),
    ];

    const readContext = async (_request: ProviderRequest, id: string) => {
      const original = items.find((item) => item.conversationId === id);

      if (!original) throw new Error('Fixture');

      const item = structuredClone(original);
      item.evidence = Array.from({ length: 8 }, (_, i) => ({
        id: `context-${i}` as (typeof item.evidence)[number]['id'],
        source: 'provider-message',
        text: `${i}` + 'y'.repeat(1999),
      }));

      return success([item]);
    };

    const result = await run({ readContext }, success(items));
    expect(result.status).toBe('success');

    if (result.status !== 'success') return;

    expect(result.candidates.slice(0, 2).every((item) => item.evidence.length === 8)).toBe(true);
    expect(
      result.candidates.reduce(
        (sum, item) => sum + item.evidence.reduce((n, part) => n + part.text.length, 0),
        0,
      ),
    ).toBeLessThanOrEqual(limits.totalEvidence);
    expect(result.candidates.at(-1)?.evidence).toHaveLength(0);
  });
});
