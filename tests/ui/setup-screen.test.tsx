// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../../src/ui/SetupScreen';

afterEach(cleanup);
describe('injected setup view', () => {
  it('routes each labeled action to its selected provider and exposes live statuses', () => {
    const props = {
      providers: [
        { provider: 'chatgpt' as const, status: 'selected', pending: false, selected: true },
        {
          provider: 'google-ai-mode' as const,
          status: 'connecting',
          pending: true,
          selected: false,
        },
      ],
      onConnect: vi.fn(),
      onInspect: vi.fn(),
      onDisconnect: vi.fn(),
      onCancel: vi.fn(),
    };
    render(<SetupScreen {...props} />);
    const chat = within(screen.getByRole('region', { name: 'ChatGPT' }));
    const google = within(screen.getByRole('region', { name: 'Google Search AI Mode' }));
    fireEvent.click(chat.getByRole('button', { name: 'Connect ChatGPT' }));
    fireEvent.click(chat.getByRole('button', { name: 'Check selected site' }));
    fireEvent.click(chat.getByRole('button', { name: 'Clear selection' }));
    fireEvent.click(google.getByRole('button', { name: 'Cancel' }));
    expect(props.onConnect).toHaveBeenCalledWith('chatgpt');
    expect(props.onInspect).toHaveBeenCalledWith('chatgpt');
    expect(props.onDisconnect).toHaveBeenCalledWith('chatgpt');
    expect(props.onCancel).toHaveBeenCalledWith('google-ai-mode');
    expect(
      (google.getByRole('button', { name: 'Connect Google Search AI Mode' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(google.getByRole('status').textContent).toContain('Checking site access');
    expect(chat.getByRole('status').textContent).toContain('unverified');
  });
  it.each(['<img src=x onerror=alert(1)>', 'constructor', 'toString', '__proto__'])(
    'falls back to safe unavailable text for unexpected status %s and renders no injected HTML',
    (status) => {
      render(
        <SetupScreen
          providers={[
            {
              provider: 'chatgpt',
              status,
              selected: false,
              pending: false,
            },
          ]}
          onConnect={() => {}}
          onInspect={() => {}}
          onDisconnect={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.getByRole('status').textContent).toContain('unavailable');
      expect(document.querySelector('img')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
    },
  );
});
