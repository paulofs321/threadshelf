import { rankingReferencesCandidates } from '../contracts';
import type {
  Candidate,
  DescriptionReport,
  ModelFailure,
  ModelRanking,
  SearchOutcome,
} from '../contracts';
import { providerLabels } from './SetupScreen';
import { providerFailureText } from './provider-failures';

const noticeText: Record<DescriptionReport['notices'][number], string> = {
  'literal-keywords':
    'Requires the description’s literal content words together in one excerpt. Paraphrases and longer explanations can be missed. Literal fallback does not understand related meanings.',
  'ambiguous-date':
    'The date wording is ambiguous or unsupported. Use the date controls to constrain results.',
  'explicit-date-precedence': 'The explicit date filter takes precedence over the description.',
  'model-unavailable': 'AI interpretation was not enabled or available for this search.',
  'invalid-model-output':
    'An AI stage failed or returned unusable output; fallback was used for that stage.',
  'model-timeout': 'The model did not finish; deterministic matching was used for that stage.',
};

const stageText = {
  unavailable: 'not enabled or unavailable',
  completed: 'completed',
  failed: 'failed; fallback used',
  timeout: 'timed out; fallback used',
  'no-candidates': 'skipped; no candidates',
};

const failureText: Record<ModelFailure['code'], string> = {
  unavailable: 'Local model session unavailable',
  busy: 'Previous local inference still running',
  'prompt-limit': 'Prompt exceeded the size limit',
  'context-limit': 'Prompt exceeded the model context budget',
  timeout: 'Local inference deadline reached',
  cancelled: 'Local inference was stopped',
  'api-error': 'Chrome model API rejected the operation',
  'response-limit': 'Model response exceeded the size limit',
  'invalid-json': 'Model response was not valid JSON',
  'invalid-output': 'Model output failed schema or evidence validation',
};

function FailureDetail({ stage, failure }: { stage: string; failure: ModelFailure }) {
  return (
    <p>
      {stage}: {failureText[failure.code]} ({failure.phase}
      {failure.apiError ? `; ${failure.apiError}` : ''}).
    </p>
  );
}

export function DescriptionSummary({
  report,
  timeZone,
  outcomes,
}: {
  report: DescriptionReport;
  timeZone: string;
  outcomes?: SearchOutcome['outcomes'];
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
      {report.execution && (
        <details>
          <summary className="cursor-pointer">AI and retrieval details</summary>
          <p>AI interpretation: {stageText[report.execution.interpretation.status]}.</p>
          <p>AI matching: {stageText[report.execution.matching.status]}.</p>
          {report.execution.interpretation.failure && (
            <FailureDetail
              stage="Interpretation failure"
              failure={report.execution.interpretation.failure}
            />
          )}
          {report.execution.matching.failure && (
            <FailureDetail stage="Matching failure" failure={report.execution.matching.failure} />
          )}
          <p>
            AI prompts sent: interpretation {report.execution.interpretation.promptCalls}; matching{' '}
            {report.execution.matching.promptCalls}.
          </p>
          <p>
            Conversations supplied for matching: {report.execution.candidates}; with message
            context: {report.execution.messageCandidates}.
          </p>
          {outcomes?.map((item) => (
            <p key={item.scope.provider}>
              {providerLabels[item.scope.provider]}:{' '}
              {item.status === 'success'
                ? `${item.candidates.length} retrieved; ${report.ranking.selections.filter((selection) => item.candidates.some((candidate) => candidate.id === selection.candidateId)).length} matched.`
                : `retrieval failed (${item.status}). ${providerFailureText[item.status]}`}
            </p>
          ))}
          <p>
            AI can judge only the retrieved excerpts. Conversations outside this bounded search
            cannot be matched.
          </p>
        </details>
      )}
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
