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
the main connection state. This status describes the browser connection; each search still checks
account identity and can report expired login or revoked access.

**Back to search** and **Continue to search** preserve the query, filters, selected source tab, sort,
results and pending search. Page navigation does not reconnect providers or stop their keepalive.
Focus moves to the connection heading or back to the query. **Search settings** contains search
mode, provider checkboxes and date filters, preserving their values when collapsed.

**All sources**, **ChatGPT** and **Google AI Mode** tabs show counts from the current validated result
set. Switching tabs only changes the view; it does not repeat requests or change search filters.
Provider failures stay flagged on their tabs, with recovery actions inside the affected panel.
Tabs support arrow/Home/End navigation and linked accessible panels. Sorting defaults to newest
available date with undated conversations last; **Provider order** restores the engine's order.
**Refresh** repeats the current search with a fresh request ID. Counts are search results, never an
invented total of saved history. Message counts and provider sync metadata are not available.

Click **Connect** for either provider from any tab. Permission is requested only from that gesture.
ThreadShelf reuses an unambiguous supported provider page in this window, preferring its active page
when several exist. If no provider page exists, or several match and all are inactive, it opens
the provider’s fixed landing page in a new inactive tab.
You do not need to open or stay on that tab manually. This still uses a real browser tab for isolated
session access; it does not export credentials or promise tab-free authenticated requests.

Each provider retains its own pinned tab/document and scope across tab/window focus changes. A
20-second local heartbeat keeps the worker available only while the panel has connected scopes;
it performs no provider reads and stops on disconnect/unmount. Connections/results remain memory
only for this panel session; closing the panel, restarting Chrome, navigating/closing the source,
revoking permission or detecting changed account identity can require reconnecting. Disconnect
closes only unchanged inactive tabs created by this connection, preserving existing user tabs and
pages currently activated/navigated by the user. Background loading is cancellable and bounded by
the access deadline. Multiple inactive matching account pages are not selected arbitrarily.

Selection validates the document; authenticated identity is checked around each search. Enter
keywords and search the checked providers. Description mode stays disabled and marked pending.
ChatGPT supports personal accounts; Google Search AI Mode supports the default account in the
verified `www.google.com/search?udm=50` context. Login or browser challenges can still require action
on the provider site; no credentials are collected. After updating/rebuilding, reload the unpacked
extension at `chrome://extensions` and reopen the panel to replace both UI and worker together.

Provider filters are explicit. Date controls convert local calendar boundaries in the displayed
browser timezone to `[From, Before)` UTC intervals. Supply both dates or neither. Filtering uses
each conversation’s available date and stated meaning/source; a conversation update is not proof of
when a topic was discussed. Undated results are excluded by date filters and disclosed in coverage.
Google uses the first visible message’s date from the conversation. A time-only label uses the
local date when read. Hover the date for its basis; unknown or unreadable dates remain unavailable.

The search bridge carries normalized keyword requests and cancellation IDs, alongside strict
access commands and empty local keepalive messages. The worker
requires current in-process broker capabilities before creating provider adapters, then runs the
existing bounded keyword engine. The panel validates request IDs, full scopes/generations, dates
and original links before display. Starting a replacement search, editing filters, cancelling,
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
Reconnect requests access through the same explicit connection gesture. Native permission prompts
cannot be dismissed by the extension; cancelling prevents subsequent work until that prompt settles.

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
