# Developer notes

## Current layout

| Path                            | Role                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `src/entrypoints/`              | WXT background and side panel entrypoints                     |
| `src/ui/`                       | React presentation; currently only setup status               |
| `src/contracts/`                | Normalized runtime schemas, validation helpers and ports      |
| `src/platform/`                 | Reserved for Chrome session/message/access boundaries         |
| `src/providers/chatgpt/`        | Reserved for ChatGPT transport and parsing                    |
| `src/providers/google-ai-mode/` | Reserved for Google Search AI Mode transport and parsing      |
| `src/search/`                   | Reserved for provider-independent search orchestration        |
| `src/description/`              | Reserved for interpretation, ranking, and evidence validation |
| `src/storage/`                  | Reserved for isolated optional local storage                  |
| `tests/contracts/`              | Synthetic contract and boundary regression tests              |
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
npm test
npm run lint
npm run check
npm run build
```

`npm test` uses Vitest's non-watch runner. `npm run test:watch` watches the same suites. Test discovery
uses `tests/**/*.test.ts` in the Node environment with explicit imports; no browser/network access is
needed. Missing suites and focused `.only` tests fail. These checks prove contract behavior and the
extension scaffold, without establishing authenticated provider access. Demo, CI and ZIP commands
remain planned.

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
