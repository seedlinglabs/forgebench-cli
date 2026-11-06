import assert from "node:assert/strict"
import { test } from "node:test"
import { setup } from "../dist/v2/plugin.js"
import { createCredentialResolver, LEGACY_REFRESH } from "../dist/v2/auth.js"
import { PROVIDER_ID } from "../dist/v2/options.js"
import { fakeBackend, fakeConnection, fakeCtx, fakeStorage, installTripwire } from "./helpers.js"

const KEY = "fbk_secret_value"
// Keeps first-read discovery off the network: setup races a failing fetch instead of DNS.
const OFFLINE = { models: { fetchImpl: () => Promise.reject(new Error("offline")) }, reporting: { autoRetry: false } }
const gatewayOptions = {
  gateway: true,
  url: "https://gw.example.com/",
  models: ["gpt-5", { id: "claude-x", name: "Claude X", context: 1000 }],
  headers: { "X-Forgebench-Profile": "p1", Authorization: "Bearer nope" },
}

// Every test in this file runs with a recording `forgebench` first on PATH; the last test asserts silence.
const tripwire = installTripwire()

const modelRequest = (reg) => reg.hooks.find((hook) => hook.name === "model.request")
const send = async (reg, event = {}) => {
  const hook = modelRequest(reg)
  const input = { model: { providerID: PROVIDER_ID }, headers: {}, sessionID: "ses_1", ...event }
  await hook.cb(input)
  return input
}

test("cleanup waits for an in-flight native session report", async () => {
  let release
  let started
  const began = new Promise((resolve) => { started = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  const backend = fakeBackend({
    "GET /v1/auth/whoami": { tenant_id: "tenant-1", identity_id: "person-1" },
    "GET /v1/sessions/capture-policy": { effective: { mode: "legacy", revision: 0 } },
    "POST /v1/sessions/meta": async () => { started(); await blocked; return { accepted: 1 } },
  })
  const url = "https://gw.example.com"
  const conn = fakeConnection({ type: "oauth", access: KEY, refresh: "reporting", metadata: { url } })
  const { ctx } = fakeCtx({ url, gateway: false, mcp: false, traces: false }, {
    connection: conn.connection,
    events: [{ type: "session.idle", data: { sessionID: "ses_1" } }],
    sessions: { ses_1: { time: { created: 1_700_000_000_000, idle: 1_700_000_010_000 } } },
  })
  const cleanup = await setup(ctx, { reporting: { fetchImpl: backend.fetchImpl, autoRetry: false } })
  await began
  let finished = false
  const closing = cleanup().then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  release()
  await closing
  assert.equal(backend.count("/v1/sessions/meta"), 1)
})

test("provider is registered from options without apiKey in its settings, and the harness header is kept", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, OFFLINE)
  const { info, models } = reg.provider[0]
  assert.equal(info.id, PROVIDER_ID)
  assert.equal(info.settings.baseURL, "https://gw.example.com/v1")
  assert.ok(!("apiKey" in info.settings))
  assert.equal(info.headers["X-Forgebench-Harness"], "opencode")
  assert.equal(info.headers["X-Forgebench-Profile"], "p1")
  assert.ok(!Object.keys(info.headers).some((name) => name.toLowerCase() === "authorization"))
  assert.deepEqual(models.map((m) => m.id), ["gpt-5", "claude-x"])
})

test("model.request injects Authorization, the session header and a request id; it strips a user Authorization", async () => {
  const { ctx, reg } = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(ctx, OFFLINE)
  assert.deepEqual(modelRequest(reg).opts, { providerID: PROVIDER_ID })
  const out = await send(reg, { headers: { Authorization: "Bearer user" } })
  assert.equal(out.headers.authorization, `Bearer ${KEY}`)
  assert.equal(out.headers.Authorization, undefined)
  assert.equal(out.headers["X-Forgebench-Session-Id"], "ses_1")
  assert.match(out.headers["X-Client-Request-Id"], /^[0-9a-f-]{36}$/)
  const other = { model: { providerID: "openai" }, headers: {}, sessionID: "ses_1" }
  await modelRequest(reg).cb(other)
  assert.deepEqual(other.headers, {})
})

test("credential precedence: connection, then apiKey, then FORGEBENCH_GATEWAY_KEY; no CLI fallback exists", async () => {
  const url = "https://gw.example.com"
  const env = { FORGEBENCH_GATEWAY_KEY: "from-env" }
  const conn = fakeConnection({ type: "oauth", access: "from-connection", refresh: "r", metadata: { url } })
  const make = (extra) => createCredentialResolver({ url, env: () => env, ttlMs: 0, ...extra })
  assert.equal(await make({ integration: { connection: conn.connection }, apiKey: "from-option" })(), "from-connection")
  assert.equal(await make({ apiKey: "from-option" })(), "from-option")
  assert.equal(await make({})(), "from-env")
  // A connection stored for another deployment is never used here.
  conn.state.credential = { type: "oauth", access: "elsewhere", refresh: "r", metadata: { url: "https://other.example" } }
  assert.equal(await make({ integration: { connection: conn.connection }, apiKey: "from-option" })(), "from-option")
  // A pasted key credential resolves from `key`.
  conn.state.credential = { type: "key", key: "pasted" }
  assert.equal(await make({ integration: { connection: conn.connection } })(), "pasted")
  // Lookup failure falls through; nothing spawns anything (tripwire is checked in after()).
  const broken = { connection: { active: async () => { throw new Error("boom") }, resolve: async () => undefined } }
  assert.equal(await make({ integration: broken })(), "from-env")
  assert.equal(await createCredentialResolver({ url, env: () => ({}) })(), undefined)
})

test("a request without any credential sends no Authorization and keeps the session header", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, OFFLINE)
  const out = await send(reg)
  assert.equal(out.headers.authorization, undefined)
  assert.equal(out.headers["X-Forgebench-Session-Id"], "ses_1")
})

test("auth auto registers both /connect methods; oauth/key register one; none registers neither", async () => {
  const methods = async (auth) => {
    const { ctx, reg } = fakeCtx({ ...gatewayOptions, auth })
    await setup(ctx, OFFLINE)
    return reg.methods.map((m) => `${m.integrationID}:${m.method.type}`)
  }
  assert.deepEqual(await methods("auto"), ["forgebench:oauth", "forgebench:key"])
  assert.deepEqual(await methods("oauth"), ["forgebench:oauth"])
  assert.deepEqual(await methods("key"), ["forgebench:key"])
  assert.deepEqual(await methods("none"), [])
})

test("authorize() runs the CLI-free sign-in with an opencode-<install> descriptor and stores two distinct grants", async () => {
  const seen = []
  const startSignIn = async (input) => {
    seen.push(input)
    return { url: "https://gw.example.com/login", promise: Promise.resolve({ access: "gateway-secret", reportingKey: "reporting-secret", name: "My key", prefix: "sk_x" }) }
  }
  const storage = fakeStorage({ "device-id": "install-123" })
  const { ctx, reg } = fakeCtx(gatewayOptions, { storage })
  await setup(ctx, { ...OFFLINE, oauth: { startSignIn } })
  const oauth = reg.methods.find((m) => m.method.type === "oauth")
  const authorization = await oauth.authorize({})
  assert.equal(seen[0].installId, "install-123")
  assert.equal(seen[0].url, "https://gw.example.com")
  assert.equal(authorization.mode, "auto")
  assert.ok(!authorization.instructions.includes("CLI"))
  const credential = await authorization.callback
  assert.equal(credential.access, "gateway-secret")
  assert.equal(credential.refresh, "reporting-secret")
  assert.deepEqual(credential.metadata, { url: "https://gw.example.com", name: "My key", prefix: "sk_x" })
  assert.equal(oauth.label(credential), "ForgeBench · My key")
})

test("authorize() offers sign-in the current model key only from a connection on the same deployment", async () => {
  const seen = []
  const startSignIn = async (input) => { seen.push(input); return { url: "u", promise: new Promise(() => {}) } }
  const conn = fakeConnection({ type: "oauth", access: "current-model-key", refresh: "r", metadata: { url: "https://gw.example.com", name: "Kept", prefix: "sk_k" } })
  const { ctx, reg } = fakeCtx(gatewayOptions, { connection: conn.connection })
  await setup(ctx, { ...OFFLINE, oauth: { startSignIn } })
  await reg.methods.find((m) => m.method.type === "oauth").authorize({})
  const current = seen[0].currentAccess
  assert.deepEqual(await current(), { access: "current-model-key", name: "Kept", prefix: "sk_k" })
  conn.state.credential = { type: "oauth", access: "elsewhere", refresh: "r", metadata: { url: "https://other.example" } }
  assert.equal(await current(), undefined)
  conn.state.credential = { type: "key", key: "pasted" }
  assert.deepEqual(await current(), { access: "pasted" })
  conn.state.credential = undefined
  assert.equal(await current(), undefined)
})

test("with reporting disabled the reporting grant is not stored", async () => {
  const startSignIn = async () => ({ url: "u", promise: Promise.resolve({ access: "g", reportingKey: "r" }) })
  const { ctx, reg } = fakeCtx({ ...gatewayOptions, sync: false })
  await setup(ctx, { ...OFFLINE, oauth: { startSignIn } })
  const credential = await (await reg.methods.find((m) => m.method.type === "oauth").authorize({})).callback
  assert.equal(credential.refresh, LEGACY_REFRESH)
})

test("sign-in failures propagate to the connect UI", async () => {
  const startSignIn = async () => ({ url: "u", promise: Promise.reject(new Error("declined")) })
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { ...OFFLINE, oauth: { startSignIn } })
  const authorization = await reg.methods.find((m) => m.method.type === "oauth").authorize({})
  await assert.rejects(authorization.callback, /declined/)
})

const catalog = { data: [{ id: "live-model", kind: "chat", available: true, context_window: 9000, max_output_tokens: 700, description: "Live", input_per_1k_usd: 0.001, output_per_1k_usd: 0.002 }, { id: "embed", kind: "embedding" }] }
const catalogFetch = (calls = []) => async (url, init) => { calls.push({ url: String(url), init }); return Response.json(catalog) }

test("discovery replaces the fallback models, survives reloads, and uses the resolved key", async () => {
  const calls = []
  const { ctx, reg, providers } = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(ctx, { ...OFFLINE, models: { fetchImpl: catalogFetch(calls) } })
  assert.equal(calls[0].url, "https://gw.example.com/v1/models")
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
  assert.deepEqual([...providers.get(PROVIDER_ID).models.keys()], ["live-model"])
  const model = providers.get(PROVIDER_ID).models.get("live-model")
  assert.equal(model.limit.context, 9000)
  assert.equal(model.cost[0].input, 1)
  assert.ok(reg.reloads >= 1)
})

test("failed or credential-less discovery keeps the fallback list", async () => {
  const failing = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(failing.ctx, OFFLINE)
  assert.deepEqual([...failing.providers.get(PROVIDER_ID).models.keys()], ["gpt-5", "claude-x"])
  const calls = []
  const anonymous = fakeCtx(gatewayOptions)
  await setup(anonymous.ctx, { ...OFFLINE, models: { fetchImpl: catalogFetch(calls) } })
  assert.equal(calls.length, 0)
  assert.deepEqual([...anonymous.providers.get(PROVIDER_ID).models.keys()], ["gpt-5", "claude-x"])
})

test("a credential event with a working gateway swaps the model list", async () => {
  const conn = fakeConnection(undefined)
  const events = [{ type: "credential.updated", data: {} }]
  const { ctx, providers } = fakeCtx({ ...gatewayOptions }, { events, connection: conn.connection })
  conn.state.credential = { type: "key", key: KEY }
  await setup(ctx, { ...OFFLINE, models: { fetchImpl: catalogFetch() } })
  for (let i = 0; i < 20 && !providers.get(PROVIDER_ID).models.has("live-model"); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(providers.get(PROVIDER_ID).models.has("live-model"))
})

test("no options enables the hosted gateway, connect methods, MCP and direct reporting, with no executable involved", async () => {
  const { ctx, reg } = fakeCtx(undefined)
  const cleanup = await setup(ctx, OFFLINE)
  assert.equal(reg.provider[0].info.settings.baseURL, "https://api.forgebench.ai/v1")
  assert.deepEqual(reg.methods.map((m) => m.method.type), ["oauth", "key"])
  assert.deepEqual(reg.mcp, [{ name: "forgebench", config: { type: "remote", url: "https://api.forgebench.ai/mcp", oauth: { client_id: "forgebench-opencode" } } }])
  assert.deepEqual(reg.toolHooks.map((h) => h.name), ["execute.before", "execute.after"])
  assert.equal(reg.subscribed, 1)
  assert.equal(typeof cleanup, "function")
  await cleanup()
  assert.equal(reg.aborted, true)
})

test("explicit false flags and invalid flag types register nothing; sync:false is the reporting opt-out alias", async () => {
  for (const options of [{ gateway: false, sync: false, mcp: false }, { gateway: "false", sync: 0, mcp: null }, { gateway: false, reporting: false, mcp: false }]) {
    const { ctx, reg } = fakeCtx(options)
    assert.equal(await setup(ctx, OFFLINE), undefined)
    assert.deepEqual([reg.provider.length, reg.hooks.length, reg.methods.length, reg.mcp.length, reg.subscribed, reg.toolHooks.length], [0, 0, 0, 0, 0, 0])
  }
  const reportingOff = fakeCtx({ sync: false })
  await setup(reportingOff.ctx, OFFLINE)
  assert.equal(reportingOff.reg.toolHooks.length, 0)
  assert.equal(reportingOff.reg.provider.length, 1)
  const onlyMcp = fakeCtx({ gateway: false, sync: false })
  await setup(onlyMcp.ctx, OFFLINE)
  assert.equal(onlyMcp.reg.mcp.length, 1)
  assert.equal(onlyMcp.reg.provider.length, 0)
})

test("deployment overrides apply everywhere and a legacy `executable` option is accepted and ignored", async () => {
  const { ctx, reg } = fakeCtx({ url: "https://gw.example.com/", mcpUrl: "https://mcp.example.com/x", executable: "/opt/forgebench", headers: { "X-Team": "t" } })
  await setup(ctx, OFFLINE)
  assert.equal(reg.provider[0].info.settings.baseURL, "https://gw.example.com/v1")
  assert.equal(reg.mcp[0].config.url, "https://mcp.example.com/x")
  assert.equal(reg.provider[0].info.headers["X-Team"], "t")
})

test("an invalid or non-https deployment url fails closed: nothing registers", async () => {
  for (const url of ["http://api.example.com", "ftp://x", "not a url", "https://user:pw@api.example.com"]) {
    const { ctx, reg } = fakeCtx({ url })
    assert.equal(await setup(ctx, OFFLINE), undefined, url)
    assert.deepEqual([reg.provider.length, reg.mcp.length, reg.toolHooks.length], [0, 0, 0])
  }
  const loopback = fakeCtx({ url: "http://127.0.0.1:8000" })
  await setup(loopback.ctx, OFFLINE)
  assert.equal(loopback.reg.provider[0].info.settings.baseURL, "http://127.0.0.1:8000/v1")
})

test("config conflict: a user-defined forgebench provider for another host is left untouched and never receives the key", async () => {
  const userProvider = { id: PROVIDER_ID, name: "Mine", settings: { baseURL: "https://proxy.corp.example/v1" }, headers: { "X-Mine": "1" }, activation: "disabled" }
  const providers = new Map([[PROVIDER_ID, { provider: userProvider, models: new Map() }]])
  const { ctx, reg, storage } = fakeCtx({ ...gatewayOptions, apiKey: KEY }, { providers })
  await setup(ctx, { ...OFFLINE, models: { fetchImpl: catalogFetch() } })
  assert.deepEqual(userProvider, { id: PROVIDER_ID, name: "Mine", settings: { baseURL: "https://proxy.corp.example/v1" }, headers: { "X-Mine": "1" }, activation: "disabled" })
  assert.equal(reg.provider.length, 0)
  const out = await send(reg)
  assert.equal(out.headers.authorization, undefined)
  assert.equal(await storage.get("config-conflict:provider"), true)
})

test("a user's existing provider for the same deployment is merged, not replaced", async () => {
  const userProvider = { id: PROVIDER_ID, name: "Mine", settings: { baseURL: "https://gw.example.com/v1", timeout: 5 }, headers: { "X-Mine": "1" } }
  const providers = new Map([[PROVIDER_ID, { provider: userProvider, models: new Map() }]])
  const { ctx } = fakeCtx(gatewayOptions, { providers })
  await setup(ctx, OFFLINE)
  assert.equal(userProvider.name, "Mine")
  assert.equal(userProvider.settings.timeout, 5)
  assert.equal(userProvider.headers["X-Mine"], "1")
  assert.equal(userProvider.headers["X-Forgebench-Harness"], "opencode")
})

test("config conflict: an existing forgebench MCP entry is never overwritten", async () => {
  const same = fakeCtx({ gateway: false, sync: false, mcpUrl: "https://mcp.example.com/x" }, { mcpExisting: { forgebench: { type: "remote", url: "https://mcp.example.com/x" } } })
  await setup(same.ctx, OFFLINE)
  assert.equal(same.reg.mcp.length, 0)
  assert.equal(await same.storage.get("config-conflict:mcp"), undefined)
  const other = fakeCtx({ gateway: false, sync: false }, { mcpExisting: { forgebench: { type: "remote", url: "https://elsewhere.example/mcp" } } })
  await setup(other.ctx, OFFLINE)
  assert.equal(other.reg.mcp.length, 0)
  assert.equal(await other.storage.get("config-conflict:mcp"), true)
})

test("a request headed to a different base URL never gets the Forgebench credential", async () => {
  const { ctx, reg } = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(ctx, OFFLINE)
  const out = await send(reg, { baseURL: "https://evil.example/v1" })
  assert.equal(out.headers.authorization, undefined)
  const ok = await send(reg, { baseURL: "https://gw.example.com/v1" })
  assert.equal(ok.headers.authorization, `Bearer ${KEY}`)
})

test("the plugin never invoked a forgebench executable during this file", () => {
  assert.equal(tripwire.calls(), "")
  tripwire.restore()
})
