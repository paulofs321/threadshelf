# Keyword search engine

`src/search` exports `KeywordSearch`, a browser-independent implementation of `SearchPort`.
Construct one instance per search surface with normalized `ProviderPort` implementations and their
original-link verifiers. It also accepts synthetic ports for tests or a future demo. The engine
imports no UI, Chrome APIs, provider transports, model or storage implementation.

`search(request, { signal })` validates and snapshots a keyword `SearchRequest`, calls only its
explicitly selected providers, validates replies against the request and full session scope, then
returns a validated `SearchOutcome`. The provider search operation owns fresh authentication checks;
the engine does not add a separate inspection call, list history, enrich messages or infer pagination.
Description mode is rejected until its separate pipeline exists.

## Results and coverage

Results are candidate IDs referencing the retrieved inventories in successful provider outcomes.
Order follows explicit provider selection and each provider's native order, regardless of response
timing. There is no cross-provider relevance or chronological ordering claim.

Repeated conversations coalesce by provider, full account/workspace or ephemeral scope, generation
and conversation ID. Equal titles do not establish identity. The first candidate ID survives;
distinct exact evidence is retained within the shared bounds. Missing metadata can be filled from
the same scoped conversation. Conflicting metadata, evidence IDs or candidate IDs fail that provider
with `schema-changed`. Original links must pass the injected provider policy. Unsafe links are
rejected even for candidates later excluded by a date or result limit.

Every selected provider has its own outcome. Successful providers keep useful results when another
fails. All-success completion has `state: success`; mixed success/failure has `partial`; no successful
provider has `failure`, except all-cancelled outcomes have `cancelled`. Genuine empty results have
zero result IDs and successful provider outcomes. Zero results with a failed provider remain partial
or failed. Login expiry, missing permission, unavailability, schema changes, rate limits, timeout,
cancellation, scope changes and interruption retain their exact provider statuses.

Completion and coverage are independent. `complete`, `partial` or `unknown` coverage retains every
provider limit and adds exclusions such as `unknown-dates`, `result-limit`, `query-budget` or
`provider-failure`. Successful native search does not imply complete conversation history.

## Dates

Normalized date constraints are UTC half-open intervals `[start, end)`. `calendarDateRange(start,
end, timeZone)` converts local `YYYY-MM-DD` calendar boundaries using the supplied browser timezone;
the end date is exclusive. It handles DST days and fractional-hour offsets without assuming a
24-hour day. Invalid, reversed or skipped civil dates are rejected. Calendar dates support years
1000–9999. `previousCalendarMonth(now, timeZone)` uses an explicit canonical UTC clock to return
the previous calendar month; it performs no natural-language query interpretation.

Filtering uses a candidate's available date, preserving its meaning and source. Conversation
creation/update metadata does not establish when a particular topic or message occurred. Undated
candidates cannot satisfy a date constraint; their retrieved evidence and `unknown-dates` disclosure
remain in the outcome. Google currently supplies no verified dates. The exported
`availableDateDisclosure` gives future views a shared explanation of these semantics.

## Lifecycles and budgets

Starting a valid search cancels the previous run, including its already completed provider results.
Invalid replacement input does not cancel valid work. Abort cancels queued and active work, prevents
new dispatch and removes obsolete results. Provider/request deadlines preserve other completed
providers. Late responses and rejections cannot alter the returned outcome.

The owner must call `invalidate(scope)` when selection, account/workspace, login or permission changes,
and clear that provider's already displayed results. Invalidation aborts matching pending reads and
erases completed results from an active aggregate. Older generations cannot retire newer selections;
retired or regressing scopes cannot dispatch work. Login-expired, permission-needed and scope-changed
provider outcomes retire that scope. Reconnection needs a fresh scope/generation and suitable ports.
The engine does not observe browser events or retain completed outcomes as a cache.

| Policy                        | Default | Allowed range |
| ----------------------------- | ------- | ------------- |
| `concurrency`                 | 2       | 1–2           |
| `maxProviderCalls` per search | 2       | 1–2           |
| `maxResults`                  | 200     | 1–200         |
| `providerTimeoutMs`           | 12,000  | 1–60,000      |
| `requestTimeoutMs`            | 25,000  | 1–60,000      |

Each selected provider receives at most one search call; there are no automatic retries. A valid
rate-limit hint blocks new calls to that provider until its bounded cooldown expires, with a
one-second cooldown when no hint is available. Caller retries still receive `rate-limited` and the
remaining hint. No timer schedules background work.

At most one physical promise per provider and `concurrency` total remain pending per engine instance.
If a port ignores abort, it holds its slot until it settles; further calls report `interrupted`
instead of accumulating abandoned work. Both normal and abandoned operations consume late failures
without logging private exception text. Shared input limits remain 100 candidates and 64,000 evidence
code units per provider, eight evidence items per candidate and 2,000 code units per excerpt.
Deduplicated evidence exceeding the candidate bound is disclosed as `missing-evidence`.

## Verification and composition status

Run `npm test -- tests/search` for synthetic retrieval, normalized adapter composition, all provider
status combinations, date boundaries, malformed replies, deduplication, budgets, rate limits,
cancellation, timeout and scope races. Fake timers verify deadlines and cleanup without live waits.
These checks do not establish live Chrome or provider authentication.

The engine is implemented independently of the panel. The current extension still exposes setup
controls; full search controls and browser lifecycle composition remain separate work. No dependency,
extension permission, live probe, model call or persistent storage was added by this engine.
