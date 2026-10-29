import type { SearchPort, SearchRequest, SessionScope, OperationContext } from '../contracts';
import { sameScope } from '../contracts';
import type { AccessClient } from './client';

/** Recheck the original identity after local ranking and before exposing any completed evidence. */
export class SessionCheckedSearch implements SearchPort {
  constructor(
    private readonly searchPort: SearchPort,
    private readonly access: Pick<AccessClient, 'verify'>,
  ) {}

  async search(request: SearchRequest, context: OperationContext) {
    const outcome = await this.searchPort.search(request, context);

    if (context.signal.aborted) return outcome;

    const checked = await Promise.all(
      outcome.outcomes.flatMap((item) =>
        item.status === 'success'
          ? [
              this.access
                .verify(item.scope, context.signal)
                .then((reply) => reply.status === 'verified' && sameScope(reply.scope, item.scope)),
            ]
          : [],
      ),
    );

    if (context.signal.aborted || checked.some((valid) => !valid))
      throw new Error('Session verification interrupted. Reconnect.');

    return outcome;
  }

  invalidate(scope: SessionScope): void {
    this.searchPort.invalidate(scope);
  }
}
