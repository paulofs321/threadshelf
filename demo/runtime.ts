import type { LinkVerifiers, ProviderPort } from '../src/contracts';
import { KeywordSearch } from '../src/search';
import { DescriptionSearch, SearchModes } from '../src/description';
import { demoCandidates, demoNow, demoScopes } from './data';

export type DemoScenario = 'ready' | 'google-unavailable' | 'slow' | 'empty';
export const demoVerifiers: LinkVerifiers = {
  chatgpt: () => false,
  'google-ai-mode': () => false,
};

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });

    if (signal.aborted) finish();
  });
}

/** Each composition owns its engines and memory; no Chrome, network, storage or model capability. */
export function createDemo(scenario: DemoScenario = 'ready') {
  const inventory = demoCandidates();
  const providers: ProviderPort[] = demoScopes.map((scope) => ({
    provider: scope.provider,
    inspectSession: async () => ({ status: 'ready', scope }),
    search: async (request, { signal }) => {
      await pause(scenario === 'slow' ? 3000 : 150, signal);
      const reply = { requestId: request.requestId, scope: request.scope };

      if (signal.aborted) return { ...reply, status: 'cancelled' };

      if (scenario === 'google-unavailable' && scope.provider === 'google-ai-mode')
        return { ...reply, status: 'unavailable' };

      const needle = request.query.text.toLowerCase();

      return {
        ...reply,
        status: 'success',
        candidates:
          scenario === 'empty'
            ? []
            : inventory.filter(
                (candidate) =>
                  candidate.scope.provider === scope.provider &&
                  candidate.evidence.some((evidence) =>
                    evidence.text.toLowerCase().includes(needle),
                  ),
              ),
        coverage: { extent: 'complete', reasons: [] },
      };
    },
  }));
  const keyword = new KeywordSearch({ providers, linkVerifiers: demoVerifiers });
  let serial = 0;
  const description = new DescriptionSearch({
    retrieval: keyword,
    linkVerifiers: demoVerifiers,
    now: () => demoNow,
    freshId: () => `fictional-topic-${++serial}`,
  });

  return {
    scenario,
    scopes: structuredClone(demoScopes),
    search: new SearchModes(keyword, description),
  };
}
