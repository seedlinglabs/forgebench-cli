# @forgebench/opencode

Forgebench plugin for **OpenCode 2.x only** (no 1.x hooks, no `config()` fallback). One V2 `Plugin.define`
entry, loaded from the root `server.js`. The Bun host injects `@opencode/plugin`, so nothing is installed at runtime.

## Options

Passed as `plugins: [{ "package": "<dir or name>", "options": { ... } }]` (or legacy `plugin: [[path, options]]`).
Every slice is off unless its flag is `true`; with all flags off the plugin registers nothing.

| Option | Slice / use |
| --- | --- |
| `gateway` | Register the `forgebench` provider, dynamic model discovery, and inject `Authorization` + `X-Forgebench-Session-Id` per request. Needs `url`. |
| `auth` | `"auto"` (default), `"oauth"`, `"key"`, or `"none"`. Selects which `/connect` methods are exposed. |
| `apiKey` | Optional static gateway key for headless/CI setups (prefers `/connect` or env). |
| `sync` | Spawn a detached `<executable> sync --quiet [--url <url>]` on `session.idle` and `session.execution.{succeeded,failed,interrupted}`. Needs `executable`. |
| `mcp` | Register the remote OAuth MCP server `forgebench` at `mcpUrl` (default `<url>/mcp`). |
| `url` | Forgebench origin; the provider `baseURL` is `<url>/v1`. |
| `executable` | Path of the `forgebench` CLI (fallback credential source and sync runner). |
| `models` | Fallback models used when `/v1/models` is unreachable or unauthenticated: ids or `{ id, name?, context?, output?, tools?, input? }`. |
| `headers` | Static routing headers on the provider (`X-Forgebench-Harness: opencode` is the default). `Authorization` is ignored. |

## Authentication & Credentials

When `gateway: true` is enabled, the provider exposes `/connect` methods to OpenCode:
- **Sign in with ForgeBench** (`oauth`): launches browser OAuth with loopback PKCE to the ForgeBench control plane. The person consents in the browser, and the resulting chat-scoped gateway key is securely transferred into OpenCode's credential store.
- **ForgeBench gateway key** (`key`): allows manually pasting a gateway key (`sk_...`).

The plugin resolves credentials per request in the following order:
1. Active OpenCode connection (`/connect`: OAuth sign-in or pasted key)
2. Static `apiKey` plugin option
3. `FORGEBENCH_GATEWAY_KEY` environment variable
4. `<executable> gateway token --forgebench-url <url>` (CLI 0600 store fallback)

Existing `Authorization` headers are stripped and replaced with the resolved Bearer token and `X-Forgebench-Session-Id`.

## Model Discovery

At setup and upon credential change (`credential.updated`, `credential.switched`, `integration.updated`), the plugin queries `GET <url>/v1/models` using the resolved credential to discover active chat models, their context/output token limits, tool/vision capabilities, and pricing. If unauthenticated or unreachable, it falls back to the configured `options.models`.

## Test

```
npm test          # node --test (also passes under `bun test`)
npm run smoke     # real OpenCode 2.x, throwaway HOME/XDG under /tmp, mock OpenAI server; skips if not installed
```
