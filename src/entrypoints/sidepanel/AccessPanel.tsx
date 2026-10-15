import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ProviderId } from '../../contracts/primitives';
import type { SessionScope } from '../../contracts/session';
import { AccessClient } from '../../platform/client';
import { panelPortName } from '../../platform/protocol';
import { currentPanelWindow } from '../../platform/panel-window';
import type { AccessEvent, AccessReply } from '../../platform/protocol';
import { providerPermission } from '../../platform/policy';
import { SetupScreen } from '../../ui/SetupScreen';

interface ProviderState {
  status: AccessReply['status'] | 'idle' | 'connecting';
  pending: boolean;
  scope?: SessionScope;
}
const initialState: Record<ProviderId, ProviderState> = {
  chatgpt: { status: 'idle', pending: false },
  'google-ai-mode': { status: 'idle', pending: false },
};

export function AccessPanel() {
  const [states, setStates] = useState(initialState);
  const client = useRef<AccessClient | null>(null);
  const active = useRef(new Map<ProviderId, AbortController>());
  const mounted = useRef(false);

  function update(provider: ProviderId, state: ProviderState) {
    if (mounted.current) setStates((previous) => ({ ...previous, [provider]: state }));
  }

  async function getClient(signal: AbortSignal): Promise<AccessClient | null> {
    if (!client.current || client.current.isClosed) {
      const windowId = await currentPanelWindow(signal);
      if (windowId === null || signal.aborted) return null;
      // Concurrent provider actions may have created the same panel's client while we awaited.
      if (client.current && !client.current.isClosed) return client.current;
      const connection = browser.runtime.connect({ name: panelPortName(windowId) });
      client.current = new AccessClient(connection, () => crypto.randomUUID());
      client.current.subscribe((event: AccessEvent) => {
        // Interruption is published inside the port callback; consume Chrome's error there.
        // Keeping this on the client's subscription lets close remove every port listener.
        if (event.status === 'interrupted') void browser.runtime.lastError;
        if (mounted.current)
          setStates((previous) => ({
            ...previous,
            [event.provider]: {
              status:
                event.status === 'scope-changed' && previous[event.provider].status === 'cancelled'
                  ? 'cancelled'
                  : event.status,
              pending: previous[event.provider].pending,
            },
          }));
      });
    }
    return client.current;
  }

  useEffect(() => {
    mounted.current = true;
    const operations = active.current;
    return () => {
      mounted.current = false;
      for (const controller of operations.values()) controller.abort();
      operations.clear();
      client.current?.close();
      client.current = null;
    };
  }, []);

  async function perform(provider: ProviderId, operation: 'connect' | 'inspect' | 'disconnect') {
    if (active.current.has(provider)) return;
    const scope = states[provider].scope;
    if (operation !== 'connect' && !scope) return;
    const controller = new AbortController();
    active.current.set(provider, controller);
    update(provider, { status: 'connecting', pending: true });
    try {
      // This call happens synchronously in the click handler, before any await loses the gesture.
      if (operation === 'connect') {
        const granted = await browser.permissions.request(providerPermission(provider));
        if (controller.signal.aborted) return;
        if (!granted) {
          update(provider, { status: 'permission-needed', pending: false });
          return;
        }
      }
      if (controller.signal.aborted) return;
      const access = await getClient(controller.signal);
      if (controller.signal.aborted) return;
      if (!access) {
        update(provider, { status: 'interrupted', pending: false });
        return;
      }
      const reply =
        operation === 'connect'
          ? await access.connect(provider, controller.signal)
          : scope && operation === 'inspect'
            ? await access.inspect(provider, scope, controller.signal)
            : scope
              ? await access.disconnectSelection(provider, scope, controller.signal)
              : null;
      if (!reply || controller.signal.aborted) return;
      update(
        provider,
        reply.status === 'selected'
          ? { status: reply.status, pending: false, scope: reply.scope }
          : { status: reply.status, pending: false },
      );
    } catch {
      if (!controller.signal.aborted) update(provider, { status: 'unavailable', pending: false });
    } finally {
      if (active.current.get(provider) === controller) {
        active.current.delete(provider);
        if (mounted.current)
          setStates((previous) => ({
            ...previous,
            [provider]: { ...previous[provider], pending: false },
          }));
      }
    }
  }

  function cancel(provider: ProviderId) {
    active.current.get(provider)?.abort();
    update(provider, { status: 'cancelled', pending: true });
    // Keep the action blocked until a pending Chrome permission prompt actually settles.
  }

  return (
    <SetupScreen
      providers={(['chatgpt', 'google-ai-mode'] as const).map((provider) => ({
        provider,
        status: states[provider].status,
        pending: states[provider].pending,
        selected: states[provider].scope !== undefined,
      }))}
      onConnect={(provider) => {
        void perform(provider, 'connect');
      }}
      onInspect={(provider) => {
        void perform(provider, 'inspect');
      }}
      onDisconnect={(provider) => {
        void perform(provider, 'disconnect');
      }}
      onCancel={cancel}
    />
  );
}
