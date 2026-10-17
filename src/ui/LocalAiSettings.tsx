import type { LocalAiControls } from '../description/on-device/types';
import { Button } from './components/button';

const messages = {
  checking: 'Checking local AI support…',
  available:
    'Local AI is available. Enable it to understand descriptions and rank matching evidence.',
  downloadable: 'Chrome needs to download its local model before AI search can run.',
  starting: 'Preparing local AI…',
  downloading: 'Downloading the local AI model…',
  ready: 'Local AI enabled. Description search uses AI interpretation and ranking.',
  running: 'Local AI is interpreting or ranking this search…',
  unavailable:
    'Local AI is unavailable on this device or Chrome configuration. Keyword/topic fallback remains available.',
  error:
    'Local AI could not start. Keyword/topic fallback remains available. Check support to retry.',
  disabled: 'Local AI is off. Description search uses keyword/topic fallback.',
};

export function LocalAiSettings({ controls }: { controls: LocalAiControls }) {
  const { state } = controls;
  const active = ['starting', 'downloading', 'ready', 'running'].includes(state.status);

  return (
    <section aria-label="Local AI" className="space-y-2 rounded-lg border p-3 text-xs">
      <h3 className="font-medium">AI description search</h3>
      <p>Describe any topic you remember.</p>
      <p>
        Runs on this device. Your query and retrieved excerpts stay local. Chrome may download a
        model; availability depends on your device. English descriptions are supported.
      </p>
      <p role="status" aria-live="polite">
        {messages[state.status]}
      </p>
      {state.status === 'downloading' && (
        <progress
          aria-label="Local AI model download"
          max={1}
          value={state.progress ?? 0}
          className="w-full"
        />
      )}
      {active ? (
        <Button type="button" size="sm" variant="outline" onClick={controls.disable}>
          {state.status === 'starting' || state.status === 'downloading'
            ? 'Cancel model preparation'
            : 'Disable local AI'}
        </Button>
      ) : state.status === 'available' || state.status === 'downloadable' ? (
        <Button type="button" size="sm" onClick={controls.enable}>
          {state.status === 'downloadable' ? 'Download and enable local AI' : 'Enable local AI'}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.status === 'checking'}
          onClick={controls.check}
        >
          Check AI support
        </Button>
      )}
    </section>
  );
}
