import { modelPlanSchemaFor, requireValid } from '../contracts';
import type { ModelPlan, SearchRequest } from '../contracts';
import { previousCalendarMonth } from '../search/dates';
import { descriptionWords } from '../search/terms';

export type DescriptionNotice =
  | 'literal-keywords'
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
  const notices: DescriptionNotice[] = ['literal-keywords'];
  const relative = /\blast month\b/iu.test(request.query.text);
  const ambiguous =
    /\b(last (?:week|year)|recent(?:ly)?|earlier|yesterday|today|this (?:week|month|year)|\d{1,2}[/-]\d{1,2})\b/iu.test(
      request.query.text,
    );
  const words = [...new Set(descriptionWords(request.query.text))];
  const topics = words;
  const keywords = words.slice(8, 16);

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
