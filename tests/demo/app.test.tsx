// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { DemoApp } from '../../demo/App';

afterEach(cleanup);

it('uses the shared panel with fictional navigation, memory-only controls and a fresh simulation', async () => {
  const user = userEvent.setup();
  render(<DemoApp />);
  expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull();
  const query = screen.getByRole('searchbox', { name: 'Search conversations' });
  await user.type(query, 'floating library{Enter}');
  const results = screen.getByRole('region', { name: 'Search results' });
  await within(results).findAllByRole('article');
  expect(within(results).queryByRole('link')).toBeNull();
  expect(
    within(results).getAllByText('Fictional conversation — original navigation disabled.'),
  ).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Search settings' }));
  expect(screen.getByText(/All demo state stays in memory/)).toBeTruthy();
  expect(screen.getByText(/This demo searches only the fictional excerpts/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Clear local data and preferences' }));
  expect((query as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('heading', { name: 'Connect your accounts' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Simulated provider behavior'), {
    target: { value: 'empty' },
  });
  await user.type(screen.getByRole('searchbox'), 'floating library{Enter}');
  expect(await screen.findByText('No matches in the searched conversations.')).toBeTruthy();
});
