import * as v from 'valibot';
import { DateRangeSchema, requireValid, TimestampSchema, TimeZoneSchema } from '../contracts';
import type { DateRange } from '../contracts';

const CalendarDateSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d{3}-\d{2}-\d{2}$/u),
  v.check((date) => {
    const instant = Date.parse(`${date}T00:00:00.000Z`);

    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date;
  }),
);

function calendarFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone: requireValid(TimeZoneSchema, timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function localDate(formatter: Intl.DateTimeFormat, instant: number): string {
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;

  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}

// Find the first real instant of the local day, including midnight DST transitions.
// A skipped civil date is rejected instead of silently selecting a different day.
function dayStart(dateInput: string, formatter: Intl.DateTimeFormat): string {
  const date = requireValid(CalendarDateSchema, dateInput);
  const nominal = Date.parse(`${date}T00:00:00.000Z`);
  let low = nominal - 36 * 60 * 60 * 1_000;
  let high = nominal + 36 * 60 * 60 * 1_000;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (localDate(formatter, middle) < date) low = middle + 1;
    else high = middle;
  }

  if (localDate(formatter, low) !== date) throw new Error('Invalid calendar date context.');

  return new Date(low).toISOString();
}

// Both arguments are local calendar dates; end is exclusive. Never assume a 24-hour day.
export function calendarDateRange(start: string, end: string, timeZone: string): DateRange {
  const formatter = calendarFormatter(timeZone);

  return requireValid(DateRangeSchema, {
    start: dayStart(start, formatter),
    end: dayStart(end, formatter),
  });
}

// A reusable calendar primitive, with an explicit clock. Natural-language interpretation is separate.
export function previousCalendarMonth(now: string, timeZone: string): DateRange {
  const instant = Date.parse(requireValid(TimestampSchema, now));
  const date = requireValid(CalendarDateSchema, localDate(calendarFormatter(timeZone), instant));
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;

  return calendarDateRange(
    `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`,
    `${year}-${String(month).padStart(2, '0')}-01`,
    timeZone,
  );
}

export const availableDateDisclosure =
  'Date filters use each conversation’s available date and its stated meaning and source. Creation or update dates do not establish when a topic was discussed. Undated conversations are excluded by date filters.';
