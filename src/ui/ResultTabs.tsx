import { useState } from 'react';
import type { ReactNode } from 'react';
import type { LinkVerifiers, ProviderId, SearchOutcome } from '../contracts';
import { ResultCard } from './ResultCard';
import { providerLabels } from './SetupScreen';
import { Alert } from './components/alert';
import { Button } from './components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/tabs';

const failureText = {
  'login-expired': 'Login expired. Sign in on the provider site, then reconnect.',
  'permission-needed': 'Site permission is required. Reconnect to request access.',
  unavailable: 'Provider unavailable. Open the supported provider page and try again.',
  'schema-changed': 'Provider response changed. Search is unavailable until support is updated.',
  'rate-limited': 'Rate limited. Wait before retrying.',
  timeout: 'Search timed out. You can retry.',
  cancelled: 'Search cancelled.',
  'scope-changed': 'Account or selected context changed. Reconnect before searching.',
  interrupted: 'Connection interrupted. Reconnect to retry.',
};
const sources = [
  { value: 'all', label: 'All sources' },
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'google-ai-mode', label: 'Google AI Mode' },
] as const;

export function ResultTabs({
  outcome,
  verifiers,
  timeZone,
  onConnect,
  children,
}: {
  outcome: SearchOutcome | undefined;
  verifiers: LinkVerifiers;
  timeZone: string;
  onConnect(provider: ProviderId): void;
  children: ReactNode;
}) {
  const [selectedSort, setSort] = useState<string>();
  const sort =
    selectedSort === 'relevance' && !outcome?.description
      ? 'recent'
      : (selectedSort ?? (outcome?.description ? 'relevance' : 'recent'));
  const candidates =
    outcome?.outcomes.flatMap((item) => (item.status === 'success' ? item.candidates : [])) ?? [];
  const ordered =
    outcome?.results.flatMap((id) => candidates.filter((candidate) => candidate.id === id)) ?? [];

  if (sort === 'recent')
    ordered.sort((a, b) => {
      if (!a.date) return b.date ? 1 : 0;

      if (!b.date) return -1;

      return b.date.at.localeCompare(a.date.at);
    });

  return (
    <Tabs defaultValue="all" className="min-w-0 space-y-4">
      <TabsList aria-label="Conversation sources">
        {sources.map((source) => {
          const matches = ordered.filter(
            (candidate) => source.value === 'all' || candidate.scope.provider === source.value,
          );
          const failed = outcome?.outcomes.some(
            (item) => source.value === item.scope.provider && item.status !== 'success',
          );

          return (
            <TabsTrigger key={source.value} value={source.value} className="gap-1 text-xs">
              <span>{source.label}</span>
              {outcome && <span className="text-muted-foreground">{matches.length}</span>}
              {failed && (
                <span className="text-destructive">
                  <span aria-hidden="true">!</span>
                  <span className="sr-only"> failed</span>
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {outcome && (
          <label className="shrink-0 text-xs text-muted-foreground">
            <span className="sr-only">Sort results</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="max-w-28 bg-transparent py-1"
            >
              <option value="provider">Provider order</option>
              {outcome?.description && <option value="relevance">Relevance</option>}
              <option value="recent">Most recent date</option>
            </select>
          </label>
        )}
      </div>
      {sources.map((source) => {
        const matches = ordered.filter(
          (candidate) => source.value === 'all' || candidate.scope.provider === source.value,
        );
        const outcomes =
          outcome?.outcomes.filter(
            (item) => source.value === 'all' || item.scope.provider === source.value,
          ) ?? [];

        return (
          <TabsContent key={source.value} value={source.value} className="space-y-3">
            {outcomes.map(
              (item) =>
                item.status !== 'success' && (
                  <Alert key={item.scope.provider} role="note" variant="destructive">
                    <p className="font-semibold">{providerLabels[item.scope.provider]}</p>
                    <p>
                      {failureText[item.status]}
                      {item.status === 'rate-limited' && item.retryAfterMs !== undefined
                        ? ` Retry after ${Math.ceil(item.retryAfterMs / 1000)} seconds.`
                        : ''}
                    </p>
                    {[
                      'login-expired',
                      'permission-needed',
                      'scope-changed',
                      'interrupted',
                    ].includes(item.status) && (
                      <Button
                        variant="outline"
                        type="button"
                        className="mt-2"
                        onClick={() => onConnect(item.scope.provider)}
                      >
                        Reconnect {providerLabels[item.scope.provider]}
                      </Button>
                    )}
                  </Alert>
                ),
            )}
            {outcomes.map(
              (item) =>
                item.status === 'success' &&
                item.rateLimit && (
                  <Alert key={item.scope.provider} role="note">
                    <p className="font-semibold">{providerLabels[item.scope.provider]}</p>
                    <p>
                      Rate limited. Earlier matches are retained. Wait before retrying.
                      {item.rateLimit.retryAfterMs !== undefined
                        ? ` Retry after ${Math.ceil(item.rateLimit.retryAfterMs / 1000)} seconds.`
                        : ''}
                    </p>
                  </Alert>
                ),
            )}
            {matches.map((candidate) => (
              <ResultCard
                key={candidate.id}
                candidate={candidate}
                verifiers={verifiers}
                timeZone={timeZone}
                selection={outcome?.description?.ranking.selections.find(
                  (item) => item.candidateId === candidate.id,
                )}
              />
            ))}
            {!outcome && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Search your saved conversations to get started.
              </p>
            )}
            {outcome && source.value !== 'all' && outcomes.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                This provider was not included in this search.
              </p>
            )}
            {outcomes.some((item) => item.status === 'success') && matches.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No matching conversations in this source.
              </p>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
