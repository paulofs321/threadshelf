// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAiSettings } from '../../src/ui/LocalAiSettings';
import type { LocalAiState } from '../../src/description/on-device/types';
import { SearchScreen } from '../../src/ui/SearchScreen';
import { chatScope, linkVerifiers } from '../fixtures/description/corpus';

afterEach(cleanup);

describe('optional local AI controls', () => {
  it.each([
    'checking',
    'available',
    'downloadable',
    'starting',
    'downloading',
    'ready',
    'running',
    'unavailable',
    'error',
    'disabled',
  ] as const)('shows accurate %s status and actions', (status) => {
    const controls = { state: { status }, enable: vi.fn(), disable: vi.fn(), check: vi.fn() };
    render(<LocalAiSettings controls={controls} />);
    expect(screen.getByRole('status').textContent?.length).toBeGreaterThan(0);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    if (['starting', 'downloading', 'ready', 'running'].includes(status))
      expect(controls.disable).toHaveBeenCalledOnce();
    else if (['available', 'downloadable'].includes(status))
      expect(controls.enable).toHaveBeenCalledOnce();
    else if (status === 'checking') expect(controls.check).not.toHaveBeenCalled();
    else expect(controls.check).toHaveBeenCalledOnce();
  });
  it('exposes bounded download progress with an accessible label', () => {
    const { rerender } = render(
      <LocalAiSettings
        controls={{
          state: { status: 'downloading', progress: 0.45 },
          enable: vi.fn(),
          disable: vi.fn(),
          check: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Local AI model download' })).toHaveProperty(
      'value',
      0.45,
    );
    rerender(
      <LocalAiSettings
        controls={{
          state: { status: 'downloading' },
          enable: vi.fn(),
          disable: vi.fn(),
          check: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('progressbar')).toHaveProperty('value', 0);
  });
  it('wires enable/disable/check through the shared screen, clearing prior searches', () => {
    const controls = {
      state: { status: 'available' } as LocalAiState,
      enable: vi.fn(),
      disable: vi.fn(),
      check: vi.fn(),
    };
    const props = {
      scopes: [chatScope],
      providers: [
        { provider: chatScope.provider, status: 'selected', selected: true, pending: false },
      ],
      search: null,
      verifiers: linkVerifiers,
      freshId: () => 'fiction-ai-ui',
      timeZone: 'UTC',
      onConnect: vi.fn(),
      onInspect: vi.fn(),
      onDisconnect: vi.fn(),
      onCancel: vi.fn(),
      ai: controls,
    };
    const { rerender } = render(<SearchScreen {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable local AI' }));
    expect(controls.enable).toHaveBeenCalledOnce();
    rerender(<SearchScreen {...props} ai={{ ...controls, state: { status: 'ready' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable local AI' }));
    expect(controls.disable).toHaveBeenCalledOnce();
    rerender(<SearchScreen {...props} ai={{ ...controls, state: { status: 'disabled' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check AI support' }));
    expect(controls.check).toHaveBeenCalledOnce();
  });
});
