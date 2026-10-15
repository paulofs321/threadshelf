// The no-port constructor stays unavailable; this diagnostic does not enable browser access.
export const chatGptAvailability = Object.freeze({
  status: 'unavailable' as const,
  reason: 'connection-required' as const,
  missingEvidence: Object.freeze([
    'selected-extension-context',
    'account-workspace-identity',
  ] as const),
});
