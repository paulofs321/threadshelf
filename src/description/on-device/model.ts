import {
  ModelApiErrorNameSchema,
  modelPlanSchemaFor,
  modelRankingSchemaFor,
  requireValid,
  validate,
} from '../../contracts';
import type {
  Candidate,
  ModelPort,
  ModelRanking,
  ModelOperationContext,
  ModelFailure,
  SearchRequest,
} from '../../contracts';
import {
  modelOptions,
  planConstraint,
  planPrompt,
  rankingConstraint,
  rankingPrompt,
  RankingOutputSchema,
  systemInstruction,
  TermsOutputSchema,
} from './prompts';
import type { LocalAiState, LocalModelFactory, LocalSession } from './types';

class InferenceError extends Error {
  constructor(readonly failure: ModelFailure) {
    super('Local inference failed.');
  }
}

function apiFailure(error: unknown, phase: ModelFailure['phase']): InferenceError {
  if (error instanceof InferenceError) return error;

  const name = validate(
    ModelApiErrorNameSchema,
    error instanceof Error || error instanceof DOMException ? error.name : undefined,
  );

  return new InferenceError({
    phase,
    code:
      name.ok && name.value === 'TimeoutError'
        ? 'timeout'
        : name.ok && name.value === 'AbortError'
          ? 'cancelled'
          : name.ok && name.value === 'QuotaExceededError'
            ? 'context-limit'
            : 'api-error',
    ...(name.ok ? { apiError: name.value } : {}),
  });
}

export function browserLanguageModel(): LocalModelFactory | undefined {
  return typeof LanguageModel === 'undefined' ? undefined : LanguageModel;
}

/** One panel-owned opt-in. The warm session contains instructions only; clones never share queries. */
export class OnDeviceModel implements ModelPort {
  private state: LocalAiState = { status: 'checking' };
  private generation = 0;
  private base: LocalSession | undefined;
  private startup: AbortController | undefined;
  private operation: AbortController | undefined;
  private readonly sessions = new Set<LocalSession>();
  private physicallyPending = false;

  constructor(
    private readonly getFactory: () => LocalModelFactory | undefined,
    private readonly publish: (state: LocalAiState) => void,
  ) {}

  get enabled(): boolean {
    return this.base !== undefined;
  }

  async check(): Promise<void> {
    this.disable();
    const generation = this.generation;
    this.set({ status: 'checking' });
    const factory = this.getFactory();

    if (!factory) {
      this.set({ status: 'unavailable' });

      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const status = await Promise.race([
        factory.availability(structuredClone(modelOptions)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local model check timed out.')), 5000);
        }),
      ]);

      if (generation !== this.generation) return;

      this.set({
        status:
          status === 'available'
            ? 'available'
            : status === 'downloadable' || status === 'downloading'
              ? 'downloadable'
              : 'unavailable',
      });
    } catch {
      if (generation === this.generation) this.set({ status: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }

  // Called directly from the user's click. No await precedes create(), preserving user activation.
  async enable(): Promise<void> {
    if (this.state.status !== 'available' && this.state.status !== 'downloadable') return;

    const factory = this.getFactory();

    if (!factory) {
      this.set({ status: 'unavailable' });

      return;
    }

    this.disable();
    const generation = this.generation;
    const controller = new AbortController();
    this.startup = controller;
    this.set({ status: 'starting' });
    const timer = setTimeout(() => controller.abort(), 120_000);
    const stop = new Promise<undefined>((resolve) => {
      controller.signal.onabort = () => resolve(undefined);
    });
    let detachProgress: (() => void) | undefined;

    try {
      const pending = factory.create({
        ...structuredClone(modelOptions),
        initialPrompts: [{ role: 'system', content: systemInstruction }],
        signal: controller.signal,
        monitor: (monitor) => {
          const progress = (event: ProgressEvent) => {
            if (
              generation === this.generation &&
              !controller.signal.aborted &&
              Number.isFinite(event.loaded) &&
              event.loaded >= 0 &&
              event.loaded <= 1
            )
              this.set({
                status: 'downloading',
                progress: Math.max(this.state.progress ?? 0, event.loaded),
              });
          };

          monitor.addEventListener('downloadprogress', progress);
          detachProgress = () => monitor.removeEventListener('downloadprogress', progress);
        },
      });
      // Own late creations even if Chrome ignores abort; never leak a downloaded session.
      void pending.then(
        (session) => {
          if (generation !== this.generation || controller.signal.aborted) session.destroy();
        },
        () => {},
      );
      const session = await Promise.race([pending, stop]);

      if (!session) {
        if (generation === this.generation) this.set({ status: 'error' });

        return;
      }

      if (generation !== this.generation || controller.signal.aborted) return;

      this.base = session;
      this.set({ status: 'ready' });
    } catch {
      if (generation === this.generation) this.set({ status: 'error' });
    } finally {
      clearTimeout(timer);
      detachProgress?.();
      controller.signal.onabort = null;

      if (this.startup === controller) this.startup = undefined;
    }
  }

  disable(): void {
    this.generation++;
    this.startup?.abort();
    this.operation?.abort();

    this.base?.destroy();
    this.base = undefined;
    this.set({ status: 'disabled' });
  }

  async interpret(request: SearchRequest, context: ModelOperationContext): Promise<unknown> {
    const raw = await this.infer(planPrompt(request), planConstraint, context);

    return this.validated(context, () =>
      requireValid(modelPlanSchemaFor(request), {
        requestId: request.requestId,
        ...requireValid(TermsOutputSchema, raw),
      }),
    );
  }

  async rank(
    request: SearchRequest,
    candidates: readonly Candidate[],
    context: ModelOperationContext,
  ): Promise<unknown> {
    const schema = modelRankingSchemaFor(request, candidates);
    let batch: Candidate[] = [];
    const batches: Candidate[][] = [batch];

    for (const candidate of candidates) {
      if (batch.length > 0 && rankingPrompt(request, [...batch, candidate]).length > 16_000) {
        batch = [candidate];
        batches.push(batch);
      } else batch.push(candidate);
    }

    // The validated inventory bounds batch count; the caller's overall deadline bounds time.
    // Do not discard a valid inventory before prompting just because messages need more batches.
    const selections: ModelRanking['selections'] = [];

    for (const items of batches) {
      const raw = await this.infer(rankingPrompt(request, items), rankingConstraint, context);
      const ranking = this.validated(context, () =>
        requireValid(modelRankingSchemaFor(request, items), {
          requestId: request.requestId,
          ...requireValid(RankingOutputSchema, raw),
        }),
      );
      selections.push(...ranking.selections);
    }

    return this.validated(context, () =>
      requireValid(schema, { requestId: request.requestId, selections }),
    );
  }

  private validated<T>(context: ModelOperationContext, check: () => T): T {
    try {
      return check();
    } catch {
      const error = new InferenceError({ phase: 'validate', code: 'invalid-output' });
      context.onFailure?.(error.failure);
      throw error;
    }
  }

  private async infer(
    prompt: string,
    constraint: Record<string, unknown>,
    { signal, onPrompt, onFailure }: ModelOperationContext,
  ): Promise<unknown> {
    const base = this.base;

    if (!base || signal.aborted || this.physicallyPending || prompt.length > 20_000) {
      const error = new InferenceError({
        phase: 'prepare',
        code: !base
          ? 'unavailable'
          : signal.aborted
            ? 'cancelled'
            : this.physicallyPending
              ? 'busy'
              : 'prompt-limit',
      });
      onFailure?.(error.failure);
      throw error;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.operation = controller;
    let phase: ModelFailure['phase'] = 'prepare';
    let timedOut = false;
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const stop = new Promise<never>((_, reject) => {
      controller.signal.onabort = () => {
        for (const session of this.sessions) session.destroy();

        this.sessions.clear();
        reject(new InferenceError({ phase, code: timedOut ? 'timeout' : 'cancelled' }));
      };
    });
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, 9000);
    this.physicallyPending = true;
    this.set({ status: 'running' });
    const pending = (async () => {
      // Retry only unsupported structured output, with a fresh clone and the SAME deadline.
      for (const constrained of [true, false]) {
        phase = 'prepare';
        const session = await base.clone({ signal: controller.signal });

        if (controller.signal.aborted || generation !== this.generation) {
          session.destroy();
          throw new InferenceError({ phase, code: 'cancelled' });
        }

        this.sessions.add(session);

        try {
          const options: LanguageModelPromptOptions = {
            ...(constrained ? { responseConstraint: constraint } : {}),
            signal: controller.signal,
          };
          phase = 'measure';
          const usage = await session.measureContextUsage(prompt, options);

          if (
            !Number.isFinite(usage) ||
            usage < 0 ||
            !Number.isFinite(session.contextUsage) ||
            !Number.isFinite(session.contextWindow) ||
            usage + session.contextUsage + 512 > Math.min(session.contextWindow, 8192)
          )
            throw new InferenceError({ phase, code: 'context-limit' });

          if (controller.signal.aborted) throw new InferenceError({ phase, code: 'cancelled' });

          phase = 'prompt';
          onPrompt?.();
          const response = await session.prompt(prompt, options);

          if (controller.signal.aborted || generation !== this.generation)
            throw new InferenceError({ phase, code: 'cancelled' });

          phase = 'parse';

          if (response.length > 32_000) throw new InferenceError({ phase, code: 'response-limit' });

          try {
            // Accept a single JSON code fence, never surrounding prose or multiple JSON values.
            const json = response.trim().replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/u, '$1');

            return JSON.parse(json) as unknown;
          } catch {
            throw new InferenceError({ phase, code: 'invalid-json' });
          }
        } catch (error) {
          const failure = apiFailure(error, phase);

          if (
            !constrained ||
            (phase !== 'measure' && phase !== 'prompt') ||
            failure.failure.apiError !== 'NotSupportedError' ||
            controller.signal.aborted ||
            generation !== this.generation
          )
            throw failure;
        } finally {
          if (this.sessions.delete(session)) session.destroy();
        }
      }
    })();

    const release = () => {
      this.physicallyPending = false;
    };

    void pending.then(release, release);

    try {
      return await Promise.race([pending, stop]);
    } catch (error) {
      const failure = apiFailure(error, phase);
      onFailure?.(failure.failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.signal.onabort = null;

      if (this.operation === controller) this.operation = undefined;

      if (generation === this.generation) this.set({ status: 'ready' });
    }
  }

  private set(state: LocalAiState): void {
    this.state = state;
    this.publish(state);
  }
}
