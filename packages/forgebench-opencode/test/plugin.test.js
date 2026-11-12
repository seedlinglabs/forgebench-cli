import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setup } from "../src/plugin.js"
import { createTokenSource } from "../src/token.js"
import { createSyncRunner } from "../src/sync.js"
import { until } from "./support/gateway-e2e.js"

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

// OpenCode's flow: `model.request` prepares the headers once, `http.request` sees each physical send.
async function sendHeaders(reg, event) {
  for (const hook of reg.hooks.filter((h) => h.name === "model.request")) await hook.cb(event)
  const request = new Request("http://gw.test/v1/chat/completions", { method: "POST", headers: event.headers })
  for (const hook of reg.hooks.filter((h) => h.name === "http.request")) {
    await hook.cb({ model: event.model, sessionID: event.sessionID, request })
  }
  return request.headers
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

test("http.request sets Authorization on each send; model.request sets the session header", async () => {
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run: async () => `${KEY}\n` } })
  for (const name of ["model.request", "http.request"]) {
    assert.deepEqual(reg.hooks.find((h) => h.name === name).opts, { providerID: "forgebench" })
  }
  const event = { model: { providerID: "forgebench" }, sessionID: "ses_1", headers: {} }
  const headers = await sendHeaders(reg, event)
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`)
  assert.equal(headers.get("x-forgebench-session-id"), "ses_1")
  assert.ok(!("authorization" in event.headers), "the prepared request must not carry the key")
  const other = { model: { providerID: "openai" }, sessionID: "ses_1", headers: { Authorization: "Bearer theirs" } }
  assert.equal((await sendHeaders(reg, other)).get("authorization"), "Bearer theirs")
  assert.deepEqual(other.headers, { Authorization: "Bearer theirs" })
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

test("expired keys return immediately while one background refresh rotates the key", async () => {
  let spawns = 0
  let clock = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const getToken = createTokenSource({
    executable: EXE, ttlMs: 100, now: () => clock,
    run: async () => { if (++spawns === 2) await gate; return `k${spawns}` },
  })
  assert.equal(await getToken(), "k1")
  clock = 99
  assert.equal(await getToken(), "k1")
  clock = 100
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => getToken())), Array(6).fill("k1"))
  assert.equal(spawns, 2)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await getToken(), "k2")
  assert.equal(spawns, 2)
})

test("a failed background refresh keeps the key and retries after backoff without renewing its ttl", async () => {
  for (const failure of [new Error("command failed"), "  \n"]) {
    let spawns = 0
    let clock = 0
    const getToken = createTokenSource({
      executable: EXE, ttlMs: 100, now: () => clock,
      run: async () => {
        spawns += 1
        if (spawns === 2) {
          if (failure instanceof Error) throw failure
          return failure
        }
        return `k${spawns}`
      },
    })
    assert.equal(await getToken(), "k1")
    clock = 100
    assert.deepEqual(await Promise.all([getToken(), getToken()]), ["k1", "k1"])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(spawns, 2)
    assert.equal(await getToken(), "k1")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(spawns, 2)
    clock += 30_000
    assert.equal(await getToken(), "k1")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await getToken(), "k3")
    clock += 99
    assert.equal(await getToken(), "k3")
    assert.equal(spawns, 3)
  }
})

test("a token failure without a cached key rejects and can recover", async () => {
  let spawns = 0
  const failure = new Error("command failed")
  const getToken = createTokenSource({
    executable: EXE,
    run: async () => { if (++spawns === 1) throw failure; return KEY },
  })
  await assert.rejects(getToken(), /gateway token.*failed/)
  assert.equal(await getToken(), KEY)
  assert.equal(spawns, 2)
})

test("the deadline aborts a command that never completes and permits a later fetch", async () => {
  let signal
  let spawns = 0
  const getToken = createTokenSource({
    executable: EXE, timeoutMs: 20,
    run: async (_exe, _url, options) => {
      spawns += 1
      signal = options.signal
      assert.equal(options.timeoutMs, 20)
      if (spawns === 1) return new Promise(() => {})
      return KEY
    },
  })
  await assert.rejects(getToken(), /timed out after 0\.02s/)
  assert.equal(signal.aborted, true)
  assert.equal(await getToken(), KEY)
})

test("the deadline fires while a bootstrap's child still holds stdout open", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fb token deadline "))
  const executable = join(dir, "forgebench")
  const pidFile = join(dir, "child.pid")
  try {
    await writeFile(executable, '#!/bin/sh\nsleep 10 &\nprintf "%s" "$!" > "$4"\nwait\n', { mode: 0o755 })
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const getToken = createTokenSource({ executable, url: pidFile })
    const rejected = assert.rejects(getToken(), /timed out after 30s/)
    assert.ok(await until(async () => Number(await readFile(pidFile, "utf8").catch(() => "")) > 0), "the bootstrap did not start its child")
    const pid = Number(await readFile(pidFile, "utf8"))
    assert.ok(pid > 0)
    t.mock.timers.tick(30_000)
    await rejected
    t.mock.timers.reset()
    // The deadline ends the bootstrap's child too, not just the bootstrap.
    const gone = () => { try { process.kill(pid, 0); return false } catch (error) { return error.code === "ESRCH" } }
    for (let i = 0; i < 100 && !gone(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(gone(), "the bootstrap's child outlived the deadline")
  } finally {
    t.mock.timers.reset()
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""))
    if (pid) {
      try { process.kill(pid, "SIGKILL") } catch (error) { assert.equal(error.code, "ESRCH") }
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("refresh failures log once per streak without exposing error output", async (t) => {
  const log = t.mock.method(console, "error", () => {})
  let spawns = 0
  const getToken = createTokenSource({
    executable: EXE,
    run: async () => {
      if (++spawns === 3) return KEY
      throw Object.assign(new Error(KEY), { code: 7, stdout: KEY, stderr: KEY })
    },
  })
  await assert.rejects(getToken(), (error) => !error.message.includes(KEY))
  await assert.rejects(getToken(), (error) => !error.message.includes(KEY))
  assert.equal(log.mock.calls.length, 1)
  assert.equal(await getToken(), KEY)
  await assert.rejects(getToken.refresh(), (error) => !error.message.includes(KEY))
  assert.equal(log.mock.calls.length, 2)
  assert.ok(!JSON.stringify(log.mock.calls).includes(KEY))
})

test("the first 401 forces a key refresh and retries once", async () => {
  for (const initialFailure of [false, true]) {
    let spawns = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { ctx, reg } = fakeCtx(gatewayOptions)
    await setup(ctx, { token: { run: async () => {
      spawns += 1
      if (spawns === 1 && initialFailure) throw new Error("command failed")
      if (spawns === 2) await gate
      return `k${spawns}`
    } } })
    const retry = reg.hooks.find((h) => h.name === "retry")
    assert.deepEqual(retry.opts, { providerID: "forgebench" })
    const first = await sendHeaders(reg, { model: { providerID: "forgebench" }, headers: {} })
    assert.equal(first.get("authorization"), initialFailure ? null : "Bearer k1")
    const event = { error: { status: 401 }, attempt: 2 }
    const pending = retry.cb(event)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(event.decision, undefined)
    assert.equal(spawns, 2)
    release()
    await pending
    assert.deepEqual(event.decision, { retry: true, delay: 0 })
    const next = await sendHeaders(reg, { model: { providerID: "forgebench" }, headers: {} })
    assert.equal(next.get("authorization"), "Bearer k2")
    for (const ignored of [{ error: { status: 401 }, attempt: 3 }, { error: { status: 500 }, attempt: 2 }]) {
      ignored.decision = { retry: false }
      await retry.cb(ignored)
      assert.deepEqual(ignored.decision, { retry: false })
    }
    assert.equal(spawns, 2)
  }
})

test("a failed forced refresh keeps the last good key and does not retry", async () => {
  let spawns = 0
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run: async () => { if (++spawns === 2) throw new Error("command failed"); return `k${spawns}` } } })
  const retry = reg.hooks.find((h) => h.name === "retry").cb
  await sendHeaders(reg, { model: { providerID: "forgebench" }, headers: {} })
  const event = { error: { status: 401 }, attempt: 2, decision: { retry: false } }
  await retry(event)
  assert.deepEqual(event.decision, { retry: false })
  const next = await sendHeaders(reg, { model: { providerID: "forgebench" }, headers: {} })
  assert.equal(next.get("authorization"), "Bearer k1")
  assert.equal(spawns, 2)
})

test("token failure sends no Authorization, keeps the session header, and retries next time", async () => {
  let spawns = 0
  const run = async () => { spawns += 1; if (spawns === 1) throw new Error("boom"); return KEY }
  const { ctx, reg } = fakeCtx(gatewayOptions)
  await setup(ctx, { token: { run } })
  const first = {
    model: { providerID: "forgebench" }, sessionID: "ses_1",
    headers: { Authorization: "Bearer stale-key", authorization: "Bearer another-stale-key" },
  }
  const firstSent = await sendHeaders(reg, first)
  assert.deepEqual(first.headers, { "X-Forgebench-Session-Id": "ses_1" })
  assert.equal(firstSent.get("authorization"), null)
  const second = {
    model: { providerID: "forgebench" }, sessionID: "ses_1",
    headers: { Authorization: "Bearer stale-key" },
  }
  assert.equal((await sendHeaders(reg, second)).get("authorization"), `Bearer ${KEY}`)
  assert.ok(!("Authorization" in second.headers))
  assert.equal(spawns, 2)
})

test("an empty token is a failure; a failing command's error does not carry output", async () => {
  const empty = createTokenSource({ executable: EXE, run: async () => "  \n" })
  await assert.rejects(empty(), /printed no key/)
  const missing = createTokenSource({ executable: "/nonexistent/forgebench" })
  await assert.rejects(missing(), (err) => !err.message.includes(KEY) && /gateway token/.test(err.message))
})

test("token command failures log exit codes and signals without command output", async (t) => {
  const log = t.mock.method(console, "error", () => {})
  const dir = await mkdtemp(join(tmpdir(), "fb token failure "))
  const executable = join(dir, "forgebench")
  try {
    for (const [finish, reason] of [["process.exit(7)", "7"], ["process.kill(process.pid, 'SIGTERM')", "SIGTERM"]]) {
      await writeFile(executable, `#!${process.execPath}
process.stdout.write(${JSON.stringify(KEY)})
process.stderr.write(${JSON.stringify(KEY)})
${finish}
`, { mode: 0o755 })
      const getToken = createTokenSource({ executable })
      await assert.rejects(getToken(), (error) => {
        assert.ok(error.message.includes(`failed (${reason})`))
        assert.ok(!error.message.includes(KEY))
        return true
      })
      const message = log.mock.calls.at(-1).arguments.join(" ")
      assert.ok(message.includes(`failed (${reason})`))
      assert.ok(!message.includes(KEY))
    }
    assert.equal(log.mock.calls.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("oversized token stdout rejects without replacing the last good key", async (t) => {
  const log = t.mock.method(console, "error", () => {})
  const dir = await mkdtemp(join(tmpdir(), "fb token overflow "))
  const executable = join(dir, "forgebench")
  const writeCommand = (body) => writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  try {
    await writeCommand(`process.stdout.write(${JSON.stringify(KEY)})`)
    const getToken = createTokenSource({ executable })
    assert.equal(await getToken(), KEY)
    for (const body of [
      'process.stdout.write("x".repeat(64 * 1024), () => process.stdout.end("x".repeat(1024)))',
      'process.stdout.end("é".repeat(32 * 1024 + 1))',
    ]) {
      await writeCommand(body)
      await assert.rejects(getToken.refresh(), /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/)
      assert.equal(await getToken(), KEY)
    }
    assert.ok(!JSON.stringify(log.mock.calls).includes(KEY))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
    const headers = await sendHeaders(reg, { model: { providerID: "forgebench" }, headers: {} })
    assert.equal(headers.get("authorization"), "Bearer staging-key")
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
