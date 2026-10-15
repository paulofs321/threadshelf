import { ProviderRequestSchema, requireValid, SessionScopeSchema } from '../../../src/contracts';
import type { ProviderRequest, SessionScope } from '../../../src/contracts';

// Handwritten normalized inputs only; these contain no proposed Google transport schema.
export function selectedGoogleAiModeScope(): SessionScope {
  return requireValid(SessionScopeSchema, {
    kind: 'ephemeral',
    provider: 'google-ai-mode',
    partition: 'fictional-google-aim-selected-document',
    generation: 3,
  });
}

export function verifiedGoogleAiModeScope(): SessionScope {
  // Synthetic account/workspace labels exercise isolation without establishing Google identity.
  return requireValid(SessionScopeSchema, {
    kind: 'verified',
    provider: 'google-ai-mode',
    accountPartition: 'fictional-google-aim-account',
    workspacePartition: 'fictional-normalized-workspace',
    generation: 7,
  });
}

export function googleAiModeRequest(scope = selectedGoogleAiModeScope()): ProviderRequest {
  return requireValid(ProviderRequestSchema, {
    requestId: 'fictional-google-aim-search',
    scope,
    query: {
      text: 'imaginary clockwork orchard',
      mode: 'keyword',
      providers: ['google-ai-mode'],
      timeZone: 'Europe/Zurich',
    },
  });
}
