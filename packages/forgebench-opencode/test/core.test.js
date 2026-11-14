import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { BackendError, errorCode, failureKind, normalizeOrigin, request } from "../dist/core/backend.js"
import { fetchCatalog, parseCatalog } from "../dist/core/catalog.js"
import { digest, isNativeSessionId, ownerOf, spanId, traceId } from "../dist/core/idempotency.js"
import { resolveCoreOptions } from "../dist/core/options.js"
import { nativeContextAcknowledged, observationsBody, observationsReceipt } from "../dist/core/proposed.js"
import { DeliveryQueue, MAX_JOBS, backoff } from "../dist/core/queue.js"
import { repositoryIdentity, safeName, scrub, toolName } from "../dist/core/redact.js"
import { buildSessionMeta, sessionMeasurements } from "../dist/core/sessions.js"
import { parseTaskSelection } from "../dist/core/tasks.js"
import { fakeStorage } from "./helpers.js"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const read = (file) => readFileSync(file, "utf8")

test("shared-safe boundary: src/core imports nothing from @opencode/* and spawns nothing", () => {
  const files = walk(join(PKG, "src/core")).filter((f) => f.endsWith(".ts"))
  assert.ok(files.length >= 10)
  for (const file of files) {
    const text = read(file)
    assert.ok(!/from\s+["']@opencode\//.test(text) && !/import\(["']@opencode\//.test(text), `${file} imports an OpenCode package`)
    assert.ok(!/child_process|execFile|spawn\(/.test(text), `${file} can spawn a process`)
    assert.ok(!/from\s+["']\.\.\/v2\//.test(text), `${file} imports the V2 adapter`)
  }
})

test("no source file references the CLI runtime, installer or sync-by-default path", () => {
  const banned = /createSyncRunner|createCliRuntime|cli\.ensure|forgebench sync|gateway token|sync --quiet|--tool opencode|install\.sh|credentials\.json|gateway-keys\.json/
  for (const file of walk(join(PKG, "src")).filter((f) => f.endsWith(".ts"))) assert.ok(!banned.test(read(file)), file)
  for (const file of ["server.js", "package.json", "README.md"]) assert.ok(!banned.test(read(join(PKG, file))), file)
  const pkg = JSON.parse(read(join(PKG, "package.json")))
  assert.ok(!Object.values(pkg.scripts).some((script) => /forgebench|sync/.test(script)))
  assert.ok(!pkg.dependencies, "no runtime dependency on anything: the host provides @opencode/plugin")
})

test("child_process is imported only where a git remote is read", () => {
  const users = walk(join(PKG, "src")).filter((f) => f.endsWith(".ts") && /child_process/.test(read(f)))
  assert.deepEqual(users.map((f) => f.slice(PKG.length + 1)), ["src/v2/context.ts"])
  const text = read(join(PKG, "src/v2/context.ts"))
  assert.deepEqual([...text.matchAll(/execFile\(\s*"([^"]+)"/g)].map((m) => m[1]), ["git"])
})

test("normalizeOrigin accepts https and loopback http only", () => {
  assert.equal(normalizeOrigin("https://api.forgebench.ai/"), "https://api.forgebench.ai")
  assert.equal(normalizeOrigin("http://127.0.0.1:8000"), "http://127.0.0.1:8000")
  assert.equal(normalizeOrigin("http://localhost:8000/base/"), "http://localhost:8000/base")
  for (const bad of ["http://api.forgebench.ai", "ftp://x", "https://u:p@x.example", "nonsense", ""]) assert.throws(() => normalizeOrigin(bad), bad)
})

test("backend errors parse nested detail.error, bare error and Retry-After, and never keep a body", async () => {
  assert.equal(errorCode({ detail: { error: "model_not_allowed" } }), "model_not_allowed")
  assert.equal(errorCode({ error: "budget_exceeded" }), "budget_exceeded")
  assert.equal(errorCode({ error: { code: "rate_limited" } }), "rate_limited")
  assert.equal(errorCode({ detail: "free text with sk_secret_value" }), undefined)
  const fetchImpl = async () => new Response(JSON.stringify({ detail: { error: "session_owner_conflict", message: "sk_abcdefghijk" } }), { status: 409, headers: { "retry-after": "7" } })
  await assert.rejects(request("https://x.example", "/p", "k", {}, { fetchImpl }), (error) => {
    assert.ok(error instanceof BackendError)
    assert.deepEqual([error.status, error.code, error.retryAfterMs], [409, "session_owner_conflict", 7000])
    assert.ok(!error.message.includes("sk_"))
    return true
  })
  assert.deepEqual(["auth", "rate", "payment", "terminal", "retry", "retry"], [401, 429, 402, 409, 503, undefined].map((s) => failureKind(s ? new BackendError(s) : new Error("net"))))
})

test("request sends the key only in Authorization, refuses redirects, and enforces a timeout signal", async () => {
  let seen
  const fetchImpl = async (url, init) => { seen = { url, init }; return Response.json({ ok: true }) }
  await request("https://x.example", "/v1/a?b=1", "KEY", { n: 1 }, { fetchImpl })
  assert.equal(seen.url, "https://x.example/v1/a?b=1")
  assert.equal(seen.init.headers.Authorization, "Bearer KEY")
  assert.equal(seen.init.redirect, "error")
  assert.ok(seen.init.signal instanceof AbortSignal)
  assert.ok(!seen.url.includes("KEY") && !String(seen.init.body).includes("KEY"))
})

test("idempotency helpers are deterministic and shaped for the backend contract", () => {
  assert.match(traceId("ses_1"), /^[0-9a-f]{32}$/)
  assert.match(spanId("ses_1", "tool", "call"), /^[0-9a-f]{16}$/)
  assert.equal(spanId("a", "b"), spanId("a", "b"))
  assert.notEqual(spanId("a", "b"), spanId("ab"))
  assert.equal(digest({ b: 1, a: [1, { d: 1, c: 2 }] }), digest({ a: [1, { c: 2, d: 1 }], b: 1 }))
  assert.notEqual(ownerOf("https://a", "k1"), ownerOf("https://a", "k2"))
  assert.ok(!ownerOf("https://a", "secret-key").includes("secret"))
  assert.ok(isNativeSessionId("ses_abc.DEF-1:2") && !isNativeSessionId("a/b") && !isNativeSessionId("x".repeat(129)) && !isNativeSessionId(""))
})

test("redaction keeps names and repository identity, drops paths, urls with credentials and secrets", () => {
  assert.equal(repositoryIdentity("git@github.com:SeedlingLabs/ForgeBench.git"), "github.com/seedlinglabs/forgebench")
  assert.equal(repositoryIdentity("https://token:x@github.com/o/r.git"), "github.com/o/r")
  assert.equal(repositoryIdentity("file:///etc/passwd"), undefined)
  assert.equal(repositoryIdentity("https://github.com/only-one"), undefined)
  for (const bad of ["/Users/a/secret", "C:\\x", "sk_live_abcdef", "Bearer abc", "a\nb"]) assert.equal(safeName(bad), undefined, bad)
  assert.equal(safeName("fix/ENG-123"), "fix/ENG-123")
  assert.equal(toolName("bash"), "bash")
  assert.equal(toolName("rm -rf /; echo"), "tool")
  assert.ok(!scrub("Authorization: Bearer abcdef sk_abcdefghijkl").includes("abcdef"))
})

test("session payload: counters only, real parent, safe context, never usage", () => {
  const measured = sessionMeasurements([{ type: "assistant", tokens: { input: 5 }, model: { id: "m", providerID: "forgebench" }, content: [] }])
  assert.deepEqual(Object.keys(measured).sort(), ["prompt_count", "tool_call_count", "tool_failure_count", "turn_count"])
  const meta = buildSessionMeta({ sessionID: "ses_c", startedAt: "2026-10-30T08:00:00.000Z", parentSessionID: "ses_p", context: { branch: "fix/ENG-1" }, measurements: measured })
  assert.equal(meta.session_kind, "subagent")
  assert.equal(meta.parent_session_id, "ses_p")
  assert.equal(meta.usage_expected, undefined)
  assert.equal(buildSessionMeta({ sessionID: "ses_c" }), undefined)
})

test("task selection is validated by shape and never inferred", () => {
  const id = "123E4567-E89B-12D3-A456-426614174000"
  assert.deepEqual(parseTaskSelection({ connectionId: id, taskId: "ENG-123" }), { connectionId: id.toLowerCase(), taskId: "ENG-123" })
  for (const bad of [undefined, "ENG-123", { taskId: "ENG-123" }, { connectionId: "x", taskId: "ENG-1" }, { connectionId: id, taskId: "bad id!" }, { connectionId: id, taskId: "" }]) assert.equal(parseTaskSelection(bad), undefined)
  assert.equal(resolveCoreOptions({}).reporting.tasks, false, "a branch name never becomes a declaration")
})

test("options: defaults on, explicit opt-outs honored, executable ignored", () => {
  const defaults = resolveCoreOptions(undefined)
  assert.equal(defaults.url, "https://api.forgebench.ai")
  assert.ok(defaults.gateway && defaults.reporting && defaults.mcp)
  assert.equal(defaults.reporting.traces, true)
  const off = resolveCoreOptions({ gateway: false, sync: false, mcp: false, executable: "/x" })
  assert.deepEqual([off.gateway, off.reporting, off.mcp], [undefined, undefined, undefined])
  assert.equal(resolveCoreOptions({ traces: false }).reporting.traces, false)
  assert.equal(resolveCoreOptions({ url: "http://insecure.example" }).urlError !== undefined, true)
})

test("catalog parsing is runtime-neutral and filters non-chat, retired and duplicate entries", async () => {
  const models = parseCatalog([{ id: "a", kind: "chat", vision: true, context_window: 100 }, { id: "a", kind: "chat" }, { id: "e", kind: "embedding" }, { id: "r", kind: "chat", retired: true }, { id: "n", kind: "chat", available: false }])
  assert.deepEqual(models.map((m) => [m.id, m.vision, m.contextWindow]), [["a", true, 100]])
  await assert.rejects(fetchCatalog({ url: "https://x", key: "KEY", fetchImpl: async () => new Response("<html>KEY</html>", { status: 500 }) }), (e) => !e.message.includes("KEY"))
})

test("proposed contract: every capability fails closed when its marker is absent", async () => {
  assert.equal(nativeContextAcknowledged({ accepted: 1 }), false)
  assert.equal(nativeContextAcknowledged({ accepted: 1, capture_contract: 1 }), true)
  assert.equal(observationsReceipt({ accepted: 2 }), undefined, "HTTP success is not a storage receipt")
  assert.equal(observationsReceipt({ accepted: 3, capture_contract: 1, receipt: { stored: 1, duplicates: 1 } }), undefined, "accepted must equal stored+duplicates")
  assert.deepEqual(observationsReceipt({ accepted: 2, capture_contract: 1, receipt: { stored: 1, duplicates: 1 } }), { stored: 1, duplicates: 1 })
  const body = observationsBody({ deviceId: "d", sessionID: "s", traceId: traceId("s"), sdkVersion: "1", spans: [{ id: spanId("s"), trace_id: traceId("s"), parent_observation_id: null, type: "agent", name: "n", start_time: "t", end_time: "t", level: "DEFAULT" }] })
  assert.equal(body.observations[0].input, null)
})

test("delivery queue: bounded, coalesces by slot, orders oldest first, backoff is capped with jitter", async () => {
  let t = 1000
  const queue = new DeliveryQueue(fakeStorage(), () => t)
  assert.equal(await queue.put("o", "meta", DeliveryQueue.slot("meta", "s1"), { v: 1 }), "queued")
  t += 1
  await queue.put("o", "meta", DeliveryQueue.slot("meta", "s2"), { v: 1 })
  t += 1
  await queue.put("o", "meta", DeliveryQueue.slot("meta", "s1"), { v: 2 })
  const jobs = await queue.list("o")
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.map((j) => j.payload.v), [2, 1], "s1 keeps its original position with the newest payload")
  assert.deepEqual((await queue.list("other")).length, 0, "owners are isolated")
  for (let i = 0; i < MAX_JOBS + 5; i++) await queue.put("full", "meta", DeliveryQueue.slot("meta", `s${i}`), {})
  assert.equal((await queue.list("full")).length, MAX_JOBS)
  assert.equal(await queue.put("full", "meta", DeliveryQueue.slot("meta", "new"), {}), "full")
  assert.equal(backoff(0, () => 0.5), 2000)
  assert.ok(backoff(30, () => 1) <= 15 * 60 * 1000 * 1.2)
  assert.equal(backoff(3, () => 0.5, 9000), 9000)
})
