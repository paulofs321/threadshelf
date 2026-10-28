// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessPanel } from '../../src/entrypoints/sidepanel/AccessPanel';
import type { AccessOperation, AccessRequest, FailureStatus } from '../../src/platform/protocol';
import { clientTimeoutMs, heartbeatIntervalMs } from '../../src/platform/protocol';
import { deferred, event } from '../platform/helpers';
import { CandidateSchema, SearchRequestSchema, requireValid } from '../../src/contracts';
import type { SearchCommand } from '../../src/platform/search-protocol';
import { chatCandidate } from '../fixtures/contracts';
import { fixture as localModelFixture } from '../description/on-device/helpers';

const chrome = vi.hoisted(() => ({
  permissions: { request: vi.fn() },
  runtime: { connect: vi.fn(), lastError: undefined },
  windows: { getCurrent: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: chrome }));

function connection() {
  const port = {
    postMessage: vi.fn<(input: AccessRequest | SearchCommand) => void>(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
  port.postMessage.mockImplementation((command) => {
    if (command.operation === 'verify-session')
      port.onMessage.emit({
        kind: 'reply',
        requestId: command.requestId,
        status: 'verified',
        session: 'authenticated',
        scope: command.scope,
      });
  });

  return port;
}

const ports: ReturnType<typeof connection>[] = [];

function chat() {
  return screen.getByRole('region', { name: 'ChatGPT' });
}

function google() {
  return screen.getByRole('region', { name: 'Google Search AI Mode' });
}

function connectButton(region = chat()) {
  return within(region).getByRole('button', { name: /^(?:Connect|Reconnect)/ });
}

function lastRequest(port = ports[0]): AccessOperation {
  const request = port?.postMessage.mock.calls.at(-1)?.[0];

  if (
    !request ||
    request.operation === 'cancel' ||
    request.operation === 'keyword-search' ||
    request.operation === 'description-retrieval' ||
    request.operation === 'cancel-search' ||
    request.operation === 'finish-description'
  )
    throw new Error('Expected synthetic access operation.');

  return request;
}

async function start(region = chat()) {
  await act(async () => {
    fireEvent.click(connectButton(region));
  });

  return lastRequest();
}

function replySelected(port = ports[0], generation = 1, partition = 'fiction-panel-partition') {
  if (!port) throw new Error('Expected synthetic connection.');

  const request = lastRequest(port);
  act(() => {
    port.onMessage.emit({
      kind: 'reply',
      requestId: request.requestId,
      status: 'connected',
      session: 'authenticated',
      scope: { kind: 'ephemeral', provider: request.provider, generation, partition },
    });
  });
}

async function select(region = chat(), generation = 1, partition = 'fiction-panel-partition') {
  await start(region);
  await act(async () => {
    replySelected(ports[0], generation, partition);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  chrome.permissions.request.mockResolvedValue(true);
  chrome.windows.getCurrent.mockResolvedValue({ id: 3, incognito: false });
  chrome.runtime.connect.mockImplementation(() => {
    const port = connection();
    ports.push(port);

    return port;
  });
});
afterEach(() => {
  cleanup();
  ports.splice(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('side-panel permission and operation flow with real AccessClient', () => {
  it('never treats an unverified document selection as Connected or exposes a search scope', async () => {
    render(<AccessPanel />);
    const request = await start();
    await act(async () =>
      ports[0]?.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: 'selected',
        session: 'unverified',
        scope: {
          kind: 'ephemeral',
          provider: 'chatgpt',
          partition: 'fiction-unverified',
          generation: 1,
        },
      }),
    );
    expect(within(chat()).getByRole('status').textContent).toContain('unverified');
    expect(screen.queryByRole('button', { name: 'Continue to search' })).toBeNull();
    expect(document.body.textContent).not.toContain('is already connected');
  });
  it('announces human sign-in and verification, permits cancellation beyond the short timeout, and preserves provider independence', async () => {
    vi.useFakeTimers();
    render(<AccessPanel />);
    const request = await start();
    await act(async () =>
      ports[0]?.onMessage.emit({
        kind: 'connection-progress',
        requestId: request.requestId,
        provider: 'chatgpt',
        status: 'waiting-for-sign-in',
      }),
    );
    expect(within(chat()).getByRole('status').textContent).toContain('5 minutes');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(clientTimeoutMs * 2);
    });
    expect(within(chat()).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await select(google(), 1, 'fiction-google');
    await act(async () =>
      ports[0]?.onMessage.emit({
        kind: 'connection-progress',
        requestId: request.requestId,
        provider: 'chatgpt',
        status: 'verifying-session',
      }),
    );
    expect(within(chat()).getByRole('status').textContent).toContain('Verifying');
    await act(async () => fireEvent.click(within(chat()).getByRole('button', { name: 'Cancel' })));
    expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    expect(within(google()).getByRole('status').textContent).toContain('is already connected');
  });
  it('clears local queries, filters, preferences, scopes, transport and optional AI from one action', async () => {
    render(<AccessPanel />);
    await select();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search settings' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fiction-private-query' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search mode' }), {
      target: { value: 'description' },
    });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } });
    expect(localStorage.getItem('threadshelf:preferences:v1')).toBe(
      '{"version":1,"mode":"description"}',
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Clear local data and preferences' })),
    );
    expect(localStorage.getItem('threadshelf:preferences:v1')).toBeNull();
    expect(ports[0]?.disconnect).toHaveBeenCalledOnce();
    expect(within(chat()).queryByText(/already connected/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Search settings' }));
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: 'Search mode' }) as HTMLSelectElement).value).toBe(
      'keyword',
    );
  });
  it('retains both provider connections and worker keepalive across connection/search page navigation', async () => {
    vi.useFakeTimers();
    render(<AccessPanel />);
    await select(chat());
    await select(google(), 1, 'fiction-google-partition');
    expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to search' }));
    expect(screen.getByRole('searchbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(within(chat()).getByRole('status').textContent).toBe('ChatGPT is already connected.');
    expect(within(google()).getByRole('status').textContent).toBe(
      'Google Search AI Mode is already connected.',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs);
    });
    expect(ports[0]?.postMessage).toHaveBeenLastCalledWith({ operation: 'keepalive' });
    expect(chrome.permissions.request).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.connect).toHaveBeenCalledOnce();
  });
  it.each(['valid', 'unsafe'] as const)(
    'composes real search/access clients, handles a %s reply, and clears stale results on invalidation',
    async (kind) => {
      render(<AccessPanel />);
      await select();
      fireEvent.click(screen.getByRole('button', { name: 'Continue to search' }));
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fictional library' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      });
      const command = ports[0]?.postMessage.mock.lastCall?.[0];

      if (command?.operation !== 'keyword-search') throw new Error('Expected search command');

      const request = requireValid(SearchRequestSchema, command.request);
      const scope = request.scopes[0];
      const candidate = requireValid(CandidateSchema, {
        ...chatCandidate,
        scope,
        conversationId: '11111111-1111-1111-1111-111111111111',
        originalUrl:
          kind === 'valid'
            ? 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'
            : 'https://evil.invalid/thread',
      });
      await act(async () => {
        ports[0]?.onMessage.emit({
          kind: 'search-result',
          outcome: {
            requestId: request.requestId,
            state: 'success',
            results: [candidate.id],
            outcomes: [
              {
                requestId: request.requestId,
                scope,
                status: 'success',
                candidates: [candidate],
                coverage: { extent: 'complete', reasons: [] },
              },
            ],
            coverage: { extent: 'complete', reasons: [] },
          },
        });
      });

      if (kind === 'unsafe') {
        expect(ports[0]?.disconnect).toHaveBeenCalledOnce();
        expect(document.getElementById('chatgpt-status')?.textContent).toContain('interrupted');
        expect(screen.queryByRole('article')).toBeNull();
      } else {
        expect(screen.getByRole('article')).toBeTruthy();
        expect(ports[0]?.disconnect).not.toHaveBeenCalled();
        await act(async () => {
          ports[0]?.onMessage.emit({
            kind: 'invalidated',
            provider: 'chatgpt',
            generation: 2,
            status: 'permission-needed',
          });
        });
        expect(screen.queryByRole('article')).toBeNull();
      }
    },
  );
  it('starts idle, exposes labeled native buttons/statuses, and requests no access on mount even in StrictMode', () => {
    render(
      <StrictMode>
        <AccessPanel />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'ThreadShelf' })).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Welcome to ThreadShelf' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(within(chat()).getByRole('status').textContent).toBe('Not connected.');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    connectButton().focus();
    expect(document.activeElement).toBe(connectButton());
  });
  it.each([
    { name: 'ChatGPT', provider: 'chatgpt', origin: 'https://chatgpt.com/*' },
    {
      name: 'Google Search AI Mode',
      provider: 'google-ai-mode',
      origin: 'https://www.google.com/*',
    },
  ])(
    'requests only $name permissions synchronously from the click, before opening the broker port',
    async ({ name, provider, origin }) => {
      const permission = deferred<boolean>();
      chrome.permissions.request.mockReturnValue(permission.promise);
      render(<AccessPanel />);
      const region = screen.getByRole('region', { name });
      fireEvent.click(connectButton(region));
      expect(chrome.permissions.request).toHaveBeenCalledWith({
        permissions: ['scripting'],
        origins: [origin],
      });
      expect(chrome.runtime.connect).not.toHaveBeenCalled();
      expect((connectButton(region) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        permission.resolve(true);
      });
      expect(chrome.windows.getCurrent).toHaveBeenCalledWith({ populate: false });
      expect(chrome.runtime.connect).toHaveBeenCalledWith({
        name: 'threadshelf:selected-tab:v1:window:3',
      });
      expect(lastRequest()).toMatchObject({ operation: 'connect', provider });
    },
  );
  it('handles denied permissions without opening a broker, then allows an explicit retry', async () => {
    chrome.permissions.request.mockResolvedValueOnce(false);
    render(<AccessPanel />);
    await act(async () => {
      fireEvent.click(connectButton());
    });
    expect(within(chat()).getByRole('status').textContent).toContain('permission is required');
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    expect((connectButton() as HTMLButtonElement).disabled).toBe(false);
    await select();
    expect(within(chat()).getByRole('status').textContent).toContain('is already connected.');
  });
  it.each(['request rejected', 'request threw', 'port creation threw'] as const)(
    'shows unavailable for %s without exposing browser error details',
    async (cause) => {
      if (cause === 'request rejected')
        chrome.permissions.request.mockRejectedValue(new Error('fiction-private-detail'));
      else if (cause === 'request threw')
        chrome.permissions.request.mockImplementation(() => {
          throw new Error('fiction-private-detail');
        });
      else
        chrome.runtime.connect.mockImplementation(() => {
          throw new Error('fiction-private-detail');
        });

      render(<AccessPanel />);
      await act(async () => {
        fireEvent.click(connectButton());
      });
      expect(within(chat()).getByRole('status').textContent).toContain('could not be verified');
      expect(document.body.textContent).not.toContain('fiction-private-detail');
      expect((connectButton() as HTMLButtonElement).disabled).toBe(false);
    },
  );
  it('prevents duplicate work while a permission prompt is pending and keeps cancellation blocked until it settles', async () => {
    const permission = deferred<boolean>();
    chrome.permissions.request.mockReturnValue(permission.promise);
    render(<AccessPanel />);
    fireEvent.click(connectButton());
    fireEvent.click(connectButton());
    expect(chrome.permissions.request).toHaveBeenCalledOnce();
    fireEvent.click(within(chat()).getByRole('button', { name: 'Cancel' }));
    expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    expect((connectButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      permission.resolve(true);
    });
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    expect((connectButton() as HTMLButtonElement).disabled).toBe(false);
    expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
  });
  it('does not revive a cancelled permission attempt when Chrome later rejects it', async () => {
    const failure = deferred<boolean>();
    chrome.permissions.request.mockReturnValue(failure.promise);
    render(<AccessPanel />);
    fireEvent.click(connectButton());
    fireEvent.click(within(chat()).getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      failure.reject(new Error('fiction-private-error'));
    });
    expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });
  it('shows already connected, rechecks the current scope, and disconnects without revoking permission', async () => {
    render(<AccessPanel />);
    await select();
    expect(within(chat()).getByRole('status').textContent).toContain('is already connected.');
    fireEvent.click(within(chat()).getByText('Connection options'));
    await act(async () => {
      fireEvent.click(within(chat()).getByRole('button', { name: 'Recheck connection' }));
    });
    expect(lastRequest()).toMatchObject({
      operation: 'inspect-context',
      scope: { kind: 'ephemeral', partition: 'fiction-panel-partition', generation: 1 },
    });
    await act(async () => {
      replySelected(ports[0], 2, 'fiction-fresh-partition');
    });
    fireEvent.click(within(chat()).getByText('Connection options'));
    await act(async () => {
      fireEvent.click(within(chat()).getByRole('button', { name: 'Disconnect' }));
    });
    const request = lastRequest();
    expect(request).toMatchObject({
      operation: 'disconnect',
      scope: { partition: 'fiction-fresh-partition', generation: 2 },
    });
    await act(async () => {
      ports[0]?.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: 'disconnected',
      });
    });
    expect(within(chat()).getByRole('status').textContent).toBe('Disconnected.');
    expect(within(chat()).queryByRole('button', { name: 'Recheck connection' })).toBeNull();
    expect(chrome.permissions.request).toHaveBeenCalledOnce();
  });
  it.each([
    'permission-needed',
    'unavailable',
    'scope-changed',
    'timeout',
    'cancelled',
    'interrupted',
    'busy',
  ] satisfies FailureStatus[])(
    'renders explicit terminal failure %s and removes loading/selection controls',
    async (status) => {
      render(<AccessPanel />);
      const request = await start();
      await act(async () => {
        ports[0]?.onMessage.emit({ kind: 'reply', requestId: request.requestId, status });
      });
      expect(within(chat()).queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(within(chat()).queryByRole('button', { name: 'Recheck connection' })).toBeNull();
      expect((connectButton() as HTMLButtonElement).disabled).toBe(false);
      expect(within(chat()).getByRole('status').textContent).not.toContain('Checking');
    },
  );
  it('cancel stops a sent request and delayed invalidation/selection cannot replace the cancelled status', async () => {
    render(<AccessPanel />);
    const request = await start();
    await act(async () => {
      fireEvent.click(within(chat()).getByRole('button', { name: 'Cancel' }));
    });
    expect(ports[0]?.postMessage).toHaveBeenLastCalledWith({
      operation: 'cancel',
      requestId: request.requestId,
    });
    await act(async () => {
      ports[0]?.onMessage.emit({
        kind: 'invalidated',
        provider: 'chatgpt',
        status: 'scope-changed',
        generation: 2,
      });
      ports[0]?.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: 'selected',
        session: 'unverified',
        scope: { kind: 'ephemeral', provider: 'chatgpt', generation: 1, partition: 'fiction-late' },
      });
    });
    expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    expect(within(chat()).queryByRole('button', { name: 'Recheck connection' })).toBeNull();
  });
  it('keeps provider selections independent and invalidates only the reported provider', async () => {
    render(<AccessPanel />);
    await select(chat());
    await select(google(), 1, 'fiction-google-partition');
    expect(chrome.runtime.connect).toHaveBeenCalledOnce();
    await act(async () => {
      ports[0]?.onMessage.emit({
        kind: 'invalidated',
        provider: 'chatgpt',
        status: 'permission-needed',
        generation: 2,
      });
    });
    expect(within(chat()).queryByRole('button', { name: 'Recheck connection' })).toBeNull();
    expect(within(google()).getByRole('status').textContent).toContain('is already connected.');
    expect(within(google()).queryByRole('button', { name: /^(?:Connect|Reconnect)/ })).toBeNull();
  });
  it('clears both provider selections on worker disconnect and opens a fresh port only on explicit reconnect', async () => {
    render(<AccessPanel />);
    await select(chat());
    await select(google(), 1, 'fiction-google-partition');
    await act(async () => {
      ports[0]?.onDisconnect.emit();
    });

    for (const region of [chat(), google()]) {
      expect(within(region).getByRole('status').textContent).toContain('interrupted');
      expect(within(region).queryByRole('button', { name: 'Recheck connection' })).toBeNull();
    }

    expect(chrome.runtime.connect).toHaveBeenCalledOnce();
    await start();
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
  });
  it('times out a silent worker in the panel and discards a later success', async () => {
    vi.useFakeTimers();
    render(<AccessPanel />);
    const request = await start();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(clientTimeoutMs);
    });
    expect(within(chat()).getByRole('status').textContent).toContain('timed out');
    await act(async () => {
      ports[0]?.onMessage.emit({
        kind: 'reply',
        requestId: request.requestId,
        status: 'selected',
        session: 'unverified',
        scope: { kind: 'ephemeral', provider: 'chatgpt', generation: 1, partition: 'fiction-late' },
      });
    });
    expect(within(chat()).getByRole('status').textContent).toContain('timed out');
    // Flush DOM selection events and Radix mount frames, retaining any leaked request timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersToNextFrame();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('unmount aborts pending operations, disconnects the port, and removes client listeners/timers', async () => {
    vi.useFakeTimers();
    const rendered = render(<AccessPanel />);
    await start();
    rendered.unmount();
    expect(ports[0]?.disconnect).toHaveBeenCalledOnce();
    expect(ports[0]?.onMessage.size()).toBe(0);
    expect(ports[0]?.onDisconnect.size()).toBe(0);
    // Flush DOM selection events and Radix mount frames, retaining any leaked request timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersToNextFrame();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('unmount during a Chrome permission prompt prevents all later access', async () => {
    const permission = deferred<boolean>();
    chrome.permissions.request.mockReturnValue(permission.promise);
    const rendered = render(<AccessPanel />);
    fireEvent.click(connectButton());
    rendered.unmount();
    await act(async () => {
      permission.resolve(true);
    });
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });
  it('binds concurrent provider actions to one port for the calling panel window', async () => {
    const owner = deferred<unknown>();
    chrome.windows.getCurrent.mockReturnValue(owner.promise);
    render(<AccessPanel />);
    await act(async () => {
      fireEvent.click(connectButton(chat()));
      fireEvent.click(connectButton(google()));
    });
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    await act(async () => {
      owner.resolve({ id: 4, incognito: false });
    });
    expect(chrome.runtime.connect).toHaveBeenCalledOnce();
    expect(chrome.runtime.connect).toHaveBeenCalledWith({
      name: 'threadshelf:selected-tab:v1:window:4',
    });
    expect(ports[0]?.postMessage.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ operation: 'connect', provider: 'chatgpt' }),
      expect.objectContaining({ operation: 'connect', provider: 'google-ai-mode' }),
    ]);
  });
  it.each(['invalid', 'rejected', 'timeout'] as const)(
    'fails without opening a port when the panel window lookup is %s',
    async (cause) => {
      vi.useFakeTimers();

      if (cause === 'invalid')
        chrome.windows.getCurrent.mockResolvedValue({ id: -1, incognito: false });
      else if (cause === 'rejected')
        chrome.windows.getCurrent.mockRejectedValue(new Error('fiction-private-window-error'));
      else chrome.windows.getCurrent.mockReturnValue(new Promise(() => {}));

      render(<AccessPanel />);
      await act(async () => {
        fireEvent.click(connectButton());
      });

      if (cause === 'timeout') {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(clientTimeoutMs);
        });
      }

      expect(within(chat()).getByRole('status').textContent).toContain('interrupted');
      expect(chrome.runtime.connect).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('fiction-private-window-error');
      // Flush DOM selection events and Radix mount frames, retaining any leaked request timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersToNextFrame();
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['cancel', 'unmount'] as const)(
    'prevents late window metadata from opening a broker after %s',
    async (stop) => {
      vi.useFakeTimers();
      const owner = deferred<unknown>();
      chrome.windows.getCurrent.mockReturnValue(owner.promise);
      const rendered = render(<AccessPanel />);
      await act(async () => {
        fireEvent.click(connectButton());
      });

      if (stop === 'unmount') rendered.unmount();
      else fireEvent.click(within(chat()).getByRole('button', { name: 'Cancel' }));

      await act(async () => {
        owner.resolve({ id: 3, incognito: false });
      });
      expect(chrome.runtime.connect).not.toHaveBeenCalled();
      // Flush DOM selection events and Radix mount frames, retaining any leaked request timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersToNextFrame();
      });
      expect(vi.getTimerCount()).toBe(0);

      if (stop === 'cancel')
        expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    },
  );
});

it('composes description retrieval locally over real validated keyword messages and clears it on invalidation', async () => {
  render(<AccessPanel />);
  await select();
  const port = ports[0];

  if (!port) throw new Error('Missing synthetic connection');

  port.postMessage.mockImplementation((command) => {
    if (command.operation === 'verify-session') {
      port.onMessage.emit({
        kind: 'reply',
        requestId: command.requestId,
        status: 'verified',
        session: 'authenticated',
        scope: command.scope,
      });

      return;
    }

    if (command.operation !== 'keyword-search' && command.operation !== 'description-retrieval')
      return;

    const scope = command.request.scopes[0];
    const candidate = requireValid(CandidateSchema, {
      ...chatCandidate,
      scope,
      conversationId: '11111111-1111-1111-1111-111111111111',
      originalUrl: 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111',
    });
    port.onMessage.emit({
      kind: 'search-result',
      outcome: {
        requestId: command.request.requestId,
        state: 'success',
        results: [candidate.id],
        outcomes: [
          {
            requestId: command.request.requestId,
            scope,
            status: 'success',
            candidates: [candidate],
            coverage: { extent: 'complete', reasons: [] },
          },
        ],
        coverage: { extent: 'complete', reasons: [] },
      },
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Search settings' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Search mode' }), {
    target: { value: 'description' },
  });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'floating library' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  });
  expect(screen.getByText('Literal keyword fallback')).toBeTruthy();
  expect(screen.getByRole('article')).toBeTruthy();
  const commands = port.postMessage.mock.calls.flatMap(([command]) =>
    command.operation === 'description-retrieval' ? [command] : [],
  );
  expect(commands).toHaveLength(2);
  expect(new Set(commands.map((command) => command.request.requestId)).size).toBe(2);
  expect(commands.every((command) => command.request.query.mode === 'keyword')).toBe(true);
  await act(async () =>
    port.onMessage.emit({
      kind: 'invalidated',
      provider: 'chatgpt',
      generation: 2,
      status: 'scope-changed',
    }),
  );
  expect(screen.queryByRole('article')).toBeNull();
});

it('enables optional local inference only after a user action and clears sessions on disable', async () => {
  const f = localModelFixture();
  vi.stubGlobal('LanguageModel', f.factory);
  render(<AccessPanel />);
  await select();
  const port = ports[0];

  if (!port) throw new Error('Fixture port');

  port.postMessage.mockImplementation((command) => {
    if (command.operation === 'verify-session') {
      port.onMessage.emit({
        kind: 'reply',
        requestId: command.requestId,
        status: 'verified',
        session: 'authenticated',
        scope: command.scope,
      });

      return;
    }

    if (command.operation !== 'keyword-search' && command.operation !== 'description-retrieval')
      return;

    const scope = command.request.scopes[0];
    const item = requireValid(CandidateSchema, {
      ...chatCandidate,
      scope,
      conversationId: '11111111-1111-1111-1111-111111111111',
      originalUrl: 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111',
    });
    port.onMessage.emit({
      kind: 'search-result',
      outcome: {
        requestId: command.request.requestId,
        state: 'success',
        results: [item.id],
        outcomes: [
          {
            requestId: command.request.requestId,
            scope,
            status: 'success',
            candidates: [item],
            coverage: { extent: 'complete', reasons: [] },
          },
        ],
        coverage: { extent: 'complete', reasons: [] },
      },
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Search settings' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check AI support' })));
  expect(f.factory.create).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable local AI' })));
  expect(f.factory.create).toHaveBeenCalledOnce();
  f.session.prompt
    .mockResolvedValueOnce(JSON.stringify({ topics: ['library'], keywords: [] }))
    .mockResolvedValueOnce(
      JSON.stringify({
        selections: [
          {
            candidateId: chatCandidate.id,
            score: 0.9,
            evidenceIds: [chatCandidate.evidence[0]?.id],
          },
        ],
      }),
    );
  fireEvent.change(screen.getByRole('combobox', { name: 'Search mode' }), {
    target: { value: 'description' },
  });
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'Where did we talk about floating libraries?' },
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Search$/ })));
  expect(screen.getByText('Model-assisted matching with verified evidence')).toBeTruthy();
  expect(f.session.prompt).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disable local AI' })));
  expect(f.base.destroy).toHaveBeenCalledOnce();
  expect(screen.queryByRole('article')).toBeNull();
});
