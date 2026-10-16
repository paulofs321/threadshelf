# ThreadShelf

ThreadShelf is a Chrome side panel for searching conversations already saved in your
currently logged-in **ChatGPT** and **Google Search AI Mode** accounts. Google Search AI Mode is a
separate integration from the Gemini app at `gemini.google.com`.

The goal is to find sessions by keyword or description without manually saving or exporting each
conversation. Examples include “Where did I compare deployment options for my portfolio?” and
“Which sessions did I discuss authentication last month?” Keyword results show their provider, title,
available date, exact excerpts and validated original links. The shadcn/ui panel supports provider/date
filters, per-provider result tabs, compact expandable previews, cancellation, retry/reconnect and
explicit empty, partial and failed outcomes. Description
search is disabled and labeled pending; the fictional demo remains planned.

## Current status

This repository contains the extension scaffold, **shared contracts**, and a **selected-site access
foundation**: WXT, React, strict TypeScript, Chrome Manifest V3, Valibot schemas, normalized ports,
synthetic tests, and ESLint. The toolbar opens the side panel. Connect requests optional permission
for one provider site and scripting, then checks its selected top-level document. The broker validates
the sending panel, correlates requests, and clears access on navigation, revocation, cancellation,
timeout, or worker interruption. Unknown identity receives a fresh ephemeral scope on every check.

Selecting a site checks browser context only. Both provider adapters now support authenticated
reads through trusted selected-document bindings. The panel now connects the
[keyword search engine](docs/keyword-search.md) to both adapters through a validated runtime bridge.
Shared views receive capability ports and have no Chrome/provider imports. See the
[side panel reference](docs/sidepanel.md) for controls, states and current limitations.

The ChatGPT adapter implements personal-account keyword/list/API-message reads, exact evidence,
original links, UTC updated dates and identity checks around reads. Actual unpacked-extension
verification passed with five native-matching results, API message evidence, a genuine empty search
and a bounded 50-conversation list. Workspaces, pagination and complete-history coverage remain
unsupported or unverified. See the [ChatGPT adapter](docs/chatgpt-adapter.md) for details.

Google Search AI Mode implements default-account search/list reads, exact snippets, verified original
links, bounded rendered-thread evidence, HTTP failures and fresh identity checks. On October 15,
2026, native and actual unpacked-extension reads returned three snippet-only matches, a genuine
empty search, a capped partial list and a rendered excerpt from an owned background tab that closed
afterward. Nondefault accounts, timestamp meanings, continuation beyond 300 listed records and
complete-message retrieval remain unresolved. Unknown dates are omitted; complete-history coverage
is never claimed. Live checks are separate from synthetic tests. See the
[Google Search AI Mode adapter](docs/google-ai-mode-adapter.md) for the technical reference.

Without a selected-document binding, either adapter remains unavailable. Model inference,
persistent storage, demo and release packaging remain unimplemented. GitHub Actions runs locked
installation, tests, lint, type/format checks and the Chrome build on pull requests and pushes to
`main`. Internal provider website interfaces are undocumented and may change.

## Development

The extension requires Chrome 116 or later.

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
| `npm run test:browser`  | Run isolated Chromium UI/CSP smoke after building     |
| `npm run test:watch`    | Watch and rerun synthetic tests                       |
| `npm run lint`          | Run ESLint with zero warnings allowed                 |
| `npm run format`        | Format public/source project files                    |
| `npm run format:check`  | Check formatting                                      |
| `npm run check`         | Run type checking and formatting checks               |
| `npm run build`         | Build the extension to `.output/chrome-mv3/`          |

For manual inspection, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `.output/chrome-mv3/`. Click the ThreadShelf toolbar action or select it in Chrome's side
panel menu. Open **Search settings** for provider connections and date filters; settings start open
when nothing is connected. Click **Connect** for either provider from any tab. ThreadShelf reuses a suitable provider
page in this window or opens its fixed landing page in a background tab when needed.
Chrome requests optional `scripting` and either `https://chatgpt.com/*` or `https://www.google.com/*`.
After connecting, enter keywords and search the checked provider. The date interval uses local
calendar boundaries; **Before** is exclusive. Each provider stays connected while you browse other
tabs. Closing/navigating its source page or losing account/site access can require reconnecting.
Only `sidePanel` is required at installation. Google locale hosts and the Gemini app are unsupported.
**Clear selection** releases the in-memory context; revoke granted site access in Chrome's extension
settings. After rebuilding/updating the unpacked extension, click **Reload** in `chrome://extensions`
and reopen the panel so its UI and worker use the same build. Incognito is disabled. Actual-account
acceptance is separate from synthetic native-panel transport checks. See
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
provider access or private storage. Extension ZIP packaging and GitHub Pages readiness remain
planned. Public demo deployment and store submission remain future actions.
