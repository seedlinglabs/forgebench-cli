# @forgebench/opencode

Forgebench plugin for **OpenCode 2.x only** (no 1.x hooks, no `config()` fallback). One V2 `Plugin.define`
entry, loaded from the root `server.js`. The Bun host injects `@opencode/plugin`, so nothing is installed at runtime.

## Options

Passed as `plugins: [{ "package": "<dir or name>", "options": { ... } }]` (or legacy `plugin: [[path, options]]`).
Every slice is off unless its flag is `true`; with all flags off the plugin registers nothing.

| Option | Slice / use |
| --- | --- |
| `gateway` | Register the `forgebench` provider and inject `Authorization` + `X-Forgebench-Session-Id` per request. Needs `url` and `executable`. |
| `sync` | Spawn a detached `<executable> sync --quiet [--url <url>]` on `session.idle` and `session.execution.{succeeded,failed,interrupted}`. Needs `executable`. |
| `mcp` | Register the remote OAuth MCP server `forgebench` at `mcpUrl` (default `<url>/mcp`). |
| `url` | Forgebench origin; the provider `baseURL` is `<url>/v1`. |
| `executable` | Path of the `forgebench` CLI. |
| `models` | Resolved by the CLI at install time: ids or `{ id, name?, context?, output?, tools?, input? }`. |
| `headers` | Static routing headers on the provider (`X-Forgebench-Harness: opencode` is the default). `Authorization` is ignored. |

Options never carry a key. The provider is registered **without `apiKey`**, because setting it overrides the
`Authorization` that `model.request` sets. The key comes from
`<executable> gateway token --forgebench-url <url>` for this deployment (stdout is the key
only), cached 5 minutes with the in-flight promise shared, so concurrent title and primary requests spawn one
process. Existing Authorization headers are removed before the lookup. If the command fails or prints nothing,
no `Authorization` is sent (the gateway answers 401) and the
next request retries.

## Test

```
npm test          # node --test test/   (also passes under `bun test`)
npm run smoke     # real OpenCode 2.x, throwaway HOME/XDG under /tmp, mock OpenAI server; skips if not installed
```
