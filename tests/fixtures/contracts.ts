import {
  CandidateSchema,
  CoverageSchema,
  ProviderOutcomeSchema,
  ProviderRequestSchema,
  requireValid,
  SearchRequestSchema,
  SessionScopeSchema,
  VerifiedScopeSchema,
} from '../../src/contracts';
import type { LinkVerifiers } from '../../src/contracts';

// Handwritten fictional data. Reserved .invalid URLs never resolve to real account conversations.
export const chatScope = requireValid(VerifiedScopeSchema, {
  provider: 'chatgpt',
  kind: 'verified',
  accountPartition: 'fictional-account-aurora',
  workspacePartition: 'fictional-workspace-cloud-lab',
  generation: 1,
});

export const googleScope = requireValid(VerifiedScopeSchema, {
  provider: 'google-ai-mode',
  kind: 'verified',
  accountPartition: 'fictional-account-borealis',
  workspacePartition: null,
  generation: 1,
});

export const ephemeralScope = requireValid(SessionScopeSchema, {
  provider: 'chatgpt',
  kind: 'ephemeral',
  partition: 'fictional-one-tab-partition',
  generation: 2,
});

export const chatCandidate = requireValid(CandidateSchema, {
  id: 'fictional-candidate-aurora',
  scope: chatScope,
  conversationId: 'fictional-thread-aurora',
  originalUrl: 'https://chatgpt.example.invalid/threads/fictional-thread-aurora',
  title: 'A floating library for Cloud City',
  date: {
    at: '2026-09-12T10:00:00.000Z',
    meaning: 'conversation-created',
    source: 'provider-metadata',
  },
  evidence: [
    { id: 'fictional-title-aurora', text: 'A floating library for Cloud City', source: 'title' },
    {
      id: 'fictional-snippet-aurora',
      text: 'The imaginary library uses paper wings to deliver storybooks.',
      source: 'native-snippet',
    },
  ],
});

export const googleCandidate = requireValid(CandidateSchema, {
  id: 'fictional-candidate-borealis',
  scope: googleScope,
  conversationId: 'fictional-thread-borealis',
  originalUrl: 'https://google-ai-mode.example.invalid/threads/fictional-thread-borealis',
  title: 'A floating library for Cloud City',
  // Unknown date is omitted. A matching title never establishes shared identity.
  evidence: [
    {
      id: 'fictional-snippet-borealis',
      text: 'An invented moon librarian compares paper wings and balloon baskets.',
      source: 'native-snippet',
    },
  ],
});

export const linkVerifiers: LinkVerifiers = {
  chatgpt: (url, id) =>
    url.origin === 'https://chatgpt.example.invalid' &&
    url.pathname === `/threads/${encodeURIComponent(id)}` &&
    url.search === '' &&
    url.hash === '',
  'google-ai-mode': (url, id) =>
    url.origin === 'https://google-ai-mode.example.invalid' &&
    url.pathname === `/threads/${encodeURIComponent(id)}` &&
    url.search === '' &&
    url.hash === '',
};

export const request = requireValid(SearchRequestSchema, {
  requestId: 'fictional-request-1',
  query: {
    text: 'floating library',
    mode: 'keyword',
    providers: ['chatgpt', 'google-ai-mode'],
    timeZone: 'Europe/Zurich',
  },
  scopes: [chatScope, googleScope],
});

export const descriptionRequest = requireValid(SearchRequestSchema, {
  ...request,
  query: { ...request.query, mode: 'description' },
});

export const chatRequest = requireValid(ProviderRequestSchema, {
  requestId: request.requestId,
  query: request.query,
  scope: chatScope,
});

export const completeCoverage = requireValid(CoverageSchema, { extent: 'complete', reasons: [] });
export const unknownCoverage = requireValid(CoverageSchema, {
  extent: 'unknown',
  reasons: ['unknown-reach'],
});

export const chatSuccess = requireValid(ProviderOutcomeSchema, {
  status: 'success',
  requestId: request.requestId,
  scope: chatScope,
  candidates: [chatCandidate],
  coverage: unknownCoverage,
});

export const googleFailure = requireValid(ProviderOutcomeSchema, {
  status: 'unavailable',
  requestId: request.requestId,
  scope: googleScope,
});
