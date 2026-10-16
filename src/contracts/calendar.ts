import * as v from 'valibot';
import { TimeZoneSchema } from './primitives';
import { requireValid } from './validation';

export const CalendarDateSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d{3}-\d{2}-\d{2}$/u),
  v.check((date) => {
    const instant = Date.parse(`${date}T00:00:00.000Z`);

    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date;
  }),
);

export function calendarFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone: requireValid(TimeZoneSchema, timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function localDate(formatter: Intl.DateTimeFormat, instant: number): string {
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;

  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}

// Find the first real instant of the local day, including midnight DST transitions.
// A skipped civil date is rejected instead of silently selecting a different day.
export function dayStart(dateInput: string, formatter: Intl.DateTimeFormat): string {
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
