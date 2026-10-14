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

This repository contains the **initial setup only**: WXT, React, strict TypeScript, a Chrome Manifest
V3 configuration, and a side panel that honestly displays the setup status. Conversation access,
search, description ranking, storage, automated feature tests, CI, demo, and release packaging are
not implemented. A successful build verifies the scaffold; it does not verify logged-in integrations.

Earlier read-only website probes on October 13, 2026 observed search capability in both providers.
Their internal interfaces are undocumented and may change. Request schemas and operation inside an
actual extension still need verification; complete-history coverage is not established.

## Development

Use Node.js 22.12 or later within the Node 22 release line and npm. Dependencies are pinned in
`package.json` and `package-lock.json`.

```sh
npm ci
npm run check
npm run build
```

| Command                | Available behavior                                    |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Start WXT's Chrome development build/browser workflow |
| `npm run prepare`      | Generate WXT TypeScript configuration                 |
| `npm run typecheck`    | Prepare and check TypeScript without emitting files   |
| `npm run format`       | Format public/source project files                    |
| `npm run format:check` | Check formatting                                      |
| `npm run check`        | Run type checking and formatting checks               |
| `npm run build`        | Build the setup scaffold to `.output/chrome-mv3/`     |

For manual scaffold inspection, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `.output/chrome-mv3/`. Open ThreadShelf using Chrome's side panel selection.
The scaffold currently requests only `sidePanel`; it requests no provider host access.
No browser smoke test is claimed by this setup. See [developer notes](docs/development.md).

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
planned. No remote repository, public deployment, or store submission has been created.
