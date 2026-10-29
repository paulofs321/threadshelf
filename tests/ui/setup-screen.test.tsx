// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../../src/ui/SetupScreen';

afterEach(cleanup);
describe('injected setup view', () => {
  it('connects only disconnected providers and removes the Connect button after success', () => {
    const props = {
      providers: [
        { provider: 'chatgpt' as const, status: 'idle', pending: false, selected: false },
        { provider: 'google-ai-mode' as const, status: 'idle', pending: false, selected: false },
      ],
      onConnect: vi.fn(),
      onInspect: vi.fn(),
      onDisconnect: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(<SetupScreen {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Search AI Mode' }));
    expect(props.onConnect.mock.calls).toEqual([['chatgpt'], ['google-ai-mode']]);
    rerender(
      <SetupScreen
        {...props}
        providers={props.providers.map((item) => ({
          ...item,
          status: 'connected',
          selected: true,
        }))}
      />,
    );
    expect(
      screen
        .getAllByRole('status')
        .every((status) => status.textContent?.includes('is already connected.')),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
    expect(props.onConnect).toHaveBeenCalledTimes(2);
  });
  it('keeps pending connections cancellable instead of reporting them as already connected', () => {
    render(
      <SetupScreen
        providers={[{ provider: 'chatgpt', status: 'connecting', pending: true, selected: true }]}
        onConnect={vi.fn()}
        onInspect={vi.fn()}
        onDisconnect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    expect(screen.getByRole('button', { name: 'Reconnect ChatGPT' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
  it('routes each labeled action to its selected provider and exposes live statuses', () => {
    const props = {
      providers: [
        { provider: 'chatgpt' as const, status: 'connected', pending: false, selected: true },
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
    expect(chat.queryByRole('button', { name: 'Connect ChatGPT' })).toBeNull();
    expect(chat.getByText('Connection options').closest('details')?.open).toBe(false);
    fireEvent.click(chat.getByText('Connection options'));
    fireEvent.click(chat.getByRole('button', { name: 'Recheck connection' }));
    fireEvent.click(chat.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(google.getByRole('button', { name: 'Cancel' }));
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(props.onInspect).toHaveBeenCalledWith('chatgpt');
    expect(props.onDisconnect).toHaveBeenCalledWith('chatgpt');
    expect(props.onCancel).toHaveBeenCalledWith('google-ai-mode');
    expect(
      (google.getByRole('button', { name: 'Reconnect Google Search AI Mode' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(google.getByRole('status').textContent).toContain('Connecting');
    expect(chat.getByRole('status').textContent).toBe('ChatGPT is already connected.');
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
      expect(screen.getByRole('status').textContent).toContain('could not be verified');
      expect(document.querySelector('img')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    },
  );
});
