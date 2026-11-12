# @forgebench/opencode

Forgebench plugin for **OpenCode 2.x only** (no 1.x hooks, no `config()` fallback). One V2 `Plugin.define`
entry, loaded from the root `server.js`. The Bun host injects `@opencode/plugin`, so nothing is installed at runtime.

## Options

Passed as `plugins: [{ "package": "<dir or name>", "options": { ... } }]` (or legacy `plugin: [[path, options]]`).
Every slice is off unless its flag is `true`; with all flags off the plugin registers nothing.

| Option | Slice / use |
| --- | --- |
| `gateway` | Register the `forgebench` provider, set `X-Forgebench-Session-Id` on each model request and `Authorization` on each HTTP send. Needs `url` and `executable`. |
| `sync` | Spawn a detached `<executable> sync --quiet [--url <url>]` on `session.idle` and `session.execution.{succeeded,failed,interrupted}`. Needs `executable`. |
| `mcp` | Register the remote OAuth MCP server `forgebench` at `mcpUrl` (default `<url>/mcp`). |
| `url` | Forgebench origin; the provider `baseURL` is `<url>/v1`. |
| `executable` | Path of the `forgebench` CLI. |
| `models` | Resolved by the CLI at install time: ids or `{ id, name?, context?, output?, tools?, input? }`. |
| `headers` | Static routing headers on the provider (`X-Forgebench-Harness: opencode` is the default). `Authorization` is ignored. |

Options never carry a key, and the provider is registered **without `apiKey`**. The key is set in the
`http.request` hook, on every physical HTTP send, not in `model.request`. OpenCode prepares a model request
once, and a compaction retry resends that prepared request, so a key placed in `model.request` would stay
stale after a 401. `model.request` only strips any `Authorization` and sets `X-Forgebench-Session-Id`.

The key comes from `<executable> gateway token --forgebench-url <url>` for this deployment (stdout is the
key only).
- It is cached for 5 minutes, and the in-flight lookup is shared, so concurrent title and primary requests
  spawn one process.
- After 5 minutes, sends keep using the cached key immediately while one background refresh runs. Only a
  lookup with no key yet waits for the command.
- The last good key is kept until a refresh succeeds. A failed refresh, a forced refresh after a 401, or a
  refresh that completes after its deadline never clears or overwrites it. A failed refresh does not renew
  the TTL, so the next send starts another refresh.
- Failures are logged to stderr once per failure streak, without command output or the key. A successful
  fetch resets the streak.

Each command runs with a 30-second deadline, and the plugin owns every process the command starts. On POSIX
the command runs in its own process group. A onefile CLI bootstrap runs the real CLI as its child, so both
are in that group. At the deadline the plugin sends the group SIGTERM, then SIGKILL 2 seconds later. After
the command exits, anything it left in the group is killed. On Windows, `taskkill /T /F` ends the tree from
the bootstrap. A descendant that deliberately leaves the group (`setsid`) is out of reach.

Existing `Authorization` headers on a send to this provider are replaced. Without a previously fetched key, a
failed lookup sends no `Authorization` (the gateway answers 401). On the first 401 retry (`attempt === 2`),
the plugin awaits a forced refresh and requests an immediate retry only when that refresh produced a key.
Later attempts keep OpenCode's retry decision. Both primary and compaction retries pick up the refreshed key
in `http.request`; this is checked against OpenCode v2.2.7.

## Test

```
npm test          # node --test test/   (also passes under `bun test`)
npm run smoke     # real OpenCode 2.x, throwaway HOME/XDG under /tmp, mock OpenAI server; skips if not installed
```
