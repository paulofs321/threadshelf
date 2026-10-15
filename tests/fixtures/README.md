# Synthetic fixtures

All fixtures are handwritten fiction about a floating library or an imaginary clockwork orchard.
Account/workspace partitions, conversation IDs, excerpts and timestamps are invented.
The `.invalid` URLs are reserved synthetic
links, and their link policies simulate adapter validation without making network requests.

Fixtures exercise normalized shared contracts and adapter-owned response structures. They prove no
browser authentication, live endpoint availability, model inference, or persistence support.
`chatgpt/requests.ts` defines fictional normalized scope/query inputs; `chatgpt/wire.ts` defines
handwritten search/list/message/bootstrap shapes established by separate read-only verification.
The deliberately fake credential is a test canary, never a live token or copied response.
