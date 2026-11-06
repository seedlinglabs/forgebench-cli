import assert from "node:assert/strict"
import { test } from "node:test"
import { reportingKey } from "../dist/v2/auth.js"
import { createDelivery } from "../dist/core/delivery.js"
import { fakeStorage, fakeBackend } from "./helpers.js"

// Reuses hunt-capture/plugin/account-repro.mjs with a denial assertion.
test("environment credential switch holds A's private context across restart", async () => {
  let key = "tenant-A-owner-key"
  const store = fakeStorage()
  const backend = fakeBackend({
    "GET /v1/auth/whoami": ({ auth }) => ({ tenant_id: auth.includes("tenant-A") ? "tenant-A" : "tenant-B", identity_id: "person" }),
    "GET /v1/sessions/capture-policy": { effective: { mode: "local", revision: 0 } },
    "POST /v1/sessions/meta": { accepted: 1 },
  })
  const deps = { url: "https://example.invalid", store, deviceId: async () => "same-install",
    reportingKey: () => reportingKey(undefined, "https://example.invalid", () => ({ FORGEBENCH_API_KEY: key })),
    options: { context: true, traces: false, tasks: false, sdkVersion: "regression" }, autoRetry: false, fetchImpl: backend.fetchImpl }
  const first = createDelivery(deps)
  await first.enqueueSession("ses_A", { source: "opencode", session_id: "ses_A", branch: "tenant-A-private-branch" })
  first.dispose()
  key = "tenant-B-owner-key"
  const restarted = createDelivery(deps)
  await restarted.drain()
  assert.equal(backend.count("/v1/sessions/meta"), 0, "A's context must never be POSTed using B")
  assert.equal([...store.map.keys()].filter(k => k.startsWith("q:")).length, 1)
  assert.equal((await restarted.status()).state, "principal-held")
  key = "tenant-A-owner-key"
  await restarted.drain()
  assert.equal(backend.count("/v1/sessions/meta"), 1)
  assert.equal(backend.calls.find(c => c.path === "/v1/sessions/meta").auth, "Bearer tenant-A-owner-key")
  assert.equal([...store.map.keys()].filter(k => k.startsWith("q:")).length, 0)
})

function harness({ identity = { tenant_id: "tenant", identity_id: "A" }, store = fakeStorage() } = {}) {
  const state = { key: "key-A", identity, online: true, mode: "local", upload: true }
  const backend = fakeBackend({
    "GET /v1/auth/whoami": () => state.online ? state.identity : Promise.reject(new TypeError("offline")),
    "GET /v1/sessions/capture-policy": () => ({ effective: { mode: state.mode, revision: 0 } }),
    "POST /v1/sessions/meta": () => state.upload ? { accepted: 1 } : Response.json({}, { status: 503 }),
  })
  const deps = { url: "https://example.invalid", store, deviceId: async () => "install", reportingKey: async () => state.key,
    options: { context: true, traces: false, tasks: false, sdkVersion: "test" }, autoRetry: false, fetchImpl: backend.fetchImpl }
  return { state, store, backend, deps, delivery: createDelivery(deps) }
}
const queued = h => [...h.store.map.entries()].filter(([k]) => k.startsWith("q:"))

test("same tenant but different person is held; own work still drains without overwriting it", async () => {
  const h = harness()
  await h.delivery.enqueueSession("same", { session_id: "private-A" })
  h.state.key = "key-B"
  h.state.identity = { tenant_id: "tenant", identity_id: "B" }
  await h.delivery.enqueueSession("same", { session_id: "private-B" })
  await h.delivery.drain()
  assert.equal(h.backend.count("/v1/sessions/meta"), 1)
  assert.equal(h.backend.calls.find(c => c.path === "/v1/sessions/meta").body.sessions[0].session_id, "private-B")
  assert.equal(queued(h).length, 1)
  assert.equal((await h.delivery.status()).held_jobs, 1)
})

test("verified same-person rotation delivers all job types with the replacement key", async () => {
  const h = harness()
  h.deps.options.traces = true
  h.deps.options.tasks = true
  await h.delivery.enqueueSession("s", { session_id: "s" })
  await h.delivery.enqueueObservations("s", { spans: [] })
  await h.delivery.enqueueTask("s", { id: "task" })
  h.state.key = "key-rotated"
  await h.delivery.drain()
  assert.equal(h.backend.count("/v1/sessions/meta"), 1)
  assert.equal(queued(h).length, 0) // unsupported optional endpoints retain their existing handling
  assert.ok(h.backend.calls.filter(c => c.method === "POST").every(c => c.auth === "Bearer key-rotated"))
})

test("unverified offline work cannot be claimed by a replacement key, but its original key can verify", async () => {
  const h = harness()
  h.state.online = false
  await h.delivery.enqueueSession("s", { session_id: "s" })
  await h.delivery.drain()
  assert.equal(queued(h).length, 1)
  assert.equal((await h.delivery.status()).code, "identity_unavailable")
  h.state.online = true
  h.state.key = "key-rotated"
  await h.delivery.drain()
  assert.equal(h.backend.count("/v1/sessions/meta"), 0)
  h.state.key = "key-A"
  h.state.upload = false
  await h.delivery.drain()
  assert.ok(queued(h)[0][1].binding.principal, "verified binding survives a retry/restart")
  const restarted = createDelivery({ ...h.deps, now: () => Date.now() + 60_000 })
  h.state.key = "key-rotated"
  h.state.upload = true
  await restarted.drain()
  assert.equal(queued(h).length, 0)
})

test("missing owner identity and identity refusals never acknowledge or post jobs", async () => {
  const h = harness({ identity: { tenant_id: "tenant", identity_id: null } })
  await h.delivery.enqueueSession("s", { session_id: "s" })
  await h.delivery.drain()
  assert.equal(h.backend.count("/v1/sessions/meta"), 0)
  assert.equal(queued(h).length, 1)
  assert.equal((await h.delivery.status()).code, "identity_unavailable")
})

test("legacy jobs are held, never posted, and dropped once expired", async () => {
  const { queueOwnerOf } = await import("../dist/core/idempotency.js")
  const { DeliveryQueue, MAX_AGE_MS } = await import("../dist/core/queue.js")
  const h = harness()
  const owner = queueOwnerOf(h.deps.url, "install")
  await new DeliveryQueue(h.store, () => Date.now()).put(owner, "meta", "fresh", { session: { session_id: "fresh" } })
  await new DeliveryQueue(h.store, () => Date.now() - MAX_AGE_MS - 1).put(owner, "meta", "old", { session: { session_id: "legacy" } })
  h.state.mode = "off"
  await h.delivery.enqueueSession("new", { session_id: "new" })
  await h.delivery.drain()
  assert.equal(h.backend.count("/v1/sessions/meta"), 0)
  assert.equal(queued(h).length, 1)
  assert.equal((await h.delivery.status()).held_jobs, 1)
})

test("held jobs share the install capacity limit across principal switches", async () => {
  const h = harness()
  for (let n = 0; n < 101; n++) {
    h.state.key = `key-${n}`
    h.state.identity = { tenant_id: "tenant", identity_id: `person-${n}` }
    await h.delivery.enqueueSession("same", { session_id: "s" })
  }
  assert.equal(queued(h).length, 100)
  assert.equal((await h.delivery.status()).state, "backpressure")
})

test("all job types remain held under a different principal and identity HTTP failures retain them", async () => {
  const h = harness()
  await h.delivery.enqueueSession("s", { session_id: "s" })
  await h.delivery.enqueueObservations("s", { private: "A" })
  await h.delivery.enqueueTask("s", { id: "private-A" })
  for (const status of [401, 403, 404, 503]) {
    h.state.identity = Response.json({}, { status })
    await h.delivery.resume()
    assert.equal(queued(h).length, 3)
    assert.equal(h.backend.calls.filter(c => c.method === "POST").length, 0)
  }
  h.state.key = "key-B"
  h.state.identity = { tenant_id: "tenant", identity_id: "B" }
  await h.delivery.resume()
  assert.equal(queued(h).length, 3)
  assert.equal(h.backend.calls.filter(c => c.method === "POST").length, 0)
})

test("real HTTP boundary verifies rotation and reads held spool back after restart", async t => {
  const { createServer } = await import("node:http")
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization })
    res.setHeader("Content-Type", "application/json")
    const who = req.headers.authorization === "Bearer B" ? "B" : "A"
    res.end(JSON.stringify(req.url === "/v1/auth/whoami"
      ? { tenant_id: "tenant", identity_id: who }
      : req.url.startsWith("/v1/sessions/capture-policy") ? { effective: { mode: "local", revision: 0 } } : { accepted: 1 }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  let key = "A"
  const store = fakeStorage()
  const deps = { url: `http://127.0.0.1:${server.address().port}`, store, deviceId: async () => "http-install", reportingKey: async () => key,
    options: { context: true, traces: false, tasks: false, sdkVersion: "http" }, autoRetry: false }
  const first = createDelivery(deps)
  await first.enqueueSession("s", { session_id: "private-A" })
  first.dispose()
  // Independent storage readback and reconstruction, rather than retaining core memory.
  const entries = await store.scan({ prefix: "q:" })
  const recovered = fakeStorage(Object.fromEntries(entries.entries.map(e => [e.key, e.value])))
  const restarted = createDelivery({ ...deps, store: recovered })
  key = "B"
  await restarted.drain()
  assert.equal((await recovered.scan({ prefix: "q:" })).entries.length, 1)
  assert.equal((await restarted.status()).held_jobs, 1)
  assert.equal(calls.filter(c => c.path === "/v1/sessions/meta").length, 0)
  key = "A-rotated"
  await restarted.drain()
  assert.equal((await recovered.scan({ prefix: "q:" })).entries.length, 0)
  assert.equal(calls.find(c => c.path === "/v1/sessions/meta").auth, "Bearer A-rotated")
})
