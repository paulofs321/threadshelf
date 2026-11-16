// Handwritten structural fiction using the positions observed in the native website.
export function googleThread(id = 'fictional-thread-1'): unknown[] {
  const state = `synthetic_state_${id}`;
  const row: unknown[] = Array.from({ length: 28 }, () => null);
  row[0] = [state, id];
  row[1] = 'Clockwork orchard maintenance';
  row[5] = [1_791_936_000, 123_000_000];
  row[6] = [1_792_022_400, 456_000_000];
  row[22] = [
    ['mtid', id],
    ['csuir', '1'],
    ['mstk', state],
    ['udm', '50'],
  ];

  return row;
}

export function googleMatch(
  row = googleThread(),
  snippet: unknown = 'The orchard gate uses authentication with imaginary brass keys.',
): unknown[] {
  const match: unknown[] = Array.from({ length: 16 }, () => null);
  match[13] = [row[1], 0];
  match[14] = snippet === null ? null : [snippet, 1, 21, 14];
  match[15] = row;

  return match;
}

// November 16, 2026: native records append metadata without moving consumed fields.
export function googleExtendedThread(id = 'fictional-thread-1'): unknown[] {
  return [...googleThread(id), null, null, 7];
}

export function googleExtendedMatch(row = googleExtendedThread()): unknown[] {
  const match = googleMatch(row);
  match[14] = ['An exact fictional orchard passage.', 1, 21, 14, 0, 'fictional metadata'];

  return match;
}

export function googleJson(value: unknown): string {
  return ")]}'\n" + JSON.stringify(value);
}
