import * as v from 'valibot';
import { CandidateListSchema } from '../../contracts/conversation';
import type { Candidate } from '../../contracts/conversation';
import { ProviderOutcomeSchema } from '../../contracts/outcome';
import type { Coverage, ProviderOutcome } from '../../contracts/outcome';
import type { OperationContext, ProviderPort } from '../../contracts/ports';
import { limits } from '../../contracts/primitives';
import { ProviderRequestSchema } from '../../contracts/query';
import type { ProviderRequest } from '../../contracts/query';
import { sameScope, SessionScopeSchema } from '../../contracts/session';
import type { SessionOutcome, SessionScope } from '../../contracts/session';
import { requireValid, validate } from '../../contracts/validation';
import { chatGptAvailability } from './availability';
import { ChatGptReadResultSchema } from './transport';
import type { ChatGptOperation, ChatGptReadPort, ChatGptReadResult } from './transport';
import { parseChatGptCandidates, parseChatGptMessages } from './wire';

const ChatGptScopeSchema = v.pipe(
  SessionScopeSchema,
  v.check((scope) => scope.provider === 'chatgpt'),
);
const ChatGptRequestSchema = v.pipe(
  ProviderRequestSchema,
  v.check((request) => request.scope.provider === 'chatgpt'),
);
type Failure = Exclude<ChatGptReadResult, { status: 'success' }>;
const connectedCapabilities = Object.freeze({
  status: 'session-required' as const,
  operations: Object.freeze(['search', 'list', 'messages'] as const),
  account: 'personal-only' as const,
});

export class ChatGptProvider implements ProviderPort {
  readonly provider = 'chatgpt' as const;
  // No read port means explicitly unavailable. Composition is a trusted, in-process capability.
  get availability() {
    return this.port ? connectedCapabilities : chatGptAvailability;
  }
  private readonly selectedScope: SessionScope;
  private invalidated = false;
  private identity: string | undefined;
  private active: AbortController | undefined;
  private retrieved: { requestId: string; candidates: Candidate[]; coverage: Coverage } | undefined;

  constructor(
    scope: SessionScope,
    private readonly port?: ChatGptReadPort,
  ) {
    this.selectedScope = requireValid(ChatGptScopeSchema, scope);
  }

  async inspectSession(context: OperationContext): Promise<SessionOutcome> {
    if (this.invalidated)
      return {
        status: 'scope-changed',
        provider: this.provider,
        generation: this.selectedScope.generation,
      };
    if (!this.port || context.signal.aborted)
      return {
        status: 'unavailable',
        provider: this.provider,
        generation: this.selectedScope.generation,
      };
    const result = await this.run(context, (signal) => this.read({ kind: 'inspect' }, signal));
    if (result.status === 'success') return { status: 'ready', scope: { ...this.selectedScope } };

    return {
      status: ['login-expired', 'permission-needed', 'scope-changed'].includes(result.status)
        ? (result.status as 'login-expired' | 'permission-needed' | 'scope-changed')
        : 'unavailable',
      provider: this.provider,
      generation: this.selectedScope.generation,
    };
  }

  search(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    return this.candidates(input, context, 'search');
  }

  list(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    return this.candidates(input, context, 'list');
  }

  private async candidates(
    input: ProviderRequest,
    context: OperationContext,
    kind: 'search' | 'list',
  ): Promise<ProviderOutcome> {
    const request = requireValid(ChatGptRequestSchema, input);
    const early = this.unusable(request, context);
    if (early) return this.outcome(request, early);
    this.retrieved = undefined;
    const result = await this.run(context, async (signal) => {
      const read = await this.read(
        kind === 'search' ? { kind, query: request.query.text } : { kind },
        signal,
      );
      if (read.status !== 'success') return read;
      try {
        const parsed = parseChatGptCandidates(read.body, request.scope, kind);
        if (request.query.dateRange && parsed.candidates.some((c) => !c.date))
          parsed.coverage.reasons.push('unknown-dates');
        this.retrieved = {
          requestId: request.requestId,
          candidates: requireValid(CandidateListSchema, parsed.candidates),
          coverage: structuredClone(parsed.coverage),
        };

        return { ...read, body: parsed };
      } catch {
        return { status: 'schema-changed' as const };
      }
    });
    if (result.status !== 'success') return this.outcome(request, result);
    const parsed = result.body as { candidates: Candidate[]; coverage: Coverage };

    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      status: 'success',
      ...parsed,
    });
  }

  // Enrich only candidates from this instance's latest successful request, at most three reads.
  // Never accepts caller-supplied URLs/IDs or silently enumerates all history.
  async enrich(input: ProviderRequest, context: OperationContext): Promise<ProviderOutcome> {
    const request = requireValid(ChatGptRequestSchema, input);
    const early = this.unusable(request, context);
    if (early) return this.outcome(request, early);
    const previous = this.retrieved;
    if (!previous || previous.requestId !== request.requestId)
      return this.outcome(request, { status: 'scope-changed' });
    const candidates = requireValid(CandidateListSchema, previous.candidates);
    const coverage = structuredClone(previous.coverage);
    const result = await this.run(context, async (signal) => {
      let total = candidates.reduce(
        (n, c) => n + c.evidence.reduce((sum, e) => sum + e.text.length, 0),
        0,
      );
      for (const candidate of candidates.slice(0, 3)) {
        const read = await this.read(
          { kind: 'messages', conversationId: candidate.conversationId },
          signal,
        );
        if (read.status !== 'success') return read;
        let excerpts: string[];
        try {
          excerpts = parseChatGptMessages(read.body, candidate.conversationId);
        } catch {
          return { status: 'schema-changed' as const };
        }
        for (const excerpt of excerpts) {
          if (
            candidate.evidence.length >= limits.evidencePerCandidate ||
            total >= limits.totalEvidence
          )
            break;
          const text = excerpt.slice(0, limits.totalEvidence - total);
          if (!text.trim() || candidate.evidence.some((e) => e.text === text)) continue;
          candidate.evidence.push({
            id: `${candidate.id}:message:${candidate.evidence.length}` as Candidate['evidence'][number]['id'],
            text,
            source: 'provider-message',
          });
          total += text.length;
        }
      }
      if (!coverage.reasons.includes('missing-evidence')) coverage.reasons.push('missing-evidence');
      if (candidates.length > 3 && !coverage.reasons.includes('query-budget'))
        coverage.reasons.push('query-budget');
      coverage.extent = 'partial';

      return {
        status: 'success' as const,
        identityBefore: this.identity as string,
        identityAfter: this.identity as string,
        body: { candidates, coverage },
      };
    });
    if (result.status !== 'success') return this.outcome(request, result);

    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      status: 'success',
      ...(result.body as { candidates: Candidate[]; coverage: Coverage }),
    });
  }

  invalidate(): void {
    this.invalidated = true;
    this.identity = undefined;
    this.retrieved = undefined;
    this.active?.abort();
  }

  private unusable(request: ProviderRequest, context: OperationContext): Failure | undefined {
    if (context.signal.aborted) return { status: 'cancelled' };
    if (this.invalidated || !sameScope(request.scope, this.selectedScope))
      return { status: 'scope-changed' };
    if (!this.port) return { status: 'unavailable' };
  }
  private outcome(request: ProviderRequest, failure: Failure): ProviderOutcome {
    return requireValid(ProviderOutcomeSchema, {
      requestId: request.requestId,
      scope: request.scope,
      ...failure,
    });
  }
  private async read(operation: ChatGptOperation, signal: AbortSignal): Promise<ChatGptReadResult> {
    if (signal.aborted) return { status: 'cancelled' };
    if (!this.port) return { status: 'unavailable' };
    const parsed = validate(
      ChatGptReadResultSchema,
      await this.port.read(operation, this.identity, { signal }),
    );
    if (signal.aborted) return { status: 'cancelled' };
    if (this.invalidated) return { status: 'scope-changed' };
    if (!parsed.ok) return { status: 'schema-changed' };
    const result = parsed.value;
    if (result.status === 'success') {
      if (
        result.identityBefore !== result.identityAfter ||
        (this.identity !== undefined && this.identity !== result.identityBefore)
      ) {
        this.invalidate();

        return { status: 'scope-changed' };
      }
      this.identity = result.identityBefore;
    } else if (result.status === 'scope-changed') this.invalidate();
    else if (result.status === 'login-expired') {
      // Retire without racing this terminal login failure against our abort listener.
      this.invalidated = true;
      this.identity = undefined;
      this.retrieved = undefined;
    }

    return result;
  }
  private async run(
    context: OperationContext,
    action: (signal: AbortSignal) => Promise<ChatGptReadResult>,
  ): Promise<ChatGptReadResult> {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    let timedOut = false;
    let stopped: (value: ChatGptReadResult) => void;
    const interruption = new Promise<ChatGptReadResult>((resolve) => {
      stopped = resolve;
    });
    const cancel = () => {
      controller.abort();
      stopped({ status: this.invalidated ? 'scope-changed' : timedOut ? 'timeout' : 'cancelled' });
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    context.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, 10_000);
    try {
      const result = await Promise.race([action(controller.signal), interruption]);
      if (context.signal.aborted) return { status: 'cancelled' };
      if (this.invalidated && result.status !== 'login-expired') return { status: 'scope-changed' };

      return controller.signal.aborted ? { status: timedOut ? 'timeout' : 'cancelled' } : result;
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', cancel);
      if (this.active === controller) this.active = undefined;
    }
  }
}
