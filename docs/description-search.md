# Grounded description search

Select **Description** in Search settings and describe the conversation you want to find. This build
supports optional **on-device AI** to interpret descriptions about arbitrary topics and rank retrieved
evidence. Enable it in **Search settings → AI description search** on a compatible Chrome/device.
When it is off, unavailable or fails, **literal keyword fallback** requires the original description's
content words together in one evidence passage. There are no topic-specific dictionaries. Native
provider search and snippet limits still apply. See [local AI](on-device-ai.md) for setup and evidence limits.

Descriptions express a complete intent. Required subjects, relationships, qualifiers and exclusions
must hold together; independently mentioning some or all search words is insufficient. This applies
to arbitrary subjects, including locations, food restrictions and remembered TV plots. AI receives the
original description again when ranking, and is instructed to omit incomplete or uncertain matches.
Explicit alternatives remain alternatives. Search-term expansion only retrieves candidates; it does
not replace these matching requirements.

`DescriptionSearch` implements `SearchPort` in `src/description`. The panel's `SearchModes` composition
routes description requests through it and leaves direct keyword requests with `PanelSearchClient`.
Normalized keyword requests and a narrow description-retrieval operation cross the validated worker
bridge. The latter carries the original description, never a caller-supplied conversation ID or URL.
Shared presentation has
no browser or provider imports. No permissions, persistent caches or uploads are added. Chrome AI type definitions are a pinned development dependency.

## Pipeline

1. Use the optional model to interpret a validated description into bounded topics/keywords; otherwise extract literal words and an optional available-date
   interval. “Last month” uses the supplied clock and browser timezone to mean the previous calendar
   month. Explicit provider selections and date controls remain authoritative. Other recognized date
   wording is labeled ambiguous/unsupported; use date controls to resolve it.
2. Search selected native providers for at most three distinct terms, sequentially. Each keyword
   request has a fresh ID and uses the existing bounded two-provider engine. Expanded terms retrieve
   candidates; the original full description remains authoritative for ranking. There is no history crawl.
3. Before ranking, read bounded message context for at most eight eligible native results per provider
   and term, with a twelve-second context deadline. Prefer candidates containing distinctive words
   from the complete description. Within one description request, successive terms examine previously
   unvisited conversations; this request-local tracking is released after completion or cancellation.
   ChatGPT uses its verified active-branch message read; Google reads supported rendered turns in a
   temporary same-origin frame inside the connected Google page. Prefer relevant windows, adjacent
   prompts/replies and recent context
   so paraphrases remain available. A broad conversation qualifies when a subdiscussion supports the
   complete description; other surrounding subjects do not disqualify it. Separate unrelated mentions
   still do not establish the requested relationship.
4. Deduplicate by provider, full session scope/generation and conversation ID. Preserve the first
   candidate ID and merge exact evidence within limits. Apply effective date filters before collection
   budgets so excluded candidates cannot crowd out eligible matches from later terms.
   Response-local candidate/evidence IDs are reassigned when reused across searches; snippet variants
   retain their exact text. Conflicting
   metadata or malformed IDs within one response fail closed. Literal fallback requires every original
   content word in one passage, with only grammatical words between them and no adjacent explicit
   negation of a positive request. It never joins separate titles, snippets, messages or sentences to
   manufacture a match. Match whole words, preserve exact spans and stable ties, and weight excerpt
   evidence more strongly than title evidence. AI can select supported paraphrases without these
   literal-word requirements.
5. Return candidate IDs with scores and owned evidence IDs/optional exact spans. Links, dates, titles
   and quotations come from the validated retrieved inventory. **Why this matched** resolves those
   references into exact text. No model-generated narrative, quote, date or link is accepted.

The synthetic corpus's four cases retrieve the authored first matches and supporting evidence. It
is a small regression corpus, not an estimate of recall across real accounts. Literal fallback,
query budgets, missing snippets and provider search behavior can miss relevant conversations.
Fallback deliberately favors precision: it can omit paraphrases, explicit alternatives, evidence split
across sentences and passages with intervening content words. It does not establish semantic relevance.
Its constraints come from the full original description, even when an AI-expanded retrieval plan was
used before a ranking error or timeout. The literal-fallback notice remains visible in that case.

Context reading is deliberately bounded, not a full-history scan. Passage selection considers up to
3,000,000 UTF-16 units of eligible message text and keeps at most five exact 1,000-unit windows. A
relevant passage beyond the former initial 128,000-unit limit can now reach ranking. Neighboring
messages help interpret short follow-up prompts. Google reads supported rendered conversation turns,
with a last-turn fallback; messages absent from that rendered document remain unavailable. Only the
small selected windows and unchanged titles/native
excerpts reach ranking. Missing, timed-out, unsupported or omitted context retains an explicit
`missing-evidence` coverage reason. Native results survive nonterminal context errors; login,
permission or account/scope changes discard that provider's evidence. A context rate limit preserves
the native inventory and already-read message evidence, reports `provider-failure` alongside
`missing-evidence`, and retains its retry hint. Keyword searches do not trigger message reads.

Google message reads require the existing connected Google page. They load verified saved threads in
owned hidden frames, then remove those frames on completion, cancellation or failure. Search does not
create, navigate or close browser tabs. The connected page's document/account and the child thread's
origin, ID and account are checked. A missing source page or blocked frame yields incomplete context;
there is no new-tab fallback. No new permission, credential handling, hosted upload or persistent
conversation cache is added.

## Bounds and outcomes

| Boundary                     | Default / hard maximum                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Native query terms           | 3 / 8, at most two selected providers per term                               |
| Context reads                | 8 per provider/term; at most 48 at default query count, 128 at hard maximum  |
| Context-read deadline        | 12 seconds per provider/term, within the complete request deadline           |
| Collected candidates         | 100 per provider, shared contract bound                                      |
| Evidence                     | 8 items per candidate; 2,000 UTF-16 units each; 64,000 units per provider    |
| Ranking context              | 100 candidates and 64,000 evidence units total across providers              |
| Selected results             | 50 / 100                                                                     |
| Optional interpreter stage   | 10 seconds in the side panel (generic port default: 3 seconds)               |
| Local ranking stage          | Bounded inventory batches, 9 seconds each, within a 40-second stage          |
| Complete description request | 60 seconds in the side panel / 60 seconds (generic port default: 45 seconds) |

Topic/keyword plans each allow eight terms of 128 UTF-16 units. The ranking context prefers lexical
matches before remaining retrieved excerpts. Missing/omitted evidence and reached budgets are
reported in coverage. All results preserve independently reported provider limits; successful native
search never establishes complete-history reach.

A provider failure leaves other providers' useful results available. A later topic failure preserves
earlier successful reads with incomplete coverage; login/permission/scope loss erases that provider's
prior results. A later rate limit retains its bounded retry hint alongside earlier matches in the
successful outcome's optional `rateLimit` field. The panel shows the limit and blocks search/refresh
for that interval (one second when no hint is available). Editing or clearing search controls does not
reset the retry deadline. Cancellation, query replacement and global timeout abort work and discard
obsolete private results. Abandoned ports retain physical ownership
until their promises settle, preventing concurrent reuse. Replacement retrieval waits for that
settlement within the new request's deadline; cancellation and scope invalidation also stop the wait.
Provider retrieval does not automatically retry. Local AI has one narrowly bounded structured-output
compatibility attempt, described in [local AI](on-device-ai.md).

Date filters use each candidate's available timestamp with its stated provenance; conversation or
provider-record dates do not prove when a topic was discussed. Unknown dates cannot satisfy a date
filter, and their exclusion is disclosed. Explicit dates override relative wording.

## Optional model ports

`InterpreterPort` and `RankerPort` return unknown data until contextual validation. `ModelPort` extends
both for compatibility. A valid interpreter can propose topics/keywords but cannot change selected
providers or the deterministic/explicit date interval. A ranker receives only bounded retrieved
candidates. It can select their IDs and their own evidence IDs, with finite scores in `[0,1]`.
Optional spans use integer UTF-16 `[start,end)` offsets, must stay within cited evidence and cannot
split a surrogate pair. Duplicate references, unknown evidence, stale requests and fabricated metadata
or prose fail validation. Retrieved instructions remain inert evidence with no privileged tools.

Invalid, throwing, unsupported or timed-out stages use deterministic fallback with an explicit notice.
Only successful AI matching is labeled model-assisted; interpretation alone does not establish that
the model judged candidate relevance. **AI and retrieval details** shows each stage's completion and
actual prompt-call counts, candidates supplied to matching, candidates with message context, and
per-provider retrieved versus matched counts. A model port notifies `ModelOperationContext.onPrompt`
immediately before an actual inference call; preflight rejection and abandoned callbacks are not
counted. These counters contain no private prompt text and are scoped to the current search.
`ModelOperationContext.onFailure` carries only runtime-validated reason codes/phases and allowlisted
Chrome exception names, with no raw error messages or model output. Local inference deadlines are
reported as timeouts. Provider failures include their explanation directly in the global search
details, independently of the selected provider tab.
The panel injects the on-device model only
after explicit enablement. Each stage clones an instruction-only session, checks context limits and
destroys the clone after use; queries/evidence are not carried into another request. Disable, account
change, cancellation and panel closure destroy obsolete model state. Hosted processing remains
disabled. See [local AI verification](on-device-ai.md) and [testing](testing.md) for actual versus
synthetic evidence.
