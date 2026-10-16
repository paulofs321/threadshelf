// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateSchema, requireValid, SearchRequestSchema } from '../../src/contracts';
import type { ProviderOutcome } from '../../src/contracts';
import { aggregateSearch } from '../../src/search/aggregate';
import { ResultTabs } from '../../src/ui/ResultTabs';
import {
  chatCandidate,
  chatScope,
  googleCandidate,
  googleScope,
  linkVerifiers,
  request,
} from '../fixtures/contracts';

const successes: ProviderOutcome[] = [chatCandidate, googleCandidate].map((candidate) => ({
  requestId: request.requestId,
  scope: candidate.scope,
  status: 'success',
  candidates: [candidate],
  coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
}));
const chatSuccess = successes[0];
const googleSuccess = successes[1];

if (!chatSuccess || !googleSuccess) throw new Error('Missing synthetic provider success.');

function setup(outcomes = successes, searchRequest = request) {
  const props = {
    outcome: aggregateSearch(searchRequest, outcomes, linkVerifiers, 200, []),
    verifiers: linkVerifiers,
    timeZone: 'UTC',
    onConnect: vi.fn(),
    children: <p>Search status</p>,
  };

  return { ...render(<ResultTabs {...props} />), props };
}

const panel = () => within(screen.getByRole('tabpanel'));

afterEach(cleanup);
describe('provider result tabs', () => {
  it('shows separate counts and only the selected source, retaining original verified links', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('tab', { name: 'All sources 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(panel().getAllByRole('article')).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: 'ChatGPT 1' }));
    expect(panel().getAllByRole('article')).toHaveLength(1);
    expect(panel().getByRole('link').getAttribute('href')).toBe(chatCandidate.originalUrl);
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode 1' }));
    expect(panel().getAllByRole('article')).toHaveLength(1);
    expect(panel().getByRole('link').getAttribute('href')).toBe(googleCandidate.originalUrl);
    await user.click(screen.getByRole('tab', { name: 'All sources 2' }));
    expect(panel().getAllByRole('article')).toHaveLength(2);
  });
  it('supports arrow, Home and End navigation with linked tab panels and roving focus', async () => {
    const user = userEvent.setup();
    setup();
    const all = screen.getByRole('tab', { name: 'All sources 2' });
    const chat = screen.getByRole('tab', { name: 'ChatGPT 1' });
    const google = screen.getByRole('tab', { name: 'Google AI Mode 1' });
    all.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(chat));
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(chat.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(chat.id);
    expect(all.tabIndex).toBe(-1);
    expect(chat.tabIndex).toBe(0);
    await user.keyboard('{End}');
    await waitFor(() => expect(document.activeElement).toBe(google));
    await user.keyboard('{Home}');
    await waitFor(() => expect(document.activeElement).toBe(all));
  });
  it('keeps failure badges visible and scopes failure/reconnect actions to their provider', async () => {
    const user = userEvent.setup();
    const { props } = setup([
      chatSuccess,
      { requestId: request.requestId, scope: googleScope, status: 'login-expired' },
    ]);
    expect(panel().getAllByRole('article')).toHaveLength(1);
    expect(panel().getByRole('note').textContent).toContain('Login expired');
    await user.click(screen.getByRole('tab', { name: 'ChatGPT 1' }));
    expect(panel().queryByRole('note')).toBeNull();
    await user.click(screen.getByRole('tab', { name: /Google AI Mode 0 failed/ }));
    expect(panel().queryAllByRole('article')).toHaveLength(0);
    await user.click(panel().getByRole('button', { name: 'Reconnect Google Search AI Mode' }));
    expect(props.onConnect).toHaveBeenCalledExactlyOnceWith('google-ai-mode');
  });
  it('distinguishes an excluded provider from a successful search with no matches', async () => {
    const user = userEvent.setup();
    const chatOnly = requireValid(SearchRequestSchema, {
      ...request,
      query: { ...request.query, providers: ['chatgpt'] },
      scopes: [chatScope],
    });
    setup(
      [
        {
          requestId: request.requestId,
          scope: chatScope,
          status: 'success',
          candidates: [],
          coverage: { extent: 'complete', reasons: [] },
        },
      ],
      chatOnly,
    );
    expect(panel().getByText('No matching conversations in this source.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode 0' }));
    expect(panel().getByText('This provider was not included in this search.')).toBeTruthy();
    expect(panel().queryByText('No matching conversations in this source.')).toBeNull();
    expect(panel().queryByRole('note')).toBeNull();
  });
  it('sorts known dates newest first, places unknown dates last and can restore provider order', () => {
    const rows = [
      ['undated-one', undefined],
      ['older', '2026-01-01T00:00:00.000Z'],
      ['undated-two', undefined],
      ['newer', '2026-10-01T00:00:00.000Z'],
    ].map(([id, at]) =>
      requireValid(CandidateSchema, {
        id,
        scope: chatScope,
        conversationId: id,
        title: id,
        originalUrl: `https://chatgpt.example.invalid/threads/${id}`,
        evidence: [],
        ...(at
          ? { date: { at, meaning: 'conversation-updated', source: 'provider-metadata' } }
          : {}),
      }),
    );
    setup([
      {
        requestId: request.requestId,
        scope: chatScope,
        status: 'success',
        candidates: rows,
        coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
      },
      googleSuccess,
    ]);
    const names = () =>
      panel()
        .getAllByRole('article')
        .map((article) => article.getAttribute('aria-label'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'provider' },
    });
    const original = names();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'recent' },
    });
    expect(names()).toEqual([
      'newer',
      'older',
      'undated-one',
      'undated-two',
      googleCandidate.title,
    ]);
    expect(rows.map((row) => row.title)).toEqual(['undated-one', 'older', 'undated-two', 'newer']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'provider' },
    });
    expect(names()).toEqual(original);
  });
  it('discards old results when scope validation clears the outcome, including an inactive tab', async () => {
    const user = userEvent.setup();
    const { rerender, props } = setup();
    await user.click(screen.getByRole('tab', { name: 'Google AI Mode 1' }));
    rerender(<ResultTabs {...props} outcome={undefined} />);
    expect(panel().queryAllByRole('article')).toHaveLength(0);
    expect(panel().getByText('Search your saved conversations to get started.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'ChatGPT' }));
    expect(panel().queryAllByRole('article')).toHaveLength(0);
    expect(props.onConnect).not.toHaveBeenCalled();
  });
});
