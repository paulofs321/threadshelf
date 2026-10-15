// Structural verification is not a session grant; inspectSession checks each bound context.
export const googleAiModeAvailability = Object.freeze({
  status: 'verified' as const,
  context: 'chrome-isolated-world' as const,
  requires: 'selected-document-binding' as const,
  messageEvidence: 'partial-rendered' as const,
  missingEvidence: Object.freeze([
    'nondefault-account-selection',
    'timestamp-semantics',
    'continuation-and-coverage',
  ] as const),
});
