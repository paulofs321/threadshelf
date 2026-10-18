# Local AI description search

Describe any topic you remember, for example “Which sessions did we talk about jobs?” or “Where did
we discuss folding paper animals?” Optional AI interprets the meaning into related search terms,
retrieves real provider candidates, and selects supporting evidence. There is no hard-coded topic
category or synonym dictionary. Results still depend on what each provider's native search exposes.
Both prompts receive the full original description. Interpretation preserves relationships and
qualifiers in retrieval phrases; ranking is instructed to require the full intent in connected
evidence and omit partial, unrelated or uncertain matches. Explicit alternatives and exclusions are
preserved. These instructions apply to arbitrary subjects, rather than a fixed set of topics.
Before ranking, description retrieval reads bounded message context from native candidates. A broad
conversation can match through a supported subdiscussion even when its title or initial snippet does
not name the requested topic. The model receives selected exact excerpts, not unlimited conversations.
See [context limits and temporary Google tabs](description-search.md).

Open **Search settings → AI description search**. Check support, then click **Enable local AI** or
**Download and enable local AI**. The model download is separate from conversation search; preparation
is limited to two minutes and can be cancelled. Search remains available with explicitly labeled
literal keyword fallback while AI is off, downloading, unsupported or failing. Enablement lasts only
for this panel session and is cleared on connection/account changes; Chrome manages downloaded model
files. No private excerpt cache or persistent conversation history is created by this integration.

Chrome's [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) supports extension documents
from Chrome 138. It runs Gemini Nano locally after a separate model download. Availability depends
on Chrome configuration, supported language, operating system, hardware/storage and model readiness.
The current API requires substantial free storage and suitable CPU/RAM or GPU; check the official
requirements when support is unavailable. The extension detects support instead of assuming a version
or capable device. This integration requests English text input/output. Its base extension minimum
remains Chrome 116; older/unsupported installations retain literal search.

## Processing and limits

The panel document owns `OnDeviceModel`; the service worker does not invoke the model. Availability
checks pass the same English text options used for creation. Only an explicit button action can
create/download the instruction-only warm session. Each interpretation/ranking stage gets its own
clone, so no description or evidence is reused as history in another search. Clones are destroyed on
completion, cancellation, deadline, disabling, account changes or panel closure. Late creations are
also destroyed, and abandoned inference retains physical ownership until it settles.

Interpretation accepts bounded topics/keywords only. The model cannot supply filters, links, dates,
quotes or narrative. Ranking receives candidate/evidence IDs and exact evidence text, excluding URLs,
account/session identifiers and dates. Strict schema and contextual checks reject invented references,
metadata, invalid scores and duplicates. Untrusted descriptions/evidence are explicitly presented as
data, with no model tools. Application code resolves approved references to exact links and quotations.

Each prompt is limited to 20,000 UTF-16 units, with a measured context ceiling of 8,192 tokens (or the
smaller reported model window), including a 512-token output reserve. Responses are limited to 32,000
units. Oversized context, unsupported structured output, malformed JSON and inference errors fall
back visibly. Ranking splits larger inventories into at most four independent batches with a
16,000-unit prompt target; a single oversized candidate or a larger batch count falls back explicitly.
Each inference has a nine-second local deadline. Interpretation is capped at ten seconds and ranking
at forty seconds, within the complete sixty-second description request. Every batch validates its own
candidate/evidence membership before merging selections. Native retrieval budgets still apply.

## Verification and release recommendation

Unit and panel tests use synthetic model outputs, including unrelated job-search, origami and
astronomy descriptions, adversarial evidence, false IDs and stale sessions. The native-panel Chromium
check uses the real API's availability call first: it exposes `LanguageModel` but reports unavailable
in the tested configuration. It then injects a synthetic model to verify opt-in, interpretation,
ranking and cleanup alongside real provider code with synthetic HTTP. Actual Gemini Nano semantic
accuracy and inference latency remain **unverified**; mock results are not a quality benchmark.

Keep local AI optional and treat it as experimental until it can be evaluated with the authored
corpus on an available device. No complete-history or general recall guarantee is made. The fallback
is literal matching and does not claim semantic understanding. A future real evaluation should record
first-match recall, false positives, evidence support and latency, separately from transport tests.
Literal fallback requires all original content words together in one passage, without combining
independent snippets or using expanded terms as replacement constraints. This favors precision and
can miss relevant paraphrases or longer explanations. Food, TV, location-qualified descriptions and
misleading co-occurrences have synthetic regression coverage; real-model accuracy is still unverified.

## Hosted option

Hosted AI could avoid local hardware/download requirements, but would send selected descriptions and
excerpts outside the browser and need a separately authorized service, secure key handling, retention
policy, cost/usage limits and exact-payload consent. It is not implemented or enabled, and no hosted
fallback occurs. Local processing preserves the current privacy boundary without adding permissions,
remote runtime code, service credentials or a billing dependency. See [description search](description-search.md).
