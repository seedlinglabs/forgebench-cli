import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setup } from "../src/plugin.js"
import { PROVIDER_ID } from "../src/options.js"
import { createTokenSource } from "../src/token.js"
import { createSyncRunner } from "../src/sync.js"

const KEY = "fbk_secret_value"
const EXE = "/usr/local/bin/forgebench"
// Keeps first-read discovery off the network: every gateway-driven setup races a
// failing fetch instead of a DNS timeout.
const OFFLINE = { models: { fetchImpl: () => Promise.reject(new Error("offline")) } }

// A stand-in for the V2 plugin context: it records what the plugin registers and
// replays provider transforms on `provider.reload()` (how OpenCode picks up new models).
function fakeCtx(options, events = []) {
  const reg = { provider: [], hooks: [], mcp: [], methods: [], subscribed: 0, aborted: false, reloads: 0 }
  const providers = new Map()
  const transforms = []
  const editor = () => ({
    add: (input) => {
      if (providers.has(input.info.id)) throw new Error(`provider ${input.info.id} already exists`)
      providers.set(input.info.id, { info: input.info, models: new Map(input.models.map((m) => [m.id, m])) })
      reg.provider.push(input)
    },
    get: (id) => providers.get(id),
    update: (id, fn) => { const record = providers.get(id); if (record) fn(record.info) },
    models: {
      set: (id, list) => {
        const record = providers.get(id)
        if (record) record.models = new Map(list.map((m) => [m.id, m]))
      },
    },
  })
  const ctx = {
    options,
    provider: {
      transform: async (cb) => { transforms.push(cb); cb(editor()) },
      reload: async () => { reg.reloads += 1; for (const cb of transforms) cb(editor()) },
    },
    integration: {
      transform: async (cb) => {
        cb({ method: { update: (input) => reg.methods.push(input) } })
      },
    },
    session: { hook: async (name, cb, opts) => { reg.hooks.push({ name, cb, opts }) } },
    mcp: { transform: async (cb) => { cb({ set: (name, config) => reg.mcp.push({ name, config }) }) } },
    event: {
      subscribe: ({ signal }) => {
        reg.subscribed += 1
        signal?.addEventListener?.("abort", () => { reg.aborted = true })
        return (async function* () { yield* events })()
      },
    },
  }
  return { ctx, reg, providers, discover: (credential) => ({ credential }) }
}

const gatewayOptions = {
  gateway: true,
  url: "https://gw.example.com/",
  executable: EXE,
  models: ["gpt-5", { id: "claude-x", name: "Claude X", context: 1000 }],
  headers: { "X-Forgebench-Profile": "p1", Authorization: "Bearer nope" },
}

test("provider is registered from options without apiKey in its settings", async () => {
  const { ctx, reg } = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(ctx, { token: { run: async () => KEY }, ...OFFLINE })
  assert.equal(reg.provider.length, 1)
  const { info, models } = reg.provider[0]
  assert.equal(info.id, "forgebench")
  assert.equal(info.settings.baseURL, "https://gw.example.com/v1")
  assert.ok(!("apiKey" in info.settings))
  assert.deepEqual(info.headers, { "X-Forgebench-Harness": "opencode", "X-Forgebench-Profile": "p1" })
  assert.deepEqual(models.map((m) => m.id), ["gpt-5", "claude-x"])
  assert.equal(models[1].limit.context, 1000)
  assert.ok(!JSON.stringify(reg.provider).includes(KEY))
})

test("model.request injects Authorization and the session header", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run: async () => `${KEY}\n` }, ...OFFLINE })
  const hook = reg.hooks.find((h) => h.name === "model.request")
  assert.deepEqual(hook.opts, { providerID: "forgebench" })
  const event = { model: { providerID: "forgebench" }, sessionID: "ses_1", headers: {} }
  await hook.cb(event)
  assert.equal(event.headers.authorization, `Bearer ${KEY}`)
  assert.equal(event.headers["X-Forgebench-Session-Id"], "ses_1")
  const other = { model: { providerID: "openai" }, sessionID: "ses_1", headers: {} }
  await hook.cb(other)
  assert.deepEqual(other.headers, {})
})

test("credential precedence: connection wins over apiKey, option, env and the CLI token", async () => {
  const DEV = process.env.FORGEBENCH_GATEWAY_KEY
  process.env.FORGEBENCH_GATEWAY_KEY = "env-key"
  try {
    const connection = { type: "credential", id: "c1" }
    const calls = []
    const { ctx, reg } = fakeCtx({ ...gatewayOptions, apiKey: "option-key" })
    ctx.integration.connection = {
      active: async (integrationID) => {
        calls.push(integrationID)
        return connection
      },
      resolve: async (conn) => {
        assert.equal(conn, connection)
        return { type: "oauth", access: "connection-key" }
      },
    }
    await setup(ctx, { token: { run: async () => { throw new Error("must not be called") } }, ...OFFLINE })
    const event = { model: { providerID: "forgebench" }, sessionID: "ses_1", headers: {} }
    await reg.hooks[0].cb(event)
    assert.equal(event.headers.authorization, "Bearer connection-key")
    assert.deepEqual(calls, [PROVIDER_ID])
  } finally {
    if (DEV === undefined) delete process.env.FORGEBENCH_GATEWAY_KEY
    else process.env.FORGEBENCH_GATEWAY_KEY = DEV
  }
})

test("credential precedence without a connection: apiKey over env, env over the CLI token", async () => {
  const saved = process.env.FORGEBENCH_GATEWAY_KEY
  process.env.FORGEBENCH_GATEWAY_KEY = "env-key"
  try {
    const { ctx, reg } = fakeCtx({ ...gatewayOptions, executable: EXE, apiKey: "option-key" })
    await setup(ctx, { token: { run: async () => "token-key" }, ...OFFLINE })
    const event = { model: { providerID: "forgebench" }, headers: {} }
    await reg.hooks[0].cb(event)
    assert.equal(event.headers.authorization, "Bearer option-key")
  } finally {
    if (saved === undefined) delete process.env.FORGEBENCH_GATEWAY_KEY
    else process.env.FORGEBENCH_GATEWAY_KEY = saved
  }
  const noKey = fakeCtx({ ...gatewayOptions })
  await setup(noKey.ctx, { token: { run: async () => "token-key" }, ...OFFLINE })
  // `now`-based cache aside, a fresh resolver per setup: no env this time.
  const event = { model: { providerID: "forgebench" }, headers: {} }
  await noKey.reg.hooks[0].cb(event)
  assert.equal(event.headers.authorization, "Bearer token-key")
})

test("a connection key credential resolves from `key`, not `access`", async () => {
  const { ctx, reg } = fakeCtx({ ...gatewayOptions })
  ctx.integration.connection = {
    active: async () => ({ type: "credential", id: "c2" }),
    resolve: async () => ({ type: "key", key: "pasted-key" }),
  }
  await setup(ctx, { token: { run: async () => "token-key" }, ...OFFLINE })
  const event = { model: { providerID: "forgebench" }, headers: {} }
  await reg.hooks[0].cb(event)
  assert.equal(event.headers.authorization, "Bearer pasted-key")
})

test("connection failure falls through to the token source", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  ctx.integration.connection = {
    active: async () => { throw new Error("integration offline") },
    resolve: async () => { throw new Error("unreachable") },
  }
  await setup(ctx, { token: { run: async () => KEY }, ...OFFLINE })
  const event = { model: { providerID: "forgebench" }, headers: {} }
  await reg.hooks[0].cb(event)
  assert.equal(event.headers.authorization, `Bearer ${KEY}`)
})

test("N concurrent token requests spawn the command once", async () => {
  let spawns = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const getToken = createTokenSource({
    executable: EXE,
    run: async (exe) => { spawns += 1; assert.equal(exe, EXE); await gate; return KEY },
  })
  const calls = Array.from({ length: 6 }, () => getToken())
  release()
  assert.deepEqual(await Promise.all(calls), Array(6).fill(KEY))
  await getToken()
  assert.equal(spawns, 1)
})

test("the cache expires after the ttl", async () => {
  let spawns = 0
  let clock = 0
  const getToken = createTokenSource({ executable: EXE, ttlMs: 100, now: () => clock, run: async () => `k${++spawns}` })
  assert.equal(await getToken(), "k1")
  clock = 99
  assert.equal(await getToken(), "k1")
  clock = 100
  assert.equal(await getToken(), "k2")
})

test("token failure sends no Authorization, keeps the session header, and retries next time", async () => {
  // The one lookup initial discovery makes lands before the hook runs; only
  // calls made after setup counts as hook traffic.
  let warmupDone = false
  let spawns = 0
  const run = async () => {
    if (!warmupDone) throw new Error("warm-up") // discovery's lookup: nothing cached on failure
    spawns += 1
    if (spawns === 1) throw new Error("boom")
    return KEY
  }
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run }, ...OFFLINE })
  warmupDone = true
  const hook = reg.hooks[0].cb
  const first = {
    model: { providerID: "forgebench" }, sessionID: "ses_1",
    headers: { Authorization: "Bearer stale-key", authorization: "Bearer another-stale-key" },
  }
  await hook(first)
  assert.deepEqual(first.headers, { "X-Forgebench-Session-Id": "ses_1" })
  const second = {
    model: { providerID: "forgebench" }, sessionID: "ses_1",
    headers: { Authorization: "Bearer stale-key" },
  }
  await hook(second)
  assert.equal(second.headers.authorization, `Bearer ${KEY}`)
  assert.ok(!("Authorization" in second.headers))
  assert.equal(spawns, 2)
})

test("an empty token is a failure; a failing command's error does not carry output", async () => {
  const empty = createTokenSource({ executable: EXE, run: async () => "  \n" })
  await assert.rejects(empty(), /printed no key/)
  const missing = createTokenSource({ executable: "/nonexistent/forgebench" })
  await assert.rejects(missing(), (err) => !err.message.includes(KEY) && /gateway token/.test(err.message))
})

test("token lookup selects the configured deployment instead of the CLI default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fb token test "))
  const executable = join(dir, "forgebench")
  const log = join(dir, "argv.json")
  const url = "https://staging.example.test"
  try {
    await writeFile(executable, `#!${process.execPath}
const { writeFileSync } = require("node:fs")
const args = process.argv.slice(2)
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args))
process.stdout.write(args[2] === "--forgebench-url" && args[3] === ${JSON.stringify(url)} ? "staging-key" : "production-key")
`, { mode: 0o755 })
    const { ctx, reg } = fakeCtx({ ...gatewayOptions, url: url + "/", executable })
    await setup(ctx, OFFLINE)
    const event = { model: { providerID: "forgebench" }, headers: {} }
    await reg.hooks[0].cb(event)
    assert.equal(event.headers.authorization, "Bearer staging-key")
    assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["gateway", "token", "--forgebench-url", url])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("auth auto registers both /connect methods, keyed to the forgebench integration", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run: async () => KEY }, ...OFFLINE })
  const kinds = reg.methods.map((m) => m.method.type)
  assert.deepEqual(kinds, ["oauth", "key"])
  for (const entry of reg.methods) assert.equal(entry.integrationID, "forgebench")
  const oauth = reg.methods[0]
  assert.equal(oauth.method.id, "oauth")
  assert.equal(oauth.method.label, "Sign in with ForgeBench")
  assert.equal(typeof oauth.authorize, "function")
  assert.equal(typeof oauth.refresh, "function")
  assert.equal(reg.methods[1].method.label, "ForgeBench gateway key")
})

test("auth oauth and auth key each register only their method; auth none registers neither", async () => {
  const oauthOnly = fakeCtx({ ...gatewayOptions, auth: "oauth" })
  await setup(oauthOnly.ctx, { token: { run: async () => KEY }, ...OFFLINE })
  assert.deepEqual(oauthOnly.reg.methods.map((m) => m.method.type), ["oauth"])

  const keyOnly = fakeCtx({ ...gatewayOptions, auth: "key" })
  await setup(keyOnly.ctx, { token: { run: async () => KEY }, ...OFFLINE })
  assert.deepEqual(keyOnly.reg.methods.map((m) => m.method.type), ["key"])

  const none = fakeCtx({ ...gatewayOptions, auth: "none" })
  await setup(none.ctx, { token: { run: async () => KEY }, ...OFFLINE })
  assert.deepEqual(none.reg.methods, [])
  assert.equal(none.reg.provider.length, 1)
})

test("authorize() runs the sign-in and resolves an oauth credential with metadata", async () => {
  const startSignIn = async ({ url }) => {
    assert.equal(url, "https://gw.example.com")
    return { url: "https://gw.example.com/v1/auth/oidc/login?…", promise: Promise.resolve({ access: KEY, name: "Ada's key", prefix: "sk_abc" }) }
  }
  const { ctx, reg } = fakeCtx({ ...gatewayOptions })
  await setup(ctx, { token: { run: async () => KEY }, oauth: { startSignIn }, ...OFFLINE })
  const method = reg.methods.find((m) => m.method.type === "oauth")
  const authorization = await method.authorize({})
  assert.equal(authorization.mode, "auto")
  assert.match(authorization.url, /^https:\/\/gw\.example\.com\/v1\/auth\/oidc\/login\?/)
  assert.equal(typeof authorization.instructions, "string")
  assert.ok(authorization.instructions.length > 0)
  const credential = await authorization.callback
  assert.deepEqual(credential, {
    type: "oauth",
    methodID: "oauth",
    refresh: "forgebench-gateway-key",
    access: KEY,
    expires: credential.expires,
    metadata: { url: "https://gw.example.com", name: "Ada's key", prefix: "sk_abc" },
  })
  assert.ok(credential.expires > Date.now() + 300 * 24 * 60 * 60 * 1000, "the static credential does not look expired")
  assert.equal(await method.refresh(credential), credential)
  assert.equal(method.label(credential), "ForgeBench · Ada's key")
  assert.equal(method.label({ metadata: {} }), undefined)
  assert.ok(!JSON.stringify(authorization).includes(KEY))
})

test("authorize() propagates sign-in failures to the connect UI", async () => {
  const startSignIn = async () => ({ url: "https://gw.example.com/l", promise: Promise.reject(new Error("declined")) })
  const { ctx, reg } = fakeCtx({ ...gatewayOptions })
  await setup(ctx, { token: { run: async () => KEY }, oauth: { startSignIn }, ...OFFLINE })
  const method = reg.methods.find((m) => m.method.type === "oauth")
  const authorization = await method.authorize({})
  await assert.rejects(authorization.callback, /declined/)
})

test("discovery replaces the fallback models and survives reloads", async () => {
  let calls = 0
  const catalog = () => ({
    object: "list",
    data: [
      { id: "catalog-model", kind: "chat", available: true, context_window: 9000, max_output_tokens: 777, description: "Catalog Model", input_per_1k_usd: 0.001, output_per_1k_usd: 0.002, tool_call: true, vision: false },
      { id: "embedding", kind: "embedding", available: true },
      { id: "gpt-5", kind: "chat", available: true, context_window: 5000, max_output_tokens: 500 },
    ],
  })
  const { ctx, reg, providers } = fakeCtx(gatewayOptions)
  await setup(ctx, {
    token: { run: async () => KEY },
    models: {
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify(catalog()), { status: 200, headers: { "content-type": "application/json" } })
      },
    },
  })
  assert.equal(calls, 1)
  assert.equal(reg.reloads >= 1, true)
  const record = providers.get("forgebench")
  // Discovered list is the provider's models; catalog-model (with cost per MILLION)
  // entered, the embedding entry was filtered, gpt-5 refreshed its limits.
  const ids = [...record.models.values()].map((m) => m.id)
  assert.deepEqual(ids, ["catalog-model", "gpt-5"])
  const discovered = record.models.get("catalog-model")
  assert.equal(discovered.name, "Catalog Model")
  assert.equal(discovered.limit.context, 9000)
  assert.equal(discovered.limit.output, 777)
  assert.deepEqual(discovered.cost, [{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  // Re-running the transforms (as a further reload would) does not duplicate the provider.
  await ctx.provider.reload()
  assert.deepEqual([...providers.get("forgebench").models.keys()].sort(), ["catalog-model", "gpt-5"])
  assert.equal(reg.provider.length, 1)
})

test("a failed discovery keeps the fallback model list", async () => {
  const { ctx, reg, providers } = fakeCtx(gatewayOptions)
  await setup(ctx, {
    token: { run: async () => KEY },
    models: { fetchImpl: async () => { throw new Error("gateway down") } },
  })
  const ids = [...providers.get("forgebench").models.keys()]
  assert.deepEqual(ids, ["gpt-5", "claude-x"])
  assert.equal(reg.reloads, 0)
})

test("a discovery with no credential yet stops early and leaves the fallback list", async () => {
  const fetches = []
  const { ctx, reg, providers } = fakeCtx({ ...gatewayOptions, executable: EXE })
  await setup(ctx, {
    token: { run: async () => { throw new Error("headless, no key stored") } },
    models: { fetchImpl: async (url) => { fetches.push(url); throw new Error("no credential") } },
  })
  // The token source failed, the option/env carried nothing: discovery never fetched.
  assert.deepEqual(fetches, [])
  assert.equal(reg.reloads, 0)
  assert.deepEqual([...providers.get("forgebench").models.keys()], ["gpt-5", "claude-x"])
})

test("a connection event with a working gateway swaps the model list", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ object: "list", data: [{ id: "grid-1", kind: "chat", available: true, context_window: 4096 }] }), { status: 200 })
  const { ctx, reg, providers } = fakeCtx({ ...gatewayOptions }, [{ type: "credential.switched" }])
  await setup(ctx, { token: { run: async () => KEY }, models: { fetchImpl } })
  await new Promise((resolve) => setImmediate(resolve))
  const ids = [...providers.get("forgebench").models.keys()]
  assert.deepEqual(ids, ["grid-1"])
  assert.ok(reg.reloads >= 1)
})

test("all flags off registers nothing", async () => {
  const off = [
    undefined,
    {},
    { url: "https://gw", executable: EXE, models: ["m"] },
    { gateway: "yes", sync: 1, mcp: "true", url: "https://gw", executable: EXE },
  ]
  for (const options of off) {
    const { ctx, reg } = fakeCtx(options)
    const cleanup = await setup(ctx)
    assert.deepEqual(reg.provider, [])
    assert.deepEqual(reg.hooks, [])
    assert.deepEqual(reg.mcp, [])
    assert.deepEqual(reg.methods, [])
    assert.equal(reg.subscribed, 0)
    assert.equal(cleanup, undefined)
  }
})

test("each flag enables only its slice", async () => {
  const base = { url: "https://gw.example.com", executable: EXE }
  const gw = fakeCtx({ ...base, gateway: true })
  await setup(gw.ctx, { token: { run: async () => KEY }, ...OFFLINE })
  // The gateway slice registers the provider, its per-request hook and the
  // refresh subscription; the MCP slice and options models stay untouched.
  assert.equal(gw.reg.provider.length, 1)
  assert.equal(gw.reg.mcp.length, 0)
  assert.deepEqual(gw.reg.hooks.map((h) => h.name), ["model.request"])
  assert.equal(gw.reg.subscribed, 1)

  const mcp = fakeCtx({ ...base, mcp: true })
  await setup(mcp.ctx)
  assert.deepEqual(mcp.reg.mcp, [{ name: "forgebench", config: { type: "remote", url: "https://gw.example.com/mcp", oauth: {} } }])
  assert.equal(mcp.reg.provider.length + mcp.reg.hooks.length + mcp.reg.subscribed, 0)

  const sync = fakeCtx({ ...base, sync: true })
  const cleanup = await setup(sync.ctx, { sync: { start: () => ({}) } })
  assert.equal(sync.reg.subscribed, 1)
  assert.equal(sync.reg.provider.length + sync.reg.hooks.length + sync.reg.mcp.length, 0)
  cleanup()
  assert.equal(sync.reg.aborted, true)
})

test("an explicit mcpUrl wins; the gateway slice still needs url, and a credential path", async () => {
  const a = fakeCtx({ mcp: true, mcpUrl: "https://mcp.example.com/mcp" })
  await setup(a.ctx)
  assert.equal(a.reg.mcp[0].config.url, "https://mcp.example.com/mcp")
  // No url: nothing.
  const b = fakeCtx({ gateway: true })
  await setup(b.ctx)
  assert.deepEqual(b.reg.provider, [])
  // auth none without apiKey or executable cannot authenticate: slice off.
  const c = fakeCtx({ gateway: true, url: "https://gw", auth: "none" })
  await setup(c.ctx)
  assert.deepEqual(c.reg.provider, [])
})

test("sync events spawn a detached sync, one at a time", async () => {
  const children = []
  const start = (exe, args) => {
    const handlers = {}
    const child = { exe, args, once: (name, cb) => { handlers[name] = cb }, finish: () => handlers.exit?.() }
    children.push(child)
    return child
  }
  const sync = createSyncRunner({ executable: EXE, url: "https://gw", start })
  sync(); sync(); sync()
  assert.equal(children.length, 1)
  assert.deepEqual(children[0].args, ["sync", "--quiet", "--url", "https://gw"])
  children[0].finish()
  assert.equal(children.length, 2)
  children[1].finish()
  assert.equal(children.length, 2)

  const ran = []
  const events = [{ type: "session.created" }, { type: "session.idle" }, { type: "session.execution.started" }, { type: "session.execution.failed" }]
  const { ctx } = fakeCtx({ sync: true, executable: EXE }, events)
  const cleanup = await setup(ctx, { sync: { start: (exe, args) => { ran.push([exe, args]); return {} } } })
  await new Promise((resolve) => setImmediate(resolve))
  // The stub child never emits `exit`, so the burst coalesces into the one running sync.
  assert.deepEqual(ran, [[EXE, ["sync", "--quiet"]]])
  cleanup()
})
