// Missing observations are diagnostics, never switches for an inferred transport.
export const googleAiModeAvailability = Object.freeze({
  status: 'unavailable' as const,
  reason: 'verification-required' as const,
  missingEvidence: Object.freeze([
    'selected-extension-context',
    'account-selection-and-identity',
    'native-list-search-contracts',
    'original-links-and-timestamps',
    'failure-semantics',
    'continuation-and-coverage',
    'complete-message-or-bounded-rendered-evidence',
  ] as const),
});
