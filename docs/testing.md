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
`npm test -- tests/ui tests/entrypoints`. Run the unavailable ChatGPT boundary tests with
`npm test -- tests/providers/chatgpt`.

The suite contains 633 cases across 21 files, including 66 ChatGPT boundary cases. All fixtures are
handwritten fiction; tests perform no live provider or account reads. Contract/platform tests run in
Node. UI tests use jsdom and React
Testing Library, with explicit cleanup and mocked Chrome APIs. The entrypoint tests check toolbar
configuration and panel mounting without starting an actual extension.

| Area                         | Demonstrated behavior and defective scenarios                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives/query/session     | Exact numeric/string/UTF-16 limits, malformed IDs/controls, canonical UTC/leap dates, timezone validation, duplicate/unselected providers, incomplete scopes, unknown identity and safe errors                                                                                                                    |
| Conversation/evidence        | Exact candidate/title/evidence budgets, aggregate text limit, unique scoped conversations/evidence, exact optional metadata, provenance, half-open dates, unknown dates, hostile text and unsafe links                                                                                                            |
| Array preflight              | Oversized provider/scope/candidate/evidence/model/result/coverage arrays are rejected before a spy-backed hostile member getter is read                                                                                                                                                                           |
| Provider/aggregate outcomes  | All 100 two-provider status combinations plus every single-provider status; conflicting completion states, failed versus empty success, coverage suppression, retry hints, missing/stale references and hidden unsafe links                                                                                       |
| Model boundaries             | Exact term/selection/evidence budgets, score endpoints, duplicate/fabricated/cross-candidate IDs, explicit-filter overrides, stale account/workspace/generation contexts and empty retrieval                                                                                                                      |
| Optional cache contracts     | Verified/versioned keys, cross-account/workspace/generation entries, future writes, one-millisecond and maximum TTL, exclusive expiry, unverified links and malformed caller clocks                                                                                                                               |
| Broker                       | Sender/frame/document/window/origin guards, replay/concurrency/ID bounds, redirects/reloads, browser exceptions, context invalidation, cancellation/timeout/revocation at each of eight asynchronous boundaries and recovery                                                                                      |
| Client + broker together     | Queued message delivery between the actual classes, delayed cancellation/retry, worker/panel deadlines, suspension before delivery, obsolete scope reuse, provider changes and independent panels                                                                                                                 |
| Chrome composition/probe     | Exact origins and isolated document targets, ambiguous tabs/owners, canonical window bindings, global panel windowId -1, independent multi-window panels, window closure, targeted revocation, late output and closure-free serialized script behavior                                                            |
| Panel/view/entrypoints       | Synchronous optional permission requests, denied/thrown/rejected permission outcomes, cancel while native permission is pending, explicit failures, fresh scopes, provider isolation, worker reconnect, teardown, safe fallback status, toolbar lifecycle and missing DOM root                                    |
| Unavailable ChatGPT boundary | Immutable verification diagnostic; no network/logging/timers; malformed/missing/extra inputs; account/workspace/partition/kind/generation isolation; scope snapshots; idempotent invalidation; cancellation priority/recovery; concurrent correlation; obsolete reply rejection; unavailable versus empty success |

Coverage includes every runtime TypeScript/TSX source file under `src`, including the panel and
entrypoints. `npm run test:coverage` writes ignored text/JSON/HTML reports under `coverage/`; open
`coverage/index.html` for the detailed report. Tests and generated artifacts are not part of the
coverage source denominator. Type-only interfaces and re-export modules contain no executable
statements. Missing test suites and `.only` cases fail.

The configured minimums are 100% lines/functions, 98% statements and 97% branches across runtime
source, with 100% in all four metrics for contract code. This review measured 100% lines/functions,
98.90% statements and 97.48% branches. The ChatGPT boundary has 100% in all four metrics.
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

Real Chrome toolbar/permission/context metadata, layout, keyboard activation, cookie/CORS behavior,
account/workspace discovery and authenticated provider reads still require an unpacked-extension
check. DOM/mocked tests do not establish those integrations or a full accessibility audit.
The ChatGPT module contains no HTTP transport/parser, so its synthetic tests do not exercise real or
simulated search response envelopes, HTTP failure mappings, provider identity or conversation evidence.
