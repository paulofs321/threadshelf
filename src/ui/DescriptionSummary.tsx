import { rankingReferencesCandidates } from '../contracts';
import type { Candidate, DescriptionReport, ModelRanking } from '../contracts';

const noticeText: Record<DescriptionReport['notices'][number], string> = {
  'literal-keywords': 'Fallback matches literal words; related meanings can be missed.',
  'ambiguous-date':
    'The date wording is ambiguous or unsupported. Use the date controls to constrain results.',
  'explicit-date-precedence': 'The explicit date filter takes precedence over the description.',
  'model-unavailable': 'Model support is unavailable.',
  'invalid-model-output':
    'Invalid model output was discarded; deterministic matching was used for that stage.',
  'model-timeout': 'The model did not finish; deterministic matching was used for that stage.',
};

export function DescriptionSummary({
  report,
  timeZone,
}: {
  report: DescriptionReport;
  timeZone: string;
}) {
  const format = (at: string) =>
    new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone }).format(new Date(at));

  return (
    <div
      className="mt-2 space-y-1 text-xs text-muted-foreground"
      role="note"
      aria-label="Description search details"
    >
      <p>
        {report.strategy === 'keyword-topic-fallback'
          ? 'Literal keyword fallback'
          : 'Model-assisted matching with verified evidence'}
      </p>
      <p>Search terms: {report.terms.join(', ')}</p>
      {report.dateRange && (
        <p>
          Available date: {format(report.dateRange.start)} to {format(report.dateRange.end)}{' '}
          (exclusive), {timeZone}.
        </p>
      )}
      {report.notices.map((notice) => (
        <p key={notice}>{noticeText[notice]}</p>
      ))}
    </div>
  );
}

/** No generated narrative: the explanation can only quote the candidate's own verified evidence. */
export function EvidenceExplanation({
  candidate,
  selection,
}: {
  candidate: Candidate;
  selection: ModelRanking['selections'][number];
}) {
  if (!rankingReferencesCandidates({ selections: [selection] }, [candidate])) return null;

  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer text-primary">Why this matched</summary>
      <p className="mt-2">Selected evidence from this conversation:</p>
      {selection.evidenceIds.map((id) => {
        const evidence = candidate.evidence.find((item) => item.id === id);
        const span = selection.spans?.find((item) => item.evidenceId === id);

        return (
          evidence && (
            <blockquote key={id} className="mt-1 whitespace-pre-wrap">
              {span ? evidence.text.slice(span.start, span.end) : evidence.text}
            </blockquote>
          )
        );
      })}
    </details>
  );
}
