# Grounded description search

Select **Description** in Search settings and describe the conversation you want to find. This build
uses **keyword/topic fallback matching**, with a small English vocabulary for authentication/security,
deployment/hosting and database/performance, plus literal terms for other topics. It does not run an
AI model or promise semantic search quality. Native provider search and snippet limits still apply.

`DescriptionSearch` implements `SearchPort` in `src/description`. The panel's `SearchModes` composition
routes description requests through it and leaves direct keyword requests with `PanelSearchClient`.
Only normalized keyword searches cross the existing validated worker bridge. Shared presentation has
no browser or provider imports. No permissions, dependencies, persistent caches or uploads are added.

## Pipeline

1. Interpret a validated description into bounded topics/keywords and an optional available-date
   interval. “Last month” uses the supplied clock and browser timezone to mean the previous calendar
   month. Explicit provider selections and date controls remain authoritative. Other recognized date
   wording is labeled ambiguous/unsupported; use date controls to resolve it.
2. Search selected native providers for at most three distinct terms, sequentially. Each keyword
   request has a fresh ID and uses the existing bounded two-provider engine. There is no listing,
   pagination crawl, automatic message enrichment or per-candidate tab creation.
3. Deduplicate by provider, full session scope/generation and conversation ID. Preserve the first
   candidate ID and merge exact evidence within limits. Response-local candidate/evidence IDs are
   reassigned when reused across searches; snippet variants retain their exact text. Conflicting
   metadata or malformed IDs within one response fail closed. Rank whole-word title/excerpt matches
   deterministically, weighting excerpt evidence more strongly than title evidence, with stable ties.
   Unrelated text does not match just by substring.
4. Return candidate IDs with scores and owned evidence IDs/optional exact spans. Links, dates, titles
   and quotations come from the validated retrieved inventory. **Why this matched** resolves those
   references into exact text. No model-generated narrative, quote, date or link is accepted.

The synthetic corpus's four cases retrieve the authored first matches and supporting evidence. It
is a small regression corpus, not an estimate of recall across real accounts. Limited vocabulary,
query budgets, missing snippets and provider search behavior can miss relevant conversations.

## Bounds and outcomes

| Boundary                             | Default / hard maximum                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Native query terms                   | 3 / 8, at most two selected providers per term                            |
| Collected candidates                 | 100 per provider, shared contract bound                                   |
| Evidence                             | 8 items per candidate; 2,000 UTF-16 units each; 64,000 units per provider |
| Ranking context                      | 100 candidates and 64,000 evidence units total across providers           |
| Selected results                     | 50 / 100                                                                  |
| Optional interpreter or ranker stage | 3 seconds / 10 seconds                                                    |
| Complete description request         | 45 seconds / 60 seconds                                                   |

Topic/keyword plans each allow eight terms of 128 UTF-16 units. The ranking context prefers lexical
matches before remaining retrieved excerpts. Missing/omitted evidence and reached budgets are
reported in coverage. All results preserve independently reported provider limits; successful native
search never establishes complete-history reach.

A provider failure leaves other providers' useful results available. A later topic failure preserves
earlier successful reads with incomplete coverage; login/permission/scope loss erases that provider's
prior results. A later rate limit retains its bounded retry hint alongside earlier matches in the
successful outcome's optional `rateLimit` field. The panel shows the limit and blocks search/refresh
for that interval (one second when no hint is available). Cancellation, query replacement and global
timeout abort work and discard obsolete private results. Abandoned ports retain physical ownership
until their promises settle, preventing concurrent reuse. Replacement retrieval waits for that
settlement within the new request's deadline;
cancellation and scope invalidation also stop the wait. No automatic retry occurs.

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
Successful optional stages are labeled model-assisted. The production composition injects no model;
on-device runtime support, model downloads and quality evaluation remain future work. Hosted
processing is disabled and never used as a fallback.

See [testing](testing.md) for synthetic checks and their integration limits.
