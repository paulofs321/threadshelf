# ThreadShelf

ThreadShelf is a Chrome side panel for searching conversations already saved in your selected
**ChatGPT** and **Google Search AI Mode** accounts. Google Search AI Mode is separate from the
Gemini app. No manual export or per-conversation saving is required.

Search by keyword, or describe a conversation using literal fallback or optional on-device AI.
The shared shadcn/ui panel provides provider/date filters, source tabs, exact expandable excerpts,
validated original links, evidence-backed explanations, cancellation and explicit partial/failure
states. Search is bounded; complete account history is never promised.

## Try it

Use a regular Chrome 116+ profile. With Node 22.12+ within Node 22 and npm:

```sh
npm ci
npm run demo:build
npm run package:chrome
```

The verified local archive is `.output/threadshelf-0.0.0-chrome.zip`. **Extract it**, open
`chrome://extensions`, enable Developer mode and choose **Load unpacked** on the directory containing
`manifest.json`. Click ThreadShelf’s toolbar icon to open the side panel. See the complete
[installation and recovery guide](docs/install.md).

Connect requests optional scripting and access to only the chosen provider origin, then verifies
the session. Confirmed sign-out opens a separate provider-managed login tab with a cancellable
five-minute wait. Connected requires fresh return verification. Passwords and MFA stay on the
provider page; generic failures do not trigger login redirects. Search expiry requires explicit
Reconnect. See [connection controls](docs/sidepanel.md).

For an account-free preview, run `npm run demo:preview` after building the demo. Seven fictional
conversations use the actual shared UI/search pipeline with no provider, model or storage
capabilities. Try **floating library**, or choose Description and ask **Where did I discuss login
security?** Root/nested build instructions and simulation controls are in the [demo guide](docs/demo.md).

## Support and limits

- **ChatGPT:** personal accounts, bounded native search/list and API-message excerpts. Workspaces,
  pagination, complete-history and entirely tab-free access are unsupported/unverified.
- **Google Search AI Mode:** default `www.google.com` account, bounded search/list/snippets and
  rendered evidence. Nondefault accounts, locale hosts, continuation beyond the bounded list and
  complete-message/history coverage are unsupported/unverified. Provider dates retain their actual
  provenance; missing dates stay unknown.
- **Description search:** literal fallback requires matching content words together. Optional local
  AI needs compatible Chrome/device/language support and may require a separate model download.
  Hosted processing is disabled. Models select validated evidence references; application code owns
  links, dates and quotations. See [description search](docs/description-search.md) and
  [local AI](docs/on-device-ai.md).
- **Verification:** historical authenticated reads and current synthetic native-panel/browser tests
  are separate evidence. Real user-completed login/MFA/return remains unverified for both providers;
  real on-device inference was unavailable in the tested configuration. See the
  [acceptance matrix](docs/acceptance.md). Provider website interfaces are undocumented and may change.

## Privacy

Private queries, excerpts, identities and results remain in memory. Only a versioned search-mode
preference persists locally; there is no excerpt cache, sync, application backend or telemetry.
**Search settings → Clear local data and preferences** cancels work, clears results/filters,
releases connections, disables AI and removes the saved setting. Revoke Chrome site grants separately
in extension settings. Incognito is disabled. See [privacy and data handling](docs/privacy.md).

## Development and verification

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
npm run package:chrome
npm run test:package
```

`npm run dev` starts WXT development, `npm test` runs tests without coverage, and `npm run test:watch`
watches them. `npm run demo:dev` starts the isolated static demo; `npm run verify:artifacts` repeats
ZIP inspection. `DEMO_BASE=/threadshelf/` configures a project-site base; use the same base for demo
build, preview, output verification and browser tests. See [developer notes](docs/development.md),
[regression tests](docs/testing.md), [architecture](docs/foundation.md),
[ChatGPT adapter](docs/chatgpt-adapter.md) and [Google adapter](docs/google-ai-mode-adapter.md).

CI uses the lockfile, enforced coverage, lint/types/format, separate extension/demo builds, output
and public-link checks, synthetic Chromium suites and extracted-ZIP installation checks. It uploads
nothing. No Pages deployment, release upload, store submission, automatic update service or hosted
processing is configured. Distribution license/store policies remain separate decisions.
