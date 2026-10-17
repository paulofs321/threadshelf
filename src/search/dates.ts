import { DateRangeSchema, requireValid, TimestampSchema } from '../contracts';
import type { DateRange } from '../contracts';
import { CalendarDateSchema, calendarFormatter, localDate, dayStart } from '../contracts/calendar';

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
