// Chrome serializes this function. Keep it self-contained and read-only; no DOM text/session read.
export function inspectSelectedDocument(expectedOrigin: string) {
  if (window !== window.top || location.origin !== expectedOrigin) return null;

  return { origin: location.origin, topLevel: true };
}
