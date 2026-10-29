import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setup } from "../src/plugin.js"
import { createTokenSource } from "../src/token.js"
import { createSyncRunner } from "../src/sync.js"

const KEY = "fbk_secret_value"
const EXE = "/usr/local/bin/forgebench"

// A stand-in for the V2 plugin context: it records what the plugin registers.
function fakeCtx(options, events = []) {
  const reg = { provider: [], hooks: [], mcp: [], subscribed: 0, aborted: false }
  const ctx = {
    options,
    provider: { transform: async (cb) => { cb({ add: (input) => reg.provider.push(input) }) } },
    session: { hook: async (name, cb, opts) => { reg.hooks.push({ name, cb, opts }) } },
    mcp: { transform: async (cb) => { cb({ set: (name, config) => reg.mcp.push({ name, config }) }) } },
    event: {
      subscribe: ({ signal }) => {
        reg.subscribed += 1
        signal.addEventListener("abort", () => { reg.aborted = true })
        return (async function* () { yield* events })()
      },
    },
  }
  return { ctx, reg }
}

const gatewayOptions = {
  gateway: true,
  url: "https://gw.example.com/",
  executable: EXE,
  models: ["gpt-5", { id: "claude-x", name: "Claude X", context: 1000 }],
  headers: { "X-Forgebench-Profile": "p1", Authorization: "Bearer nope" },
}

test("provider is registered from options without apiKey", async () => {
  const { ctx, reg } = fakeCtx({ ...gatewayOptions, apiKey: KEY })
  await setup(ctx, { token: { run: async () => KEY } })
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
  await setup(ctx, { token: { run: async () => `${KEY}\n` } })
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
  let spawns = 0
  const run = async () => { spawns += 1; if (spawns === 1) throw new Error("boom"); return KEY }
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run } })
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
    await setup(ctx)
    const event = { model: { providerID: "forgebench" }, headers: {} }
    await reg.hooks[0].cb(event)
    assert.equal(event.headers.authorization, "Bearer staging-key")
    assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["gateway", "token", "--forgebench-url", url])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
    assert.equal(reg.subscribed, 0)
    assert.equal(cleanup, undefined)
  }
})

test("each flag enables only its slice", async () => {
  const base = { url: "https://gw.example.com", executable: EXE }
  const gw = fakeCtx({ ...base, gateway: true })
  await setup(gw.ctx)
  assert.equal(gw.reg.provider.length, 1)
  assert.equal(gw.reg.mcp.length + gw.reg.subscribed, 0)

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

test("an explicit mcpUrl wins and the gateway slice needs url and executable", async () => {
  const a = fakeCtx({ mcp: true, mcpUrl: "https://mcp.example.com/mcp" })
  await setup(a.ctx)
  assert.equal(a.reg.mcp[0].config.url, "https://mcp.example.com/mcp")
  const b = fakeCtx({ gateway: true, url: "https://gw" })
  await setup(b.ctx)
  assert.deepEqual(b.reg.provider, [])
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
