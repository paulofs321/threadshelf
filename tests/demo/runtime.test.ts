import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo, demoVerifiers } from '../../demo/runtime';
import { demoCandidates } from '../../demo/data';
import {
  requireValid,
  SearchRequestSchema,
  searchOutcomeSchemaFor,
  validate,
} from '../../src/contracts';
import type { SearchRequest } from '../../src/contracts';
import { forbiddenDemoModule } from '../../vite.demo.config';

afterEach(() => vi.useRealTimers());

function fixture(scenario: Parameters<typeof createDemo>[0] = 'ready') {
  const runtime = createDemo(scenario);
  const request = (query: Partial<SearchRequest['query']> = {}) =>
    requireValid(SearchRequestSchema, {
      requestId: 'fictional-demo-test',
      query: {
        text: 'floating library',
        mode: 'keyword',
        providers: ['chatgpt', 'google-ai-mode'],
        timeZone: 'Europe/Zurich',
        ...query,
      },
      scopes: runtime.scopes.filter((scope) =>
        (query.providers ?? ['chatgpt', 'google-ai-mode']).includes(scope.provider),
      ),
    });

  return { runtime, request };
}

describe('isolated fictional demo composition', () => {
  it('returns actual matching fictional excerpts through the shared keyword engine, without links', async () => {
    const { runtime, request } = fixture();
    const input = request();
    const result = await runtime.search.search(input, { signal: new AbortController().signal });
    expect(validate(searchOutcomeSchemaFor(input, demoVerifiers), result).ok).toBe(true);
    expect(result.state).toBe('success');
    expect(result.results).toHaveLength(3);
    expect(demoCandidates().every((candidate) => candidate.originalUrl === undefined)).toBe(true);
  });

  it.each([
    ['Where did I discuss login security?', 'demo-library'],
    ['Where did I compare deployment options for my portfolio?', 'demo-portfolio'],
    ['Find conversations about database performance and slow SQL queries', 'demo-database'],
    ['Which sessions did I discuss authentication last month?', 'demo-authentication'],
  ])('grounds the example %s in an exact fictional evidence reference', async (text, id) => {
    const { runtime, request } = fixture();
    const input = request({ mode: 'description', text });
    const result = await runtime.search.search(input, { signal: new AbortController().signal });
    expect(validate(searchOutcomeSchemaFor(input, demoVerifiers), result).ok).toBe(true);
    expect(result.results).toContain(id);
    expect(result.description?.strategy).toBe('keyword-topic-fallback');
    expect(
      result.description?.ranking.selections.every((selection) => selection.evidenceIds.length > 0),
    ).toBe(true);
  });

  it('preserves partial results and distinguishes a fully empty search', async () => {
    for (const scenario of ['google-unavailable', 'empty'] as const) {
      const { runtime, request } = fixture(scenario);
      const result = await runtime.search.search(request(), {
        signal: new AbortController().signal,
      });
      expect(result.state).toBe(scenario === 'empty' ? 'success' : 'partial');
      expect(result.results).toHaveLength(scenario === 'empty' ? 0 : 1);
    }
  });

  it('cancels slow work promptly and does not leak state to another composition', async () => {
    vi.useFakeTimers();
    const { runtime, request } = fixture('slow');
    const controller = new AbortController();
    const pending = runtime.search.search(request(), { signal: controller.signal });
    controller.abort();
    expect((await pending).state).toBe('cancelled');
    const other = fixture();
    const fresh = other.runtime.search.search(other.request(), {
      signal: new AbortController().signal,
    });
    await vi.runAllTimersAsync();
    expect((await fresh).results).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies provider and exclusive date filters; undated evidence cannot satisfy dates', async () => {
    const { runtime, request } = fixture();
    const result = await runtime.search.search(
      request({
        text: 'authentication',
        providers: ['google-ai-mode'],
        dateRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      }),
      { signal: new AbortController().signal },
    );
    expect(result.results).toHaveLength(0);
    expect(result.coverage.reasons).toContain('unknown-dates');
  });

  it.each([
    '/repo/src/platform/client.ts',
    '/repo/src/providers/chatgpt/adapter.ts',
    '/repo/src/entrypoints/background.ts',
    '/repo/src/storage/preferences.ts',
    '/repo/src/description/on-device/model.ts',
    '/repo/.ai/private.md',
    '/repo/AGENTS.md',
  ])('rejects privileged or local-only imports: %s', (id) =>
    expect(forbiddenDemoModule(id)).toBe(true),
  );

  it('allows shared contracts, search and presentation', () => {
    for (const id of [
      '/repo/src/search/keyword-search.ts',
      '/repo/src/ui/SearchScreen.tsx',
      '/repo/demo/runtime.ts',
    ])
      expect(forbiddenDemoModule(id)).toBe(false);
  });
});
