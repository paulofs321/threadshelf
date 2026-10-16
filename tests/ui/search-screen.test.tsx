// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderOutcome,
  SearchOutcome,
  SearchPort,
  SearchRequest,
} from '../../src/contracts';
import { KeywordSearch } from '../../src/search';
import { aggregateSearch } from '../../src/search/aggregate';
import { SearchScreen } from '../../src/ui/SearchScreen';
import type { SearchScreenProps } from '../../src/ui/SearchScreen';
import {
  chatCandidate,
  chatScope,
  googleCandidate,
  googleScope,
  linkVerifiers,
  providerPort,
  deferred,
} from '../fixtures/search/providers';

function setup(overrides: Partial<SearchScreenProps> = {}, openSettings = true) {
  const chat = providerPort('chatgpt');
  const google = providerPort('google-ai-mode');
  const engine = new KeywordSearch({ providers: [chat, google], linkVerifiers });
  let serial = 0;
  const props: SearchScreenProps = {
    providers: [chatScope, googleScope].map((scope) => ({
      provider: scope.provider,
      status: 'selected',
      selected: true,
      pending: false,
    })),
    scopes: [chatScope, googleScope],
    search: engine,
    verifiers: linkVerifiers,
    freshId: () => `fiction-ui-${++serial}`,
    timeZone: 'Europe/Zurich',
    onConnect: vi.fn(),
    onInspect: vi.fn(),
    onDisconnect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const rendered = render(<SearchScreen {...props} />);
  const back = screen.queryByRole('button', { name: 'Back to search' });

  if (back) fireEvent.click(back);

  const settings = screen.getByRole('button', { name: 'Search settings' });

  if (openSettings && settings.getAttribute('aria-expanded') === 'false') fireEvent.click(settings);

  return { ...rendered, props, chat, google, engine };
}

const input = () => screen.getByRole('searchbox', { name: 'Search conversations' });
const results = () => within(screen.getByRole('region', { name: 'Search results' }));

async function search() {
  fireEvent.change(input(), { target: { value: 'floating library' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  });
}

function failure(
  request: SearchRequest,
  status: Exclude<ProviderOutcome['status'], 'success'>,
  retryAfterMs?: number,
): SearchOutcome {
  return aggregateSearch(
    request,
    request.scopes.map((scope) => ({
      requestId: request.requestId,
      scope,
      status,
      ...(status === 'rate-limited' && retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })),
    linkVerifiers,
    200,
    [],
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared search panel with real keyword orchestration', () => {
  it('opens the separate connection page from Connect and restores the query, selected source and sort', async () => {
    const user = userEvent.setup();
    const { props, chat, google } = setup({}, false);
    await search();
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode 1' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'provider' },
    });
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('ChatGPT is already connected.')).toBeTruthy();
    expect(screen.getByText('Google Search AI Mode is already connected.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect Google Search AI Mode' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Welcome to ThreadShelf' }),
    );
    expect(props.onConnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back to search' }));
    expect(document.activeElement).toBe(input());
    expect((input() as HTMLInputElement).value).toBe('floating library');
    expect(
      screen.getByRole('tab', { name: 'Google AI Mode 1' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      (screen.getByRole('combobox', { name: 'Sort results' }) as HTMLSelectElement).value,
    ).toBe('provider');
    expect(results().getAllByRole('article')).toHaveLength(1);
    expect(chat.search).toHaveBeenCalledOnce();
    expect(google.search).toHaveBeenCalledOnce();
  });
  it('preserves filters while the connection page is open and supports continuing to search', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-03-29' } });
    fireEvent.change(screen.getByLabelText('Before date (exclusive)'), {
      target: { value: '2026-03-30' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Google Search AI Mode' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(screen.getByText('Need help?'));
    expect(screen.getByText(/ThreadShelf uses your existing/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue to search' }));
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-03-29');
    expect((screen.getByLabelText('Before date (exclusive)') as HTMLInputElement).value).toBe(
      '2026-03-30',
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Google Search AI Mode' }) as HTMLInputElement).checked,
    ).toBe(false);
  });
  it('keeps an in-flight search running across page navigation without stealing connection-page focus', async () => {
    const user = userEvent.setup();
    const pending = deferred<SearchOutcome>();
    const port = {
      search: vi.fn<SearchPort['search']>().mockReturnValue(pending.promise),
      invalidate: vi.fn(),
    };
    setup({ search: port }, false);
    await search();
    const call = port.search.mock.calls[0];

    if (!call) throw new Error('Missing synthetic request');

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(call[1].signal.aborted).toBe(false);
    await act(async () => pending.resolve(failure(call[0], 'timeout')));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Welcome to ThreadShelf' }),
    );
    await user.click(screen.getByRole('button', { name: 'Back to search' }));
    expect(results().getByRole('status').textContent).toContain('Search failed');
  });
  it('updates the connection page immediately on scope loss and clears hidden search results', async () => {
    const user = userEvent.setup();
    const { props, rerender } = setup({}, false);
    await search();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    rerender(
      <SearchScreen
        {...props}
        scopes={[]}
        providers={props.providers.map((item) => ({
          ...item,
          selected: false,
          status: 'permission-needed',
        }))}
      />,
    );
    expect(screen.queryByText('ChatGPT is already connected.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect ChatGPT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to search' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to search' }));
    expect(results().queryAllByRole('article')).toHaveLength(0);
    expect((input() as HTMLInputElement).value).toBe('floating library');
  });
  it('keeps connected search compact while settings remain available through a keyboard toggle', async () => {
    const user = userEvent.setup();
    const { chat, google } = setup({}, false);
    const settings = screen.getByRole('button', { name: 'Search settings' });
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('combobox', { name: 'Search mode' })).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Conversation sources' })).toBeTruthy();
    settings.focus();
    await user.keyboard('{Enter}');
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Search mode' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-03-29' } });
    await user.keyboard(' ');
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{Enter}');
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-03-29');
    expect(chat.search).not.toHaveBeenCalled();
    expect(google.search).not.toHaveBeenCalled();
  });
  it('switches source tabs without repeating requests and refreshes through the real search port', async () => {
    const user = userEvent.setup();
    const { chat, google } = setup({}, false);
    await search();
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode 1' }));
    expect(results().getAllByRole('article')).toHaveLength(1);
    expect(results().getByRole('link').getAttribute('href')).toBe(googleCandidate.originalUrl);
    expect((input() as HTMLInputElement).value).toBe('floating library');
    expect(chat.search).toHaveBeenCalledOnce();
    expect(google.search).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Refresh search' }));
    expect(chat.search).toHaveBeenCalledTimes(2);
    expect(google.search).toHaveBeenCalledTimes(2);
    expect(chat.search.mock.calls[0]?.[0].requestId).not.toBe(
      chat.search.mock.calls[1]?.[0].requestId,
    );
    expect(
      screen.getByRole('tab', { name: 'Google AI Mode 1' }).getAttribute('aria-selected'),
    ).toBe('true');
  });
  it('clears a pending query, aborts its work and keeps late results out of every source tab', async () => {
    const user = userEvent.setup();
    const pending = deferred<SearchOutcome>();
    const port = {
      search: vi.fn<SearchPort['search']>().mockReturnValue(pending.promise),
      invalidate: vi.fn(),
    };
    setup({ search: port }, false);
    await search();
    const call = port.search.mock.calls[0];

    if (!call) throw new Error('Missing synthetic request');

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(call[1].signal.aborted).toBe(true);
    expect((input() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    await act(async () => pending.resolve(failure(call[0], 'login-expired')));
    expect(results().queryByRole('note')).toBeNull();
    expect(results().getByRole('status').textContent).toContain('Ready');
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode' }));
    expect(results().queryAllByRole('article')).toHaveLength(0);
  });
  it('requests nothing on mount and labels the pending mode, controls, timezone and date limits', () => {
    const { chat, google } = setup();
    expect(chat.search).not.toHaveBeenCalled();
    expect(google.search).not.toHaveBeenCalled();
    expect(
      screen.getByRole('option', { name: 'Description (pending)' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Search mode' })).toBeTruthy();
    expect(screen.getByLabelText('From date')).toBeTruthy();
    expect(screen.getByText(/Timezone: Europe\/Zurich/).textContent).toContain(
      'Undated conversations are excluded',
    );
    expect(results().getByRole('status').textContent).toContain('Ready to search');
  });
  it('passes keyword/provider filters to actual orchestration and renders exact evidence, metadata, safe links and unknown dates', async () => {
    const { chat, google } = setup();
    await search();
    expect(chat.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          text: 'floating library',
          mode: 'keyword',
          providers: ['chatgpt', 'google-ai-mode'],
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(google.search).toHaveBeenCalledOnce();
    expect(results().getAllByRole('article')).toHaveLength(2);
    expect(results().getByText('Date unavailable')).toBeTruthy();
    expect(results().getByText(/Conversation created:/).parentElement?.textContent).toContain(
      'provider metadata',
    );
    expect(results().getByText(chatCandidate.evidence[1]?.text ?? '')).toBeTruthy();
    const links = results().getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      chatCandidate.originalUrl,
      googleCandidate.originalUrl,
    ]);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });
  it('sends only the checked provider and does not invoke excluded providers', async () => {
    const { chat, google } = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Google Search AI Mode' }));
    await search();
    expect(chat.search.mock.calls[0]?.[0].query.providers).toEqual(['chatgpt']);
    expect(google.search).not.toHaveBeenCalled();
    expect(results().getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Google Search AI Mode' }));
    await search();
    expect(google.search).toHaveBeenCalledOnce();
  });
  it('converts local dates through DST and excludes unknown dates without inventing Google metadata', async () => {
    const { chat, google } = setup();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-03-29' } });
    fireEvent.change(screen.getByLabelText('Before date (exclusive)'), {
      target: { value: '2026-03-30' },
    });
    await search();
    expect(chat.search.mock.calls[0]?.[0].query.dateRange).toEqual({
      start: '2026-03-28T23:00:00.000Z',
      end: '2026-03-29T22:00:00.000Z',
    });
    expect(google.search.mock.calls[0]?.[0].query.dateRange).toEqual(
      chat.search.mock.calls[0]?.[0].query.dateRange,
    );
    expect(results().queryAllByRole('article')).toHaveLength(0);
    expect(results().getByRole('status').textContent).toContain('No matches');
    expect(results().getByText(/Coverage:/).textContent).toContain(
      'Undated conversations were excluded',
    );
  });
  it.each([
    'blank',
    'no providers',
    'one date',
    'reversed dates',
    'disconnected',
    'no port',
    'invalid timezone',
  ])(
    'rejects %s input without calling providers and focuses the query with accessible feedback',
    async (kind) => {
      const { chat, google } = setup(
        kind === 'disconnected'
          ? { scopes: [] }
          : kind === 'no port'
            ? { search: null }
            : kind === 'invalid timezone'
              ? { timeZone: 'fiction/unknown' }
              : {},
      );

      if (kind !== 'blank') fireEvent.change(input(), { target: { value: 'library' } });

      if (kind === 'no providers') {
        fireEvent.click(screen.getByRole('checkbox', { name: 'ChatGPT' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Google Search AI Mode' }));
      }

      if (kind === 'one date' || kind === 'reversed dates')
        fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-04-30' } });

      if (kind === 'reversed dates')
        fireEvent.change(screen.getByLabelText('Before date (exclusive)'), {
          target: { value: '2026-04-01' },
        });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      });
      expect(results().getByRole('alert').textContent).toContain('Enter a keyword');
      expect(input().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input());
      expect(chat.search).not.toHaveBeenCalled();
      expect(google.search).not.toHaveBeenCalled();
    },
  );
  it('distinguishes successful empty search from partial zero matches and keeps known coverage limits visible', async () => {
    const { chat, google } = setup();
    chat.search.mockImplementation(async (request) => ({
      requestId: request.requestId,
      scope: request.scope,
      status: 'success',
      candidates: [],
      coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
    }));
    google.search.mockImplementation(async (request) => ({
      requestId: request.requestId,
      scope: request.scope,
      status: 'success',
      candidates: [],
      coverage: { extent: 'complete', reasons: [] },
    }));
    await search();
    expect(results().getByRole('status').textContent).toContain('No matches');
    expect(results().getByText(/Coverage:/).textContent).toContain('reach is unknown');
    google.search.mockImplementation(async (request) => ({
      requestId: request.requestId,
      scope: request.scope,
      status: 'unavailable',
    }));
    await search();
    expect(results().getByRole('status').textContent).toContain('Partial search: 0 matches');
    expect(results().queryByText('No matches in the searched conversations.')).toBeNull();
  });
  it('preserves successful matches when another provider fails and reconnects through the injected capability', async () => {
    const { props, google } = setup();
    google.search.mockImplementation(async (request) => ({
      requestId: request.requestId,
      scope: request.scope,
      status: 'login-expired',
    }));
    await search();
    expect(results().getByRole('status').textContent).toContain('Partial search: 1 match');
    expect(results().getAllByRole('article')).toHaveLength(1);
    fireEvent.click(results().getByRole('button', { name: 'Reconnect Google Search AI Mode' }));
    expect(props.onConnect).toHaveBeenCalledWith('google-ai-mode');
  });
});

describe('search state, trust and lifecycle presentation', () => {
  it.each([
    'login-expired',
    'permission-needed',
    'unavailable',
    'schema-changed',
    'rate-limited',
    'timeout',
    'cancelled',
    'scope-changed',
    'interrupted',
  ] as const)('gives %s a distinct safe status and appropriate recovery', async (status) => {
    const searchPort = {
      search: vi
        .fn<SearchPort['search']>()
        .mockImplementation(async (request) => failure(request, status)),
      invalidate: vi.fn(),
    };
    setup({ search: searchPort });
    await search();
    const expected = {
      'login-expired': 'Login expired.',
      'permission-needed': 'Site permission is required.',
      unavailable: 'Provider unavailable.',
      'schema-changed': 'Provider response changed.',
      'rate-limited': 'Rate limited.',
      timeout: 'Search timed out.',
      cancelled: 'Search cancelled.',
      'scope-changed': 'Account or selected context changed.',
      interrupted: 'Connection interrupted.',
    };
    expect(
      results()
        .getAllByRole('note')
        .every((note) => note.textContent?.includes(expected[status])),
    ).toBe(true);
    expect(results().queryAllByRole('article')).toHaveLength(0);
    expect(results().queryAllByRole('button', { name: /Reconnect/ })).toHaveLength(
      ['login-expired', 'permission-needed', 'scope-changed', 'interrupted'].includes(status)
        ? 2
        : 0,
    );
  });
  it('honors rate-limit retry hints with a bounded UI timer and a fresh request after retry', async () => {
    vi.useFakeTimers();
    const port = {
      search: vi
        .fn<SearchPort['search']>()
        .mockImplementation(async (request) => failure(request, 'rate-limited', 2000)),
      invalidate: vi.fn(),
    };
    setup({ search: port });
    await search();
    expect(results().getAllByText(/Retry after 2 seconds/)).toHaveLength(2);
    const retry = results().getByRole('button', { name: 'Wait to retry' });
    expect(retry.hasAttribute('disabled')).toBe(true);
    fireEvent.click(retry);
    expect(port.search).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      fireEvent.click(results().getByRole('button', { name: 'Retry search' }));
    });
    expect(port.search).toHaveBeenCalledTimes(2);
    expect(port.search.mock.calls[1]?.[0].requestId).not.toBe(
      port.search.mock.calls[0]?.[0].requestId,
    );
  });
  it.each(['resolved', 'rejected'])(
    'exposes loading/cancelling/cancelled and recovers focus when cancellation is %s',
    async (settlement) => {
      const pending = deferred<SearchOutcome>();
      const port = {
        search: vi.fn<SearchPort['search']>().mockReturnValue(pending.promise),
        invalidate: vi.fn(),
      };
      setup({ search: port });
      await search();
      expect(results().getByRole('status').textContent).toContain('Searching');
      expect(results().getByRole('list', { name: 'Provider progress' }).textContent).toContain(
        'ChatGPT: searching',
      );
      const cancel = screen.getByRole('button', { name: 'Cancel search' });
      cancel.focus();
      fireEvent.click(cancel);
      expect(results().getByRole('status').textContent).toContain('Cancelling');
      const call = port.search.mock.calls[0];
      expect(call?.[1].signal.aborted).toBe(true);

      if (!call) throw new Error('Missing synthetic request');

      await act(async () => {
        if (settlement === 'rejected') pending.reject(new Error('fiction-cancelled'));
        else pending.resolve(failure(call[0], 'cancelled'));
      });
      expect(results().getByRole('status').textContent).toBe('Search cancelled.');
      expect(document.activeElement).toBe(
        results().getByRole('heading', { name: 'Search results' }),
      );
      expect(results().getByRole('button', { name: 'Retry search' })).toBeTruthy();
    },
  );
  it('replaces a running query, discards late old output and does not steal focus from active editing', async () => {
    const old = deferred<SearchOutcome>();
    const newer = deferred<SearchOutcome>();
    const port = {
      search: vi
        .fn<SearchPort['search']>()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(newer.promise),
      invalidate: vi.fn(),
    };
    setup({ search: port });
    await search();
    const first = port.search.mock.calls[0];
    fireEvent.change(input(), { target: { value: 'balloon basket' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    const second = port.search.mock.calls[1];

    if (!first || !second) throw new Error('Missing synthetic requests');

    expect(first[1].signal.aborted).toBe(true);
    input().focus();
    await act(async () => {
      old.resolve(failure(first[0], 'login-expired'));
    });
    expect(results().getByRole('status').textContent).toContain('Searching');
    await act(async () => {
      newer.resolve(failure(second[0], 'timeout'));
    });
    expect(results().getByRole('status').textContent).toContain('Search failed');
    expect(results().queryByText(/Login expired/)).toBeNull();
    expect(document.activeElement).toBe(input());
  });
  it.each(['malformed', 'unsafe link', 'wrong scope', 'wrong request', 'rejected'])(
    'rejects %s port output without displaying private exceptions or untrusted candidates',
    async (kind) => {
      const port = {
        search: vi.fn<SearchPort['search']>().mockImplementation(async (request) => {
          if (kind === 'rejected') throw new Error('fiction-private-error');

          if (kind === 'malformed') return {} as SearchOutcome;

          const candidate = structuredClone(chatCandidate);

          if (kind === 'unsafe link')
            Object.assign(candidate, { originalUrl: 'javascript:alert(1)' });

          if (kind === 'wrong scope') candidate.scope = { ...chatScope, generation: 42 };

          return {
            requestId: kind === 'wrong request' ? 'fiction-obsolete' : request.requestId,
            state: 'success',
            results: [candidate.id],
            outcomes: request.scopes.map((scope) => ({
              requestId: kind === 'wrong request' ? 'fiction-obsolete' : request.requestId,
              scope,
              status: 'success',
              candidates: scope.provider === 'chatgpt' ? [candidate] : [],
              coverage: { extent: 'complete', reasons: [] },
            })),
            coverage: { extent: 'complete', reasons: [] },
          } as SearchOutcome;
        }),
        invalidate: vi.fn(),
      };
      setup({ search: port });
      await search();
      expect(results().getByRole('alert').textContent).toContain('invalid response');
      expect(results().queryAllByRole('article')).toHaveLength(0);
      expect(document.body.textContent).not.toContain('fiction-private-error');
    },
  );
  it('clears displayed results synchronously on scope changes and prevents late private output after unmount or invalidation', async () => {
    const pending = deferred<SearchOutcome>();
    const { props, rerender, unmount } = setup();
    await search();
    expect(results().getAllByRole('article')).toHaveLength(2);
    rerender(<SearchScreen {...props} scopes={[{ ...chatScope, generation: 2 }]} />);
    expect(results().queryAllByRole('article')).toHaveLength(0);
    const port = {
      search: vi.fn<SearchPort['search']>().mockReturnValue(pending.promise),
      invalidate: vi.fn(),
    };
    rerender(<SearchScreen {...props} search={port} />);
    await search();
    const call = port.search.mock.calls[0];

    if (!call) throw new Error('Missing request');

    unmount();
    expect(call[1].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(failure(call[0], 'timeout'));
    });
    expect(document.body.textContent).toBe('');
  });
  it('aborts and discards pending results on scope invalidation while the component stays mounted', async () => {
    const pending = deferred<SearchOutcome>();
    const port = {
      search: vi.fn<SearchPort['search']>().mockReturnValue(pending.promise),
      invalidate: vi.fn(),
    };
    const { props, rerender } = setup({ search: port });
    await search();
    const call = port.search.mock.calls[0];

    if (!call) throw new Error('Missing request');

    rerender(<SearchScreen {...props} scopes={[]} />);
    expect(call[1].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(failure(call[0], 'login-expired'));
    });
    expect(results().getByRole('status').textContent).toContain('Ready');
    expect(results().queryByText(/Login expired/)).toBeNull();
  });
  it('supports keyboard query submission, checkboxes and focus recovery without a mouse', async () => {
    const user = userEvent.setup();
    setup();
    input().focus();
    await user.type(input(), 'floating library{Enter}');
    expect(results().getAllByRole('article')).toHaveLength(2);
    const provider = screen.getByRole('checkbox', { name: 'Google Search AI Mode' });
    provider.focus();
    await user.keyboard(' ');
    expect(provider.hasAttribute('checked')).toBe(true);
    expect((provider as HTMLInputElement).checked).toBe(false);
    expect(results().queryAllByRole('article')).toHaveLength(0);
    const searchButton = screen.getByRole('button', { name: 'Search' });
    searchButton.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(results().getByRole('heading', { name: 'Search results' }));
  });
});
