import { CandidateSchema, requireValid, SessionScopeSchema } from '../src/contracts';
import type { Candidate } from '../src/contracts';

export const demoNow = '2026-10-28T12:00:00.000Z';
export const demoScopes = (['chatgpt', 'google-ai-mode'] as const).map((provider) =>
  requireValid(SessionScopeSchema, {
    kind: 'ephemeral',
    provider,
    partition: `fictional-demo-${provider}`,
    generation: 1,
  }),
);

const stories = [
  [
    'chatgpt',
    'library',
    'Floating library login security',
    'Compare login security for the floating library: short-lived sessions and separate librarian roles.',
    '2026-10-21T10:00:00.000Z',
  ],
  [
    'google-ai-mode',
    'library-routes',
    'Routes between floating libraries',
    'The floating library travels between islands. Keep a paper map and pack books in waterproof crates.',
    '2026-10-22T10:00:00.000Z',
  ],
  [
    'google-ai-mode',
    'portfolio',
    'Deploying a lunar portfolio',
    'Portfolio deployment compares a static site with a small hosted application. Choose static hosting for the lunar illustrator’s portfolio.',
    '2026-09-22T10:00:00.000Z',
  ],
  [
    'chatgpt',
    'database',
    'Observatory database performance',
    'Database performance and slow SQL queries improve with an index on observation dates. Compare query plans before changing the fictional observatory database.',
    '2026-08-02T10:00:00.000Z',
  ],
  [
    'chatgpt',
    'authentication',
    'Lighthouse authentication notes',
    'Authentication for lighthouse keepers uses individual accounts. Retire old sessions when a keeper changes roles.',
    '2026-09-12T10:00:00.000Z',
  ],
  [
    'google-ai-mode',
    'undated',
    'Undated authentication sketch',
    'Authentication for the floating library needs a recovery process. This fictional sketch has no known date.',
    undefined,
  ],
  [
    'chatgpt',
    'garden',
    'The cloud garden',
    'Plant moonflowers in the fictional cloud garden. Water each pot after sunrise.',
    '2026-10-12T10:00:00.000Z',
  ],
] as const;

/** Authored fiction only. There are deliberately no original URLs or provider identifiers. */
export function demoCandidates(): Candidate[] {
  return stories.map(([provider, id, title, excerpt, at]) =>
    requireValid(CandidateSchema, {
      id: `demo-${id}`,
      conversationId: `fictional-${id}`,
      scope: demoScopes.find((scope) => scope.provider === provider),
      title,
      evidence: [
        { id: `${id}-title`, source: 'title', text: title },
        { id: `${id}-excerpt`, source: 'native-snippet', text: excerpt },
      ],
      ...(at ? { date: { at, meaning: 'conversation-updated', source: 'provider-metadata' } } : {}),
    }),
  );
}
