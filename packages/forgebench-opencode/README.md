# @forgebench/opencode

Forgebench plugin for **OpenCode 2.x only** (no 1.x hooks, no `config()` fallback). One V2 `Plugin.define`
entry, loaded from the root `server.js`, compiled from TypeScript into `dist/`. The OpenCode host provides
`@opencode/plugin`, so nothing is installed at runtime.

The plugin is **self-contained**. It does not need, download, locate, read credentials from, or run the
Forgebench CLI. Browser sign-in, the governed model gateway, model discovery, and session, context and
trace delivery all go straight from OpenCode to your Forgebench deployment. The CLI stays an optional
manager (discovery, health checks, repair, historical import); its absence changes nothing here.

## Install

Requires OpenCode 2.x (`opencode --version`). OpenCode 2.x is the `@opencode/cli` npm package; the old
`opencode-ai` package stops at 1.19.5 and owns the same `opencode` command, so remove it first:

```sh
npm uninstall -g opencode-ai && npm install -g @opencode/cli
```

Then use only OpenCode commands:

```sh
opencode plugin add @forgebench/opencode
opencode auth login forgebench --method oauth
```

OpenCode installs the package and registers the Forgebench provider. Sign in with `/connect` (browser) or
the command above, restart OpenCode if it asks you to, then pick a Forgebench model in `/models`. No
options or JSON edits are needed for the hosted service at `https://api.forgebench.ai`.

## What browser sign-in gives you

Browser sign-in runs the same OIDC loopback PKCE login as the Forgebench CLI, then asks you to approve
model access, which asks for your password a second time. It stores **two separate grants** in
OpenCode's own credential store:

| Grant | Used for | Where it lives |
| --- | --- | --- |
| Model key | `/v1/models` and every governed model request | OAuth `access` field |
| Reporting key | session, context, trace and task delivery (`sessions:write` only) | secret OAuth `refresh` field |

They are different keys with different permissions. A pasted gateway key creates no reporting
credential.

The model key must be one a workspace admin issued to you that has not been used yet. If there is none to
offer, or you decline the consent page, a reconnect keeps the model key OpenCode already holds and stores the
new reporting key. A first connection fails with that explanation; the unused reporting key stays on the
server until your next sign-in from this install replaces it, or you revoke it in the console. Ask an admin for a developer key, or connect with a pasted key. The remote MCP server is a third, independent grant handled by OpenCode's own MCP OAuth.
Keys never appear in URLs, logs, provider options or browser pages. The plugin never reads or writes
another tool's credential store.

## Options

Passed as `plugins: [{ "package": "<dir or name>", "options": { ... } }]`. Omit options for the hosted
defaults. Every feature defaults on; an explicit `false` turns it off, and all off registers nothing.

| Option | Use |
| --- | --- |
| `url` | Deployment origin (default `https://api.forgebench.ai`). Must be `https` (plain `http` only on loopback); anything else disables every network feature. |
| `gateway` | Register the `forgebench` provider, model discovery and per-request credentials. |
| `auth` | `"auto"` (default), `"oauth"`, `"key"` or `"none"`: which `/connect` methods are offered. |
| `apiKey` | Static gateway key for headless/CI setups (prefer `/connect` or the env var). |
| `reporting` | Direct session/context delivery. `sync: false` is accepted as the same opt-out. |
| `context` | `false` keeps reporting on but sends no repository, branch or remote. |
| `traces` | `false` stops tool and session spans. |
| `task` | `{ "connectionId": "<uuid>", "taskId": "ENG-123" }`: an explicit task selection declared at session start. Never inferred from a branch. |
| `mcp` / `mcpUrl` | Remote MCP server `forgebench` (default `<url>/mcp`). An existing `forgebench` MCP entry is left alone. |
| `models` | Fallback models used until `/v1/models` is reachable. |
| `headers` | Extra routing headers on the provider. `Authorization` is ignored. |
| `executable` | Accepted for old configs and ignored. |

If your config already defines a `forgebench` provider for a different host, the plugin leaves it exactly
as it is, does not send it any Forgebench credential, and records the conflict in plugin storage.

## Credentials, in order

Model requests: the active OpenCode connection, then the `apiKey` option, then `FORGEBENCH_GATEWAY_KEY`.
Reporting: the reporting key from the active connection, else the explicit `FORGEBENCH_API_KEY`. Those
environment variables are optional headless overrides that you set yourself; the plugin never writes them.
A credential stored for another deployment is never used.

## What is sent, and when

- **Gateway:** `Authorization`, `X-Forgebench-Session-Id`, `X-Forgebench-Harness: opencode` and a fresh
  `X-Client-Request-Id` go only to the configured deployment. Budgets, model policy, metering and audit
  stay server-side, and usage is measured at the gateway. The plugin never uploads token usage, so
  nothing is counted twice.
- **Sessions:** on session start and end, `POST /v1/sessions/meta` with the full native session id,
  real parent id for subagents, timestamps, safe repository/branch names and counters. Prompts, code,
  paths and tool inputs are never sent.
- **Traces:** OpenCode has no native OpenTelemetry exporter, so the plugin builds its own metadata-only
  spans from OpenCode's tool hooks (tool name, timing, status, parentage) and posts them with the
  reporting key. This requires a backend that returns an explicit storage receipt; otherwise the plugin
  reports traces as unsupported and stops trying for an hour. It does not claim OTel.
- **Reliability:** a bounded local spool, exponential backoff with jitter, `Retry-After`, no replay of
  400/403/409/422, and a pause after a `401` (revoked or expired grant) until you sign in again. Capture
  policy (`off`, `local`, `otel`, ...) is checked before every upload.

Features that depend on backend capabilities that may not be deployed yet are isolated in
`src/core/proposed.ts` and fail closed.

## Layout

- `src/core/`: runtime-independent modules (backend client, sign-in, queue, delivery, redaction,
  payloads, catalog). They import nothing from `@opencode/*`, so a future OpenCode 1.x package can reuse them.
- `src/v2/` and `src/server.ts`: the OpenCode 2.x adapter (`Plugin.define`, `setup`, integration and
  session hooks).

## Develop

```sh
npm ci
npm run typecheck
npm test          # clean build, then node --test (core, V2 adapter, sign-in, release scripts)
npm run smoke     # real OpenCode 2.x in a throwaway HOME/XDG tree with a fake backend; skips if not installed
```
