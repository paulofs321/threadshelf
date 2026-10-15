import { describe, expect, it } from 'vitest';
import { validate, searchOutcomeSchemaFor } from '../../src/contracts';
import type { ProviderOutcome, ProviderRequest } from '../../src/contracts';
import { KeywordSearch } from '../../src/search';
import {
  chatCandidate,
  googleCandidate,
  linkVerifiers,
  providerPort,
  searchRequest,
} from '../fixtures/search/providers';

const statuses: ProviderOutcome['status'][] = [
  'success',
  'login-expired',
  'permission-needed',
  'unavailable',
  'schema-changed',
  'rate-limited',
  'timeout',
  'cancelled',
  'scope-changed',
  'interrupted',
];
const rows = statuses.flatMap((chat) => statuses.map((google) => ({ chat, google })));

describe('all two-provider terminal combinations through orchestration', () => {
  it.each(rows)(
    '$chat / $google preserves status, results and coverage',
    async ({ chat: chatStatus, google: googleStatus }) => {
      const chat = providerPort('chatgpt');
      const google = providerPort('google-ai-mode');

      for (const [port, status, candidate] of [
        [chat, chatStatus, chatCandidate],
        [google, googleStatus, googleCandidate],
      ] as const) {
        if (status !== 'success')
          port.search.mockImplementation(async (request: ProviderRequest) => ({
            status,
            requestId: request.requestId,
            scope: request.scope,
          }));
        else
          port.search.mockImplementation(async (request) => ({
            status,
            requestId: request.requestId,
            scope: request.scope,
            candidates: [candidate],
            coverage: { extent: 'complete', reasons: [] },
          }));
      }

      const engine = new KeywordSearch({ providers: [chat, google], linkVerifiers });
      const request = searchRequest();
      const result = await engine.search(request, { signal: new AbortController().signal });
      const successes = Number(chatStatus === 'success') + Number(googleStatus === 'success');
      expect(result.state).toBe(
        successes === 2
          ? 'success'
          : successes === 1
            ? 'partial'
            : chatStatus === 'cancelled' && googleStatus === 'cancelled'
              ? 'cancelled'
              : 'failure',
      );
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([chatStatus, googleStatus]);
      expect(result.results).toEqual([
        ...(chatStatus === 'success' ? [chatCandidate.id] : []),
        ...(googleStatus === 'success' ? [googleCandidate.id] : []),
      ]);
      expect(result.coverage).toEqual(
        successes === 2
          ? { extent: 'complete', reasons: [] }
          : { extent: 'partial', reasons: ['provider-failure'] },
      );
      expect(validate(searchOutcomeSchemaFor(request, linkVerifiers), result).ok).toBe(true);
    },
  );
});
