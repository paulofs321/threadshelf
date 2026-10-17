import { modelPlanSchemaFor, requireValid } from '../contracts';
import type { ModelPlan, SearchRequest } from '../contracts';
import { previousCalendarMonth } from '../search/dates';

const stopWords = new Set(
  'a an and are about can compare compared comparison too conversation conversations did discuss discussed do find for from help how i in is it me my of on or options sessions show that the this to was were what when where which with your'.split(
    ' ',
  ),
);
const vocabulary = [
  ['authentication', 'login', 'security', 'password', 'oauth', 'credentials', 'signin'],
  ['deployment', 'deploy', 'hosting', 'portfolio', 'vercel', 'netlify'],
  [
    'database',
    'sql',
    'postgres',
    'postgresql',
    'query',
    'queries',
    'indexing',
    'indexes',
    'performance',
    'slow',
    'optimization',
  ],
];
export type DescriptionNotice =
  | 'limited-vocabulary'
  | 'ambiguous-date'
  | 'explicit-date-precedence'
  | 'model-unavailable'
  | 'invalid-model-output'
  | 'model-timeout';
export interface Interpretation {
  plan: ModelPlan;
  notices: DescriptionNotice[];
}

export function interpretDescription(request: SearchRequest, now: string): Interpretation {
  const notices: DescriptionNotice[] = ['limited-vocabulary'];
  const relative = /\blast month\b/iu.test(request.query.text);
  const ambiguous =
    /\b(last (?:week|year)|recent(?:ly)?|earlier|yesterday|today|this (?:week|month|year)|\d{1,2}[/-]\d{1,2})\b/iu.test(
      request.query.text,
    );
  const text = request.query.text
    .replace(/\blast month\b/giu, '')
    .replace(/\b(?:log|sign)[ -]in\b/giu, 'login');
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !stopWords.has(word)),
    ),
  ];
  const groups = vocabulary.filter((group) => group.some((word) => words.includes(word)));
  const topics = groups.length ? groups.flatMap((group) => group.slice(0, 1)) : words;
  const keywords = [...new Set([...words, ...groups.flat()])].filter(
    (word) => !topics.includes(word),
  );

  if (ambiguous) notices.push('ambiguous-date');

  if (relative && request.query.dateRange) notices.push('explicit-date-precedence');

  return {
    plan: requireValid(modelPlanSchemaFor(request), {
      requestId: request.requestId,
      topics: [
        ...new Set(
          (topics.length ? topics : [request.query.text.replace(/\s+/gu, ' ')]).map((word) =>
            word.slice(0, 128),
          ),
        ),
      ].slice(0, 8),
      keywords: [...new Set(keywords.map((word) => word.slice(0, 128)))].slice(0, 8),
      ...(request.query.dateRange
        ? { proposedDateRange: request.query.dateRange }
        : relative && !ambiguous
          ? { proposedDateRange: previousCalendarMonth(now, request.query.timeZone) }
          : {}),
    }),
    notices,
  };
}
