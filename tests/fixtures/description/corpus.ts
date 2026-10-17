import { requireValid, CandidateSchema, SearchRequestSchema } from '../../../src/contracts';
import type { Candidate, SearchRequest, SessionScope } from '../../../src/contracts';
import { chatScope, googleScope, linkVerifiers } from '../contracts';

export { chatScope, googleScope, linkVerifiers };
export const now = '2026-10-01T00:30:00.000Z';

export function request(
  text = 'Where did I discuss login security?',
  overrides: Partial<SearchRequest> = {},
): SearchRequest {
  return requireValid(SearchRequestSchema, {
    requestId: 'fiction-description',
    query: {
      text,
      mode: 'description',
      providers: ['chatgpt', 'google-ai-mode'],
      timeZone: 'Europe/Zurich',
    },
    scopes: [chatScope, googleScope],
    ...overrides,
  });
}

export function candidate(
  id: string,
  title: string,
  excerpt: string,
  scope: SessionScope = chatScope,
  at?: string,
): Candidate {
  return requireValid(CandidateSchema, {
    id,
    scope,
    conversationId: id,
    originalUrl: `https://${scope.provider === 'chatgpt' ? 'chatgpt' : 'google-ai-mode'}.example.invalid/threads/${encodeURIComponent(id)}`,
    title,
    evidence: [
      { id: `${id}-title`, source: 'title', text: title },
      { id: `${id}-excerpt`, source: 'native-snippet', text: excerpt },
    ],
    ...(at ? { date: { at, meaning: 'conversation-updated', source: 'provider-metadata' } } : {}),
  });
}

// Fictional, authored evaluation cases; never copied from provider history.
export const corpus = [
  candidate(
    'security',
    'Lighthouse login security',
    'Compare OAuth authentication, password rotation and session security.',
    chatScope,
    '2026-09-12T10:00:00.000Z',
  ),
  candidate(
    'portfolio',
    'Deploying the lunar portfolio',
    'Portfolio deployment compares Netlify hosting and Vercel deployment.',
    googleScope,
    '2026-09-22T10:00:00.000Z',
  ),
  candidate(
    'database',
    'Observatory database performance',
    'SQL database indexing fixes slow queries; compare PostgreSQL query plans.',
    chatScope,
    '2026-08-02T10:00:00.000Z',
  ),
  candidate(
    'old-auth',
    'Old authentication notebook',
    'Authentication login discussion from another month.',
    googleScope,
    '2026-08-12T10:00:00.000Z',
  ),
  candidate(
    'undated-auth',
    'Authentication without a date',
    'Authentication design, with no verified timestamp.',
    googleScope,
  ),
  candidate(
    'negative',
    'Gardening notes',
    'Plant tulips and water the fictional garden.',
    chatScope,
    '2026-09-15T10:00:00.000Z',
  ),
] as const;
export const examples = [
  {
    text: 'Where did I discuss login security?',
    expected: 'security',
    evidence: 'security-excerpt',
  },
  {
    text: 'Where did I compare deployment options for my portfolio?',
    expected: 'portfolio',
    evidence: 'portfolio-excerpt',
  },
  {
    text: 'Find conversations about database performance and slow SQL queries',
    expected: 'database',
    evidence: 'database-excerpt',
  },
  {
    text: 'Which sessions did I discuss authentication last month?',
    expected: 'security',
    evidence: 'security-excerpt',
  },
];
