# Developer notes

## Current layout

| Path                            | Role                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `src/entrypoints/`              | WXT background and side panel entrypoints                                  |
| `src/ui/`                       | Shared shadcn/ui keyword search, results and connection controls           |
| `src/contracts/`                | Normalized runtime schemas, validation helpers and ports                   |
| `src/platform/`                 | Selected-tab broker, context validation and access lifecycle               |
| `src/providers/chatgpt/`        | Verified personal-account ChatGPT reads, normalization and identity checks |
| `src/providers/google-ai-mode/` | Verified Google read adapter, wire parsing and document reader             |
| `src/search/`                   | Keyword orchestration, scoped deduplication, cancellation and date filters |
| `src/description/`              | Reserved for interpretation, ranking, and evidence validation              |
| `src/storage/`                  | Reserved for isolated optional local storage                               |
| `tests/contracts/`              | Synthetic contract and boundary regression tests                           |
| `tests/platform/`               | Synthetic broker, panel client and Chrome API wiring tests                 |
| `tests/providers/chatgpt/`      | Synthetic ChatGPT parser, transport, identity and scope tests              |
| `tests/fixtures/`               | Handwritten fictional normalized data and link policies                    |
| `demo/`                         | Reserved for the future synthetic static demo                              |
| `public/`                       | Only deliberately public extension assets                                  |

Empty directories contain `.gitkeep` files. They do not implement the reserved capability. Keep
shared contracts, orchestration, and presentation independent of authenticated adapters so a future
demo can supply synthetic capabilities without importing browser session access.

## Build and checks

WXT discovers `src/entrypoints/sidepanel/index.html` and generates the MV3 side panel manifest.
The React integration uses `@wxt-dev/module-react`; TypeScript extends the generated WXT config.
See the official [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints.html),
[React module](https://wxt.dev/guide/essentials/frontend-frameworks.html), and
[TypeScript configuration](https://wxt.dev/guide/essentials/config/typescript.html) documentation.
Chrome documents the [side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

Run the established checks with the synthetic tests and lint:

```sh
npm test -- tests/contracts
npm test -- tests/platform
npm test -- tests/providers/chatgpt
npm test
npm run test:coverage
npm run lint
npm run check
npm run build
```

`npm test` uses Vitest's non-watch runner. `npm run test:watch` watches the same suites. Test discovery
uses `tests/**/*.test.{ts,tsx}` with explicit imports. Contract/platform suites run in Node; panel/view
suites opt into jsdom with React Testing Library and explicit teardown. No provider/network access is
needed. Missing suites and focused `.only` tests fail. These checks prove contracts and access
boundary behavior using handwritten fictional metadata and injected/mocked Chrome APIs. They do
not establish actual installed-extension behavior or authenticated provider access. GitHub Actions
runs the locked install, tests, lint, type/format checks, and Chrome extension build on pull requests
and pushes to `main`. It does not upload artifacts or build the planned demo. ZIP commands remain
planned.
See [testing](testing.md) for the complete defective-scenario matrix, coverage thresholds and ignored
reports, and [technical foundation](foundation.md) for the implemented data and request flow.

ESLint uses its recommended core rules and Babel 7's TypeScript syntax parser. The pinned TypeScript
7 compiler owns type checking, name resolution and unused declarations via `npm run check`.
`typescript-eslint` 8.71.2 excludes TypeScript 7 in its peer range; ESLint 10 and Babel 8 also require
newer Node versions than this project's minimum. The compatible ESLint 9/Babel 7 versions are pinned
without compiler downgrades or peer-dependency overrides. Type-aware ESLint rules are not enabled.
Contract lint rules reject browser/adapter imports, browser globals, `any`, and non-null assertions.
See the official [ESLint configuration](https://eslint.org/docs/latest/use/configure/configuration-files)
and [Babel ESLint parser](https://babeljs.io/docs/babel-eslint-parser) documentation.

## Shared shadcn/ui panel

`components.json` uses the existing WXT `@/*` source alias and the `new-york` shadcn style.
Copied button/input/card/badge/alert/tabs primitives live under `src/ui/components`; unused card/alert
subcomponents were omitted. The upstream MIT notice ships in `public/third-party/shadcn-ui.txt`.
Button text wraps for narrow panels. `src/ui/styles.css` contains shared
CSS variable tokens adapted to the supplied Figma reference (white surfaces, muted green accents),
and imports Tailwind 4 through `@tailwindcss/vite` in WXT’s Vite hook. Radix-backed source tabs expose
All sources/ChatGPT/Google AI Mode without repeating provider requests. Connections live on a
separate welcome page reached through the conversation header’s Connect button; connected
providers show a confirmation instead of another Connect action. Search state and provider clients
stay mounted across page navigation, with focus recovery and no extra permission requests. Advanced
search settings collapse behind the header button. Compact previews expand exact evidence, and
date sorting keeps unknown dates last. The footer repeats a real search rather than reporting unavailable sync/history totals.
Explicit CSS source roots scan only UI and panel source. No replacement Vite app/tsconfig, hosted
fonts, remote code or new extension permissions are required. ESLint prevents browser/provider
imports and fetches in shared UI. Native labels, select, checkboxes and date inputs retain their
browser keyboard behavior. See the official [existing Vite setup](https://ui.shadcn.com/docs/installation/vite),
[components configuration](https://ui.shadcn.com/docs/components-json), and
[Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite).

Run the separate browser smoke after a production build:

```sh
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
npm run build
npm run test:browser
```

It copies the production extension into a temporary directory, adds a separate synthetic UI harness,
and loads it in an isolated Chromium profile. Production UI mounting and theme are checked alongside
synthetic cancellation/reconnect, safe links, keyboard/focus, 240–400px widths and absence of external
requests or CSP errors. It also opens the real native side panel and exercises both real provider
adapters/readers through keyword requests against intercepted synthetic HTTP responses, including
a repeat search after switching tabs. A temporary manifest pregrants the exact optional hosts and
scripting; its test-only driver bypasses the permission dialog. Gesture/denial behavior is tested
separately in components. DNS is blackholed, and fixture pages are prepared before navigation.
The profile/extension copy are deleted even on failure. Fixtures/drivers never enter production
output. Live accounts and screen-reader acceptance remain separate; CI’s checks are unchanged.

## Shared contracts

Valibot's modular schemas provide runtime validation and inferred TypeScript types. Shared code
imports neither Chrome APIs nor provider transports. All objects reject unknown keys; arrays and
text have explicit operation budgets in `src/contracts/primitives.ts`. Array size is checked before
member validation. Limits measure UTF-16 code units for strings. See the official
[Valibot installation guide](https://valibot.dev/guides/installation/),
[strict objects](https://valibot.dev/api/strictObject/), and
[Vitest guide](https://vitest.dev/guide/).

| Module                           | Available behavior                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `primitives.ts`, `validation.ts` | Branded opaque IDs, bounds, safe failure results, canonical UTC dates and HTTPS URLs |
| `session.ts`                     | Verified/ephemeral scopes, generation comparison and session outcomes                |
| `calendar.ts`                    | Calendar validation, timezone formatting and DST-aware local day boundaries          |
| `conversation.ts`                | Candidates, exact evidence/provenance, date meanings and scoped conversation keys    |
| `query.ts`                       | Query/provider selection, half-open date intervals and request/scope consistency     |
| `outcome.ts`                     | Distinct provider failures/successes, coverage and aggregate reference validation    |
| `model.ts`                       | Bounded plans and candidate/evidence selections; contextual filter/reference checks  |
| `storage.ts`                     | Versioned verified-scope cache entry contracts and clock-based expiry validation     |
| `ports.ts`                       | Provider/search/model/storage interfaces with injected cancellation signals          |

Use `validate(schema, unknownInput)` at boundaries. It returns `{ ok: true, value }` or
`{ ok: false, code: 'invalid-contract' }`. Detailed library errors may contain private input and must
not be logged. `requireValid` is for constructing trusted validation context and throws a generic
error on invalid context. Provider/model/storage port outputs remain `unknown` until validated.
Interfaces contain no live implementations.

Structural validation establishes shape, not provider identity or link ownership. Use
`providerOutcomeSchemaFor(request, linkVerifiers)` and `searchOutcomeSchemaFor(request, linkVerifiers)`
to check active request IDs, full session scopes/generations and injected adapter link policies.
The generic URL schema permits only canonical HTTPS without credentials or custom ports; adapters
must additionally verify observed origins, paths and conversation identifiers. A URL with no
matching policy fails closed. Unknown original links are omitted. No real provider URL policy is
implemented yet.

Verified scopes require opaque local account/workspace partitions; `workspacePartition: null` means
the provider has no workspace. Unknown account or workspace identity uses a fresh ephemeral
partition. Neither schema validation nor a `kind: 'verified'` label proves actual ownership: future
browser/adapters must establish that evidence and invalidate scope on context changes. Ephemeral
scopes cannot form persistent cache keys. Cache schemas do not enable persistence or user consent;
memory-only operation remains the default direction.

Missing titles/dates/links stay absent. Available dates carry a meaning (`conversation-created`,
`conversation-updated`, or `message-sent`) and provenance. A conversation creation/update timestamp
does not establish when a topic was discussed. Date constraints use normalized UTC `[start, end)`
intervals with a browser timezone on the query. Unknown dates cannot satisfy constraints and must be
disclosed as excluded in aggregate coverage. Optional `calendarDay` preserves date-only precision,
timezone and provider-date/time-only-today basis; its `at` must match the local day boundary. Google
time-only labels use the local date when read by explicit policy; general relative-label interpretation
is not implemented.

Provider success may contain an empty candidate list. Failures contain no candidates or fabricated
coverage. Aggregate results reference unchanged candidates in independent successful outcomes; all
requested providers must report an outcome. Terminal completion, candidate count and coverage are
separate: a successful search may have unknown reach, and no matches with another provider failing
remain partial. `complete` describes a verified requested operation, never an inferred full-history
guarantee. Aggregate coverage cannot hide failures or reported limits.

Use `modelPlanSchemaFor(request)` and `modelRankingSchemaFor(request, validatedCandidates)` for
model output. Structural model schemas alone cannot establish membership. Rankings can select only
retrieved candidate IDs and their own evidence IDs, with finite scores in `[0, 1]`. Unknown or
duplicate references, invented URLs/dates/quotations, and explicit filter overrides are rejected.
Application code maps references back to exact text/metadata. These checks establish grounding
references, not the semantic relevance of an excerpt or resistance of an actual model to injection.

The synthetic fixtures use invented account partitions/content and reserved `.invalid` links.
Their policies exercise origin/path/ID validation without making real provider endpoint assumptions.

## Selected-site access foundation

`src/platform/policy.ts` owns exact candidate origins and runtime context rules. `protocol.ts`
defines a strict versioned port protocol. `broker.ts` owns selected documents, generations,
cancellation and bounded operations through an injected `SelectedTabAccessPort`. `chrome-access.ts`
binds that port to Chrome APIs and lifecycle events. `panel-window.ts` resolves the calling panel's
browser window with cancellation and a 12-second deadline. `client.ts` owns panel-side request
deadlines and interruption handling. `document-probe.ts` contains the self-contained serialized isolated-world
function. It reads only origin/top-level status; it reads no page text, cookies, tokens, or identity.
The side panel composition owns browser interactions; shared React presentation imports no browser
or authenticated transport implementation. The current native connection controls extend the
development view; shadcn/ui configuration and the full search UI remain planned.

| Permission                 | Purpose and activation                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `sidePanel`                | Required to display the panel; toolbar action uses `setPanelBehavior`                        |
| `scripting`                | Optional; requested together with a site from the Connect button's synchronous click handler |
| `https://chatgpt.com/*`    | Optional exact ChatGPT origin; requested only when connecting ChatGPT                        |
| `https://www.google.com/*` | Optional candidate Search AI Mode origin; requested only when connecting that provider       |

There is no required host access, `tabs`, `activeTab`, `cookies`, `debugger`, `webNavigation`,
storage permission, wildcard host, persistent content script, external message endpoint, or fetch
bridge. Host permissions supply matching tab URL access; most tab events/query operations do not
need `tabs`. Host-pattern paths do not constrain network access, so the operation allowlist remains
essential. See Chrome's [tabs permission documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs),
[scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[optional permission API](https://developer.chrome.com/docs/extensions/reference/api/permissions), and
[runtime contexts](https://developer.chrome.com/docs/extensions/reference/api/runtime).

Only `runtime.connect` ports named `threadshelf:selected-tab:v1:window:<id>` are accepted, with a
canonical nonnegative integer ID. Trusted panel code obtains that ID from
[`windows.getCurrent({ populate: false })`](https://developer.chrome.com/docs/extensions/reference/api/windows#method-getCurrent)
in its own document before opening the port; a worker's current/last-focused window is not used.
Chrome-supplied sender ID, exact panel URL/origin, active document ID, and top-level/non-tab sender
are validated independently of the port name. The worker rechecks the bound window's existence and
regular profile before and after document checks; closing it disconnects the broker and aborts work.

The manifest requires Chrome 116 or later for `runtime.getContexts`. That API independently finds
the live regular-profile side panel, but global panels report `windowId: -1`, which carries no window
binding. If it supplies a nonnegative window ID, that value must agree with the binding. Missing or
unexpected context metadata fails closed. `ProviderTabs` resolves an independent provider source
in the bound window: an unambiguous supported existing page, an active matching page when several
exist, or a newly created inactive fixed landing page. Several inactive matches trigger a fresh
landing page. Rechecks remain pinned to the selected tab ID, exact URL, completed load, regular
profile and Chrome document ID; they fail closed if that source disappears. Provider sources can
remain inactive. Provider operation messages cannot supply a window, tab, URL, header, body, or
executable argument.

| Operation         | Allowed payload and result                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `connect`         | Bounded request ID and provider; selects the current document, with a fresh ephemeral scope    |
| `inspect-context` | Request ID/provider/current ephemeral scope; checks the pinned document and replaces its scope |
| `disconnect`      | Request ID/provider/current scope; clears the in-memory selection                              |
| `cancel`          | Existing request ID; aborts/discards pending work in that port                                 |

The same trusted connection also accepts `keyword-search` with a bounded normalized keyword
request, and `cancel-search` with its request ID. The worker composes the keyword engine with
current broker document bindings and the real provider factories. There is no URL/header/list/evidence
operation in this runtime bridge. Search replies undergo structural and request/scope/link/date
validation in the panel. Access and search each cap unique request IDs at 256 per connection. Search
has a separate 27-second panel deadline covering the engine’s 25-second deadline.
A `selected` reply always carries `session: 'unverified'`; it is neither a
`SessionOutcome` with authenticated readiness nor a successful provider search. Failures report
permission-needed, unavailable, scope-changed, timeout, cancelled, interrupted, or busy, without
private exception text or fabricated results. Panel reply validation checks provider/request IDs
and refuses reused partitions/generations, malformed output, and success after invalidation.

Chrome may omit document ID/lifecycle fields on an otherwise valid extension connection. The broker
still requires the exact extension ID/origin/panel URL and rejects supplied invalid lifecycle/frame/tab
metadata. When the sender omits its document ID, it queries **all** extension context types at the
canonical panel URL and admits only one actual regular `SIDE_PANEL` context. A same-URL extension
tab, multiple panels or missing identity fails closed. The independently resolved document ID is
pinned and rechecked, including against replacements at the same URL. This conservative fallback
cannot disambiguate multiple panels when Chrome supplies no sender document ID; close other panels
before reconnecting in that environment. It adds no page-provided context selector.

Initial document checks target frame 0. Chrome's injection metadata supplies the document ID;
confirmation and subsequent inspection target that exact ID, reject other frames/origins, and
recheck the tab, permission, and owning panel before returning. Both checks run in `ISOLATED`;
no main-world or extension-origin fetch is implemented. No authentication behavior is inferred from
the document marker. The broker allows one pending operation per provider per panel, at most four
panel brokers, and 256 unique operation IDs per port. Duplicate IDs or malformed requests close the
port. Requests expire after 10 seconds in the worker and 12 seconds independently in the panel.
There are no retries. Cancellation cannot undo an already dispatched Chrome injection, but it
aborts the operation signal, prevents further checks, and discards later output.

Navigation/loading or URL changes on a bound source, removed/replaced source tabs, permission
removal and port loss invalidate affected selections and pending work. Tab/window focus changes
preserve independent provider bindings. Unrelated navigation during a pending tab lookup is ignored;
the resolved provider document is checked and pinned before it can supply data. Removing a site's permission invalidates only that provider; removing
the shared `scripting` permission invalidates both. Invalidation reaches the panel before
terminal worker replies. Panel-owned timers cover a suspended/unresponsive worker; reconnect is
explicit through the Connect action. Incognito is disabled. Listeners for disconnected ports,
timers, abort subscriptions, and scopes are released. A strict empty `keepalive`/`alive` exchange
every 20 seconds keeps the worker active while the panel has connected scopes, without provider
reads or consuming request IDs. It stops when connections/panel close; unexpected worker loss still
fails closed. Only unchanged inactive connection-owned tabs are removed during cleanup.
Invalidation events carry generations; delayed cancellation/navigation events cannot clear a newer
selection or cause its fresh reply to be discarded.

Every document check creates a new opaque ephemeral partition/generation, including checks in the
same document. There is no private-data cache or persistence. This access foundation does not itself
read account data or produce a verified account scope. Both provider readers add fresh identity checks
around their own reads within ephemeral selections and reject changed sessions. Lifecycle owners
must retire adapters with their broker selections before displaying or reusing results. Unknown
identity cannot reuse an earlier check's data. A Chrome permission prompt itself cannot be cancelled
by this code; cancelling prevents the
subsequent broker operation and retry waits until that prompt settles.

## Keyword search

`KeywordSearch` composes normalized provider ports and link verifiers without UI or Chrome imports.
It validates keyword requests, applies provider and available-date filters, coalesces scoped
conversations and retains independent failures and coverage. Cancellation, query replacement,
scope retirement, deadlines, call/result budgets and rate-limit cooldowns bound work. See the
[engine reference](keyword-search.md) for policy defaults, timezone helpers and lifecycle ownership.
The shadcn/ui panel composes this engine through the validated runtime search bridge. Tests use
fictional ports and real adapters with synthetic transports; authenticated docked-panel acceptance
remains separate. See the [side panel reference](sidepanel.md).

## ChatGPT adapter

`ChatGptProvider` implements keyword search, one bounded list response, and optional message
enrichment through a trusted `ChatGptReadPort`. The no-port constructor stays unavailable.
`createChatGptProvider(binding)` supplies the concrete Chrome host for a live
`AccessBroker.bindSelectedDocument(scope)` capability. This is an in-process factory, not a new
runtime URL/header/code operation. The panel search composition now uses this factory.

The host pins the selected regular tab and Chrome document ID, checks permission/owning context
before and after work, and invalidates interrupted reads. The isolated reader compares fresh server
user/account identity around fixed same-origin requests. Authentication stays transient inside that
reader; no token or raw identity leaves it. Personal accounts only, ephemeral scope, no persistence,
no retries, no inferred pagination or complete-history claim.

Wire schemas, original URL/date mapping, source provenance, evidence budgets, HTTP outcomes,
cancellation and coverage rules are documented in the [ChatGPT adapter reference](chatgpt-adapter.md).
Synthetic fixtures are handwritten. Actual extension proof is recorded separately from tests:
ready session, five native-matching keyword results, four exact API excerpts, a successful empty
query, and a partial 50-row list. Original-link reopen and same-account/source-preservation checks
passed. Rendered message equivalence and live forced logout/workspace/error scenarios were not
established. The panel now invokes keyword search; list/message enrichment remains outside its UI.

## Google Search AI Mode adapter

See the [Google Search AI Mode adapter reference](google-ai-mode-adapter.md) for its API, trust
boundaries, native request forms, normalization, rendered evidence, failure mapping and verified limits.

`src/providers/google-ai-mode/adapter.ts` implements `GoogleAiModeProvider` with an injected
`GoogleAiModeReadPort`. A missing port keeps the original unavailable behavior. `search(request,
context)` and `list(request, context)` validate the normalized request and selected scope, then
validate the port result and provider response. `inspectSession` reports ready only after a valid
identity inspection. The platform supplies a concrete Chrome host. The runtime bridge composes this
adapter with
the keyword engine for panel searches; list/rendered-message enrichment remains outside the UI.

`wire.ts` owns the observed GET forms, XSSI JSON parsing, positional records, link policy and HTTP
failure mapping. Native verification on October 15, 2026 established keyword matches whose
titles omit the keyword, and normalized the bounded native list. Search has an
observed 30-record request limit; listing has no verified continuation. Search coverage is unknown,
and hitting a provider/application result bound is partial. Neither operation promises complete
history. Empty native search returns `[]`; malformed or missing envelopes never become empty success.

Titles remain exact when within the shared budget; absent or overlong titles are omitted. Native
snippets stay plain text, including instruction-like or HTML-like content, with bounded exact
substring extraction that preserves surrogate pairs. Duplicate threads merge distinct snippets;
conflicting identity/link/title metadata fails validation. Candidate and total evidence budgets
remain enforced. Original links use only the observed four metadata pairs on the exact Google
`/search` route, with the short ID bound to `mtid` and the long state bound to `mstk`. Duplicate,
unknown, mismatched or unsafe link parameters are rejected. A native temporary-tab check verified
that the metadata-only link reopens the saved thread under the same account.

The two native numeric timestamp pairs lack verified creation/update meanings and remain unmapped.
Search/list enrich dates through optional `openDate`, using the first visible rendered question date.
Full English dates retain their day; valid 24-hour clock-only labels use the observation’s local day
in the query/browser timezone. `calendarDay` records day precision and the explicit today fallback;
`at` represents the local day boundary for filtering, with message-sent/rendered-message provenance.
Unsupported or unreadable dates remain unknown. Date work uses at most three owned inactive tabs,
a seven-second phase budget and at most 10.5 seconds from retrieval start. It preserves native
matches when optional metadata fails; account/scope/permission/context changes still fail closed.
The [adapter reference](google-ai-mode-adapter.md#rendered-message-dates) describes parsing and cleanup.

`document-read.ts` is self-contained code serialized into Chrome’s isolated world. It performs
only fixed same-origin GET operations with browser-managed authentication, manual redirects, an
8-second deadline, a 3 MB streaming response cap, bounded document concurrency and explicit abort
cleanup. Before and after a data read, it fetches a fresh AI Mode landing page and compares its
account control with the selected document. Only a local partition-salted SHA-256 fingerprint can
leave the identity check; account email/labels are not returned or logged. A changed/missing identity
prevents success. Nondefault account selectors are currently unavailable rather than silently read
through the default account. This reader passed native and actual unpacked-extension isolated-world checks using the existing
Google session. It requires the exact `/search?udm=50` context on `www.google.com`.

HTTP 401 maps to `login-expired`, 429 to `rate-limited` with a bounded valid Retry-After hint, and other
non-200 statuses to `unavailable`. A 200 response with an unexpected content type or malformed JSON
is `schema-changed`. Manual/opaque redirects remain unavailable because their destination cannot be
verified. Transport exceptions, cancellation, timeout and scope changes have separate safe outcomes.
These failure mappings have synthetic tests; native probes observed successful 200 responses only.

The adapter independently times out unresponsive ports after 10 seconds, aborts obsolete work on
replacement/invalidation and rejects changed identity around or between operations. A regression
caught replacement cancellation retiring the newer operation; cancelled obsolete reads now remain
separate from an actual account invalidation. Candidate inventories are memory-only, bounded,
snapshotted and bound to the exact originating request/query; failed or replacement retrieval clears
old evidence access.

`messages(request, conversationId, context)` accepts only a candidate retrieved by that instance for
the same request, then uses the host's optional `openEvidence` capability. It cannot accept arbitrary
URLs or fabricate full messages. The reader supports only bounded exact text from the observed
rendered last-turn block. Native reopening showed two saved answers, but no complete-message API was
observed. Evidence coverage remains unknown with `missing-evidence`. The concrete host reuses a
complete matching conversation when available, or opens an owned temporary tab. It validates the URL
and Chrome document ID, rechecks the source context/account and preserves reused user tabs. Only
owned tabs are closed in `finally`, including late creation after cancellation.
It creates passive tabs without activating or replacing the pinned source document.

`src/platform/google-ai-mode.ts` exports `createGoogleAiModeProvider(binding)` and
`ChromeGoogleAiModeReadPort`. Trusted composition obtains an in-process capability from
`AccessBroker.bindSelectedDocument(scope)`. That method accepts only the current selected scope,
snapshots its tab/document metadata and supplies lifecycle/owning-panel checks. The capability is
never serialized into a page or runtime message. Source reads revalidate the owning panel window,
optional permission, selected regular tab, exact URL, current scope and pinned top-level document.
Each data injection validates Chrome’s returned frame/document metadata separately from its payload.

The host observes bound-source navigation, removal/replacement and permission removal during
operations. It aborts the isolated reader, discards late output, settles unresponsive Chrome calls
within 9.5 seconds and removes operation listeners/timers. Rendered evidence additionally checks
the original source identity before opening and after reading the temporary thread. The adapter’s
independent 10-second deadline protects callers of other injected ports. Neither layer retries.

`availability.ts` records structural verification in Chrome’s isolated world and the remaining
nondefault-account/date/continuation limits. This diagnostic grants no session: without a bound
port the adapter remains unavailable, and `inspectSession` requires a fresh successful identity
check before returning ready. No permission, dependency or public runtime operation was added.
The Gemini app remains outside this integration.

## Live Chrome evidence and remaining acceptance

On October 15, 2026, read-only tests ran in the existing native Google Search session and the actual
unpacked extension in Chrome 155.0.8059.40. The user loaded the local build and granted optional
Google/scripting access. Actual `ISOLATED` injections passed with Chrome-supplied frame/document
IDs pinned across operations: three search matches whose titles omitted the keyword, a deliberate
no-match query returning zero, 100 normalized candidates from the 300-row list and ready identity
inspection. Listing disclosed `partial`/`result-limit`; search retained `unknown-reach`.

The actual toolbar panel initially interrupted its connection because sender document metadata was
absent. A temporary service-worker diagnostic confirmed Chrome supplied only extension ID/URL/origin.
After the conservative context-resolution fix and reload, the panel’s Connect action selected the
site. At that time its setup-only message reported account/search access as unverified and did not
invoke the provider adapter. The current keyword panel now invokes it through the runtime bridge.
This selection check is distinct from the isolated provider-read evidence.

The concrete host then reopened one retrieved original link in an owned background tab, returned
one exact 2,000-character rendered excerpt, closed the tab and preserved the source URL. This is
partial rendered evidence, not complete-message access. Only structural counts/statuses were
retained; no account labels, conversation identifiers, live bodies or text entered fixtures/logs.
Temporary diagnostic assets, tabs and in-memory instrumentation were removed after verification.
Native development automation is not a runtime dependency or an installation requirement.

Synthetic tests separately cover HTTP failures, account changes, cancellation, invalid Chrome
metadata and cleanup. Live tests observed successful HTTP 200 reads; they did not force logout,
429 responses or account switches. Authenticated docked-panel search and native multi-window
interaction still need live acceptance.
Shared UI has synthetic component and isolated Chromium checks for narrow layout, keyboard/focus,
cancellation/reconnect, bundled tokens and MV3 CSP. The native side panel additionally passed real
client/broker/adapter/isolated-reader keyword searches with synthetic HTTP responses after tab switches. This does not establish
screen-reader compatibility, provider authentication, locale hosts or nondefault Google accounts.
No extension-origin fetch or main-world bridge is used.

## Data and artifacts

Only synthetic data may enter automated fixtures or public demonstrations. Never copy session
cookies, authorization headers, private conversations, account identifiers, raw network captures,
or live response bodies into tracked files. Report errors using bounded safe metadata.

Build assets are explicitly rooted in source entrypoints and `public/`. Keep local agent material
out of both. WXT source ZIP generation is disabled and explicit archive exclusions are configured.
Future release checks must inspect archive contents; do not archive the repository root. Static demo
publishing must use only its dedicated build directory and must not import provider/storage code.

No distribution license has been selected. Keep publishing and store submission as separate later
decisions. Local builds can be inspected with Developer mode as described in the README.
