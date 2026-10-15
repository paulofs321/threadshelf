# Foundation regression tests

Run the complete suite and enforced source coverage with Node 22.12+ within Node 22:

```sh
npm ci
npm run test:coverage
npm run lint
npm run check
npm run build
```

`npm test` runs the same tests without coverage. Focused runs are available with
`npm test -- tests/contracts`, `npm test -- tests/platform`, or
`npm test -- tests/ui tests/entrypoints`. Run provider suites with
`npm test -- tests/providers/chatgpt` or `npm test -- tests/providers/google-ai-mode`.
Run `npm test -- tests/search` for pure keyword orchestration and synthetic adapter composition.

The combined suite covers both provider adapters and their Chrome hosts, with synthetic contract,
transport, parser, identity, lifecycle and evidence regressions. All fixtures are handwritten fiction;
tests perform no live provider or account reads. Contract/platform tests run in Node. UI tests use
jsdom and React Testing Library with explicit cleanup and mocked Chrome APIs. Entrypoint tests check toolbar
configuration and panel mounting without starting an actual extension.

| Area                                 | Demonstrated behavior and defective scenarios                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives/query/session             | Exact numeric/string/UTF-16 limits, malformed IDs/controls, canonical UTC/leap dates, timezone validation, duplicate/unselected providers, incomplete scopes, unknown identity and safe errors                                                                                                                                            |
| Conversation/evidence                | Exact candidate/title/evidence budgets, aggregate text limit, unique scoped conversations/evidence, exact optional metadata, provenance, half-open dates, unknown dates, hostile text and unsafe links                                                                                                                                    |
| Array preflight                      | Oversized provider/scope/candidate/evidence/model/result/coverage arrays are rejected before a spy-backed hostile member getter is read                                                                                                                                                                                                   |
| Provider/aggregate outcomes          | All 100 two-provider status combinations plus every single-provider status; conflicting completion states, failed versus empty success, coverage suppression, retry hints, missing/stale references and hidden unsafe links                                                                                                               |
| Model boundaries                     | Exact term/selection/evidence budgets, score endpoints, duplicate/fabricated/cross-candidate IDs, explicit-filter overrides, stale account/workspace/generation contexts and empty retrieval                                                                                                                                              |
| Optional cache contracts             | Verified/versioned keys, cross-account/workspace/generation entries, future writes, one-millisecond and maximum TTL, exclusive expiry, unverified links and malformed caller clocks                                                                                                                                                       |
| Broker                               | Sender/frame/document/window/origin guards, replay/concurrency/ID bounds, redirects/reloads, browser exceptions, context invalidation, cancellation/timeout/revocation at each of eight asynchronous boundaries and recovery                                                                                                              |
| Client + broker together             | Queued message delivery between the actual classes, delayed cancellation/retry, worker/panel deadlines, suspension before delivery, obsolete scope reuse, provider changes and independent panels                                                                                                                                         |
| Chrome composition/probe             | Exact origins and isolated document targets, ambiguous tabs/owners, canonical window bindings, global panel windowId -1, independent multi-window panels, window closure, targeted revocation, late output and closure-free serialized script behavior                                                                                    |
| Panel/view/entrypoints               | Synchronous optional permission requests, denied/thrown/rejected permission outcomes, cancel while native permission is pending, explicit failures, fresh scopes, provider isolation, worker reconnect, teardown, safe fallback status, toolbar lifecycle and missing DOM root                                                            |
| Unavailable ChatGPT boundary         | Immutable verification diagnostic; no network/logging/timers; malformed/missing/extra inputs; account/workspace/partition/kind/generation isolation; scope snapshots; idempotent invalidation; cancellation priority/recovery; concurrent correlation; obsolete reply rejection; unavailable versus empty success                         |
| Google boundary without a bound port | Immutable missing-evidence diagnostic; no network/logging/timers; strict request/scope validation; Gemini alias rejection; scope snapshots; account/workspace/partition/kind/generation isolation; cancellation/retirement/recovery; obsolete account replies; cross-provider isolation and aggregate failure without fabricated coverage |

Google read/parser suites also cover native snippets absent from titles, genuine empty envelopes,
malformed XSSI/JSON, duplicate records, hostile links/text, missing metadata, result/text bounds,
HTTP/Retry-After mapping, before/after account changes, internal abort cleanup, obsolete replies,
exact evidence inventory ownership and closure-free document serialization.

Search suites exercise all 100 two-provider terminal-status combinations through the engine,
useful partial matches and partial zero matches, actual adapters with synthetic transports, strict
input/output/link validation, scoped deduplication and conflicting metadata/evidence. Fake timers
cover queued/active cancellation, replacement with reused IDs, ports that ignore abort, total and
provider deadlines, occupied concurrency slots, rate-limit cooldowns, logout and generation races,
including invalidating an already completed provider while another remains pending. Calendar cases
cover browser-timezone month/year/leap boundaries, fractional offsets, 23/25-hour days, midnight
transitions and a skipped civil date. Available-date meanings, unknown-date exclusions and all
coverage reasons remain visible. Every fake-timer lifecycle test checks for zero remaining timers.

Coverage includes every runtime TypeScript/TSX source file under `src`, including the panel and
entrypoints. `npm run test:coverage` writes ignored text/JSON/HTML reports under `coverage/`; open
`coverage/index.html` for the detailed report. Tests and generated artifacts are not part of the
coverage source denominator. Type-only interfaces and re-export modules contain no executable
statements. Missing test suites and `.only` cases fail.

The configured minimums are 100% lines/functions, 98% statements and 97% branches across runtime
source, with 100% in all four metrics for contract code. The final coverage run includes the
connected ChatGPT adapter, isolated reader, wire parsers and Chrome host; thresholds are unchanged.
Defensive short-circuit branches in the UI/transport are outside complete branch coverage.
These measurements are regression guards, not evidence that a
website authenticates the extension or that every possible failure has been reproduced.

The unmount test demonstrated a retained disconnect-error listener. Error consumption now runs
through the client's existing interruption subscription, which is invoked synchronously in the
Chrome disconnect callback; no separate port listener is registered. The regression requires zero
remaining message/disconnect listeners and timers after panel unmount.
Unexpected status keys such as `constructor`, `toString` and `__proto__` previously read inherited
dictionary properties and produced empty text or a render error. The view now checks own dictionary
entries and falls back to unavailable text; all three defective cases have regression coverage.

The Google integration was verified separately on October 15, 2026 in native Google Search and an
actual unpacked Chrome extension. Isolated-world reads returned three snippet-only keyword matches,
a genuine empty search, a capped partial list and a consistent fresh account fingerprint. A concrete
Chrome-host check reopened one retrieved thread in a background tab, returned bounded rendered
evidence, closed that tab and preserved the source URL. These observations establish the tested
context, not complete-history access or universal account/browser support.

`tests/platform/google-ai-mode.test.ts` covers the concrete host with mocked Chrome APIs: scoped
candidate membership/link validation, pinned document/frame IDs, owning context and permission
checks, source/temporary-tab changes, account rechecks, stalled reads, abort-injection rejection,
late tab creation and listener/timer/tab cleanup. Permission-removal tests distinguish the Google
origin/shared scripting permission from unrelated removals and verify an unaffected session stays ready.
Broker tests cover selected-document capabilities, replacement/closure and conservative context lookup.

ChatGPT live verification is separate from these synthetic tests. The actual unpacked extension
returned five native-matching keyword results, four exact API text excerpts, a successful empty
search and a partial 50-row list in a personal account. An original link reopened in the same
account, preserved the source and its temporary tab closed. API text has separate provenance from
rendered message text; their equivalence was not established. See the [adapter reference](chatgpt-adapter.md).

The ChatGPT suites cover malformed/additive fields, dates/links, active message branches, hidden/
analysis/tool content, exact text and aggregate budgets; HTTP/MIME/JSON/UTF-8/redirect failures;
identity/workspace changes, request/query correlation, supersession, navigation, revocation and cleanup.

Live checks did not force logout/account switching, HTTP failures or permission revocation; those
paths have synthetic coverage. Google nondefault accounts, timestamp meanings, continuation beyond
300 and complete-message access remain unresolved. ChatGPT workspaces, tab-free behavior, pagination
and full-history reach remain unsupported or unverified. The actual Google panel Connect path selected
the site after the context fix; panel search controls, multi-window interaction and full accessibility
acceptance remain future work. Fixtures contain no live payloads.
