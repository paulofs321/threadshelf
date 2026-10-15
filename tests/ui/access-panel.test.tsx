// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessPanel } from '../../src/entrypoints/sidepanel/AccessPanel';
import type { AccessOperation, AccessRequest, FailureStatus } from '../../src/platform/protocol';
import { clientTimeoutMs } from '../../src/platform/protocol';
import { deferred, event } from '../platform/helpers';

const chrome = vi.hoisted(() => ({
  permissions: { request: vi.fn() },
  runtime: { connect: vi.fn(), lastError: undefined },
  windows: { getCurrent: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: chrome }));

function connection() {
  return {
    postMessage: vi.fn<(input: AccessRequest) => void>(),
    disconnect: vi.fn(),
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
  };
}
const ports: ReturnType<typeof connection>[] = [];
function chat() {
  return screen.getByRole('region', { name: 'ChatGPT' });
}
function google() {
  return screen.getByRole('region', { name: 'Google Search AI Mode' });
}
function connectButton(region = chat()) {
  return within(region).getByRole('button', { name: /^Connect/ });
}
function lastRequest(port = ports[0]): AccessOperation {
  const request = port?.postMessage.mock.calls.at(-1)?.[0];
  if (!request || request.operation === 'cancel')
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
      status: 'selected',
      session: 'unverified',
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
});

describe('side-panel permission and operation flow with real AccessClient', () => {
  it('starts idle, exposes labeled native buttons/statuses, and requests no access on mount even in StrictMode', () => {
    render(
      <StrictMode>
        <AccessPanel />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'ThreadShelf' })).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(within(chat()).getByRole('status').textContent).toBe('No site selected.');
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
    expect(within(chat()).getByRole('status').textContent).toContain(
      'Account access is unverified',
    );
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
      expect(within(chat()).getByRole('status').textContent).toContain('unavailable');
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
  it('renders selected as unverified, checks the current scope, and clears without silently revoking permission', async () => {
    render(<AccessPanel />);
    await select();
    expect(within(chat()).getByRole('status').textContent).toContain('search is unavailable');
    await act(async () => {
      fireEvent.click(within(chat()).getByRole('button', { name: 'Check selected site' }));
    });
    expect(lastRequest()).toMatchObject({
      operation: 'inspect-context',
      scope: { kind: 'ephemeral', partition: 'fiction-panel-partition', generation: 1 },
    });
    await act(async () => {
      replySelected(ports[0], 2, 'fiction-fresh-partition');
    });
    await act(async () => {
      fireEvent.click(within(chat()).getByRole('button', { name: 'Clear selection' }));
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
    expect(within(chat()).getByRole('status').textContent).toBe('Selection cleared.');
    expect(within(chat()).queryByRole('button', { name: 'Check selected site' })).toBeNull();
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
      expect(within(chat()).queryByRole('button', { name: 'Check selected site' })).toBeNull();
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
    expect(within(chat()).queryByRole('button', { name: 'Check selected site' })).toBeNull();
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
    expect(within(chat()).queryByRole('button', { name: 'Check selected site' })).toBeNull();
    expect(within(google()).getByRole('button', { name: 'Check selected site' })).toBeTruthy();
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
      expect(within(region).queryByRole('button', { name: 'Check selected site' })).toBeNull();
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
      expect(vi.getTimerCount()).toBe(0);
      if (stop === 'cancel')
        expect(within(chat()).getByRole('status').textContent).toContain('cancelled');
    },
  );
});
