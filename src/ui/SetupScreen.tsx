import type { ProviderId } from '../contracts/primitives';

interface ProviderView {
  provider: ProviderId;
  status: string;
  pending: boolean;
  selected: boolean;
}
interface SetupScreenProps {
  providers: readonly ProviderView[];
  onConnect(provider: ProviderId): void;
  onInspect(provider: ProviderId): void;
  onDisconnect(provider: ProviderId): void;
  onCancel(provider: ProviderId): void;
}
const labels: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  'google-ai-mode': 'Google Search AI Mode',
};
const statuses: Record<string, string> = {
  idle: 'No site selected.',
  connecting: 'Checking site access…',
  selected: 'Site selected. Account access is unverified; conversation search is unavailable.',
  disconnected: 'Selection cleared.',
  'permission-needed': 'Site permission is required. Connect to request it.',
  unavailable: 'Site access is unavailable. Open the provider in the selected tab and try again.',
  'scope-changed': 'The selected context changed. Connect again.',
  timeout: 'The site check timed out. Connect again.',
  cancelled: 'Site check cancelled.',
  interrupted: 'Connection interrupted. Connect again to retry.',
  busy: 'A site check is already running.',
};

export function SetupScreen(props: SetupScreenProps) {
  return (
    <main>
      <p className="eyebrow">Development preview</p>
      <h1>ThreadShelf</h1>
      <p>Find past ChatGPT and Google Search AI Mode conversations.</p>
      <p>
        Open a provider in this window’s selected tab, then connect to allow access to that site.
      </p>
      <p className="status">Conversation search is not implemented yet.</p>
      {props.providers.map((item) => (
        <section key={item.provider} aria-labelledby={`${item.provider}-label`}>
          <h2 id={`${item.provider}-label`}>{labels[item.provider]}</h2>
          <p role="status">
            {Object.hasOwn(statuses, item.status) ? statuses[item.status] : statuses.unavailable}
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={item.pending}
              onClick={() => props.onConnect(item.provider)}
            >
              Connect {labels[item.provider]}
            </button>
            {item.selected && (
              <>
                <button type="button" onClick={() => props.onInspect(item.provider)}>
                  Check selected site
                </button>
                <button type="button" onClick={() => props.onDisconnect(item.provider)}>
                  Clear selection
                </button>
              </>
            )}
            {item.pending && (
              <button type="button" onClick={() => props.onCancel(item.provider)}>
                Cancel
              </button>
            )}
          </div>
        </section>
      ))}
    </main>
  );
}
