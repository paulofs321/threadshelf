import * as v from 'valibot';
import {
  limits,
  matchesDateRange,
  modelPlanSchemaFor,
  modelRankingSchemaFor,
  requireValid,
  sameScope,
  SearchRequestSchema,
  searchOutcomeSchemaFor,
  SessionScopeSchema,
  validate,
} from '../contracts';
import type {
  Candidate,
  Coverage,
  DescriptionReport,
  InterpreterPort,
  ModelPort,
  LinkVerifiers,
  OperationContext,
  ProviderId,
  ProviderOutcome,
  RankerPort,
  SearchOutcome,
  SearchPort,
  SearchRequest,
  SessionScope,
} from '../contracts';
import { aggregateSearch } from '../search/aggregate';
import { collect } from './collect';
import { interpretDescription } from './interpret';
import { rankKeywords } from './rank';

const integer = (maximum: number) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(maximum));
const PolicySchema = v.strictObject({
  maxQueries: integer(8),
  maxCandidates: integer(limits.candidates),
  maxResults: integer(limits.candidates),
  modelTimeoutMs: integer(10_000),
  requestTimeoutMs: integer(60_000),
});
export interface DescriptionSearchOptions {
  retrieval: SearchPort;
  linkVerifiers: LinkVerifiers;
  now(): string;
  freshId(): string;
  interpreter?: InterpreterPort;
  model?: () => ModelPort | undefined;
  ranker?: RankerPort;
  policy?: Partial<v.InferOutput<typeof PolicySchema>>;
}
interface Run {
  request: SearchRequest;
  controller: AbortController;
  status?: 'cancelled' | 'scope-changed' | 'timeout';
}

function normalizeTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((term) => term.trim().toLowerCase()))];
}

/** Panel/document-owned orchestration. No model implementation, browser access or persistent state. */
export class DescriptionSearch implements SearchPort {
  private active: Run | undefined;
  private readonly retired = new Map<ProviderId, SessionScope>();
  private readonly policy: v.InferOutput<typeof PolicySchema>;
  private readonly occupied = new Map<object, Promise<unknown>>();

  constructor(private readonly options: DescriptionSearchOptions) {
    this.policy = requireValid(PolicySchema, {
      maxQueries: 3,
      maxCandidates: 100,
      maxResults: 50,
      modelTimeoutMs: 3000,
      requestTimeoutMs: 45_000,
      ...options.policy,
    });
  }

  async search(input: SearchRequest, context: OperationContext): Promise<SearchOutcome> {
    const request = requireValid(
      v.pipe(
        SearchRequestSchema,
        v.check((item) => item.query.mode === 'description'),
      ),
      input,
    );
    this.stop(this.active, 'cancelled');
    const run: Run = { request, controller: new AbortController() };
    this.active = run;
    const cancel = () => this.stop(run, 'cancelled');
    context.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => this.stop(run, 'timeout'), this.policy.requestTimeoutMs);

    if (context.signal.aborted) cancel();

    if (
      request.scopes.some((scope) => {
        const retired = this.retired.get(scope.provider);

        return retired !== undefined && scope.generation <= retired.generation;
      })
    )
      this.stop(run, 'scope-changed');

    try {
      return await this.execute(run);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);

      if (this.active === run) this.active = undefined;
    }
  }

  invalidate(input: SessionScope): void {
    const scope = requireValid(SessionScopeSchema, input);
    const previous = this.retired.get(scope.provider);

    if (!previous || scope.generation > previous.generation)
      this.retired.set(scope.provider, scope);

    this.options.retrieval.invalidate(scope);

    if (
      this.active?.request.scopes.some(
        (current) =>
          sameScope(current, scope) ||
          (current.provider === scope.provider && current.generation < scope.generation),
      )
    )
      this.stop(this.active, 'scope-changed');
  }

  private stop(run: Run | undefined, status: NonNullable<Run['status']>): void {
    if (!run || run.status) return;

    run.status = status;
    run.controller.abort();
  }

  private terminal(run: Run): SearchOutcome {
    return aggregateSearch(
      run.request,
      run.request.scopes.map((scope) => ({
        requestId: run.request.requestId,
        scope,
        status: run.status ?? 'cancelled',
      })),
      this.options.linkVerifiers,
      this.policy.maxResults,
      [],
    );
  }

  private async execute(run: Run): Promise<SearchOutcome> {
    const { request } = run;

    if (run.status) return this.terminal(run);

    const fallback = interpretDescription(request, this.options.now());
    const notices = fallback.notices;
    let plan = fallback.plan;
    let assisted = false;
    const effective: SearchRequest = {
      ...request,
      query: {
        ...request.query,
        ...(plan.proposedDateRange ? { dateRange: plan.proposedDateRange } : {}),
      },
    };

    const model = this.options.model?.();
    const interpreter = this.options.interpreter ?? model;

    if (interpreter) {
      const raw = await this.bounded(interpreter, run, (context) =>
        interpreter.interpret(structuredClone(effective), context),
      );
      const parsed = validate(modelPlanSchemaFor(effective), raw.value);

      if (
        parsed.ok &&
        JSON.stringify(parsed.value.proposedDateRange ?? effective.query.dateRange) ===
          JSON.stringify(effective.query.dateRange)
      ) {
        plan = parsed.value;
        assisted = true;
      } else notices.push(raw.timeout ? 'model-timeout' : 'invalid-model-output');
    } else notices.push('model-unavailable');

    if (run.status) return this.terminal(run);

    plan = {
      ...plan,
      topics: normalizeTerms(plan.topics),
      keywords: normalizeTerms(plan.keywords),
    };
    const terms = [...new Set([...plan.topics, ...plan.keywords])];
    const queries = terms.slice(0, this.policy.maxQueries);
    const reasons: Coverage['reasons'] = terms.length > queries.length ? ['query-budget'] : [];
    const collected = new Map<ProviderId, ProviderOutcome>();
    const stopped = new Set<ProviderId>();

    for (const text of queries) {
      const scopes = request.scopes.filter((scope) => !stopped.has(scope.provider));

      if (scopes.length === 0) break;

      const retrievalRequest = requireValid(SearchRequestSchema, {
        requestId: this.options.freshId(),
        query: {
          ...effective.query,
          mode: 'keyword',
          text,
          providers: scopes.map((scope) => scope.provider),
        },
        scopes,
      });
      const read = await this.bounded(
        this.options.retrieval,
        run,
        (context) => this.options.retrieval.search(structuredClone(retrievalRequest), context),
        this.policy.requestTimeoutMs,
      );

      if (run.status) return this.terminal(run);

      const parsed = validate(
        searchOutcomeSchemaFor(retrievalRequest, this.options.linkVerifiers),
        read.value,
      );
      const outcomes = parsed.ok
        ? parsed.value.outcomes
        : scopes.map((scope): ProviderOutcome => ({
            requestId: retrievalRequest.requestId,
            scope,
            status: read.timeout ? 'timeout' : 'schema-changed',
          }));

      if (parsed.ok) reasons.push(...parsed.value.coverage.reasons);

      for (const outcome of outcomes) {
        const next = collect(
          collected.get(outcome.scope.provider),
          outcome,
          { requestId: request.requestId, query: effective.query, scope: outcome.scope },
          this.options.linkVerifiers,
        );
        collected.set(outcome.scope.provider, next);

        if (outcome.status !== 'success' || next.status !== 'success')
          stopped.add(outcome.scope.provider);
      }
    }

    const outcome = aggregateSearch(
      effective,
      request.scopes.map(
        (scope) =>
          collected.get(scope.provider) ?? {
            requestId: request.requestId,
            scope,
            status: 'unavailable',
          },
      ),
      this.options.linkVerifiers,
      limits.candidates * 2,
      [...new Set(reasons)],
    );
    const inventory = outcome.outcomes.flatMap((item) =>
      item.status === 'success' ? item.candidates : [],
    );
    const eligible = inventory.filter((item) => matchesDateRange(item, effective.query.dateRange));
    // Lexical matches lead the bounded context; remaining retrieved excerpts can be reranked.
    const preliminary = rankKeywords(effective, eligible, plan);
    const scores = new Map(preliminary.selections.map((item) => [item.candidateId, item.score]));
    const pool = eligible
      .filter((item) => item.evidence.length > 0)
      .toSorted((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
    const candidates: Candidate[] = [];
    let textSize = 0;

    for (const candidate of pool) {
      const size = candidate.evidence.reduce((sum, item) => sum + item.text.length, 0);

      if (
        candidates.length < this.policy.maxCandidates &&
        textSize + size <= limits.totalEvidence
      ) {
        candidates.push(candidate);
        textSize += size;
      }
    }

    if (candidates.length < pool.length) reasons.push('result-limit');

    if (inventory.some((item) => item.evidence.length === 0)) reasons.push('missing-evidence');

    let ranking = rankKeywords(effective, candidates, plan);

    const ranker = this.options.ranker ?? model;

    if (ranker && candidates.length > 0) {
      const raw = await this.bounded(ranker, run, (context) =>
        ranker.rank(structuredClone(effective), structuredClone(candidates), context),
      );
      const parsed = validate(modelRankingSchemaFor(effective, candidates), raw.value);

      if (parsed.ok) {
        ranking = parsed.value;
        ranking.selections.sort((a, b) => b.score - a.score);
        assisted = true;
      } else notices.push(raw.timeout ? 'model-timeout' : 'invalid-model-output');
    }

    if (run.status) return this.terminal(run);

    if (ranking.selections.length > this.policy.maxResults) reasons.push('result-limit');

    ranking.selections = ranking.selections.slice(0, this.policy.maxResults);
    const report: DescriptionReport = {
      strategy: assisted ? 'model-assisted' : 'keyword-topic-fallback',
      terms,
      notices: [...new Set(notices.filter((notice) => !assisted || notice !== 'literal-keywords'))],
      ranking,
      ...(effective.query.dateRange ? { dateRange: effective.query.dateRange } : {}),
    };
    const aggregate = aggregateSearch(
      effective,
      outcome.outcomes,
      this.options.linkVerifiers,
      limits.candidates * 2,
      [...new Set(reasons)],
    );

    return requireValid(searchOutcomeSchemaFor(request, this.options.linkVerifiers), {
      ...aggregate,
      results: ranking.selections.map((item) => item.candidateId),
      description: report,
    });
  }

  // Keep physical ownership until abandoned ports settle; consume late rejection without logging.
  private async bounded(
    owner: object,
    run: Run,
    operation: (context: OperationContext) => Promise<unknown>,
    timeoutMs = this.policy.modelTimeoutMs,
  ): Promise<{ value?: unknown; timeout?: boolean }> {
    if (run.status) return {};

    const previous = this.occupied.get(owner);

    // Models may fall back while busy; native retrieval must serialize replacements.
    if (previous && owner !== this.options.retrieval) return {};

    const controller = new AbortController();
    let timeout = false;
    const abort = () => controller.abort();
    run.controller.signal.addEventListener('abort', abort, { once: true });
    const interrupted = new Promise<undefined>((resolve) => {
      controller.signal.onabort = () => resolve(undefined);
    });
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, timeoutMs);

    try {
      if (previous)
        await Promise.race([
          previous.then(
            () => undefined,
            () => undefined,
          ),
          interrupted,
        ]);

      if (controller.signal.aborted) return { timeout };

      const pending = Promise.resolve().then(() =>
        controller.signal.aborted ? undefined : operation({ signal: controller.signal }),
      );
      this.occupied.set(owner, pending);
      const release = () => this.occupied.delete(owner);
      void pending.then(release, release);

      return { value: await Promise.race([pending, interrupted]), timeout };
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
      run.controller.signal.removeEventListener('abort', abort);
      controller.signal.onabort = null;
    }
  }
}

/** Reuses the existing keyword transport; interpretation/model data never crosses that boundary. */
export class SearchModes implements SearchPort {
  constructor(
    private readonly keyword: SearchPort,
    private readonly description: SearchPort,
  ) {}
  search(request: SearchRequest, context: OperationContext): Promise<SearchOutcome> {
    return (request.query.mode === 'description' ? this.description : this.keyword).search(
      request,
      context,
    );
  }
  invalidate(scope: SessionScope): void {
    this.keyword.invalidate(scope);
    this.description.invalidate(scope);
  }
}
