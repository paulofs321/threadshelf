import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelSearchBroker } from '../../src/platform/search-broker';
import type { SearchReply } from '../../src/platform/search-protocol';
import { maximumRequestsPerPort } from '../../src/platform/protocol';
import { CandidateSchema, SearchRequestSchema, requireValid } from '../../src/contracts';
import type { ProviderId, ProviderPort, SearchRequest } from '../../src/contracts';
import type { SelectedDocumentBinding } from '../../src/platform/broker';
import { chatCandidate, deferred } from '../fixtures/search/providers';
import { brokerHarness, selected } from './helpers';

const resources: PanelSearchBroker[] = [];

async function harness() {
  const access = brokerHarness();
  const scope = await selected(access);
  const candidate = requireValid(CandidateSchema, {
    ...chatCandidate,
    scope,
    conversationId: '11111111-1111-1111-1111-111111111111',
    originalUrl: 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111',
  });
  const provider = {
    provider: 'chatgpt' as const,
    invalidate: vi.fn(),
    inspectSession: vi.fn(),
    search: vi.fn<ProviderPort['search']>().mockImplementation(async (request) => ({
      requestId: request.requestId,
      scope: request.scope,
      status: 'success',
      candidates: [candidate],
      coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
    })),
  };
  const factory = vi.fn((_binding: SelectedDocumentBinding) => provider);
  const messages: SearchReply[] = [];
  const search = new PanelSearchBroker(
    access.broker,
    { chatgpt: factory, 'google-ai-mode': factory },
    (reply) => messages.push(reply),
  );
  resources.push(search);
  const request = requireValid(SearchRequestSchema, {
    requestId: 'fiction-search',
    query: { text: 'library', mode: 'keyword', providers: ['chatgpt'], timeZone: 'Europe/Zurich' },
    scopes: [scope],
  });

  return {
    access,
    scope,
    candidate,
    provider,
    factory,
    messages,
    search,
    request,
    dispatch: (input: SearchRequest = request) =>
      search.receive({ operation: 'keyword-search', request: input }),
  };
}

afterEach(() => {
  resources.splice(0).forEach((search) => search.close());
  vi.useRealTimers();
});
describe('trusted panel search composition and document binding', () => {
  it('retrieves before reading context, preserving native metadata and the original description', async () => {
    const { search, provider, candidate, request, messages } = await harness();
    const readContext = vi.fn(async () => ({
      requestId: request.requestId,
      scope: request.scopes[0],
      status: 'success',
      candidates: [
        {
          ...candidate,
          evidence: [
            ...candidate.evidence,
            { id: 'context:0', source: 'provider-message', text: 'Food without dairy.' },
          ],
        },
      ],
      coverage: { extent: 'partial', reasons: ['missing-evidence'] },
    }));
    Object.assign(provider, { readContext });
    search.receive({
      operation: 'description-retrieval',
      request,
      description: 'food without dairy',
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(readContext).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: request.requestId }),
      candidate.conversationId,
      'food without dairy',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(provider.search.mock.invocationCallOrder[0]).toBeLessThan(
      readContext.mock.invocationCallOrder[0] ?? 0,
    );
    expect(JSON.stringify(messages[0])).toContain('Food without dairy.');
    expect(messages[0]?.outcome.outcomes[0]).toMatchObject({
      candidates: [expect.objectContaining({ originalUrl: candidate.originalUrl })],
    });
  });
  it('does not invoke a context reader for ordinary keyword searches', async () => {
    const { dispatch, provider, messages } = await harness();
    const readContext = vi.fn();
    Object.assign(provider, { readContext });
    dispatch();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(readContext).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'scope-change'] as const)(
    'discards messages after context %s',
    async (stop) => {
      const { search, access, provider, request, messages, candidate } = await harness();
      const pending = deferred<unknown>();
      const readContext = vi.fn(() => pending.promise);
      Object.assign(provider, { readContext });
      search.receive({ operation: 'description-retrieval', request, description: 'food' });
      await vi.waitFor(() => expect(readContext).toHaveBeenCalledOnce());

      if (stop === 'cancel')
        search.receive({ operation: 'cancel-search', requestId: request.requestId });
      else access.broker.invalidate('chatgpt', 'scope-changed');

      pending.resolve({
        requestId: request.requestId,
        scope: request.scopes[0],
        status: 'success',
        candidates: [candidate],
        coverage: { extent: 'complete', reasons: [] },
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]?.outcome.results).toEqual([]);
      expect(messages[0]?.outcome.outcomes[0]?.status).toBe(
        stop === 'cancel' ? 'cancelled' : 'scope-changed',
      );
    },
  );
  it.each([
    { description: '' },
    { description: 'x'.repeat(1025) },
    { description: 'x\u0000' },
    { description: 'food', url: 'https://evil.invalid' },
    { description: 'food', conversationId: 'unretrieved' },
  ])('rejects forged context commands before provider access: %j', async (patch) => {
    const { search, request, factory } = await harness();
    expect(search.receive({ operation: 'description-retrieval', request, ...patch })).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
  it('binds existing selections to real orchestration, reuses adapters in the same scope, and never inspects a fake session', async () => {
    const { dispatch, messages, provider, factory, request } = await harness();
    expect(dispatch()).toBe(true);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.outcome.results).toHaveLength(1);
    expect(messages[0]?.outcome.coverage).toEqual({
      extent: 'unknown',
      reasons: ['unknown-reach'],
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'fiction-document-one',
        isCurrent: expect.any(Function),
      }),
    );
    expect(provider.inspectSession).not.toHaveBeenCalled();
    dispatch(requireValid(SearchRequestSchema, { ...request, requestId: 'fiction-second' }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(factory).toHaveBeenCalledOnce();
  });
  it.each(['unselected', 'wrong generation', 'wrong partition', 'other provider'] as const)(
    'refuses %s scope before constructing or reading any provider',
    async (kind) => {
      const { access, request, dispatch, messages, factory } = await harness();

      if (kind === 'unselected') access.broker.invalidate('chatgpt', 'scope-changed');

      const originalScope = request.scopes[0];

      if (!originalScope) throw new Error('Missing synthetic scope');

      const scope = {
        ...originalScope,
        ...(kind === 'wrong generation'
          ? { generation: 99 }
          : kind === 'wrong partition'
            ? { partition: 'fiction-forged-partition' }
            : kind === 'other provider'
              ? { provider: 'google-ai-mode' as ProviderId }
              : {}),
      };
      const forged = requireValid(SearchRequestSchema, {
        ...request,
        scopes: [scope],
        query: { ...request.query, providers: [scope.provider] },
      });
      dispatch(forged);
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]?.outcome.outcomes[0]?.status).toBe('scope-changed');
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    { operation: 'keyword-search', request: { url: 'https://evil.invalid' } },
    { operation: 'keyword-search', request: null },
    { operation: 'fetch', url: 'https://evil.invalid' },
    { operation: 'cancel-search', requestId: 'fiction', url: 'https://evil.invalid' },
  ])('leaves malformed or unknown messages to the access boundary to close', async (input) => {
    const { search, factory } = await harness();
    expect(search.receive(input)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not accept description searches over the keyword operation', async () => {
    const { search, request, factory } = await harness();
    expect(
      search.receive({
        operation: 'keyword-search',
        request: { ...request, query: { ...request.query, mode: 'description' } },
      }),
    ).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
  it('cancels only the named request, stops active work and discards its later private reply', async () => {
    const { dispatch, search, provider, messages, request } = await harness();
    const pending = deferred();
    provider.search.mockReturnValue(pending.promise);
    dispatch();
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledOnce());
    search.receive({ operation: 'cancel-search', requestId: 'fiction-unknown' });
    expect(provider.search.mock.calls[0]?.[1].signal.aborted).toBe(false);
    search.receive({ operation: 'cancel-search', requestId: request.requestId });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.outcome.state).toBe('cancelled');
    expect(messages[0]?.outcome.results).toEqual([]);
    pending.resolve({ status: 'success', candidates: ['fiction-late-private'] });
    await Promise.resolve();
    expect(messages).toHaveLength(1);
  });
  it('invalidates bound adapters and pending scopes, and recreates capabilities after explicit reconnect', async () => {
    const { access, scope, dispatch, search, messages, provider, factory, request } =
      await harness();
    dispatch();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    search.invalidate('chatgpt');
    expect(provider.invalidate).toHaveBeenCalledOnce();
    const reply = await access.connect('fiction-reconnect');

    if (reply.status !== 'selected') throw new Error('Synthetic reconnect failed');

    dispatch(
      requireValid(SearchRequestSchema, {
        ...request,
        requestId: 'fiction-fresh',
        scopes: [reply.scope],
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reply.scope.generation).toBeGreaterThan(scope.generation);
  });
  it('retires a still-pending scope on invalidation and does not dispatch a delayed provider call', async () => {
    const { search, dispatch, provider, messages } = await harness();
    const pending = deferred();
    provider.search.mockReturnValue(pending.promise);
    dispatch();
    search.invalidate('chatgpt');
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.outcome.outcomes[0]?.status).toBe('scope-changed');
    expect(provider.search).not.toHaveBeenCalled();
  });
  it('invalidates the previous adapter when a newer selection replaces it', async () => {
    const { access, dispatch, messages, request, provider, factory } = await harness();
    dispatch();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const reply = await access.connect('fiction-reconnect');

    if (reply.status !== 'selected') throw new Error('Synthetic reconnect failed');

    dispatch(
      requireValid(SearchRequestSchema, {
        ...request,
        requestId: 'fiction-fresh',
        scopes: [reply.scope],
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(provider.invalidate).toHaveBeenCalledOnce();
  });
  it('replaces pending searches without publishing obsolete terminal output', async () => {
    const { dispatch, request, provider, messages } = await harness();
    const pending = deferred();
    provider.search.mockReturnValueOnce(pending.promise);
    dispatch();
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledOnce());
    dispatch(requireValid(SearchRequestSchema, { ...request, requestId: 'fiction-new' }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.outcome.requestId).toBe('fiction-new');
    pending.resolve({ status: 'success', candidates: ['fiction-obsolete-private'] });
    await Promise.resolve();
    expect(messages).toHaveLength(1);
  });
  it('closes the access transport for reused IDs and after the bounded request budget', async () => {
    const { dispatch, access } = await harness();
    dispatch();
    dispatch();
    expect(access.close).toHaveBeenCalledOnce();
    const other = await harness();

    for (let index = 0; index <= maximumRequestsPerPort; index++)
      other.dispatch(
        requireValid(SearchRequestSchema, { ...other.request, requestId: `fiction-${index}` }),
      );

    expect(other.access.close).toHaveBeenCalledOnce();
  });
  it('close aborts active reads, clears adapters and never sends late output or dispatches again', async () => {
    const { dispatch, search, messages, provider } = await harness();
    const pending = deferred();
    provider.search.mockReturnValue(pending.promise);
    dispatch();
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledOnce());
    search.close();
    expect(provider.search.mock.calls[0]?.[1].signal.aborted).toBe(true);
    pending.reject(new Error('fiction-private-error'));
    await Promise.resolve();
    await Promise.resolve();
    expect(messages).toEqual([]);
    expect(dispatch()).toBe(true);
    expect(provider.search).toHaveBeenCalledOnce();
  });
  it('closes the owning access transport if result delivery throws', async () => {
    const original = await harness();
    const search = new PanelSearchBroker(
      original.access.broker,
      { chatgpt: original.factory, 'google-ai-mode': original.factory },
      () => {
        throw new Error('fiction-closed-channel');
      },
    );
    resources.push(search);
    search.receive({ operation: 'keyword-search', request: original.request });
    await vi.waitFor(() => expect(original.access.close).toHaveBeenCalledOnce());
  });
});
