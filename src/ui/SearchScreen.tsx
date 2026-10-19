import { useEffect, useRef, useState } from 'react';
import {
  limits,
  requireValid,
  sameScope,
  SearchRequestSchema,
  searchOutcomeSchemaFor,
  validate,
} from '../contracts';
import type {
  LinkVerifiers,
  ProviderId,
  SearchOutcome,
  SearchPort,
  SessionScope,
} from '../contracts';
import { availableDateDisclosure, calendarDateRange } from '../search';
import { Icon } from './Icon';
import { ResultTabs } from './ResultTabs';
import { DescriptionSummary } from './DescriptionSummary';
import { LocalAiSettings } from './LocalAiSettings';
import type { LocalAiControls } from '../description/on-device/types';
import { SetupScreen, providerLabels } from './SetupScreen';
import type { SetupScreenProps } from './SetupScreen';
import { Alert } from './components/alert';
import { Button } from './components/button';
import { Card, CardContent } from './components/card';
import { Input } from './components/input';

export interface SearchScreenProps extends SetupScreenProps {
  scopes: readonly SessionScope[];
  search: SearchPort | null;
  verifiers: LinkVerifiers;
  freshId(): string;
  timeZone: string;
  ai?: LocalAiControls;
}
type Phase = 'idle' | 'loading' | 'cancelling' | 'cancelled' | 'finished' | 'error';
interface View {
  key: string;
  phase: Phase;
  outcome?: SearchOutcome;
  error?: string;
}
const coverageText = {
  'unknown-reach': 'The provider’s search reach is unknown.',
  'result-limit': 'A result limit was reached.',
  'query-budget': 'The search call budget was reached.',
  'missing-evidence': 'Some excerpts are unavailable.',
  'unknown-dates': 'Undated conversations were excluded by the date filter.',
  'provider-failure': 'Some providers did not complete successfully.',
};

function outcomeStatus(outcome: SearchOutcome): string {
  if (outcome.state === 'cancelled') return 'Search cancelled.';

  if (outcome.state === 'failure') return 'Search failed. No providers completed successfully.';

  const matches = `${outcome.results.length} ${outcome.results.length === 1 ? 'match' : 'matches'}`;

  if (outcome.state === 'partial')
    return `Partial search: ${matches}. Results are incomplete because a provider failed.`;

  return outcome.results.length === 0
    ? 'No matches in the searched conversations.'
    : `${matches} found.`;
}

/** Capability-independent presentation; browser/session composition belongs to the entrypoint. */
export function SearchScreen(props: SearchScreenProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'keyword' | 'description'>('keyword');
  const [page, setPage] = useState<'search' | 'connections'>(
    props.scopes.length === 0 ? 'connections' : 'search',
  );
  const previousPage = useRef(page);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<ProviderId[]>(
    props.scopes.map((scope) => scope.provider),
  );
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const key = JSON.stringify(props.scopes);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [view, setView] = useState<View>({ key, phase: 'idle' });
  const [retryUntil, setRetryUntil] = useState(0);
  const cooldown = retryUntil > Date.now();
  const [retired, setRetired] = useState<Partial<Record<ProviderId, SessionScope>>>({});
  const active = useRef<{ controller: AbortController; key: string } | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const visible = view.key === key ? view : { key, phase: 'idle' as const };
  const outcome = visible.outcome;
  const busy = visible.phase === 'loading' || visible.phase === 'cancelling';
  const reconnectRequired = props.scopes.some((scope) => {
    const previous = retired[scope.provider];

    return (
      selected.includes(scope.provider) && previous !== undefined && sameScope(previous, scope)
    );
  });

  useEffect(() => {
    if (previousPage.current === page) return;

    previousPage.current = page;

    if (page === 'connections') document.getElementById('connections-heading')?.focus();
    else queryInput.current?.focus();
  }, [page]);

  useEffect(() => {
    setSelected(props.scopes.map((scope) => scope.provider));
    setRetired((previous) =>
      Object.fromEntries(
        props.scopes
          .filter((scope) => {
            const retiredScope = previous[scope.provider];

            return retiredScope !== undefined && sameScope(retiredScope, scope);
          })
          .map((scope) => [scope.provider, scope]),
      ),
    );

    return () => {
      active.current?.controller.abort();
      active.current = null;
    };
  }, [key, props.search]);

  useEffect(() => {
    const retryMs = retryUntil - Date.now();

    if (retryMs <= 0) return;

    const timer = setTimeout(() => setRetryUntil(0), retryMs);

    return () => clearTimeout(timer);
  }, [retryUntil]);

  function edit() {
    active.current?.controller.abort();
    active.current = null;
    setView({ key, phase: 'idle' });
  }

  async function submit() {
    if (reconnectRequired || cooldown) return;

    let request;

    try {
      if ((start.length === 0) !== (end.length === 0)) throw new Error('Both dates required.');

      request = requireValid(SearchRequestSchema, {
        requestId: props.freshId(),
        query: {
          text,
          mode,
          providers: selected,
          timeZone: props.timeZone,
          ...(start && end ? { dateRange: calendarDateRange(start, end, props.timeZone) } : {}),
        },
        scopes: props.scopes.filter((scope) => selected.includes(scope.provider)),
      });

      if (!props.search) throw new Error('No search connection.');
    } catch {
      setView({
        key,
        phase: 'error',
        error:
          'Enter a query, select connected providers, and supply both dates in increasing order or leave both empty.',
      });
      queryInput.current?.focus();

      return;
    }

    active.current?.controller.abort();
    const run = { controller: new AbortController(), key };
    active.current = run;
    setView({ key, phase: 'loading' });

    try {
      const raw = await props.search.search(request, { signal: run.controller.signal });

      if (active.current !== run || currentKey.current !== key) return;

      const result = validate(searchOutcomeSchemaFor(request, props.verifiers), raw);

      if (!result.ok) throw new Error('Invalid search outcome.');

      if (!run.controller.signal.aborted) {
        const retryMs = Math.max(
          0,
          ...result.value.outcomes.map((item) =>
            item.status === 'rate-limited'
              ? (item.retryAfterMs ?? 1000)
              : item.status === 'success' && item.rateLimit
                ? (item.rateLimit.retryAfterMs ?? 1000)
                : 0,
          ),
        );

        if (retryMs > 0) {
          const deadline = Date.now() + retryMs;
          setRetryUntil((previous) => Math.max(previous, deadline));
        }

        const terminal = result.value.outcomes.filter((item) =>
          ['login-expired', 'permission-needed', 'scope-changed'].includes(item.status),
        );

        if (terminal.length)
          setRetired((previous) => ({
            ...previous,
            ...Object.fromEntries(terminal.map((item) => [item.scope.provider, item.scope])),
          }));
      }

      setView(
        run.controller.signal.aborted
          ? { key, phase: 'cancelled' }
          : { key, phase: 'finished', outcome: result.value },
      );
    } catch {
      if (active.current === run && currentKey.current === key)
        setView(
          run.controller.signal.aborted
            ? { key, phase: 'cancelled' }
            : {
                key,
                phase: 'error',
                error: 'Search interrupted or returned an invalid response. Reconnect or retry.',
              },
        );
    } finally {
      if (active.current === run) {
        active.current = null;

        // Recover disappearing action focus, including rejected cancellation, without taking
        // focus from someone editing a field. The status heading remains mounted.
        if (
          document.activeElement === cancelButton.current ||
          document.activeElement === searchButton.current
        )
          statusHeading.current?.focus();
      }
    }
  }

  const status =
    visible.phase === 'loading'
      ? mode === 'description'
        ? 'Interpreting description and searching selected providers…'
        : 'Searching selected providers…'
      : visible.phase === 'cancelling'
        ? 'Cancelling search…'
        : visible.phase === 'cancelled'
          ? 'Search cancelled.'
          : (visible.error ??
            (outcome
              ? outcomeStatus(outcome)
              : cooldown
                ? 'Rate limited. Wait before searching again.'
                : 'Ready to search. Enter a query above.'));

  return (
    <main className="mx-auto flex min-h-svh min-w-0 max-w-xl flex-col bg-background text-sm">
      <header
        className={`flex flex-wrap items-center gap-3 px-4 pb-4 pt-5 ${page === 'connections' ? 'border-b' : ''}`}
      >
        <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Icon name="shelf" className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-medium tracking-tight">ThreadShelf</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">Your AI conversations, together.</p>
          </div>
        </div>
        {page === 'search' ? (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage('connections')}
            >
              Connect
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Search settings"
              aria-expanded={settingsOpen}
              aria-controls="search-settings"
              onClick={() => setSettingsOpen((previous) => !previous)}
            >
              <Icon name="settings" className="size-5" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label="Back to search"
            onClick={() => setPage('search')}
          >
            <Icon name="back" className="size-5" />
          </Button>
        )}
      </header>
      <section hidden={page !== 'connections'} aria-labelledby="connections-heading">
        <div className="space-y-6 px-6 py-8">
          <SetupScreen
            providers={props.providers}
            onConnect={props.onConnect}
            onInspect={props.onInspect}
            onDisconnect={props.onDisconnect}
            onCancel={props.onCancel}
          />
          {props.scopes.length > 0 && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setPage('search')}
            >
              Continue to search
            </Button>
          )}
        </div>
        <footer className="flex flex-wrap items-start justify-between gap-3 border-t bg-muted/60 px-6 py-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-2">
            <Icon name="lock" className="size-4 text-primary" />
            Secure, password-free sign in
          </p>
          <details className="max-w-full">
            <summary className="w-fit cursor-pointer rounded-sm text-primary">Need help?</summary>
            <p className="mt-3 max-w-xs leading-relaxed">
              Sign in on the provider site first, then connect here. ThreadShelf uses your existing
              browser session and never asks for your password. A background provider tab may open.
              ChatGPT supports personal accounts; Google AI Mode supports the default account.
              Connections stay available while you browse other tabs.
            </p>
          </details>
        </footer>
      </section>
      <div hidden={page !== 'search'} className="space-y-4 px-4">
        <form
          role="search"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="query" className="sr-only">
            Search conversations
          </label>
          <div className="flex min-h-12 items-center gap-1 rounded-xl border border-input bg-card px-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
            <Button
              ref={searchButton}
              type="submit"
              variant="ghost"
              size="icon"
              aria-label="Search"
              disabled={visible.phase === 'cancelling' || cooldown || reconnectRequired}
              aria-describedby={reconnectRequired ? 'reconnect-help' : undefined}
              className="shrink-0 text-primary"
            >
              <Icon name="search" className="size-5" />
            </Button>
            <Input
              id="query"
              type="search"
              ref={queryInput}
              maxLength={limits.query}
              value={text}
              autoComplete="off"
              placeholder="Search your conversations…"
              className="min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              onChange={(event) => {
                edit();
                setText(event.target.value);
              }}
              aria-describedby="query-help"
              aria-invalid={visible.phase === 'error'}
            />
            {text && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                className="shrink-0 text-muted-foreground"
                onClick={() => {
                  edit();
                  setText('');
                  queryInput.current?.focus();
                }}
              >
                <Icon name="close" className="size-4" />
              </Button>
            )}
          </div>
          <p id="query-help" className="sr-only">
            {mode === 'description'
              ? 'Description search uses bounded keyword/topic fallback matching.'
              : 'Search uses the provider’s native keyword matching.'}{' '}
            Results may cover only part of your history.
          </p>
          {reconnectRequired && (
            <p id="reconnect-help" className="mt-2 text-xs text-muted-foreground">
              Reconnect the selected providers to search them again.
            </p>
          )}
        </form>
        <section
          id="search-settings"
          hidden={!settingsOpen}
          aria-label="Search settings"
          className="space-y-4 rounded-xl border bg-muted/40 p-3"
        >
          <Card className="shadow-none">
            <CardContent className="space-y-4 p-3">
              <div className="space-y-2">
                <label htmlFor="mode" className="font-medium">
                  Search mode
                </label>
                <select
                  id="mode"
                  className="h-9 w-full rounded-md border border-input bg-background px-3"
                  value={mode}
                  onChange={(event) => {
                    edit();
                    setMode(event.target.value === 'description' ? 'description' : 'keyword');
                  }}
                  aria-describedby="mode-help"
                >
                  <option value="keyword">Keyword</option>
                  <option value="description">Description</option>
                </select>
                <p id="mode-help" className="text-xs text-muted-foreground">
                  {props.ai
                    ? 'Description uses optional local AI with a keyword/topic fallback.'
                    : 'Description uses keyword/topic fallback matching. Optional model support is unavailable.'}
                  {mode === 'description' &&
                    ' Searches read limited conversation excerpts to find matching subtopics. Google reads saved threads in a hidden frame within its connected page, without opening tabs.'}
                </p>
              </div>
              {props.ai && (
                <LocalAiSettings
                  controls={{
                    ...props.ai,
                    enable: () => {
                      edit();
                      props.ai?.enable();
                    },
                    disable: () => {
                      edit();
                      props.ai?.disable();
                    },
                    check: () => {
                      edit();
                      props.ai?.check();
                    },
                  }}
                />
              )}
              <fieldset className="space-y-1">
                <legend className="mb-1 font-medium">Providers to search</legend>
                {(['chatgpt', 'google-ai-mode'] as const).map((provider) => {
                  const connected = props.scopes.some((scope) => scope.provider === provider);

                  return (
                    <label key={provider} className="flex min-h-9 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={selected.includes(provider)}
                        onChange={(event) => {
                          edit();
                          setSelected(
                            event.target.checked
                              ? [...selected, provider]
                              : selected.filter((item) => item !== provider),
                          );
                        }}
                      />
                      <span>
                        {providerLabels[provider]}
                        {!connected && (
                          <span className="text-xs text-muted-foreground"> (connect first)</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="mb-2 font-medium">Available date (optional)</legend>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-3">
                  <label className="min-w-0 space-y-1">
                    From
                    <Input
                      type="date"
                      aria-label="From date"
                      value={start}
                      onChange={(event) => {
                        edit();
                        setStart(event.target.value);
                      }}
                    />
                  </label>
                  <label className="min-w-0 space-y-1">
                    Before (exclusive)
                    <Input
                      type="date"
                      aria-label="Before date (exclusive)"
                      value={end}
                      onChange={(event) => {
                        edit();
                        setEnd(event.target.value);
                      }}
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Timezone: {props.timeZone}. {availableDateDisclosure}
                </p>
              </fieldset>
            </CardContent>
          </Card>
        </section>
        <section aria-labelledby="search-status" className="space-y-3 pb-5">
          <ResultTabs
            outcome={outcome}
            verifiers={props.verifiers}
            timeZone={props.timeZone}
            onConnect={(provider) => {
              setPage('connections');
              props.onConnect(provider);
            }}
          >
            <h2
              id="search-status"
              ref={statusHeading}
              tabIndex={-1}
              className="sr-only focus:not-sr-only focus:font-semibold"
            >
              Search results
            </h2>
            <Alert
              role={visible.phase === 'error' ? 'alert' : 'status'}
              aria-live={visible.phase === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
              variant={visible.phase === 'error' ? 'destructive' : 'default'}
              className="border-0 bg-transparent p-0 text-sm leading-relaxed"
            >
              {status}
            </Alert>
            {outcome?.description && (
              <DescriptionSummary report={outcome.description} timeZone={props.timeZone} />
            )}
            {outcome && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Coverage: {outcome.coverage.extent}.{' '}
                {outcome.coverage.reasons.map((reason) => coverageText[reason]).join(' ')}
              </p>
            )}
            {busy && (
              <ul
                aria-label="Provider progress"
                className="mt-2 space-y-1 text-xs text-muted-foreground"
              >
                {selected.map((provider) => (
                  <li key={provider}>
                    {providerLabels[provider]}:{' '}
                    {visible.phase === 'cancelling' ? 'cancelling' : 'searching'}
                  </li>
                ))}
              </ul>
            )}
          </ResultTabs>
          {busy && (
            <Button
              ref={cancelButton}
              type="button"
              variant="outline"
              disabled={visible.phase === 'cancelling'}
              onClick={() => {
                setView({ key, phase: 'cancelling' });
                active.current?.controller.abort();
              }}
            >
              Cancel search
            </Button>
          )}
          {!reconnectRequired &&
            (visible.phase === 'error' ||
              visible.phase === 'cancelled' ||
              (outcome && outcome.state !== 'success')) && (
              <Button
                variant="outline"
                type="button"
                disabled={cooldown}
                onClick={() => {
                  void submit();
                }}
              >
                {cooldown ? 'Wait to retry' : 'Retry search'}
              </Button>
            )}
        </section>
      </div>
      <footer
        hidden={page !== 'search'}
        className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t bg-muted/60 px-4 py-3 text-xs text-muted-foreground"
      >
        <p>
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-primary" />
          Session only · No model uploads
        </p>
        <Button
          type="button"
          variant="ghost"
          className="min-h-8 gap-1 px-1 py-1 text-xs"
          aria-label="Refresh search"
          disabled={!outcome || busy || cooldown || reconnectRequired}
          onClick={() => {
            void submit();
          }}
        >
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </Button>
      </footer>
    </main>
  );
}
