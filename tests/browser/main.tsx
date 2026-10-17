import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EvidenceIdSchema, requireValid, SessionScopeSchema } from '../../src/contracts';
import type { ProviderPort, SessionScope } from '../../src/contracts';
import { KeywordSearch } from '../../src/search';
import { SearchScreen } from '../../src/ui/SearchScreen';
import {
  chatCandidate,
  chatScope,
  googleCandidate,
  googleScope,
  linkVerifiers,
} from '../fixtures/contracts';
import '../../src/ui/styles.css';

// Handwritten synthetic composition. This entrypoint never enters production extension output.
function Smoke() {
  const [scopes, setScopes] = useState<SessionScope[]>([chatScope, googleScope]);
  const [engine] = useState(
    () =>
      new KeywordSearch({
        linkVerifiers,
        providers: (['chatgpt', 'google-ai-mode'] as const).map((provider): ProviderPort => ({
          provider,
          inspectSession: async () => ({ status: 'unavailable' }),
          search: async (request, { signal }) => {
            if (request.query.text === 'slow')
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );

            if (signal.aborted)
              return { requestId: request.requestId, scope: request.scope, status: 'cancelled' };

            if (request.query.text === 'expired' && provider === 'chatgpt')
              return {
                requestId: request.requestId,
                scope: request.scope,
                status: 'login-expired',
              };

            const candidate = provider === 'chatgpt' ? chatCandidate : googleCandidate;

            return {
              requestId: request.requestId,
              scope: request.scope,
              status: 'success',
              candidates: [
                {
                  ...candidate,
                  scope: request.scope,
                  ...(request.query.text === 'long excerpt'
                    ? {
                        evidence: [
                          {
                            id: requireValid(EvidenceIdSchema, 'fictional-long-snippet'),
                            source: 'native-snippet',
                            text: 'A fictional librarian travels between floating shelves.\n'.repeat(
                              20,
                            ),
                          },
                        ],
                      }
                    : {}),
                },
              ],
              coverage: { extent: 'unknown', reasons: ['unknown-reach'] },
            };
          },
        })),
      }),
  );

  return (
    <>
      <p className="p-4">Synthetic UI smoke — fictional conversations only.</p>
      <SearchScreen
        scopes={scopes}
        search={engine}
        verifiers={linkVerifiers}
        freshId={() => crypto.randomUUID()}
        timeZone="Europe/Zurich"
        providers={scopes.map((scope) => ({
          provider: scope.provider,
          status: 'selected',
          selected: true,
          pending: false,
        }))}
        onConnect={(provider) =>
          setScopes((previous) =>
            previous.map((scope) =>
              scope.provider === provider
                ? requireValid(SessionScopeSchema, { ...scope, generation: scope.generation + 1 })
                : scope,
            ),
          )
        }
        onInspect={() => {}}
        onDisconnect={(provider) =>
          setScopes((previous) => previous.filter((scope) => scope.provider !== provider))
        }
        onCancel={() => {}}
      />
    </>
  );
}

const root = document.getElementById('root');

if (!root) throw new Error('Missing synthetic smoke root.');

createRoot(root).render(<Smoke />);
