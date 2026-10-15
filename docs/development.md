# Developer notes

## Current layout

| Path                            | Role                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `src/entrypoints/`              | WXT background and side panel entrypoints                     |
| `src/ui/`                       | Injected React setup/status and connection controls           |
| `src/contracts/`                | Normalized runtime schemas, validation helpers and ports      |
| `src/platform/`                 | Selected-tab broker, context validation and access lifecycle  |
| `src/providers/chatgpt/`        | Reserved for ChatGPT transport and parsing                    |
| `src/providers/google-ai-mode/` | Reserved for Google Search AI Mode transport and parsing      |
| `src/search/`                   | Reserved for provider-independent search orchestration        |
| `src/description/`              | Reserved for interpretation, ranking, and evidence validation |
| `src/storage/`                  | Reserved for isolated optional local storage                  |
| `tests/contracts/`              | Synthetic contract and boundary regression tests              |
| `tests/platform/`               | Synthetic broker, panel client and Chrome API wiring tests    |
| `tests/fixtures/`               | Handwritten fictional normalized data and link policies       |
| `demo/`                         | Reserved for the future synthetic static demo                 |
| `public/`                       | Only deliberately public extension assets                     |

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
not establish actual installed-extension behavior or authenticated provider access. Demo, CI and
ZIP commands remain planned.
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
disclosed as excluded in aggregate coverage. Relative-date interpretation is not implemented yet.

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
binds that port to Chrome APIs and lifecycle events. `client.ts` owns panel-side deadlines and
interruption handling. `document-probe.ts` contains the self-contained serialized isolated-world
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

Only `runtime.connect` ports named `threadshelf:selected-tab:v1` are accepted. Chrome-supplied
sender ID, exact panel URL/origin, active document ID, and top-level/non-tab sender are validated.
The manifest requires Chrome 116 or later for `runtime.getContexts`. That API must independently
find the regular-profile side panel and its window before and after document checks. Missing or
unexpected context metadata fails closed. The broker queries only the active tab of that panel's
window and checks its exact provider origin, completed load, and regular profile. No caller can
supply a tab, URL, header, body, or executable argument.

| Operation         | Allowed payload and result                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `connect`         | Bounded request ID and provider; selects the current document, with a fresh ephemeral scope    |
| `inspect-context` | Request ID/provider/current ephemeral scope; checks the pinned document and replaces its scope |
| `disconnect`      | Request ID/provider/current scope; clears the in-memory selection                              |
| `cancel`          | Existing request ID; aborts/discards pending work in that port                                 |

Search/list/evidence operations are absent until their owning adapters establish actual transport
and identity evidence. A `selected` reply always carries `session: 'unverified'`; it is neither a
`SessionOutcome` with authenticated readiness nor a successful provider search. Failures report
permission-needed, unavailable, scope-changed, timeout, cancelled, interrupted, or busy, without
private exception text or fabricated results. Panel reply validation checks provider/request IDs
and refuses reused partitions/generations, malformed output, and success after invalidation.

Initial document checks target frame 0. Chrome's injection metadata supplies the document ID;
confirmation and subsequent inspection target that exact ID, reject other frames/origins, and
recheck the tab, permission, and owning panel before returning. Both checks run in `ISOLATED`;
no main-world or extension-origin fetch is implemented. No authentication behavior is inferred from
the document marker. The broker allows one pending operation per provider per panel, at most four
panel brokers, and 256 unique operation IDs per port. Duplicate IDs or malformed requests close the
port. Requests expire after 10 seconds in the worker and 12 seconds independently in the panel.
There are no retries. Cancellation cannot undo an already dispatched Chrome injection, but it
aborts the operation signal, prevents further checks, and discards later output.

Navigation/loading, URL changes, removed/replaced tabs, active-tab changes, window focus changes,
permission removal, and port loss invalidate selections and pending work. Focus/activation events
invalidate both providers. Removing a site's permission invalidates only that provider; removing
the shared `scripting` permission invalidates both. Invalidation reaches the panel before
terminal worker replies. Panel-owned timers cover a suspended/unresponsive worker; reconnect is
explicit through the Connect action. Incognito is disabled. Listeners for disconnected ports,
timers, abort subscriptions, and scopes are released.
Invalidation events carry generations; delayed cancellation/navigation events cannot clear a newer
selection or cause its fresh reply to be discarded.

Every document check creates a new opaque ephemeral partition/generation, including checks in the
same document. There is no private-data cache or persistence. Same-document account/workspace
switches and logout are not yet observed or verified; no account data is read and no verified scope
is produced. Future adapters must establish identity around real reads and invalidate through the
broker before any result is displayed or cached. Unknown identity cannot reuse an earlier check's
data. A Chrome permission prompt itself cannot be cancelled by this code; cancelling prevents the
subsequent broker operation and retry waits until that prompt settles.

## Pending live Chrome acceptance

No unpacked-extension probe was performed for this foundation. The available environment has no
connected browser automation surface or isolated extension test browser. Installed API declarations,
synthetic mocks, and generated-manifest inspection are separate evidence from a real Chrome run.

For a bounded manual check, load the production build, open the toolbar panel, connect one selected
provider tab, and confirm the exact-site permission prompt and explicit unverified status. Check
navigation (including same-URL reload), tab/window changes, permission revocation, cancellation, and
worker interruption; selections must clear and late replies must not reappear. A metadata mismatch
must produce unavailable/interrupted behavior. Keep only structural pass/fail notes and remove any
temporary test profile, tabs, or instrumentation. Authenticated same-origin reads, account/workspace
identity, actual Google host requirements, and comparison with extension-origin access remain
adapter verification work; do not infer login or complete-history support from a selected document.

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
