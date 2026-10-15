# Synthetic fixtures

All fixtures are handwritten fiction about a floating library or an imaginary clockwork orchard.
Account/workspace partitions, conversation IDs, excerpts and timestamps are invented.
The `.invalid` URLs are reserved synthetic
links, and their link policies simulate adapter validation without making network requests.

Fixtures exercise normalized shared contracts and adapter-owned response structures. They contain
no copied or anonymized live payloads and prove no browser authentication, actual extension behavior,
model inference or persistence support. The provider `requests.ts` files contain fictional normalized
scope/query inputs; synthetic verified scopes establish no real account/workspace identity.

`chatgpt/wire.ts` contains handwritten search/list/message/bootstrap shapes based on separate read-only
verification. Its deliberately fake credential is a test canary, never a live token or copied response.
`google-ai-mode/wire.ts` contains handcrafted positional records based on native structural observations.
Every title, snippet, ID, state token and timestamp is fictional. Parsing/failure tests remain separate
from native and actual extension observations.
