import { vi } from 'vitest';
import { requireValid, SearchRequestSchema } from '../../../src/contracts';
import type {
  Candidate,
  ProviderOutcome,
  ProviderPort,
  SearchRequest,
} from '../../../src/contracts';
import {
  chatCandidate,
  chatScope,
  googleCandidate,
  googleScope,
  linkVerifiers,
} from '../contracts';

export { chatCandidate, chatScope, googleCandidate, googleScope, linkVerifiers };

export function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return requireValid(SearchRequestSchema, {
    requestId: 'fictional-keyword-request',
    query: {
      text: 'floating library',
      mode: 'keyword',
      providers: ['chatgpt', 'google-ai-mode'],
      timeZone: 'Europe/Zurich',
    },
    scopes: [chatScope, googleScope],
    ...overrides,
  });
}

export function providerPort(provider: ProviderPort['provider'], candidates?: Candidate[]) {
  return {
    provider,
    inspectSession: vi
      .fn<ProviderPort['inspectSession']>()
      .mockResolvedValue({ status: 'unavailable', provider, generation: 1 }),
    search: vi.fn<ProviderPort['search']>().mockImplementation(
      async (request) =>
        ({
          status: 'success',
          requestId: request.requestId,
          scope: request.scope,
          candidates: structuredClone(
            candidates ?? [provider === 'chatgpt' ? chatCandidate : googleCandidate],
          ),
          coverage: { extent: 'complete', reasons: [] },
        }) satisfies ProviderOutcome,
    ),
  };
}

export function deferred<T = unknown>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred.');
  };

  let reject: (reason: unknown) => void = () => {
    throw new Error('Uninitialized deferred.');
  };

  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}
