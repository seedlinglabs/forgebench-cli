// FB-242 end-to-end harness: a fake OpenCode context, a gateway stub that enforces bearer auth
// the way apps/control-plane/app/deps.py does, and fake `forgebench` executables run through the
// plugin's real execFile path. No test lives here.
import assert from "node:assert/strict"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

export const PROVIDER = "forgebench"
export const UNAUTHORIZED = "missing or invalid credentials"

export function fakeCtx(options) {
  const reg = { provider: [], hooks: [] }
  const ctx = {
    options,
    provider: { transform: async (cb) => { cb({ add: (input) => reg.provider.push(input) }) } },
    session: { hook: async (name, cb, opts) => { reg.hooks.push({ name, cb, opts }) } },
    mcp: { transform: async () => {} },
    event: { subscribe: () => (async function* () {})() },
  }
  return { ctx, reg }
}

export async function startGateway(validKeys = []) {
  const valid = new Set(validKeys)
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, session: req.headers["x-forgebench-session-id"] })
    let token
    let detail = UNAUTHORIZED
    const auth = req.headers.authorization
    if (auth) {
      const [scheme, rest] = auth.split(" ", 2)
      if (scheme.toLowerCase() === "bearer" && rest?.trim()) token = rest.trim()
      else detail = "Authorization header must be 'Bearer <token>'"
    }
    req.resume()
    if (!token || !valid.has(token)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
      return res.end(JSON.stringify({ detail }))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    valid,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

// mode.json drives each spawn: {do: "ok"|"fail"|"empty"|"hang", key?, gate?}. "fail" prints the key on
// stdout and stderr before exiting 3, so a leak of either stream into an error or log is caught.
const FAKE_CLI = `
const fs = require("node:fs")
const { join } = require("node:path")
const { spawn } = require("node:child_process")
const log = (line) => fs.appendFileSync(join(__dirname, "spawns.log"), line + "\\n")
log("start")
const mode = JSON.parse(fs.readFileSync(join(__dirname, "mode.json"), "utf8"))
function finish() {
  // Like a onefile bootstrap: the real work runs in a child that stays in the bootstrap's process
  // group and holds stdout. "hang" keeps the bootstrap alive too; "orphan" lets it exit at once.
  if (mode.do === "hang" || mode.do === "orphan") {
    const body = (mode.ignoreTerm ? "process.on('SIGTERM', () => {});" : "") + "setInterval(() => {}, 1 << 30)"
    const child = spawn(process.execPath, ["-e", body], { stdio: ["ignore", "inherit", "ignore"] })
    fs.appendFileSync(join(__dirname, "pids"), process.pid + "\\n" + child.pid + "\\n")
    if (mode.do === "orphan") process.exit(0)
    setInterval(() => {}, 1 << 30)
    return
  }
  if (mode.do === "ok") process.stdout.write(mode.key + "\\n  ")
  if (mode.do === "empty") process.stdout.write("  \\n")
  if (mode.do === "fail") {
    process.stdout.write(mode.key ?? "")
    process.stderr.write(mode.key ?? "")
    process.exitCode = 3
  }
  log("end")
}
if (mode.gate) {
  const poll = setInterval(() => {
    if (fs.existsSync(join(__dirname, "release"))) { clearInterval(poll); finish() }
  }, 10)
} else finish()
`

export async function makeCli(dir) {
  const executable = join(dir, "forgebench")
  const lines = () => (existsSync(join(dir, "spawns.log")) ? readFileSync(join(dir, "spawns.log"), "utf8").split("\n") : [])
  const pids = () => (existsSync(join(dir, "pids")) ? readFileSync(join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number) : [])
  await writeFile(executable, `#!${process.execPath}\n${FAKE_CLI}`, { mode: 0o755 })
  return {
    executable,
    setMode: async (mode) => {
      await rm(join(dir, "release"), { force: true })
      await writeFile(join(dir, "mode.json"), JSON.stringify(mode))
    },
    release: () => appendFileSync(join(dir, "release"), ""),
    spawns: () => lines().filter((l) => l === "start").length,
    ends: () => lines().filter((l) => l === "end").length,
    pids,
    /** Spawned bootstraps and descendants still running (signal 0 probes without killing). */
    alive: () => pids().filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } }),
    remove: () => rename(executable, `${executable}.gone`),
    cleanup: () => {
      appendFileSync(join(dir, "release"), "")
      for (const pid of pids()) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
    },
  }
}

export function requestEvent({ providerID = PROVIDER, sessionID = "ses_1", headers = {}, kind = "primary" } = {}) {
  return { model: { providerID }, sessionID, kind, headers: { ...headers } }
}

export async function runRequestHooks(reg, event) {
  for (const hook of reg.hooks.filter((h) => h.name === "model.request")) await hook.cb(event)
  return event
}

/** OpenCode dispatches `http.request` with a web Request, only to hooks scoped to the request's provider. */
export async function runHttpHooks(reg, scope, request) {
  const event = { ...scope, request }
  const hooks = reg.hooks.filter((h) => h.name === "http.request" && (!h.opts?.providerID || h.opts.providerID === scope.model.providerID))
  for (const hook of hooks) await hook.cb(event)
  return event.request
}

function webRequest(gateway, prepared) {
  return new Request(`${gateway?.url ?? "http://127.0.0.1:9"}/v1/chat/completions`, { method: "POST", headers: prepared.headers, body: "{}" })
}

/** The headers one prepared request would go out with, without sending it. */
export async function outgoing(reg, request = {}) {
  const prepared = await runRequestHooks(reg, requestEvent(request))
  const sent = await runHttpHooks(reg, { model: prepared.model, sessionID: prepared.sessionID, kind: prepared.kind }, webRequest(undefined, prepared))
  return Object.fromEntries(sent.headers)
}

/**
 * One OpenCode model call against the stub gateway, following OpenCode v2.1.2 / v2.2.7:
 * `model.request` prepares the headers, `http.request` sees a web Request on every physical send,
 * and after an error the `retry` hooks decide whether to go again (attempt 2 is the first retry).
 * A primary retry prepares the request again (session/runner/llm.ts). A compaction retry resends
 * the request prepared once (session/compaction.ts deliver()), so only `http.request` runs again.
 */
export async function send(reg, gateway, { retry = true, beforeRetry, kind = "primary", ...request } = {}) {
  const attempts = []
  let prepared
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (!prepared || kind === "primary") prepared = await runRequestHooks(reg, requestEvent({ ...request, kind }))
    const scope = { model: prepared.model, sessionID: prepared.sessionID, kind }
    const sent = await runHttpHooks(reg, scope, webRequest(gateway, prepared))
    const res = await fetch(sent)
    const headers = Object.fromEntries(sent.headers)
    attempts.push({ status: res.status, body: await res.json(), authorization: headers.authorization, headers })
    if (res.ok || !retry) break
    await beforeRetry?.(attempt)
    const retryEvent = {
      model: { providerID: request.providerID ?? PROVIDER },
      sessionID: request.sessionID ?? "ses_1",
      attempt: attempt + 1,
      error: { status: res.status, message: attempts.at(-1).body.detail },
      decision: undefined,
    }
    const hooks = reg.hooks.filter((h) => h.name === "retry" && (!h.opts?.providerID || h.opts.providerID === retryEvent.model.providerID))
    for (const hook of hooks) await hook.cb(retryEvent)
    if (!retryEvent.decision?.retry) break
  }
  return attempts
}

/** Polls on setImmediate and the real clock, so it keeps working while setTimeout is mocked. */
export async function until(condition, ms = 5000) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (await condition()) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return false
}

export async function settled(promise, ms) {
  const state = { done: false, value: undefined }
  promise.then((value) => Object.assign(state, { done: true, value }), (value) => Object.assign(state, { done: true, value }))
  await until(() => state.done, ms)
  return state
}

/** Everything the plugin writes to the console or stderr during the test. */
export function captureOutput(t) {
  const lines = []
  for (const method of ["error", "warn", "log", "info", "debug"]) {
    t.mock.method(console, method, (...args) => { lines.push(args.map(String).join(" ")) })
  }
  t.mock.method(process.stderr, "write", (chunk) => { lines.push(String(chunk)); return true })
  return () => lines.join("\n")
}

export function assertNoKey(text, ...keys) {
  for (const key of keys) assert.ok(!text.includes(key), `a key leaked into output: ${JSON.stringify(text)}`)
}
