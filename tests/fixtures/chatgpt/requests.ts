import { ProviderRequestSchema, requireValid, SessionScopeSchema } from '../../../src/contracts';
import type { ProviderRequest, SessionScope } from '../../../src/contracts';

// Handwritten normalized inputs, NOT observations or guesses about ChatGPT's wire format.
export function selectedChatGptScope(): SessionScope {
  return requireValid(SessionScopeSchema, {
    kind: 'ephemeral',
    provider: 'chatgpt',
    partition: 'fictional-chatgpt-selected-document',
    generation: 3,
  });
}

export function verifiedChatGptScope(): SessionScope {
  // A synthetic verified label exercises isolation only; it cannot enable the unavailable adapter.
  return requireValid(SessionScopeSchema, {
    kind: 'verified',
    provider: 'chatgpt',
    accountPartition: 'fictional-chatgpt-account',
    workspacePartition: 'fictional-chatgpt-workspace',
    generation: 7,
  });
}

export function chatGptRequest(scope = selectedChatGptScope()): ProviderRequest {
  return requireValid(ProviderRequestSchema, {
    requestId: 'fictional-chatgpt-search',
    scope,
    query: {
      text: 'imaginary clockwork orchard',
      mode: 'keyword',
      providers: ['chatgpt'],
      timeZone: 'Europe/Zurich',
    },
  });
}
