import * as v from 'valibot';
import { ProviderOutcomeSchema, providerOutcomeSchemaFor } from '../../contracts/outcome';
import type { ProviderOutcome } from '../../contracts/outcome';
import type { OperationContext, ProviderPort } from '../../contracts/ports';
import { ProviderRequestSchema } from '../../contracts/query';
import type { ProviderRequest } from '../../contracts/query';
import { sameScope, SessionScopeSchema } from '../../contracts/session';
import type { SessionOutcome, SessionScope } from '../../contracts/session';
import { requireValid } from '../../contracts/validation';
import { validate } from '../../contracts/validation';
import { CandidateSchema, EvidenceSchema } from '../../contracts/conversation';
import type { Candidate } from '../../contracts/conversation';
import { limits } from '../../contracts/primitives';
import { parseGoogleDateLabel } from './dates';
import { googleAiModeAvailability } from './availability';
import { GoogleReadResultSchema } from './transport';
import type { GoogleAiModeReadPort, GoogleReadOperation } from './transport';
import { googleHttpFailure, parseGoogleRecords, verifyGoogleOriginalLink } from './wire';
import { attachMessageContext, selectMessageContext } from '../../search/context';

const GoogleAiModeScopeSchema = v.pipe(
  SessionScopeSchema,
  v.check((scope) => scope.provider === 'google-ai-mode'),
);
const GoogleAiModeRequestSchema = v.pipe(
  ProviderRequestSchema,
  v.check((request) => request.scope.provider === 'google-ai-mode'),
);

// Browser capabilities are injected by trusted composition; absence never becomes empty success.
export class GoogleAiModeProvider implements ProviderPort {
  readonly provider = 'google-ai-mode' as const;
  readonly availability = googleAiModeAvailability;
  private readonly selectedScope: SessionScope;
  private invalidated = false;
  private identity: string | undefined;
  private readonly candidates = new Map<string, Candidate>();
  private readonly pending = new Set<AbortController>();
  private retrievalEpoch = 0;
  private candidateRequestKey: string | undefined;

  constructor(
    scope: SessionScope,
    private readonly readPort?: GoogleAiModeReadPort,
    private readonly options: { freshId?: () => string; now?: () => number } = {},
  ) {
    // Parsing snapshots the normalized selection; caller mutation cannot rebind this instance.
    this.selectedScope = requireValid(GoogleAiModeScopeSchema, scope);
  }

  async inspectSession(context: OperationContext): Promise<SessionOutcome> {
    if (this.readPort && !this.invalidated && !context.signal.aborted) {
      const result = await this.read({ kind: 'inspect' }, context);

      if (
        result.status === 'success' &&
        result.response === undefined &&
        result.rendered === undefined &&
        result.dateLabel === undefined
      )
        return { status: 'ready', scope: { ...this.selectedScope } };

      if (
        result.status === 'login-expired' ||
        result.status === 'permission-needed' ||
        result.status === 'scope-changed'
      )
        return {
          status: result.status,
          provider: this.provider,
          generation: this.selectedScope.generation,
        };
    }

    return {
      status: this.invalidated ? 'scope-changed' : 'unavailable',
      provider: this.provider,
      generation: this.selectedScope.generation,
    };
  }

  async search(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    return this.retrieve(input, context, 'search');
  }

  async list(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    return this.retrieve(input, context, 'list');
  }

  private async retrieve(
    input: ProviderRequest,
    context: OperationContext,
    kind: 'search' | 'list',
  ): Promise<ProviderOutcome> {
    const request = requireValid(GoogleAiModeRequestSchema, input);
    const status = context.signal.aborted
      ? 'cancelled'
      : this.invalidated || !sameScope(request.scope, this.selectedScope)
        ? 'scope-changed'
        : 'unavailable';

    if (status !== 'unavailable' || !this.readPort) return this.failure(request, status);

    const epoch = ++this.retrievalEpoch;
    this.candidates.clear();
    this.candidateRequestKey = undefined;
    const result = await this.read(
      kind === 'search' ? { kind, query: request.query.text } : { kind },
      context,
    );

    if (result.status !== 'success') return this.failure(request, result.status);

    if (!result.response || result.rendered !== undefined)
      return this.failure(request, 'schema-changed');

    const failure = googleHttpFailure(result.response, this.options.now?.() ?? Date.now());

    if (failure) {
      if (failure.status === 'login-expired') this.invalidate();

      return requireValid(ProviderOutcomeSchema, {
        requestId: request.requestId,
        scope: request.scope,
        ...failure,
      });
    }

    try {
      const parsed = parseGoogleRecords(
        result.response.body,
        kind,
        request,
        this.options.freshId ?? (() => crypto.randomUUID()),
      );

      if (result.dateLabel) {
        const candidate = parsed.candidates.find(
          (candidate) => candidate.conversationId === result.dateLabel?.conversationId,
        );
        const date = parseGoogleDateLabel(result.dateLabel, request.query.timeZone);

        if (candidate && date) candidate.date = date;
      }

      if (context.signal.aborted) return this.failure(request, 'cancelled');

      if (epoch !== this.retrievalEpoch || this.invalidated)
        return this.failure(request, 'scope-changed');

      if (parsed.candidates.every((candidate) => candidate.date !== undefined))
        parsed.coverage.reasons = parsed.coverage.reasons.filter(
          (reason) => reason !== 'unknown-dates',
        );

      const outcome = requireValid(
        providerOutcomeSchemaFor(request, { 'google-ai-mode': verifyGoogleOriginalLink }),
        { requestId: request.requestId, scope: request.scope, status: 'success', ...parsed },
      );
      this.candidates.clear();

      for (const candidate of parsed.candidates)
        this.candidates.set(candidate.conversationId, requireValid(CandidateSchema, candidate));

      this.candidateRequestKey = JSON.stringify([request.requestId, request.query]);

      return outcome;
    } catch {
      return this.failure(request, 'schema-changed');
    }
  }

  async messages(
    input: ProviderRequest,
    conversationId: string,
    context: OperationContext,
    description?: string,
  ): Promise<ProviderOutcome> {
    const request = requireValid(GoogleAiModeRequestSchema, input);

    if (context.signal.aborted) return this.failure(request, 'cancelled');

    if (this.invalidated || !sameScope(request.scope, this.selectedScope))
      return this.failure(request, 'scope-changed');

    const candidate = this.candidates.get(conversationId);

    if (
      !candidate ||
      !this.identity ||
      !this.readPort?.openEvidence ||
      this.candidateRequestKey !== JSON.stringify([request.requestId, request.query])
    )
      return this.failure(request, 'unavailable');

    const result = await this.read(
      {
        kind: 'messages',
        conversationId,
        ...(description === undefined ? {} : { query: description }),
      },
      context,
      candidate,
    );

    if (result.status !== 'success') return this.failure(request, result.status);

    if (!result.rendered || result.response !== undefined || result.dateLabel !== undefined)
      return this.failure(request, 'schema-changed');

    const enriched =
      description === undefined
        ? requireValid(CandidateSchema, candidate)
        : attachMessageContext(
            candidate,
            selectMessageContext(result.rendered, description),
            'rendered-message',
          );

    for (const [index, text] of (description === undefined ? result.rendered : []).entries()) {
      if (enriched.evidence.length >= limits.evidencePerCandidate) break;

      enriched.evidence.push(
        requireValid(EvidenceSchema, { id: `rendered-${index}`, text, source: 'rendered-message' }),
      );
    }

    return requireValid(
      providerOutcomeSchemaFor(request, { 'google-ai-mode': verifyGoogleOriginalLink }),
      {
        requestId: request.requestId,
        scope: request.scope,
        status: 'success',
        candidates: [enriched],
        coverage: {
          extent: 'unknown',
          reasons: [
            'unknown-reach',
            'missing-evidence',
            ...(request.query.dateRange && !candidate.date ? ['unknown-dates'] : []),
          ],
        },
      },
    );
  }

  readContext(
    input: ProviderRequest,
    conversationId: string,
    description: string,
    context: OperationContext,
  ): Promise<ProviderOutcome> {
    return this.messages(input, conversationId, context, description);
  }

  private failure(
    request: ProviderRequest,
    status: Exclude<ProviderOutcome['status'], 'success'>,
  ): ProviderOutcome {
    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      status,
    });
  }

  private async read(
    operation: GoogleReadOperation,
    context: OperationContext,
    candidate?: Candidate,
  ): Promise<v.InferOutput<typeof GoogleReadResultSchema>> {
    // A replacement operation retires older work even when its port ignores AbortSignal.
    for (const pending of this.pending) pending.abort();

    const controller = new AbortController();
    this.pending.add(controller);
    let timeout = false;
    let cancelWait: (() => void) | undefined;
    const cancelled = new Promise<unknown>((resolve) => {
      cancelWait = () => {
        resolve({
          status: context.signal.aborted ? 'cancelled' : timeout ? 'timeout' : 'scope-changed',
        });
      };
    });
    const abort = () => controller.abort();
    const internallyAborted = () => cancelWait?.();
    context.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', internallyAborted, { once: true });
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, 10_000);

    try {
      const open = this.readPort?.openEvidence;
      const pending =
        candidate && open && this.identity
          ? operation.kind === 'messages' && operation.query !== undefined
            ? open.call(
                this.readPort,
                requireValid(CandidateSchema, candidate),
                this.identity,
                { signal: controller.signal },
                operation.query,
              )
            : open.call(this.readPort, requireValid(CandidateSchema, candidate), this.identity, {
                signal: controller.signal,
              })
          : this.readPort?.read(operation, this.identity, { signal: controller.signal });
      const raw = await Promise.race([pending, cancelled]);

      if (context.signal.aborted) return { status: 'cancelled' };

      if (this.invalidated) return { status: 'scope-changed' };

      if (controller.signal.aborted) return { status: timeout ? 'timeout' : 'scope-changed' };

      const result = validate(GoogleReadResultSchema, raw);

      if (!result.ok) return { status: 'schema-changed' };

      if (
        result.value.status === 'scope-changed' ||
        result.value.status === 'login-expired' ||
        result.value.status === 'permission-needed'
      )
        this.invalidate();

      if (result.value.status === 'success') {
        const value = result.value;

        if (
          value.identityBefore !== value.identityAfter ||
          (this.identity !== undefined && this.identity !== value.identityBefore)
        ) {
          this.invalidate();

          return { status: 'scope-changed' };
        }

        this.identity = value.identityBefore;
      }

      return result.value;
    } catch {
      return {
        status: context.signal.aborted
          ? 'cancelled'
          : controller.signal.aborted
            ? timeout
              ? 'timeout'
              : 'scope-changed'
            : 'unavailable',
      };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', internallyAborted);
      this.pending.delete(controller);
    }
  }

  // Lifecycle owners must retire this instance on account/document changes and create a new one.
  // This is an invalidation seam, not an observer of the Google account or browser context.
  invalidate(): void {
    this.invalidated = true;
    this.identity = undefined;
    this.candidates.clear();
    this.candidateRequestKey = undefined;

    for (const controller of this.pending) controller.abort();
  }
}
