# Verification and acceptance

The automated suites use authored fiction and isolated profiles. They do not sign in to real accounts,
read personal conversation history, or establish the stability of undocumented provider interfaces.

| Capability                                                              | Evidence                                                                                                                                       | Remaining limit                                                                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT personal-account search/list/API excerpts                       | Authenticated native and unpacked-extension checks on October 15, 2026; current parser, identity, failure and panel regression suites          | No current live revalidation, workspaces, complete history or pagination guarantee                                         |
| Google Search AI Mode default-account search/list/snippets              | Authenticated native and unpacked-extension checks on October 15, plus October 17 date checks; current synthetic reader/panel tests            | Nondefault accounts, locale hosts, pagination beyond the bounded list and complete-message coverage unsupported/unverified |
| Connect and sign-in return, both providers                              | Production native panel, worker and isolated readers against synthetic signed-out/login/return pages                                           | Real user-completed credentials, MFA/challenges and return remain unverified; login markup can change                      |
| Cancel/closed login page/late return, both providers                    | Native-panel Chromium flows plus unit matrices                                                                                                 | Browser tests do not reproduce every real provider redirect/challenge                                                      |
| Sign-in deadlines, permissions, panel/worker interruption, stale scopes | Fake-clock and lifecycle tests for both providers, with cleanup and late-result rejection                                                      | Real suspension timing and live account changes have separate acceptance limits                                            |
| Keyword/description search                                              | Runtime validation, provider-independent orchestration, literal fallback, synthetic model output/evidence rejection, date and failure matrices | Recall is bounded by retrieved excerpts; literal fallback does not understand paraphrases                                  |
| Optional on-device AI                                                   | Lifecycle/budget/error tests and synthetic native-panel model flows                                                                            | Actual tested Chromium exposes the API but reports unavailable; no real inference or quality benchmark                     |
| Fictional static demo                                                   | Root and nested-path production previews; filters, exact evidence, cancellation, partial/empty states; 240–1200px rendering                    | Simulation only; no authenticated or model capabilities                                                                    |
| Production outputs                                                      | Exact path allowlists, manifest permissions, local HTML references, privileged-import negative builds and public local-link checks             | ZIP verification is a separate packaging check                                                                             |

## Repeat the automated checks

Use Node 22 and npm:

```sh
npm ci
npm run test:coverage
npm run lint
npm run check
npm run build
npm run demo:build
npm run verify:builds
npm run check:docs
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install --with-deps chromium
npm run test:browser
npm run test:demo
DEMO_BASE=/threadshelf/ npm run demo:build
DEMO_BASE=/threadshelf/ npm run verify:builds
DEMO_BASE=/threadshelf/ npm run test:demo
```

The extension harness copies the production build into a temporary directory, pregrants only the
existing optional origins/scripting there, adds a test-only driver and intercepts all provider HTTP
with synthetic responses. Permission gesture behavior has separate component tests. The source
extension, production manifest and personal browser profile remain untouched. Temporary profiles,
copies and local preview servers close in `finally`; demo screenshots contain only fiction.

CI runs the same checks on Ubuntu with read-only repository permissions. It uploads no files and
has no deployment, publication, store submission, provider credentials or personal sessions.
Neither a passing build nor synthetic login navigation proves real provider authentication.

## Separate manual acceptance

For live acceptance, load the production extension in a regular Chrome profile, connect a supported
personal ChatGPT/default Google account and compare a bounded query with the native site. Check
exact excerpts, original links, date labels and partial/empty outcomes. Do not treat the bounded
list as complete history. Observe unsupported-model fallback on the actual device.

If testing sign-in, use an independently signed-out test context and complete credentials/MFA only
on the provider’s own page. Confirm Connected appears only after fresh return verification, Cancel
terminates waiting, and the five-minute deadline offers explicit retry. Do not force logout or alter
an existing user session for this check. Record structural outcomes only; do not capture private
text, identifiers, headers or credentials. See [connection behavior](sidepanel.md),
[privacy boundaries](development.md#data-and-artifacts) and the [regression reference](testing.md).

The real login/return and real-model gaps above remain disclosed acceptance limits. They do not
become verified through CI or packaging. Distribution is local/experimental until separately assessed.
