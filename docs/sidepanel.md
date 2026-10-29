# Search side panel

The WXT side panel uses React, strict TypeScript, shadcn/ui primitives and bundled Tailwind tokens.
`SearchScreen`, `SetupScreen` and `ResultCard` receive normalized capability ports, scopes and link
policies. They import no Chrome APIs, provider adapters, authenticated transport or storage.

The compact header, search field, green accents and result cards follow the supplied ThreadShelf
Figma reference. Submit with Enter or the search icon; clear restores query focus and cancels pending
work. The conversation header's **Connect** button opens a separate connection page matching the
Figma welcome screen. This page also appears on first open when no providers are connected, with
one Connect action per provider and expandable sign-in help. Connected providers show
“ChatGPT is already connected.” or “Google Search AI Mode is already connected.” instead of another
Connect button. **Connection options** keeps rechecking/disconnection available without cluttering
the main connection state. Connected requires the provider adapter's fresh authentication and
account checks; selecting a tab or granting permission is insufficient. Each search checks identity
again and can report expired login or revoked access.

**Back to search** and **Continue to search** preserve the query, filters, selected source tab, sort,
results and pending search. Page navigation does not reconnect providers or stop their keepalive.
Focus moves to the connection heading or back to the query. **Search settings** contains search
mode, provider checkboxes and date filters, preserving their values when collapsed.

**All sources**, **ChatGPT** and **Google AI Mode** tabs show counts from the current validated result
set. Switching tabs only changes the view; it does not repeat requests or change search filters.
Provider failures stay flagged on their tabs, with recovery actions inside the affected panel.
Tabs support arrow/Home/End navigation and linked accessible panels. Keyword sorting defaults to
newest available date with undated conversations last; description sorting initially follows relevance.
The sort control can change presentation without repeating provider reads.
**Refresh** repeats the current search with a fresh request ID. Counts are search results, never an
invented total of saved history. Message counts and provider sync metadata are not available.

Click **Connect** for either provider from any tab. Permission is requested only from that gesture.
ThreadShelf reuses an unambiguous supported provider page in this window, preferring its active page
when several exist. If no provider page exists, or several match and all are inactive, it opens
the provider’s fixed landing page in a new inactive tab.
You do not need to open or stay on that tab manually. This still uses a real browser tab for isolated
session access; it does not export credentials or promise tab-free authenticated requests.

Each provider retains its own pinned tab/document and scope across tab/window focus changes. A
20-second local heartbeat keeps the worker available while the panel has connections or pending
connection work. While idle, it also rechecks authenticated sessions; checks do not overlap searches.
These bounded rechecks detect same-document logout/account changes even without a new search,
with a delay of up to the heartbeat interval plus the check deadline. It stops on disconnect/unmount. Connections/results remain memory
only for this panel session; closing the panel, restarting Chrome, navigating/closing the source,
revoking permission or detecting changed account identity can require reconnecting. Disconnect
closes only unchanged inactive tabs created by this connection, preserving existing user tabs and
pages currently activated/navigated by the user. Background loading is cancellable and bounded by
the access deadline. Multiple inactive matching account pages are not selected arbitrarily.
Reconnect waits for that provider's owned-tab cleanup before selecting a new source; cleanup for
one provider does not block the other. An active unsupported Google account selector, or only
unsupported account tabs, is rejected without silently opening the default account. Existing pinned
default-account sources remain independent of other tabs.

Selection validates the document; authentication is checked before Connected and around each search. Enter
keywords or select **Description** in Search settings to describe a conversation. Description
search labels model-assisted matching or its literal keyword fallback, terms, inferred dates and ambiguity. **Why this matched**
quotes only the selected candidate’s exact evidence. See the [description reference](description-search.md)
for bounded message-context reads and supported subtopic matching. Google reads saved-thread content
inside hidden frames within its connected page, without creating or navigating tabs. Frames are
removed after reading or cancellation. Ordinary keyword searches do not read messages. **AI description search**
in settings provides local model support checks,
explicit enable/download, progress, cancellation and disable controls; see [local AI](on-device-ai.md).
ChatGPT supports personal accounts; Google Search AI Mode supports the default account in the
verified `www.google.com/search?udm=50` context. Login or browser challenges can still require action
on the provider site; no credentials are collected. After updating/rebuilding, reload the unpacked
extension at `chrome://extensions` and reopen the panel to replace both UI and worker together.

Provider filters are explicit. Date controls convert local calendar boundaries in the displayed
browser timezone to `[From, Before)` UTC intervals. Supply both dates or neither. Filtering uses
each conversation’s available date and stated meaning/source; a conversation update is not proof of
when a topic was discussed. Undated results are excluded by date filters and disclosed in coverage.
Google uses the timestamp supplied with each native conversation record, labeled **Provider date**
in its accessible description and tooltip. Its exact creation/update meaning is unverified. When a
matching conversation is already visible in the connected Google tab, its message date takes priority;
a time-only label uses the local date when read. Search creates no tabs and does not open conversations
for dates. Missing or unreadable dates remain unavailable.

The search bridge carries normalized keyword requests and cancellation IDs, alongside strict
access commands and empty local keepalive messages. The worker
requires current in-process broker capabilities before creating provider adapters, then runs the
existing bounded keyword engine. The panel validates request IDs, full scopes/generations, dates
and original links before display. After retrieval and optional local ranking, a separate short
identity check against the same pinned adapter must succeed before any completed evidence is shown.
This prevents an account change during ranking from displaying the old account’s results. Starting a replacement search, editing filters, cancelling,
losing context or unmounting aborts work and rejects obsolete replies. Independent panel timeouts
handle a silent worker. There are no automatic retries, private caches or model uploads.

Results show provider, available title/date/provenance, plain-text excerpts and validated
original links. Cards start with one excerpt of up to 180 Unicode characters; **Show more** reveals
all available evidence excerpts with their original whitespace, and **Show less** restores the
compact preview. Title evidence is not repeated below the heading. The full source evidence stays
unchanged. Missing metadata stays explicitly unavailable. Links require both safe HTTPS syntax
and provider ownership/ID validation, and open with no opener or referrer. Hostile HTML stays text.
Coverage limits are visible even on successful empty searches. Failed providers remain distinct
from no matches; useful successful results survive another provider’s failure.

Loading, cancelling, cancelled, empty, partial, expired login, unavailable/schema change, missing
permission, rate limiting, timeout and interruption have separate messages. Retry uses a fresh ID;
rate-limit hints temporarily disable retries and the engine independently enforces cooldowns.
Login expiry, permission loss and scope changes require reconnecting the affected provider before
retrying, refreshing or submitting another query with that scope. Editing the query does not clear
that requirement. You can search healthy providers separately by changing the provider filters.
Reconnect requests access through the same explicit connection gesture. Native permission prompts
cannot be dismissed by the extension; cancelling prevents subsequent work until that prompt settles.

Confirmed sign-out during explicit **Connect**, **Reconnect** or **Recheck connection** opens a
dedicated foreground provider sign-in tab, preserving conversation pages. ChatGPT uses its native
`/auth/login` entry; Google Account sign-in returns to `www.google.com/search?udm=50`, never Gemini.
Passwords and MFA stay on provider pages. There is no login-domain scripting, cookie access or
credential bridge. Unknown identity, unsupported accounts/workspaces, challenges, changed schemas,
network errors and rate limits do not open login pages.

The status announces **Checking session**, **Waiting for sign-in** and **Verifying session**.
Sign-in has its own **5-minute** deadline, separate from the worker's 10-second and panel's
12-second checks. Return verification gets the short deadline again. Duplicate clicks cannot start
another pending attempt; duplicate progress cannot extend either timer. Return navigation obtains a
fresh document binding/generation and reruns authentication before Connected. An unsuccessful return
does not reopen login in a loop. Cancel, tab closure/replacement, permission removal, panel closure,
deadline and worker interruption retire the attempt and discard late results. Foreground sign-in
pages remain open because the user may have entered information there. Restart interrupted attempts
with Reconnect; they are not stored or recovered automatically. Expiry during search offers explicit
Reconnect and never opens sign-in automatically.

**Search settings → Clear local data and preferences** cancels work, releases connections and local
AI sessions, clears queries/results/date filters, and restores keyword mode. Only the versioned search
mode preference is saved to extension-origin local storage. Queries, excerpts, account identifiers,
model enablement and hosted consent are never persisted or synced. There is no excerpt cache: current
ephemeral scopes cannot justify reliable account/workspace cache partitioning. Clearing cannot race a
private cached write because no private storage writer exists.

October 28, 2026 verification: both foreground sign-in/return lifecycles passed in isolated unpacked
Chromium with synthetic HTTP and simulated user return. A public signed-out Google page exposed its
native ServiceLogin control, and the login entry preserved the AI Mode return parameter. ChatGPT's
documented login URL was confirmed, but the isolated public browser received HTTP 403 from its landing
page. User-completed real login/MFA/return remains unverified for both providers. ChatGPT recognizes
explicit fresh HTTP 401; missing bootstrap on a 200 page remains a schema error rather than guessed
logout. Google requires signed-out controls in both rendered and fresh documents. Challenges or
unrecognized signed-out markup may therefore require signing in manually and reconnecting.

Fields have native labels and keyboard behavior, statuses use live announcements, and focus returns
to stable connection status/results when transient actions disappear. Text/buttons wrap and date
controls stack at narrow widths. Shared styles use system fonts and local assets under MV3 CSP.

Component/runtime tests and isolated Chromium smoke cover synthetic behavior, 240–400px widths,
keyboard/focus, source tabs, compact previews, cancellation/reconnect and bundled CSS/CSP. A native docked panel also exercises
real access/search clients, broker, both provider adapters, isolated document readers and repeated
keyword searches after tab switches against intercepted synthetic responses. A separate read-only
Chrome extension check verified the real Google adapter returned three matches from an inactive
source after accommodating its annotated account-control label. Rendered and fresh account
addresses still have to match before and after reads. This diagnostic bypasses the panel handshake;
final authenticated panel interaction and screen-reader acceptance remain separate checks.
See [testing](testing.md) and [developer notes](development.md) for commands and evidence limits.
