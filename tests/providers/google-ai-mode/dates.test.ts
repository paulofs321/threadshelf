import { describe, expect, it } from 'vitest';
import { parseGoogleDateLabel } from '../../../src/providers/google-ai-mode/dates';

const observedAt = '2026-10-15T23:30:00.000Z';
const parse = (text: string, timeZone = 'Europe/Zurich', at = observedAt) =>
  parseGoogleDateLabel({ text, observedAt: at }, timeZone);

describe('Google rendered calendar dates', () => {
  it('uses the explicit date under a question with message provenance and day precision', () => {
    expect(parse('13 October 2026')).toEqual({
      at: '2026-10-12T22:00:00.000Z',
      meaning: 'message-sent',
      source: 'rendered-message',
      calendarDay: { date: '2026-10-13', timeZone: 'Europe/Zurich', basis: 'provider-date' },
    });
  });
  it.each(['19:28', '0:00', '00:00', '9:05', '23:59'])(
    'uses today in the requested browser timezone for clock-only label %s',
    (text) => {
      expect(parse(text)).toMatchObject({
        at: '2026-10-15T22:00:00.000Z',
        calendarDay: { date: '2026-10-16', basis: 'time-only-today' },
      });
      expect(parse(text, 'America/Los_Angeles')).toMatchObject({
        at: '2026-10-15T07:00:00.000Z',
        calendarDay: { date: '2026-10-15', basis: 'time-only-today' },
      });
    },
  );
  it.each([
    ['1 January 2026', '2026-01-01T00:00:00.000Z'],
    ['29 February 2024', '2024-02-29T00:00:00.000Z'],
    ['31 December 2026', '2026-12-31T00:00:00.000Z'],
    ['2 MARCH 2026', '2026-03-02T00:00:00.000Z'],
  ])('parses a valid full English date %s without locale-dependent Date.parse', (label, at) => {
    expect(parse(label, 'UTC')?.at).toBe(at);
  });
  it('handles DST day boundaries and a midnight transition', () => {
    expect(parse('29 March 2026')?.at).toBe('2026-03-28T23:00:00.000Z');
    expect(parse('25 October 2026')?.at).toBe('2026-10-24T22:00:00.000Z');
    expect(parse('4 November 2018', 'America/Sao_Paulo')?.at).toBe('2018-11-04T03:00:00.000Z');
  });
  it.each([
    '',
    'Yesterday',
    'Today',
    '2 days ago',
    '13/10/2026',
    'October 13, 2026',
    '13 Oktober 2026',
    '13 Fiction 2026',
    '31 April 2026',
    '29 February 2026',
    '0 October 2026',
    '32 October 2026',
    '13 October 0000',
    '13 October 2026 trailing',
    '24:00',
    '23:60',
    '19:2',
    '123:28',
    '19:28:00',
    '7:28 PM',
  ])('leaves unsupported or impossible labels unknown: %s', (label) => {
    expect(parse(label)).toBeUndefined();
  });
  it('rejects a skipped civil day and invalid clock/timezone context', () => {
    expect(parse('30 December 2011', 'Pacific/Apia')).toBeUndefined();
    expect(parse('19:28', 'UTC', 'invalid')).toBeUndefined();
    expect(parse('13 October 2026', 'Invalid/Zone')).toBeUndefined();
  });
});
