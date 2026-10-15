# Synthetic fixtures

All fixtures are handwritten fiction about a floating library or an imaginary clockwork orchard.
Account/workspace partitions, conversation IDs, excerpts and timestamps are invented.
The `.invalid` URLs are reserved synthetic
links, and their link policies simulate adapter validation without making network requests.

These fixtures exercise normalized shared contracts. They contain no provider wire responses and
prove no browser authentication, real provider endpoint behavior, model inference or storage support.
`chatgpt/requests.ts` contains normalized scope/query inputs for the unavailable provider boundary;
it deliberately defines no hypothetical ChatGPT response envelope or endpoint schema.
