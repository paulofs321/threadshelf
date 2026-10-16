import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAiModeProvider } from '../../../src/providers/google-ai-mode/adapter';
import type { GoogleAiModeReadPort } from '../../../src/providers/google-ai-mode/transport';
import { matchesDateRange } from '../../../src/contracts';
import { calendarDateRange } from '../../../src/search/dates';
import { googleAiModeRequest } from '../../fixtures/google-ai-mode/requests';
import { googleJson, googleMatch, googleThread } from '../../fixtures/google-ai-mode/wire';

const identity = 'a'.repeat(64);
const success = { status: 'success', identityBefore: identity, identityAfter: identity };
const context = () => ({ signal: new AbortController().signal });
const label = (text = '13 October 2026') => ({
  ...success,
  dateLabel: { text, observedAt: '2026-10-15T23:30:00.000Z' },
});

function fixture(count = 1) {
  const port = {
    read: vi.fn<GoogleAiModeReadPort['read']>().mockResolvedValue({
      ...success,
      response: {
        status: 200,
        contentType: 'application/json',
        retryAfter: null,
        body: googleJson([
          Array.from({ length: count }, (_, i) => googleMatch(googleThread(`fiction-${i}`))),
        ]),
      },
    }),
    openDate: vi.fn<NonNullable<GoogleAiModeReadPort['openDate']>>().mockResolvedValue(label()),
    openEvidence: vi.fn<NonNullable<GoogleAiModeReadPort['openEvidence']>>().mockResolvedValue({
      ...success,
      rendered: ['A fictional rendered answer.'],
    }),
  };
  const request = googleAiModeRequest();
  request.query.dateRange = calendarDateRange('2026-10-13', '2026-10-14', request.query.timeZone);
  let id = 0;
  const provider = new GoogleAiModeProvider(request.scope, port, {
    freshId: () => `fiction-${id++}`,
  });

  return { port, request, provider };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Google date enrichment', () => {
  it('reads only retrieved scoped links and removes unknown-date coverage when every date is known', async () => {
    const { provider, request, port } = fixture(2);
    port.openDate.mockResolvedValueOnce(label()).mockResolvedValueOnce(label('19:28'));
    const outcome = await provider.search(request, context());

    if (outcome.status !== 'success') throw new Error('Expected synthetic success');

    expect(outcome.candidates.map((candidate) => candidate.date?.calendarDay?.date)).toEqual([
      '2026-10-13',
      '2026-10-16',
    ]);
    expect(
      outcome.candidates.map((candidate) => matchesDateRange(candidate, request.query.dateRange)),
    ).toEqual([true, false]);
    expect(outcome.coverage.reasons).not.toContain('unknown-dates');
    expect(port.openDate).toHaveBeenCalledWith(
      outcome.candidates[0] &&
        expect.objectContaining({
          conversationId: 'fiction-0',
          scope: request.scope,
        }),
      identity,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const messages = await provider.messages(request, 'fiction-0', context());
    expect(messages).toMatchObject({
      status: 'success',
      candidates: [{ date: outcome.candidates[0]?.date }],
    });

    if (messages.status === 'success')
      expect(messages.coverage.reasons).not.toContain('unknown-dates');
  });
  it('also dates listed candidates without claiming native timestamp meanings', async () => {
    const { provider, request, port } = fixture();
    port.read.mockResolvedValue({
      ...success,
      response: {
        status: 200,
        contentType: 'application/json',
        retryAfter: null,
        body: googleJson([[googleThread('fiction-0')], null, 0, null, null, 'fiction-tail']),
      },
    });
    expect(await provider.list(request, context())).toMatchObject({
      status: 'success',
      candidates: [{ date: { meaning: 'message-sent', source: 'rendered-message' } }],
    });
  });
  it.each([
    { status: 'unavailable' },
    { status: 'timeout' },
    { status: 'schema-changed' },
    { status: 'rate-limited' },
    {},
    success,
    label('Yesterday'),
    { ...label(), rendered: ['Unexpected private text'] },
    { ...label(), response: { status: 200, contentType: null, retryAfter: null, body: '' } },
    { ...label(), dateLabel: { text: '13 October 2026', observedAt: 'invalid' } },
  ])(
    'preserves matches and unknown-date coverage on unavailable/malformed optional dates %#',
    async (value) => {
      const { provider, request, port } = fixture();
      port.openDate.mockResolvedValue(value);
      const result = await provider.search(request, context());
      expect(result).toMatchObject({
        status: 'success',
        candidates: [{ conversationId: 'fiction-0' }],
      });

      if (result.status !== 'success') throw new Error('Expected synthetic success');

      expect(result.candidates[0]).not.toHaveProperty('date');
      expect(result.coverage.reasons).toContain('unknown-dates');
    },
  );
  it('keeps mixed known and unknown candidates without erasing coverage limits', async () => {
    const { provider, request, port } = fixture(2);
    port.openDate.mockResolvedValueOnce(label()).mockResolvedValueOnce(label('Yesterday'));
    const result = await provider.search(request, context());

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.date).toBeTruthy();
    expect(result.candidates[1]?.date).toBeUndefined();
    expect(result.coverage.reasons).toContain('unknown-dates');
  });
  it.each([
    'scope-changed',
    'login-expired',
    'permission-needed',
    'interrupted',
    'cancelled',
  ] as const)(
    'propagates %s during optional date reads instead of displaying unsafe results',
    async (status) => {
      const { provider, request, port } = fixture(4);
      port.openDate.mockResolvedValue({ status });
      expect((await provider.search(request, context())).status).toBe(status);
      expect((await provider.messages(request, 'fiction-0', context())).status).not.toBe('success');
    },
  );
  it('invalidates identity when a date belongs to another account', async () => {
    const { provider, request, port } = fixture();
    port.openDate.mockResolvedValue({ ...label(), identityAfter: 'b'.repeat(64) });
    expect((await provider.search(request, context())).status).toBe('scope-changed');
    expect((await provider.inspectSession(context())).status).toBe('scope-changed');
  });
  it('bounds date work to one tab at a time and seven seconds, ignores late replies, and releases timers', async () => {
    vi.useFakeTimers();
    const { provider, request, port } = fixture(10);
    const finishes: ((value: unknown) => void)[] = [];
    port.openDate.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const pending = provider.search(request, context());
    await vi.advanceTimersByTimeAsync(0);
    expect(port.openDate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7000);
    const result = await pending;
    expect(result.status).toBe('success');
    expect(port.openDate).toHaveBeenCalledTimes(1);

    for (const [, , ctx] of port.openDate.mock.calls) expect(ctx.signal.aborted).toBe(true);

    for (const finish of finishes) finish(label());

    await vi.advanceTimersByTimeAsync(0);

    if (result.status === 'success')
      expect(result.candidates.every((candidate) => !candidate.date)).toBe(true);

    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cancel', 'invalidate', 'replace'] as const)(
    'discards the date phase after %s without restoring obsolete inventory',
    async (action) => {
      vi.useFakeTimers();
      const { provider, request, port } = fixture();
      port.openDate.mockImplementationOnce(() => new Promise(() => {}));
      const controller = new AbortController();
      const pending = provider.search(request, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(port.openDate).toHaveBeenCalledTimes(1);

      if (action === 'cancel') controller.abort();

      if (action === 'invalidate') provider.invalidate();

      if (action === 'replace')
        expect((await provider.search(request, context())).status).toBe('success');

      expect((await pending).status).toBe(action === 'cancel' ? 'cancelled' : 'scope-changed');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('uses only the remaining provider budget after a slow native search', async () => {
    vi.useFakeTimers();
    const { provider, request, port } = fixture();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const original = port.read.getMockImplementation();

    if (!original) throw new Error('Missing synthetic read implementation');

    port.read.mockImplementation(async (...args) => {
      vi.spyOn(performance, 'now').mockReturnValue(11_000);

      return original(...args);
    });
    expect((await provider.search(request, context())).status).toBe('success');
    expect(port.openDate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not open tabs for successful empty results', async () => {
    const { provider, request, port } = fixture(0);
    expect(await provider.search(request, context())).toMatchObject({
      status: 'success',
      candidates: [],
    });
    expect(port.openDate).not.toHaveBeenCalled();
  });
});

it('discards completion when the scope retires after the native read but before publication', async () => {
  const { port, request } = fixture();
  const provider = new GoogleAiModeProvider(
    request.scope,
    { read: port.read },
    {
      freshId: () => {
        queueMicrotask(() => provider.invalidate());

        return 'fictional-late-candidate';
      },
    },
  );
  expect((await provider.search(request, context())).status).toBe('scope-changed');
});

it.each(['unavailable', 'rate-limited'] as const)(
  'stops optional date reads on %s and preserves all matches',
  async (status) => {
    const { provider, request, port } = fixture(5);
    port.openDate.mockResolvedValue({ status });
    const result = await provider.search(request, context());
    expect(result.status).toBe('success');

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates).toHaveLength(5);
    expect(result.coverage.reasons).toContain('unknown-dates');
    expect(port.openDate).toHaveBeenCalledOnce();
  },
);
