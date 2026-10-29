import * as v from 'valibot';
import {
  limits,
  ProviderIdSchema,
  requireValid,
  sameScope,
  scopeKey,
  SearchRequestSchema,
  SessionScopeSchema,
} from '../contracts';
import type {
  Coverage,
  LinkVerifiers,
  OperationContext,
  ProviderId,
  ProviderOutcome,
  ProviderPort,
  ProviderRequest,
  SearchOutcome,
  SearchPort,
  SearchRequest,
  SessionScope,
} from '../contracts';
import { aggregateSearch } from './aggregate';
import { normalizeProviderOutcome } from './normalize';

const integer = (maximum: number) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(maximum));
const PolicySchema = v.strictObject({
  concurrency: integer(2),
  maxProviderCalls: integer(2),
  maxResults: integer(limits.candidates * 2),
  providerTimeoutMs: integer(60_000),
  requestTimeoutMs: integer(60_000),
});
export type SearchPolicy = v.InferOutput<typeof PolicySchema>;
export interface KeywordSearchOptions {
  readonly providers: readonly Pick<ProviderPort, 'provider' | 'search'>[];
  readonly linkVerifiers: LinkVerifiers;
  readonly policy?: Partial<SearchPolicy>;
}
const KeywordRequestSchema = v.pipe(
  SearchRequestSchema,
  v.check((request) => request.query.mode === 'keyword'),
);
type FailureStatus = Exclude<ProviderOutcome['status'], 'success'>;
interface Task {
  readonly request: ProviderRequest;
  outcome?: ProviderOutcome;
  controller?: AbortController;
}
interface Run {
  readonly tasks: Task[];
  readonly reasons: Coverage['reasons'];
  remainingCalls: number;
  work?: Promise<void>;
}
interface ScopeRecord {
  readonly scope: SessionScope;
  retired: boolean;
}

function failure(task: Task, status: FailureStatus): ProviderOutcome {
  return { requestId: task.request.requestId, scope: task.request.scope, status };
}

function stop(task: Task, status: FailureStatus): void {
  // This also erases a completed provider's private results on cancellation or invalidation.
  task.outcome = failure(task, status);
  task.controller?.abort();
}

/** One instance per search surface. No UI, browser transport, cache or automatic retries. */
export class KeywordSearch implements SearchPort {
  private readonly providers = new Map<ProviderId, Pick<ProviderPort, 'provider' | 'search'>>();
  private readonly verifiers: LinkVerifiers;
  private readonly policy: SearchPolicy;
  private readonly scopes = new Map<ProviderId, ScopeRecord>();
  private readonly cooldowns = new Map<ProviderId, number>();
  // Keep a physical call occupied until its promise settles, even if a port ignores abort.
  private readonly inFlight = new Map<ProviderId, object>();
  private active: Run | undefined;

  constructor(options: KeywordSearchOptions) {
    this.verifiers = { ...options.linkVerifiers };
    this.policy = requireValid(PolicySchema, {
      concurrency: 2,
      maxProviderCalls: 2,
      maxResults: limits.candidates * 2,
      providerTimeoutMs: 12_000,
      requestTimeoutMs: 25_000,
      ...options.policy,
    });

    for (const port of options.providers) {
      const provider = requireValid(ProviderIdSchema, port.provider);

      if (this.providers.has(provider)) throw new Error('Duplicate provider port.');

      this.providers.set(provider, port);
    }
  }

  async search(input: SearchRequest, context: OperationContext): Promise<SearchOutcome> {
    // Invalid input must never dispatch work or replace a valid search.
    const request = requireValid(KeywordRequestSchema, input);
    const previous = this.active;
    previous?.tasks.forEach((task) => stop(task, 'cancelled'));
    const run: Run = {
      tasks: request.scopes
        .toSorted(
          (left, right) =>
            request.query.providers.indexOf(left.provider) -
            request.query.providers.indexOf(right.provider),
        )
        .map((scope) => {
          const task: Task = {
            request: { requestId: request.requestId, query: request.query, scope },
          };

          if (!this.selectScope(scope)) stop(task, 'scope-changed');

          return task;
        }),
      reasons: [],
      remainingCalls: this.policy.maxProviderCalls,
    };
    this.active = run;
    const cancel = () => run.tasks.forEach((task) => stop(task, 'cancelled'));
    context.signal.addEventListener('abort', cancel, { once: true });

    if (context.signal.aborted) cancel();

    const deadline = setTimeout(() => {
      run.tasks.filter((task) => !task.outcome).forEach((task) => stop(task, 'timeout'));
    }, this.policy.requestTimeoutMs);
    let next = 0;

    const worker = async () => {
      while (next < run.tasks.length) {
        const task = run.tasks[next++];

        if (task && !task.outcome) await this.searchProvider(task, run);
      }
    };

    try {
      // Let the replaced run release abort-aware ports and its queue before new dispatch.
      // A port still physically pending after that remains occupied and reports interrupted.
      run.work = (async () => {
        await previous?.work;
        await Promise.all(Array.from({ length: this.policy.concurrency }, worker));
      })();
      await run.work;

      // A newer search can reuse the same caller ID: object ownership still rejects the old run.
      if (this.active !== run || context.signal.aborted) cancel();

      return aggregateSearch(
        request,
        run.tasks.map((task) => task.outcome ?? failure(task, 'interrupted')),
        this.verifiers,
        this.policy.maxResults,
        run.reasons,
      );
    } finally {
      clearTimeout(deadline);
      context.signal.removeEventListener('abort', cancel);

      if (this.active === run) this.active = undefined;
    }
  }

  // Owners must call this on logout, selection/permission loss or account/workspace change,
  // and clear any already displayed outcome. No provider identity is inferred here.
  invalidate(input: SessionScope): void {
    const scope = requireValid(SessionScopeSchema, input);
    const current = this.scopes.get(scope.provider);

    if (!current || scope.generation > current.scope.generation)
      this.scopes.set(scope.provider, { scope, retired: true });
    else if (sameScope(current.scope, scope)) current.retired = true;

    this.active?.tasks
      .filter(
        (task) =>
          sameScope(task.request.scope, scope) ||
          (task.request.scope.provider === scope.provider &&
            task.request.scope.generation < scope.generation),
      )
      .forEach((task) => stop(task, 'scope-changed'));
  }

  private selectScope(scope: SessionScope): boolean {
    const current = this.scopes.get(scope.provider);

    if (!current || scope.generation > current.scope.generation) {
      this.scopes.set(scope.provider, { scope, retired: false });

      return true;
    }

    return !current.retired && scopeKey(current.scope) === scopeKey(scope);
  }

  private async searchProvider(task: Task, run: Run): Promise<void> {
    const { scope } = task.request;
    const port = this.providers.get(scope.provider);
    const retryAfterMs = Math.ceil((this.cooldowns.get(scope.provider) ?? 0) - Date.now());

    if (!port) {
      task.outcome = failure(task, 'unavailable');

      return;
    }

    if (retryAfterMs > 0) {
      task.outcome = {
        ...failure(task, 'rate-limited'),
        status: 'rate-limited',
        retryAfterMs: Math.min(retryAfterMs, limits.retryAfterMs),
      };

      return;
    }

    if (this.inFlight.has(scope.provider) || this.inFlight.size >= this.policy.concurrency) {
      task.outcome = failure(task, 'interrupted');

      return;
    }

    if (run.remainingCalls === 0) {
      task.outcome = failure(task, 'unavailable');
      run.reasons.push('query-budget');

      return;
    }

    run.remainingCalls--;
    const controller = new AbortController();
    task.controller = controller;
    const token = {};
    this.inFlight.set(scope.provider, token);

    const interrupted = new Promise<unknown>((resolve) => {
      controller.signal.onabort = () => resolve(task.outcome ?? failure(task, 'cancelled'));
    });
    const deadline = setTimeout(() => stop(task, 'timeout'), this.policy.providerTimeoutMs);
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) return task.outcome;

      return port.search(structuredClone(task.request), { signal: controller.signal });
    });

    const release = () => {
      if (this.inFlight.get(scope.provider) === token) this.inFlight.delete(scope.provider);
    };

    // Both handlers consume rejections from late, abandoned provider work without logging data.
    void pending.then(release, release);

    try {
      const raw = await Promise.race([pending, interrupted]);

      if (task.outcome) return;

      const normalized = normalizeProviderOutcome(raw, task.request, this.verifiers);

      if (task.outcome) return;

      task.outcome = normalized;

      const rateLimit =
        task.outcome.status === 'rate-limited'
          ? task.outcome
          : task.outcome.status === 'success'
            ? task.outcome.rateLimit
            : undefined;

      if (rateLimit)
        this.cooldowns.set(scope.provider, Date.now() + (rateLimit.retryAfterMs ?? 1_000));

      if (['login-expired', 'scope-changed', 'permission-needed'].includes(normalized.status)) {
        this.invalidate(scope);

        // Keep the provider's precise terminal reason when retiring its scope.
        task.outcome = normalized;
      }
    } catch {
      if (!task.outcome) task.outcome = failure(task, 'unavailable');
    } finally {
      clearTimeout(deadline);
      controller.signal.onabort = null;
      delete task.controller;
    }
  }
}
