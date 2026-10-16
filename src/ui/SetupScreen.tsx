import type { ProviderId } from '../contracts/primitives';
import { Button } from './components/button';
import { Icon } from './Icon';

export interface ProviderView {
  provider: ProviderId;
  status: string;
  pending: boolean;
  selected: boolean;
}
export interface SetupScreenProps {
  providers: readonly ProviderView[];
  onConnect(provider: ProviderId): void;
  onInspect(provider: ProviderId): void;
  onDisconnect(provider: ProviderId): void;
  onCancel(provider: ProviderId): void;
}
export const providerLabels: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  'google-ai-mode': 'Google Search AI Mode',
};
const statuses: Record<string, string> = {
  idle: 'Not connected.',
  connecting: 'Connecting…',
  selected: 'Connected.',
  disconnected: 'Disconnected.',
  'permission-needed': 'Site permission is required. Connect to request it.',
  unavailable: 'Site access is unavailable. Sign in on the provider page, then connect again.',
  'scope-changed': 'The selected context changed. Connect again.',
  timeout: 'The site check timed out. Connect again.',
  cancelled: 'Site check cancelled.',
  interrupted:
    'Connection interrupted. Connect again to retry. After updating ThreadShelf, reload it in chrome://extensions.',
  busy: 'A site check is already running.',
};

export function SetupScreen(props: SetupScreenProps) {
  function action(provider: ProviderId, callback: (provider: ProviderId) => void) {
    document.getElementById(`${provider}-status`)?.focus();
    callback(provider);
  }

  return (
    <div className="space-y-6">
      <h2
        id="connections-heading"
        tabIndex={-1}
        className="text-2xl font-semibold leading-tight tracking-tight"
      >
        Welcome to ThreadShelf
      </h2>
      <p className="text-base leading-relaxed text-muted-foreground">
        Connect the sources you use to search and chat with AI so ThreadShelf can help you find and
        revisit past conversations.
      </p>
      <div className="flex flex-wrap gap-2" aria-label="Supported providers">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-[#eaf5f0] px-2.5 py-2 text-xs font-medium text-[#12816b]">
          <Icon name="chat" className="size-4" />
          ChatGPT
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-[#eef3fc] px-2.5 py-2 text-xs font-medium text-[#4468b9]">
          <span aria-hidden="true" className="font-bold">
            G
          </span>
          Google AI Mode
        </span>
      </div>
      <div className="space-y-4 pt-2">
        {props.providers.map((item) => {
          const connected = item.selected && !item.pending;

          return (
            <section key={item.provider} aria-labelledby={`${item.provider}-label`}>
              <h3 className="sr-only" id={`${item.provider}-label`}>
                {providerLabels[item.provider]}
              </h3>
              <p
                id={`${item.provider}-status`}
                tabIndex={-1}
                role="status"
                className={
                  connected
                    ? 'flex min-h-14 items-center justify-center gap-2 rounded-lg border border-primary/20 bg-accent px-3 py-3 text-sm font-medium text-primary'
                    : item.status === 'idle'
                      ? 'sr-only'
                      : 'mb-2 text-sm text-muted-foreground'
                }
                aria-atomic="true"
              >
                {connected ? (
                  <>
                    <Icon name="check" className="size-4 shrink-0" />
                    {providerLabels[item.provider]} is already connected.
                  </>
                ) : Object.hasOwn(statuses, item.status) ? (
                  statuses[item.status]
                ) : (
                  statuses.unavailable
                )}
              </p>
              {!connected && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={item.provider === 'chatgpt' ? 'default' : 'outline'}
                    type="button"
                    aria-label={`Connect ${providerLabels[item.provider]}`}
                    disabled={item.pending}
                    className="min-h-14 w-full gap-2 rounded-lg px-3 py-4 text-sm shadow-none"
                    onClick={() => action(item.provider, props.onConnect)}
                  >
                    {item.provider === 'chatgpt' ? (
                      <Icon name="chat" className="size-4" />
                    ) : (
                      <span aria-hidden="true" className="text-base font-bold text-[#4468b9]">
                        G
                      </span>
                    )}
                    Connect {providerLabels[item.provider]}
                  </Button>
                  {item.pending && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => action(item.provider, props.onCancel)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
              {connected && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded-sm">Connection options</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => action(item.provider, props.onInspect)}
                    >
                      Recheck connection
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => action(item.provider, props.onDisconnect)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </details>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
