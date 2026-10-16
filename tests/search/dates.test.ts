import { describe, expect, it } from 'vitest';
import {
  availableDateDisclosure,
  calendarDateRange,
  previousCalendarMonth,
} from '../../src/search';

describe('browser-timezone calendar intervals', () => {
  it.each([
    [
      'Europe/Zurich',
      '2026-03-29',
      '2026-03-30',
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T22:00:00.000Z',
    ],
    [
      'Europe/Zurich',
      '2026-10-25',
      '2026-10-26',
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-08',
      '2026-03-09',
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
    ],
    [
      'Asia/Kathmandu',
      '2026-10-01',
      '2026-11-01',
      '2026-09-30T18:15:00.000Z',
      '2026-10-31T18:15:00.000Z',
    ],
    [
      'America/Sao_Paulo',
      '2018-11-04',
      '2018-11-05',
      '2018-11-04T03:00:00.000Z',
      '2018-11-05T02:00:00.000Z',
    ],
    [
      'America/Havana',
      '2015-11-01',
      '2015-11-02',
      '2015-11-01T04:00:00.000Z',
      '2015-11-02T05:00:00.000Z',
    ],
    ['UTC', '2024-02-29', '2024-03-01', '2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
    ['UTC', '1000-01-01', '1000-01-02', '1000-01-01T00:00:00.000Z', '1000-01-02T00:00:00.000Z'],
  ])('converts %s %s to exclusive %s', (zone, start, end, expectedStart, expectedEnd) => {
    expect(calendarDateRange(start, end, zone)).toEqual({ start: expectedStart, end: expectedEnd });
  });

  it.each([
    [
      '2026-10-01T00:30:00.000Z',
      'America/Los_Angeles',
      '2026-08-01T07:00:00.000Z',
      '2026-09-01T07:00:00.000Z',
    ],
    [
      '2026-10-01T00:30:00.000Z',
      'Europe/Zurich',
      '2026-08-31T22:00:00.000Z',
      '2026-09-30T22:00:00.000Z',
    ],
    ['2026-01-20T12:00:00.000Z', 'UTC', '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    ['2024-03-15T12:00:00.000Z', 'UTC', '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
  ])('uses calendar month at %s in %s', (now, zone, start, end) => {
    expect(previousCalendarMonth(now, zone)).toEqual({ start, end });
  });

  it.each([
    ['2026-02-30', '2026-03-01', 'UTC'],
    ['not-a-date', '2026-03-01', 'UTC'],
    ['2026-03-01', '2026-03-01', 'UTC'],
    ['2026-04-01', '2026-03-01', 'UTC'],
    ['2026-03-01', '2026-03-02', 'fictional/Cloud-City'],
    ['2011-12-30', '2011-12-31', 'Pacific/Apia'],
    ['2026-03-01', '2026-03-32', 'UTC'],
  ])('rejects invalid or skipped intervals (%s, %s, %s)', (start, end, zone) => {
    expect(() => calendarDateRange(start, end, zone)).toThrow();
  });

  it('rejects invalid explicit clocks and explains available-date semantics', () => {
    expect(() => previousCalendarMonth('2026-02-30T00:00:00.000Z', 'UTC')).toThrow();
    expect(availableDateDisclosure).toContain('meaning and source');
    expect(availableDateDisclosure).toContain('Undated conversations are excluded');
    expect(availableDateDisclosure).toContain('do not establish when a topic was discussed');
  });
});
