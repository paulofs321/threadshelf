# Fictional demo

The static demo runs without an extension, accounts, Chrome APIs or a backend. Seven authored
conversations share the extension’s shadcn/ui panel, contracts, keyword orchestration and grounded
description fallback. Provider labels and statuses are simulated; original navigation is disabled.
There is no model download, inference, authenticated provider code, private storage or hosted service.
All state resets on reload. Queries are processed locally against the fictional inventory.

Use Node 22 and the locked dependencies:

```sh
npm ci
npm run demo:dev
```

Search for **floating library**, or choose Description in Search settings and try **Where did I
discuss login security?** Description mode uses literal keyword matching, with exact evidence under
Why this matched. It does not understand arbitrary paraphrases. The demo clock is fixed at October
28, 2026, in Europe/Zurich, so “last month” means September. Try provider/date filters or use the
simulation selector for partial, empty and cancellable slow searches. Changing simulations resets
the panel.

For a root-path production preview:

```sh
npm run demo:build
npm run demo:preview
npm run test:demo
```

For a future project site under a nested path, use the **same** base for build and preview/testing:

```sh
DEMO_BASE=/threadshelf/ npm run demo:build
DEMO_BASE=/threadshelf/ npm run demo:preview
DEMO_BASE=/threadshelf/ npm run test:demo
```

Open the printed preview URL with `/threadshelf/` appended. Vite’s `base` follows its
[static deployment guidance](https://vite.dev/guide/static-deploy.html#github-pages).
Only `dist/demo/` is suitable for static hosting. Do not publish the repository root or extension
output. The build disables automatic public-directory copying and rejects privileged/local-only
modules in the emitted graph. The license notice is explicitly bundled.

These commands build and preview locally. There is no deployment workflow, Pages publication or
account connection. Demo results prove synthetic behavior only; see the
[testing reference](testing.md) for the separate extension and real-provider evidence.
