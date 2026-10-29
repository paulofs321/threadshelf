# Install ThreadShelf locally

ThreadShelf is an experimental Chrome Manifest V3 side-panel extension. Use a regular Chrome 116+
profile. Incognito, ChatGPT workspaces, nondefault Google accounts, Google locale hosts and the Gemini
app are unsupported. Optional local AI also depends on Chrome/device/language support and a separate
Chrome-managed model download; keyword and literal description fallback work without it.

## Build and inspect

Use Node 22.12+ within the Node 22 line and npm:

```sh
npm ci
npm run test:coverage
npm run lint
npm run check
npm run demo:build
npm run package:chrome
npm run verify:builds
npm run check:docs
```

`package:chrome` cleans only the generated `.output/chrome-mv3/` directory and the current-version
archive, invokes the locked `wxt zip -b chrome`, and verifies the resulting ZIP against the fresh
production build. It prints the absolute path and SHA-256 digest. At version 0.0.0 the file is
`.output/threadshelf-0.0.0-chrome.zip`. Source ZIP generation is disabled. `verify:artifacts` repeats
inspection without rebuilding. No release is uploaded or submitted.

The verifier requires the MV3 manifest at the archive root, exact narrow permissions, existing local
assets, bounded entries and byte equality with the production output. It rejects unexpected agent,
private, demo, test, capture, log and source-map paths, known secret/agent/test content and altered
assets. It is a build-boundary check, not a guarantee about undocumented provider interfaces.

## Load the extension

1. **Extract the ZIP** to a folder you will keep. Chrome cannot Load unpacked from an unextracted ZIP.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted directory containing `manifest.json`.
4. Pin ThreadShelf if useful, then click its toolbar icon to open the native side panel.

You can also load `.output/chrome-mv3/` directly after building. Keep the folder in place; deleting
it breaks the local installation. These steps follow Chrome’s
[Load an unpacked extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
The automated `test:package` extracts the verified ZIP and loads those unchanged bytes as an unpacked
extension in isolated Chromium. It checks the UI, native panel context and absence of pregranted
optional permissions; it does not use a real account.

## Connect and search

Choose **Connect** for ChatGPT or Google Search AI Mode. Chrome requests optional `scripting` and
access only to the chosen exact origin: `https://chatgpt.com/*` or `https://www.google.com/*`.
ThreadShelf reuses a supported page in this window or opens its fixed landing page in a background
tab for a session check. **Connected** appears only after fresh provider verification.

When the check confirms sign-out, ThreadShelf opens a separate foreground provider-managed sign-in
tab and waits up to **five minutes**. Complete passwords, MFA and challenges only on the provider’s
own page. ThreadShelf does not script login hosts or collect passwords/MFA. Return to a supported
provider page must receive a fresh document binding and session check before Connected. Existing
conversation tabs are preserved. Google returns to Search AI Mode, not the Gemini app.

**Cancel** ends waiting and rejects late completion; the foreground sign-in page remains open for
you. Closing it, losing permission, closing the panel or interrupting the worker ends the attempt.
An expired wait or interruption requires explicit **Reconnect**. Ordinary access checks use short
timeouts independently of the five-minute human sign-in wait. Generic schema/network/unsupported
account errors do not automatically redirect to login.

Enter a keyword or choose Description in **Search settings**. Provider and available-date filters
remain authoritative; **Before** is exclusive, and unknown dates cannot satisfy a date filter.
Description fallback matches literal words; optional local AI is enabled separately. Results show
exact retrieved excerpts and application-validated original links. Neither search nor the bounded
history list promises complete account history. See [provider and search limits](acceptance.md).

## Recover, clear and update

- If a search reports expired/changed access, use **Connect → Reconnect**. Searches never open a
  login page automatically. Navigating/closing a source page or changing account can retire results.
- **Connection options → Disconnect** releases the provider context. Revoke site access in Chrome’s
  extension settings to remove the grant; disconnecting does not revoke Chrome permissions.
- **Search settings → Clear local data and preferences** cancels work, clears query/results/filters,
  releases connections, disables local AI and removes the saved search-mode setting. Private text is
  memory-only; there is no persistent excerpt cache. See [privacy](privacy.md).
- After rebuilding or replacing extracted files, click **Reload** in `chrome://extensions`, then
  close/reopen the panel. Remove the old local extension through Chrome if moving its folder.

Both sign-in flows pass synthetic native-panel tests. **Real user-completed provider login/MFA/return
remains unverified**, and real on-device inference was unavailable in the tested Chrome configuration.
Historical authenticated reads and current automated proof are separated in the
[acceptance matrix](acceptance.md). No store listing, automatic update service or demo deployment is
provided by this local package.
