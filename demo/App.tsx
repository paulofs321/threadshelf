import { useState } from 'react';
import { SearchScreen } from '../src/ui/SearchScreen';
import { createDemo, demoVerifiers } from './runtime';
import type { DemoScenario } from './runtime';
import './styles.css';

export function DemoApp() {
  const [runtime, setRuntime] = useState(() => createDemo());

  return (
    <div className="demo-shell">
      <aside className="demo-guide" aria-label="Fictional demo guide">
        <h2>Try ThreadShelf with a little fiction.</h2>
        <p>Search seven invented conversations. No accounts, credentials or extension needed.</p>
        <p>
          Start with <strong>floating library</strong>. Open Search settings to try Description
          mode, provider filters or dates.
        </p>
        <details>
          <summary>Examples and matching limits</summary>
          <ul>
            <li>Where did I discuss login security?</li>
            <li>Where did I compare deployment options for my portfolio?</li>
            <li>Find conversations about database performance and slow SQL queries</li>
            <li>Which sessions did I discuss authentication last month?</li>
          </ul>
          <p className="mt-3">
            Descriptions use the same literal keyword fallback as the extension. No AI model runs
            here. The demo clock is fixed to October 28, 2026; “last month” means September, in
            Europe/Zurich.
          </p>
        </details>
        <label htmlFor="simulation">Simulated provider behavior</label>
        <select
          id="simulation"
          value={runtime.scenario}
          onChange={(event) => setRuntime(createDemo(event.target.value as DemoScenario))}
        >
          <option value="ready">Both fictional sources available</option>
          <option value="google-unavailable">Google unavailable (partial results)</option>
          <option value="slow">Slow search (try Cancel)</option>
          <option value="empty">No matches</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Changing the simulation resets the panel. All results and status labels below are
          simulated. Original navigation is disabled; nothing is saved.
        </p>
      </aside>
      <div className="demo-panel">
        <p className="demo-notice" role="note">
          Fictional demo · no live provider connection
        </p>
        <SearchScreen
          key={runtime.scenario}
          environment="demo"
          scopes={runtime.scopes}
          search={runtime.search}
          verifiers={demoVerifiers}
          freshId={() => crypto.randomUUID()}
          timeZone="Europe/Zurich"
          providers={[]}
          onConnect={() => {}}
          onInspect={() => {}}
          onDisconnect={() => {}}
          onCancel={() => {}}
        />
      </div>
    </div>
  );
}
