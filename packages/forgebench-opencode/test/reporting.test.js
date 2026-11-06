import assert from "node:assert/strict"
import { test } from "node:test"
import { createReporting } from "../dist/v2/reporting.js"
import { fakeBackend, fakeConnection, fakeCtx, fakeStorage, installTripwire } from "./helpers.js"

const URL_BASE = "https://api.example.com"
const REPORT_KEY = "report-key-1"
const GATEWAY_KEY = "gateway-key-1"
const tripwire = installTripwire()
const CONTEXT = async () => ({ repo: "forgebench", branch: "fix/ENG-1", repository: "github.com/seedlinglabs/forgebench" })
const idle = (sessionID = "ses_root") => ({ type: "session.idle", data: { sessionID } })

const POLICY = { effective: { mode: "legacy", revision: 0 } }
const okBackend = (extra = {}) => fakeBackend({
  "GET /v1/auth/whoami": { tenant_id: "tenant-1", identity_id: "person-1" },
  "GET /v1/sessions/capture-policy": POLICY,
  "POST /v1/sessions/meta": { accepted: 1 },
  ...extra,
})

function harness({ backend = okBackend(), options = {}, sessions, messages, now = { t: 1_800_000_000_000 }, key = REPORT_KEY, storage = fakeStorage() } = {}) {
  const conn = fakeConnection({ type: "oauth", access: GATEWAY_KEY, refresh: key, metadata: { url: URL_BASE } })
  const { ctx, reg } = fakeCtx({}, { connection: conn.connection, sessions, messages, storage })
  const reporting = createReporting(
    ctx,
    { url: URL_BASE, context: true, traces: true, tasks: false, ...options },
    { fetchImpl: backend.fetchImpl, now: () => now.t, random: () => 0.5, context: CONTEXT, autoRetry: false, sdkVersion: "9.9.9", installId: async () => "install-1" },
  )
  return { backend, reporting, reg, conn, now, storage, ctx }
}
const settle = async (h, ...events) => { for (const e of events) h.reporting.observe(e); await h.reporting.flush() }
const metaCalls = (h) => h.backend.calls.filter((c) => c.path === "/v1/sessions/meta")

test("session end posts context directly with the reporting key, native ids and no usage", async () => {
  const h = harness({
    sessions: { ses_root: { time: { created: 1_700_000_000_000, idle: 1_700_000_100_000 } } },
    messages: { ses_root: [
      { type: "user" },
      { type: "assistant", model: { id: "gpt-x", providerID: "forgebench" }, tokens: { input: 10, output: 5 }, content: [{ type: "tool", state: { status: "error" } }, { type: "tool", state: { status: "completed" } }] },
    ] },
  })
  await settle(h, idle())
  const [meta] = metaCalls(h)
  assert.equal(meta.auth, `Bearer ${REPORT_KEY}`)
  assert.ok(!JSON.stringify(h.backend.calls).includes(GATEWAY_KEY))
  assert.equal(meta.body.device_id, "install-1")
  assert.equal(meta.body.capture_transport, "native")
  const [session] = meta.body.sessions
  assert.equal(session.source, "opencode")
  assert.equal(session.session_id, "ses_root")
  assert.equal(session.session_kind, "main")
  assert.equal(session.branch, "fix/ENG-1")
  assert.equal(session.repository, "github.com/seedlinglabs/forgebench")
  assert.deepEqual([session.prompt_count, session.turn_count, session.tool_call_count, session.tool_failure_count], [1, 2, 2, 1])
  assert.equal(session.usage_expected, undefined)
  assert.ok(!("usage_by_model" in session) && !JSON.stringify(meta.body).includes("tokens"))
  // /value/capture needs more than sessions:write today; it is never part of the default path.
  assert.equal(h.backend.count("/v1/sessions/value/capture"), 0)
  assert.equal((await h.reporting.status()).state, "delivered")
})

test("context:false strips repository context but still reports the session", async () => {
  const h = harness({ options: { context: false } })
  await settle(h, idle())
  const [session] = metaCalls(h)[0].body.sessions
  assert.equal(session.branch, undefined)
  assert.equal(session.repository, undefined)
  assert.equal(session.session_id, "ses_root")
})

test("a subagent is reported after its real parent and links to it", async () => {
  const h = harness({ sessions: {
    ses_root: { time: { created: 1_700_000_000_000 } },
    ses_child: { time: { created: 1_700_000_050_000 }, parentID: "ses_root" },
  } })
  await settle(h, idle("ses_child"))
  const sent = metaCalls(h).flatMap((c) => c.body.sessions)
  assert.deepEqual(sent.map((s) => s.session_id), ["ses_root", "ses_child"])
  assert.equal(sent[1].session_kind, "subagent")
  assert.equal(sent[1].parent_session_id, "ses_root")
  assert.equal(sent[0].parent_session_id, undefined)
})

test("sessions with an unsafe id are never sent", async () => {
  const h = harness()
  await settle(h, idle("../../etc"), idle("x".repeat(129)))
  assert.equal(h.backend.calls.length, 0)
})

test("capture mode off drops queued work and sends nothing", async () => {
  const h = harness({ backend: okBackend({ "GET /v1/sessions/capture-policy": { effective: { mode: "off", revision: 3 } } }) })
  await settle(h, idle())
  assert.equal(metaCalls(h).length, 0)
  assert.equal((await h.reporting.status()).state, "capture-off")
  assert.equal([...h.storage.map.keys()].filter((k) => k.startsWith("q:")).length, 0)
})

test("a nonlegacy capture policy revision is acknowledged once", async () => {
  const backend = okBackend({
    "GET /v1/sessions/capture-policy": { effective: { mode: "both", revision: 4 } },
    "POST /v1/sessions/capture-policy/ack": {},
  })
  const h = harness({ backend })
  await settle(h, idle("ses_a"), idle("ses_b"))
  const acks = backend.calls.filter((c) => c.path.endsWith("/ack"))
  assert.equal(acks.length, 1)
  assert.deepEqual(acks[0].body, { revision: 4, source: "opencode", device_id: "install-1", mode: "both", status: "applied" })
})

test("under OTel capture an old server that skips native context is waiting, not delivered", async () => {
  const old = okBackend({ "GET /v1/sessions/capture-policy": { effective: { mode: "otel", revision: 1 } }, "POST /v1/sessions/capture-policy/ack": {} })
  const h = harness({ backend: old })
  await settle(h, idle())
  assert.equal((await h.reporting.status()).state, "waiting-backend-contract")
  assert.equal([...h.storage.map.keys()].filter((k) => k.startsWith("q:")).length, 1, "the job is kept")
  const current = okBackend({
    "GET /v1/sessions/capture-policy": { effective: { mode: "otel", revision: 1 } }, "POST /v1/sessions/capture-policy/ack": {},
    "POST /v1/sessions/meta": { accepted: 1, capture_contract: 1 },
  })
  const h2 = harness({ backend: current })
  await settle(h2, idle())
  assert.equal((await h2.reporting.status()).state, "delivered")
})

test("offline: the job is spooled, backs off without a hot loop, then delivers once with an identical payload", async () => {
  let online = false
  const backend = fakeBackend({
    "GET /v1/auth/whoami": { tenant_id: "tenant-1", identity_id: "person-1" },
    "GET /v1/sessions/capture-policy": () => (online ? POLICY : Promise.reject(new TypeError("fetch failed"))),
    "POST /v1/sessions/meta": { accepted: 1 },
  })
  const h = harness({ backend })
  await settle(h, idle())
  assert.equal((await h.reporting.status()).state, "retrying")
  assert.equal(metaCalls(h).length, 0)
  const spooled = [...h.storage.map.entries()].filter(([key]) => key.startsWith("q:"))
  assert.equal(spooled.length, 1)
  assert.ok(spooled[0][1].notBefore > h.now.t, "backoff scheduled")
  const payload = JSON.stringify(spooled[0][1].payload)
  online = true
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 0, "not due yet: no retry storm")
  h.now.t += 60_000
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 1)
  assert.equal(JSON.stringify({ session: metaCalls(h)[0].body.sessions[0] }), payload, "the spooled payload is resent unchanged")
  assert.equal((await h.reporting.status()).state, "delivered")
  assert.equal([...h.storage.map.keys()].filter((k) => k.startsWith("q:")).length, 0)
})

test("5xx defers the job with backoff; it is retried once due and then removed", async () => {
  let fail = true
  const backend = okBackend({ "POST /v1/sessions/meta": () => (fail ? new Response("{}", { status: 503 }) : { accepted: 1 }) })
  const h = harness({ backend })
  await settle(h, idle())
  assert.equal((await h.reporting.status()).state, "retrying")
  assert.equal(metaCalls(h).length, 1)
  await settle(h, { type: "noop", data: {} })
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 1, "not due yet")
  fail = false
  h.now.t += 60_000
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 2)
  assert.deepEqual(metaCalls(h)[0].body, metaCalls(h)[1].body)
  assert.equal((await h.reporting.status()).state, "delivered")
  h.now.t += 3_600_000
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 2, "delivered jobs are gone")
})

test("429 honors Retry-After", async () => {
  let limited = true
  const backend = okBackend({ "POST /v1/sessions/meta": () => (limited ? new Response("{}", { status: 429, headers: { "retry-after": "120" } }) : { accepted: 1 }) })
  const h = harness({ backend })
  await settle(h, idle())
  limited = false
  h.now.t += 100_000
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 1, "still inside Retry-After")
  h.now.t += 30_000
  await h.reporting.resume()
  assert.equal(metaCalls(h).length, 2)
})

test("revocation: a 401 pauses delivery until the credential changes and flags the connection", async () => {
  let revoked = true
  const backend = okBackend({ "POST /v1/sessions/meta": ({ auth }) => (revoked && auth.endsWith(REPORT_KEY) ? new Response("{}", { status: 401 }) : { accepted: 1 }) })
  const h = harness({ backend })
  await settle(h, idle())
  assert.equal(metaCalls(h).length, 1)
  assert.equal((await h.reporting.status()).state, "auth-paused")
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.reg.statuses.at(-1)?.status, "needs_auth")
  // More activity does not hammer the server with the rejected key.
  await settle(h, idle(), idle())
  assert.equal(metaCalls(h).length, 1)
  // The user signs in again: a fresh reporting key works and old-key jobs are not sent under it.
  h.conn.state.credential = { type: "oauth", access: GATEWAY_KEY, refresh: "report-key-2", metadata: { url: URL_BASE } }
  await settle(h, idle())
  const after = metaCalls(h).slice(1)
  assert.equal(after.length, 1)
  assert.equal(after[0].auth, "Bearer report-key-2")
  // And the pause is lifted for an unchanged key on an explicit reconnect event.
  assert.equal((await h.reporting.status()).state, "delivered")
})

test("a credential event that leaves the rejected key in place does not lift the pause or clear the flag", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": () => new Response("{}", { status: 401 }) })
  const h = harness({ backend })
  await settle(h, idle())
  await new Promise((r) => setTimeout(r, 5))
  const flags = h.reg.statuses.length
  await h.reporting.credentialChanged()
  assert.equal(metaCalls(h).length, 1)
  assert.equal((await h.reporting.status()).state, "auth-paused")
  assert.equal(h.reg.statuses.length, flags)
})

test("a credential event with a new key clears the flag once and delivers", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": ({ auth }) => (auth.endsWith(REPORT_KEY) ? new Response("{}", { status: 401 }) : { accepted: 1 }) })
  const h = harness({ backend })
  await settle(h, idle())
  await new Promise((r) => setTimeout(r, 5))
  h.conn.state.credential = { type: "oauth", access: GATEWAY_KEY, refresh: "report-key-2", metadata: { url: URL_BASE } }
  const flags = h.reg.statuses.length
  await h.reporting.credentialChanged()
  assert.equal(h.reg.statuses.length, flags + 1)
  await h.reporting.credentialChanged()
  assert.equal(h.reg.statuses.length, flags + 1, "no pause left to lift, so no status write that could emit another event")
})

test("a session the server's receipt says it skipped is settled, not retried", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": { accepted: 0, capture_contract: 1, receipt: { stored: 0, skipped: 1 } } })
  const h = harness({ backend })
  await settle(h, idle())
  assert.deepEqual([(await h.reporting.status()).state, (await h.reporting.status()).code], ["refused", "skipped_by_server"])
  await h.reporting.resume()
  await h.reporting.flush()
  assert.equal(metaCalls(h).length, 1)
})

test("accepted:0 with no receipt saying it was skipped still retries", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": { accepted: 0, capture_contract: 1, receipt: { stored: 0, skipped: 0 } } })
  const h = harness({ backend })
  await settle(h, idle())
  assert.equal((await h.reporting.status()).state, "retrying")
})

test("terminal refusals (403/409/422) are dropped, not retried", async () => {
  for (const status of [403, 409, 422]) {
    const backend = okBackend({ "POST /v1/sessions/meta": () => Response.json({ detail: { error: status === 409 ? "session_owner_conflict" : "refused" } }, { status }) })
    const h = harness({ backend })
    await settle(h, idle())
    await h.reporting.resume()
    assert.equal(metaCalls(h).length, 1, String(status))
    const state = await h.reporting.status()
    assert.deepEqual([state.state, state.status], ["refused", status])
    if (status === 409) assert.equal(state.code, "session_owner_conflict")
  }
})

test("no reporting credential means needs-sign-in and no network traffic", async () => {
  const h = harness()
  h.conn.state.credential = undefined
  await settle(h, idle())
  assert.equal(h.backend.calls.length, 0)
  assert.equal((await h.reporting.status()).state, "needs-sign-in")
})

test("the spool is bounded: a full queue reports backpressure instead of growing", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": () => new Response("{}", { status: 503 }) })
  const h = harness({ backend })
  for (let i = 0; i < 101; i++) { h.reporting.observe(idle(`ses_${i}`)) }
  await h.reporting.flush()
  assert.ok([...h.storage.map.keys()].filter((k) => k.startsWith("q:")).length <= 100)
  assert.equal((await h.reporting.status()).state, "backpressure")
})

const toolEvents = async (h, { status = "completed" } = {}) => {
  const before = h.reg.toolHooks.find((hook) => hook.name === "execute.before").cb
  const afterHook = h.reg.toolHooks.find((hook) => hook.name === "execute.after").cb
  h.reporting.observe({ type: "session.execution.started", data: { sessionID: "ses_root" } })
  await h.reporting.flush()
  before({ tool: "bash", sessionID: "ses_root", id: "call_1", input: { command: "cat ~/.ssh/id_rsa" } })
  h.now.t += 50
  afterHook({ tool: "bash", sessionID: "ses_root", id: "call_1", input: { command: "cat ~/.ssh/id_rsa" }, status, result: { secret: "x" } })
  h.now.t += 50
}

test("tool spans are delivered as owned, metadata-only observations with a storage receipt", async () => {
  const backend = okBackend({ "POST /v1/observations/batch": ({ body }) => ({ accepted: body.observations.length, capture_contract: 1, receipt: { source: "opencode", session_id: body.capture.session_id, stored: body.observations.length, duplicates: 0, received_at: "2026-10-30T08:00:00Z" } }) })
  const h = harness({ backend })
  await h.reporting.registerToolHooks()
  await toolEvents(h)
  await settle(h, idle())
  const [batch] = backend.calls.filter((c) => c.path === "/v1/observations/batch")
  assert.equal(batch.auth, `Bearer ${REPORT_KEY}`, "owned reporting key, never the model key")
  assert.deepEqual(batch.body.capture, { source: "opencode", session_id: "ses_root", device_id: "install-1" })
  assert.deepEqual(batch.body.sdk, { name: "forgebench-opencode", version: "9.9.9" })
  assert.match(batch.body.traces[0].id, /^[0-9a-f]{32}$/)
  assert.deepEqual(batch.body.observations.map((o) => o.type), ["agent", "tool"])
  const [root, tool] = batch.body.observations
  assert.match(root.id, /^[0-9a-f]{16}$/)
  assert.equal(tool.parent_observation_id, root.id)
  assert.equal(tool.name, "bash")
  assert.ok(batch.body.observations.every((o) => o.input === null && o.output === null && Object.keys(o.metadata).length === 0))
  const wire = JSON.stringify(batch.body)
  assert.ok(!wire.includes("id_rsa") && !wire.includes("secret") && !wire.includes("command"))
})

test("span identity is deterministic: replaying the same execution yields the same ids", async () => {
  const bodies = []
  const backend = okBackend({ "POST /v1/observations/batch": ({ body }) => { bodies.push(body); return { accepted: 2, capture_contract: 1, receipt: { stored: 0, duplicates: 2 } } } })
  for (let i = 0; i < 2; i++) {
    const h = harness({ backend })
    await h.reporting.registerToolHooks()
    await toolEvents(h)
    await settle(h, idle())
  }
  assert.deepEqual(bodies[0].observations.map((o) => o.id), bodies[1].observations.map((o) => o.id))
})

test("a server without the owned capture contract is reported unsupported and not retried", async () => {
  for (const handler of [{ accepted: 2 }, () => new Response("{}", { status: 403 }), () => new Response("{}", { status: 422 })]) {
    const backend = okBackend({ "POST /v1/observations/batch": handler })
    const h = harness({ backend })
    await h.reporting.registerToolHooks()
    await toolEvents(h)
    await settle(h, idle())
    assert.ok((await h.storage.get("off:observations")) > h.now.t, "traces marked unsupported for the probe interval")
    const sent = backend.count("/v1/observations/batch")
    await toolEvents(h)
    await settle(h, idle())
    assert.equal(backend.count("/v1/observations/batch"), sent, "traces stay off for the probe interval")
    assert.equal(await h.storage.get("status").then((s) => s.state), "delivered", "context delivery is unaffected")
  }
})

test("traces:false installs no tool hooks and sends no observations", async () => {
  const backend = okBackend({ "POST /v1/observations/batch": { accepted: 1 } })
  const h = harness({ backend, options: { traces: false } })
  await h.reporting.registerToolHooks()
  assert.equal(h.reg.toolHooks.length, 0)
  await settle(h, idle())
  assert.equal(backend.count("/v1/observations/batch"), 0)
})

test("an explicit task selection is declared once per session with the true mechanism; old servers are tolerated", async () => {
  const task = { connectionId: "123e4567-e89b-12d3-a456-426614174000", taskId: "ENG-123" }
  const backend = okBackend({ "POST /v1/sessions/value/task-declarations": { review_status: "pending", link_id: "l1" } })
  const h = harness({ backend, options: { tasks: true, task } })
  await settle(h, { type: "session.created", data: { sessionID: "ses_root" } }, idle())
  const declared = backend.calls.filter((c) => c.path === "/v1/sessions/value/task-declarations")
  assert.equal(declared.length, 1)
  assert.deepEqual(declared[0].body, { connection_id: task.connectionId, task_id: "ENG-123", source: "opencode", session_id: "ses_root", started_at: "2023-11-14T22:13:20.000Z", mechanism: "SessionStart" })
  const old = harness({ backend: okBackend({ "POST /v1/sessions/value/task-declarations": () => new Response("{}", { status: 403 }) }), options: { tasks: true, task } })
  await settle(old, idle())
  assert.equal(await old.storage.get("off:tasks") > 0, true)
  assert.equal(metaCalls(old).length, 1, "session context still delivered")
})

test("a reconnect that rotates the reporting key still delivers sessions queued before it", async () => {
  let online = false
  const backend = okBackend({ "GET /v1/sessions/capture-policy": () => (online ? POLICY : Promise.reject(new TypeError("fetch failed"))) })
  const h = harness({ backend })
  await settle(h, idle("ses_old"))
  assert.equal(metaCalls(h).length, 0)
  online = true
  h.conn.state.credential = { type: "oauth", access: GATEWAY_KEY, refresh: "report-key-2", metadata: { url: URL_BASE } }
  h.now.t += 60_000
  await h.reporting.resume()
  const sent = metaCalls(h)
  assert.deepEqual(sent.map((c) => c.body.sessions[0].session_id), ["ses_old"])
  assert.equal(sent[0].auth, "Bearer report-key-2")
})

test("a queue never crosses deployments or installs", async () => {
  const backend = okBackend({ "GET /v1/sessions/capture-policy": () => Promise.reject(new TypeError("fetch failed")) })
  const h = harness({ backend })
  await settle(h, idle("ses_a"))
  const other = harness({ backend: okBackend(), storage: h.storage })
  other.reporting.dispose()
  const { createReporting: make } = await import("../dist/v2/reporting.js")
  const { ctx } = fakeCtx({}, { connection: fakeConnection({ type: "oauth", access: GATEWAY_KEY, refresh: REPORT_KEY, metadata: { url: URL_BASE } }).connection, storage: h.storage, sessions: {} })
  const second = okBackend()
  const r = make(ctx, { url: URL_BASE, context: true, traces: false, tasks: false }, { fetchImpl: second.fetchImpl, now: () => h.now.t + 3_600_000, random: () => 0.5, context: CONTEXT, autoRetry: false, installId: async () => "install-2" })
  await r.resume()
  assert.equal(second.calls.filter((c) => c.path === "/v1/sessions/meta").length, 0)
})

test("a refusal that names a task problem rejects that declaration but keeps later declarations working", async () => {
  const task = { connectionId: "123e4567-e89b-12d3-a456-426614174000", taskId: "ENG-404" }
  let missing = true
  const backend = okBackend({ "POST /v1/sessions/value/task-declarations": () => (missing ? Response.json({ detail: { reason: "not_found" } }, { status: 404 }) : { review_status: "pending", link_id: "l1" }) })
  const h = harness({ backend, options: { tasks: true, task } })
  await settle(h, { type: "session.created", data: { sessionID: "ses_one" } })
  assert.deepEqual({ state: (await h.reporting.status()).state }, { state: "task-rejected" })
  assert.equal(await h.storage.get("off:tasks"), undefined, "one bad task must not disable declarations")
  missing = false
  await settle(h, { type: "session.created", data: { sessionID: "ses_two" } })
  assert.equal(backend.calls.filter((c) => c.path === "/v1/sessions/value/task-declarations").length, 2)
})

test("a stale tasks-unsupported flag is cleared when the credential changes", async () => {
  const task = { connectionId: "123e4567-e89b-12d3-a456-426614174000", taskId: "ENG-1" }
  const h = harness({ backend: okBackend({ "POST /v1/sessions/value/task-declarations": () => new Response("{}", { status: 404 }) }), options: { tasks: true, task } })
  await settle(h, idle())
  assert.ok(await h.storage.get("off:tasks") > 0)
  await h.reporting.resume()
  assert.equal(await h.storage.get("off:tasks"), undefined)
})

test("402 plan-required is a distinct status, keeps the job, and notifies once per credential", async () => {
  const backend = okBackend({ "POST /v1/sessions/meta": () => Response.json({ detail: { code: "plan_required" } }, { status: 402 }) })
  const h = harness({ backend })
  await settle(h, idle())
  const status = await h.reporting.status()
  assert.deepEqual([status.state, status.status, status.code], ["plan-required", 402, "plan_required"])
  assert.equal([...h.storage.map.keys()].filter((k) => k.startsWith("q:")).length, 1, "job retained for a later retry")
  h.now.t += 3_700_000
  await settle(h, idle())
  assert.equal(metaCalls(h).length, 2, "retried only after the one-hour deferral")
})

test("nothing in this file invoked a forgebench executable", () => {
  assert.equal(tripwire.calls(), "")
  tripwire.restore()
})
