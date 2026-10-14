# Developer notes

## Baseline layout

| Path                            | Role                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `src/entrypoints/`              | WXT background and side panel entrypoints                     |
| `src/ui/`                       | React presentation; currently only setup status               |
| `src/contracts/`                | Reserved for normalized runtime-validated contracts           |
| `src/platform/`                 | Reserved for Chrome session/message/access boundaries         |
| `src/providers/chatgpt/`        | Reserved for ChatGPT transport and parsing                    |
| `src/providers/google-ai-mode/` | Reserved for Google Search AI Mode transport and parsing      |
| `src/search/`                   | Reserved for provider-independent search orchestration        |
| `src/description/`              | Reserved for interpretation, ranking, and evidence validation |
| `src/storage/`                  | Reserved for isolated optional local storage                  |
| `tests/fixtures/`               | Reserved for fictional/synthetic response fixtures            |
| `demo/`                         | Reserved for the future synthetic static demo                 |
| `public/`                       | Only deliberately public extension assets                     |

Empty directories contain `.gitkeep` files. They do not implement the reserved capability. Keep
shared contracts, orchestration, and presentation independent of authenticated adapters so a future
demo can supply synthetic capabilities without importing browser session access.

## Build and checks

WXT discovers `src/entrypoints/sidepanel/index.html` and generates the MV3 side panel manifest.
The React integration uses `@wxt-dev/module-react`; TypeScript extends the generated WXT config.
See the official [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints.html),
[React module](https://wxt.dev/guide/essentials/frontend-frameworks.html), and
[TypeScript configuration](https://wxt.dev/guide/essentials/config/typescript.html) documentation.
Chrome documents the [side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

`npm run check` and `npm run build` are the available baseline checks. Feature test, lint, demo,
CI, and ZIP commands will be introduced with their implementations. Do not treat the empty background
entrypoint as proof of authenticated provider access.

## Data and artifacts

Only synthetic data may enter automated fixtures or public demonstrations. Never copy session
cookies, authorization headers, private conversations, account identifiers, raw network captures,
or live response bodies into tracked files. Report errors using bounded safe metadata.

Build assets are explicitly rooted in source entrypoints and `public/`. Keep local agent material
out of both. WXT source ZIP generation is disabled and explicit archive exclusions are configured.
Future release checks must inspect archive contents; do not archive the repository root. Static demo
publishing must use only its dedicated build directory and must not import provider/storage code.

No distribution license has been selected. Keep publishing and store submission as separate later
decisions. Local builds can be inspected with Developer mode as described in the README.
