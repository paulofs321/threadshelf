import { ConversationDateSchema } from '../../contracts/conversation';
import type { Candidate } from '../../contracts/conversation';
import { calendarFormatter, dayStart, localDate } from '../../contracts/calendar';
import { requireValid } from '../../contracts/validation';

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// Only observed full English dates and 24-hour clock labels are supported. A clock alone uses
// the observation's local calendar day by explicit product policy, not a guessed message instant.
export function parseGoogleDateLabel(
  label: { text: string; observedAt: string },
  timeZone: string,
): Candidate['date'] {
  const explicit = /^(\d{1,2}) ([A-Za-z]+) ([1-9]\d{3})$/u.exec(label.text);
  const timeOnly = /^(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(label.text);

  if (!explicit && !timeOnly) return undefined;

  try {
    const formatter = calendarFormatter(timeZone);
    const date = explicit
      ? `${explicit[3]}-${String(months.indexOf(String(explicit[2]).toLowerCase()) + 1).padStart(2, '0')}-${String(explicit[1]).padStart(2, '0')}`
      : localDate(formatter, Date.parse(label.observedAt));

    return requireValid(ConversationDateSchema, {
      at: dayStart(date, formatter),
      meaning: 'message-sent',
      source: 'rendered-message',
      calendarDay: { date, timeZone, basis: explicit ? 'provider-date' : 'time-only-today' },
    });
  } catch {
    return undefined;
  }
}

// Observed native record timestamp; its creation/update/message meaning is unverified.
// Keep that distinction explicit instead of assigning a meaning from its numeric position.
export function parseGoogleRecordDate(value: unknown): Candidate['date'] {
  if (!Array.isArray(value) || value.length !== 2) return undefined;

  const [seconds, nanos] = value;

  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1_000_000_000
  )
    return undefined;

  const milliseconds = seconds * 1000 + Math.floor(nanos / 1_000_000);

  if (!Number.isSafeInteger(milliseconds)) return undefined;

  try {
    return requireValid(ConversationDateSchema, {
      at: new Date(milliseconds).toISOString(),
      meaning: 'provider-record',
      source: 'provider-metadata',
    });
  } catch {
    return undefined;
  }
}
