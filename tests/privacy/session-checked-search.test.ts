import { describe, expect, it, vi } from 'vitest';
import { SessionCheckedSearch } from '../../src/platform/session-checked-search';
import { aggregateSearch } from '../../src/search/aggregate';
import {
  chatSuccess as baseChatSuccess,
  googleCandidate,
  request as baseRequest,
  linkVerifiers,
} from '../fixtures/contracts';
import type { AccessReply } from '../../src/platform/protocol';
import { EphemeralScopeSchema, SearchRequestSchema, requireValid } from '../../src/contracts';
import type { SessionScope } from '../../src/contracts';
import { deferred } from '../platform/helpers';

const scopes = baseRequest.scopes.map((scope) =>
  requireValid(EphemeralScopeSchema, {
    kind: 'ephemeral',
    provider: scope.provider,
    partition: `fiction-${scope.provider}`,
    generation: scope.generation,
  }),
);
const request = requireValid(SearchRequestSchema, { ...baseRequest, scopes });
const successes = [
  baseChatSuccess,
  { ...baseChatSuccess, scope: googleCandidate.scope, candidates: [googleCandidate] },
].map((outcome, i) => {
  if (outcome.status !== 'success') throw new Error('Fixture success');

  const scope = scopes[i];

  if (!scope) throw new Error('Fixture scope');

  return { ...outcome, scope, candidates: outcome.candidates.map((item) => ({ ...item, scope })) };
});

function fixture() {
  const outcome = aggregateSearch(request, successes, linkVerifiers, 100, []);
  const port = { search: vi.fn().mockResolvedValue(outcome), invalidate: vi.fn() };
  const verify = vi.fn<(scope: SessionScope, signal: AbortSignal) => Promise<AccessReply>>(
    async (scope) =>
      ({
        kind: 'reply',
        requestId: request.requestId,
        status: 'verified',
        session: 'authenticated',
        scope,
      }) as AccessReply,
  );
  const guard = new SessionCheckedSearch(port, { verify });
  const controller = new AbortController();

  return {
    outcome,
    port,
    verify,
    guard,
    controller,
    run: () => guard.search(request, { signal: controller.signal }),
  };
}

describe('final identity verification after retrieval and local ranking', () => {
  it('preserves exact validated evidence only after all successful provider sessions are rechecked', async () => {
    const h = fixture();
    const result = await h.run();
    expect(result).toBe(h.outcome);
    expect(h.verify.mock.calls.map(([scope]) => scope)).toEqual(request.scopes);
    h.guard.invalidate(request.scopes[0] as SessionScope);
    expect(h.port.invalidate).toHaveBeenCalledWith(request.scopes[0]);
  });
  it.each([
    'login-expired',
    'permission-needed',
    'scope-changed',
    'timeout',
    'interrupted',
    'unavailable',
  ] as const)(
    'discards already ranked results after %s without requesting sign-in',
    async (status) => {
      const h = fixture();
      h.verify.mockResolvedValueOnce({ kind: 'reply', requestId: request.requestId, status });
      await expect(h.run()).rejects.toThrow('Session verification interrupted');
    },
  );
  it('rejects a session from another account/generation even if verification claims success', async () => {
    const h = fixture();
    h.verify.mockImplementationOnce(
      async (scope) =>
        ({
          kind: 'reply',
          requestId: request.requestId,
          status: 'verified',
          session: 'authenticated',
          scope: { ...scope, generation: scope.generation + 1 },
        }) as AccessReply,
    );
    await expect(h.run()).rejects.toThrow('Session verification interrupted');
  });
  it('cannot expose a late successful check after cancellation during post-ranking verification', async () => {
    const h = fixture();
    const pending = deferred<AccessReply>();
    h.verify.mockReturnValueOnce(pending.promise);
    const result = h.run();
    await Promise.resolve();
    h.controller.abort();
    pending.resolve({ kind: 'reply', requestId: request.requestId, status: 'interrupted' });
    await expect(result).rejects.toThrow('Session verification interrupted');
  });
  it('does not start checks after cancellation and never checks failed providers', async () => {
    const h = fixture();
    h.controller.abort();
    expect(await h.run()).toBe(h.outcome);
    expect(h.verify).not.toHaveBeenCalled();
    const other = fixture();
    other.port.search.mockResolvedValue(
      aggregateSearch(
        request,
        request.scopes.map((scope) => ({
          scope,
          requestId: request.requestId,
          status: 'unavailable',
        })),
        linkVerifiers,
        100,
        [],
      ),
    );
    expect((await other.run()).state).toBe('failure');
    expect(other.verify).not.toHaveBeenCalled();
  });
});
