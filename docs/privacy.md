# Privacy and data handling

ThreadShelf searches conversations already saved in your selected logged-in browser account. It
has no application backend, telemetry, hosted model service or credential collection form. Search
queries and bounded excerpts are processed in the extension/browser and are not uploaded to a
ThreadShelf server. Queries necessarily reach the selected provider’s own native search interface.

## Permissions and authentication

Only `sidePanel` is required when installed. Connecting a provider requests optional `scripting` and
its exact origin, `https://chatgpt.com/*` or `https://www.google.com/*`. Chrome origin permission is
broad within that site; the application further restricts operations, paths, arguments, sender,
window/tab/document, request IDs and scope generations. No cookie/debugger/broad-host permission,
external message endpoint or caller-supplied URL/header fetch bridge is configured. Incognito is
disabled. Login hosts receive no additional scripting permission.

Browser sessions remain browser-managed. ChatGPT’s same-origin isolated reader uses the current
page’s authentication material transiently when needed for its observed reads; tokens never leave
that reader for the extension page, worker, files or a server. Google uses same-origin browser
authentication. Passwords and MFA are entered only on provider-managed pages. Login is triggered
only by confirmed sign-out during explicit Connect/Reconnect, with a finite cancellable wait.

## Local state and account changes

Queries, excerpts, identity fingerprints, selected scopes, results and pending requests live only in
memory. There is no persistent conversation/excerpt cache and no `storage.sync` use. The only saved
setting is a strict versioned keyword/description search-mode preference in extension-local
`localStorage`; it contains no query, excerpt, account, session or model consent. The static demo
saves nothing and has no authenticated capabilities.

Fresh provider identity checks guard connection, reads and final display after local ranking.
Navigation, permission loss, logout/identity change and obsolete generations retire access and
results. Idle connections are rechecked about every 20 seconds with bounded checks, so detection
can lag by the interval plus the check time. Unknown identity cannot reuse a persistent account
cache. Foreground sign-in pages remain user-owned on cancellation. Short-lived owned background
tabs/frames used for access/evidence are bounded and cleaned where applicable.

Disconnect releases in-memory provider access; it does not revoke Chrome site permissions. Use
Chrome’s extension settings to revoke those. **Search settings → Clear local data and preferences**
cancels work, clears panel data/filters, closes local clients, disables/destroys model state and
removes the saved search mode. It does not delete conversations from provider accounts or erase
Chrome-managed model files. There are no provider conversation writes.

## Optional local AI and untrusted content

Local AI requires an explicit enable/download action on a compatible device. Chrome manages model
availability/downloads; ThreadShelf bounds query/excerpt inputs and inference time, isolates request
sessions and destroys them on cancellation, disabling or scope loss. Hosted processing is disabled
and is never a silent fallback. See [local AI behavior](on-device-ai.md).

Titles, excerpts, provider responses and model output are untrusted. The UI renders evidence as plain
text. Models may select only retrieved candidate/evidence references; application code owns original
links, dates and exact quotations. Invalid output falls back explicitly. Exact evidence validation
does not establish semantic relevance or full-history recall.

## Verification and artifacts

Automated fixtures, browser profiles and demo data are handwritten fiction. No real account text,
identifiers, credentials or network captures belong in source, logs, screenshots or packages.
Production output and ZIP checks use strict file/permission allowlists and compare archive bytes
with the fresh build. Local instructions, research, tests, demo assets and captures are excluded from
the extension archive. CI uploads no artifacts and has no publication workflow.

Real provider login/MFA/return remains unverified; actual on-device inference was unavailable in
the tested configuration. Historical authenticated reads do not guarantee current undocumented
interfaces or complete history. See [acceptance evidence and gaps](acceptance.md) and
[installation/recovery](install.md). Public deployment, store distribution and any hosted processing
require separate work and decisions.
