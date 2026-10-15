// These are missing observations, not switches that enable an inferred transport.
export const chatGptAvailability = Object.freeze({
  status: 'unavailable' as const,
  reason: 'verification-required' as const,
  missingEvidence: Object.freeze([
    'selected-extension-context',
    'account-workspace-identity',
    'search-list-evidence-contracts',
    'original-links-and-timestamps',
    'failure-and-coverage-semantics',
  ] as const),
});
