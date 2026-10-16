import type { ProviderId } from '../contracts/primitives';
import { Button } from './components/button';
import { Card, CardContent, CardHeader } from './components/card';

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
  idle: 'No site selected.',
  connecting: 'Checking site access…',
  selected: 'Site selected. Account access is unverified until a search checks it.',
  disconnected: 'Selection cleared.',
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
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Connections</h2>
      <p className="text-xs text-muted-foreground">
        Connect a provider to use its signed-in browser session. If needed, ThreadShelf opens a
        background provider tab for the connection.
      </p>
      <p className="text-xs text-muted-foreground">
        Connections stay available while you browse other tabs. Closing or navigating the source
        page can require reconnecting. Account identity is checked around each search. ChatGPT
        supports personal accounts; Google supports the default account on www.google.com.
      </p>
      {props.providers.map((item) => (
        <section key={item.provider} aria-labelledby={`${item.provider}-label`}>
          <Card className="shadow-none">
            <CardHeader className="p-3 pb-2">
              <h3 className="font-semibold" id={`${item.provider}-label`}>
                {providerLabels[item.provider]}
              </h3>
              <p
                id={`${item.provider}-status`}
                tabIndex={-1}
                role="status"
                className="text-xs text-muted-foreground"
                aria-atomic="true"
              >
                {Object.hasOwn(statuses, item.status)
                  ? statuses[item.status]
                  : statuses.unavailable}
              </p>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 p-3 pt-1">
              <Button
                variant="outline"
                type="button"
                disabled={item.pending}
                onClick={() => action(item.provider, props.onConnect)}
              >
                Connect {providerLabels[item.provider]}
              </Button>
              {item.selected && (
                <>
                  <Button
                    variant="outline"
                    disabled={item.pending}
                    type="button"
                    onClick={() => action(item.provider, props.onInspect)}
                  >
                    Check selected site
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={item.pending}
                    type="button"
                    onClick={() => action(item.provider, props.onDisconnect)}
                  >
                    Clear selection
                  </Button>
                </>
              )}
              {item.pending && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => action(item.provider, props.onCancel)}
                >
                  Cancel
                </Button>
              )}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
