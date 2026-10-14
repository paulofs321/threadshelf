# ThreadShelf

ThreadShelf is a planned Chrome side panel for searching conversations already saved in your
currently logged-in **ChatGPT** and **Google Search AI Mode** accounts. Google Search AI Mode is a
separate integration from the Gemini app at `gemini.google.com`.

The goal is to find sessions by keyword or description without manually saving or exporting each
conversation. Examples include “Where did I compare deployment options for my portfolio?” and
“Which sessions did I discuss authentication last month?” Results will show their provider, title,
available date, matching excerpt, original conversation link, and evidence for description matches.
Provider and date filters, cancellation, and explicit failure/partial-result states are planned.
The implementation UI will use shadcn/ui components shared with the fictional demo.

## Current status

This repository contains the extension scaffold, **shared contracts**, and a **selected-site access
foundation**: WXT, React, strict TypeScript, Chrome Manifest V3, Valibot schemas, normalized ports,
synthetic tests, and ESLint. The toolbar opens the side panel. Connect requests optional permission
for one provider site and scripting, then checks its selected top-level document. The broker validates
the sending panel, correlates requests, and clears access on navigation, revocation, cancellation,
timeout, or worker interruption. Unknown identity receives a fresh ephemeral scope on every check.

Selecting a site does not verify login or enable conversation access. Provider authentication,
search, model inference, persistent storage, CI, demo, and release packaging remain unimplemented.
Actual unpacked-extension behavior and authenticated access are unverified; synthetic tests and
builds establish code behavior only. shadcn/ui setup remains planned for the full search UI.

Earlier read-only website probes on October 13, 2026 observed search capability in both providers.
Their internal interfaces are undocumented and may change. Request schemas and operation inside an
actual extension still need verification; complete-history coverage is not established.

## Development

Use Node.js 22.12 or later within the Node 22 release line and npm. Dependencies are pinned in
`package.json` and `package-lock.json`.

```sh
npm ci
npm test
npm run test:coverage
npm run lint
npm run check
npm run build
```

| Command                 | Available behavior                                    |
| ----------------------- | ----------------------------------------------------- |
| `npm run dev`           | Start WXT's Chrome development build/browser workflow |
| `npm run prepare`       | Generate WXT TypeScript configuration                 |
| `npm run typecheck`     | Prepare and check TypeScript without emitting files   |
| `npm test`              | Run synthetic TypeScript tests once                   |
| `npm run test:coverage` | Run all tests and enforce runtime source coverage     |
| `npm run test:watch`    | Watch and rerun synthetic tests                       |
| `npm run lint`          | Run ESLint with zero warnings allowed                 |
| `npm run format`        | Format public/source project files                    |
| `npm run format:check`  | Check formatting                                      |
| `npm run check`         | Run type checking and formatting checks               |
| `npm run build`         | Build the extension to `.output/chrome-mv3/`          |

For manual inspection, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `.output/chrome-mv3/`. Click the ThreadShelf toolbar action or select it in Chrome's side
panel menu. Open the provider in the selected tab of that window, then click **Connect** in the panel.
Chrome requests optional `scripting` and either `https://chatgpt.com/*` or `https://www.google.com/*`.
Only `sidePanel` is required at installation. Google locale hosts and the Gemini app are unsupported.
**Clear selection** releases the in-memory context; revoke granted site access in Chrome's extension
settings. Incognito is disabled. No live browser smoke test is claimed. See
[developer notes](docs/development.md) for permissions, protocol, and remaining verification.
See the [technical foundation](docs/foundation.md) for the implemented architecture and
[regression test matrix](docs/testing.md) for comprehensive failure coverage and its limits.

## Planned boundaries

Provider adapters will use permitted browser contexts and existing logged-in sessions. The product
will not collect passwords, export browser credentials, or require “Allow JavaScript from Apple
Events.” Private sessions and messages must stay out of logs, fixtures, Git, demos, and packages.

Description search will interpret topics/filters, retrieve candidates, and rank evidence from titles
and excerpts. An optional on-device model is the initial direction; supported hardware and model
download are required. Keyword/topic fallback will be explicit. Hosted processing would require an
opt-in explanation of which excerpts leave the browser and separate infrastructure; it is not enabled.

The future static demo will use fictional conversations and share suitable UI/search code without
provider access or private storage. Extension ZIP packaging, GitHub Pages readiness, and CI are
planned. Public demo deployment and store submission remain future actions.
