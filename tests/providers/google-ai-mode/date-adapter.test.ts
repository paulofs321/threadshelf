import { describe, expect, it, vi } from 'vitest';
import { GoogleAiModeProvider } from '../../../src/providers/google-ai-mode/adapter';
import type { GoogleAiModeReadPort } from '../../../src/providers/google-ai-mode/transport';
import { matchesDateRange } from '../../../src/contracts';
import { calendarDateRange } from '../../../src/search/dates';
import { googleAiModeRequest } from '../../fixtures/google-ai-mode/requests';
import { googleJson, googleMatch, googleThread } from '../../fixtures/google-ai-mode/wire';

const identity = 'a'.repeat(64);
const success = { status: 'success', identityBefore: identity, identityAfter: identity };
const context = () => ({ signal: new AbortController().signal });
const label = (text = '13 October 2026', conversationId = 'fiction-0') => ({
  conversationId,
  text,
  observedAt: '2026-10-15T23:30:00.000Z',
});

function fixture({
  count = 1,
  dated = true,
  kind = 'search',
  dateLabel,
}: {
  count?: number;
  dated?: boolean;
  kind?: 'search' | 'list';
  dateLabel?: unknown;
} = {}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const row = googleThread(`fiction-${i}`);

    if (!dated) row[5] = null;

    return row;
  });
  const port = {
    read: vi.fn<GoogleAiModeReadPort['read']>().mockResolvedValue({
      ...success,
      response: {
        status: 200,
        contentType: 'application/json',
        retryAfter: null,
        body: googleJson([kind === 'search' ? rows.map((row) => googleMatch(row)) : rows]),
      },
      ...(dateLabel === undefined ? {} : { dateLabel }),
    }),
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

describe('Google dates without conversation navigation', () => {
  it.each(['search', 'list'] as const)(
    'dates every native %s record with one read and no evidence request',
    async (kind) => {
      const { provider, request, port } = fixture({ count: 2, kind });
      const result = await provider[kind](request, context());

      if (result.status !== 'success') throw new Error('Expected synthetic success');

      expect(result.candidates.map((c) => c.date)).toEqual(
        Array.from({ length: 2 }, () => ({
          at: new Date(1_791_936_000_123).toISOString(),
          meaning: 'provider-record',
          source: 'provider-metadata',
        })),
      );
      expect(result.coverage.reasons).toEqual(['unknown-reach']);
      expect(port.read).toHaveBeenCalledOnce();
      expect(port.openEvidence).not.toHaveBeenCalled();
    },
  );
  it('prefers the matching visible message date, retains other native dates and snapshots it for explicit evidence', async () => {
    const { provider, request, port } = fixture({ count: 2, dateLabel: label() });
    const result = await provider.search(request, context());

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.date).toMatchObject({
      meaning: 'message-sent',
      source: 'rendered-message',
      calendarDay: { date: '2026-10-13', basis: 'provider-date' },
    });
    expect(result.candidates[1]?.date?.meaning).toBe('provider-record');
    const candidate = result.candidates[0];

    if (!candidate?.date) throw new Error('Missing synthetic date');

    expect(matchesDateRange(candidate, request.query.dateRange)).toBe(true);
    const expectedDate = structuredClone(result.candidates[0]?.date);
    candidate.date.at = '2020-01-01T00:00:00.000Z';
    expect(await provider.messages(request, 'fiction-0', context())).toMatchObject({
      status: 'success',
      candidates: [{ date: expectedDate }],
      coverage: { reasons: ['unknown-reach', 'missing-evidence'] },
    });
    expect(port.openEvidence).toHaveBeenCalledOnce();
  });
  it('uses observation-local today for a time-only label, including across UTC midnight', async () => {
    const { provider, request } = fixture({ dated: false, dateLabel: label('19:28') });
    const result = await provider.search(request, context());
    expect(result).toMatchObject({
      status: 'success',
      candidates: [
        {
          date: {
            at: '2026-10-15T22:00:00.000Z',
            calendarDay: { date: '2026-10-16', basis: 'time-only-today' },
          },
        },
      ],
    });

    if (result.status === 'success') {
      const candidate = result.candidates[0];

      if (!candidate) throw new Error('Missing synthetic candidate');

      expect(matchesDateRange(candidate, request.query.dateRange)).toBe(false);
      expect(result.coverage.reasons).not.toContain('unknown-dates');
    }
  });
  it.each([label('Yesterday'), label('31 April 2026'), label('13 October 2026', 'another-thread')])(
    'keeps native dates for unsupported or unrelated visible labels: %j',
    async (dateLabel) => {
      const { provider, request } = fixture({ dateLabel });
      expect(await provider.search(request, context())).toMatchObject({
        status: 'success',
        candidates: [
          {
            date: {
              meaning: 'provider-record',
              source: 'provider-metadata',
            },
          },
        ],
      });
    },
  );
  it('keeps unknown-date coverage for undated records without fabricating today', async () => {
    const { provider, request } = fixture({ count: 2, dated: false, dateLabel: label() });
    const result = await provider.search(request, context());

    if (result.status !== 'success') throw new Error('Expected synthetic success');

    expect(result.candidates[0]?.date).toBeTruthy();
    expect(result.candidates[1]).not.toHaveProperty('date');
    expect(result.coverage.reasons).toContain('unknown-dates');
    expect(await provider.messages(request, 'fiction-1', context())).toMatchObject({
      status: 'success',
      coverage: { reasons: ['unknown-reach', 'missing-evidence', 'unknown-dates'] },
    });
  });
  it('accepts successful empty results without extra reads or unknown-date limitations', async () => {
    const { provider, request, port } = fixture({ count: 0, dateLabel: label() });
    expect(await provider.search(request, context())).toMatchObject({
      status: 'success',
      candidates: [],
      coverage: { reasons: ['unknown-reach'] },
    });
    expect(port.read).toHaveBeenCalledOnce();
    expect(port.openEvidence).not.toHaveBeenCalled();
  });
  it.each([
    { text: '19:28', observedAt: 'invalid', conversationId: 'fiction-0' },
    { text: '19:28', observedAt: label().observedAt },
    { ...label(), extra: 'untrusted' },
  ])('rejects invalid source bindings or transport metadata: %j', async (dateLabel) => {
    const { provider, request } = fixture({ dateLabel });
    expect((await provider.search(request, context())).status).toBe('schema-changed');
  });
  it('discards results whose optional visible date crosses an account change', async () => {
    const { provider, request, port } = fixture({ dateLabel: label() });
    const response = (await port.read(
      { kind: 'search', query: 'fictional' },
      undefined,
      context(),
    )) as object;
    port.read.mockResolvedValue({ ...response, identityAfter: 'b'.repeat(64) });
    expect((await provider.search(request, context())).status).toBe('scope-changed');
    expect((await provider.inspectSession(context())).status).toBe('scope-changed');
  });
  it('discards completion when the scope retires during normalization', async () => {
    const { port, request } = fixture();
    const provider = new GoogleAiModeProvider(request.scope, port, {
      freshId: () => {
        provider.invalidate();

        return 'fictional-late-candidate';
      },
    });
    expect((await provider.search(request, context())).status).toBe('scope-changed');
  });
});
