import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { registerGateway } from "../dist/v2/gateway.js"
import { createCredentialResolver } from "../dist/v2/auth.js"
import { fakeConnection, fakeCtx } from "./helpers.js"

const url = "https://gw.example.com"
const model = { providerID: "forgebench" }
const offline = { models: { fetchImpl: () => Promise.reject(new Error("offline")) } }

async function gateway(connection) {
  const { ctx, reg } = fakeCtx({}, { connection })
  const changed = await registerGateway(ctx, { url, headers: {}, models: [] }, offline)
  const hook = (name) => reg.hooks.find((hook) => hook.name === name).cb
  return { hook, changed }
}

test("model discovery fences previous accounts and restores only the same key's catalog on an outage", async () => {
  const conn = fakeConnection({ type: "key", key: "first" })
  const { ctx, providers } = fakeCtx({}, { connection: conn.connection })
  const visible = () => [...providers.get("forgebench").models.keys()]
  const response = (id) => Response.json({ data: [{ id, kind: "chat" }] })
  let fetch = async () => response("first-model")
  const changed = await registerGateway(ctx, { url, models: [], headers: {} }, {
    models: { fetchImpl: (...args) => fetch(...args) },
  })
  assert.deepEqual(visible(), ["first-model"])
  fetch = async () => { throw new Error("offline") }
  await changed()
  assert.deepEqual(visible(), ["first-model"])

  let release, start
  const started = new Promise(resolve => { start = resolve })
  fetch = () => { start(); return new Promise(resolve => { release = resolve }) }
  const pending = changed(false)
  await started
  assert.deepEqual(visible(), ["first-model"], "integration updates retain the current key's models during refresh")
  conn.state.credential = { type: "key", key: "second" }
  fetch = async () => { throw new Error("offline") }
  const switched = changed()
  assert.deepEqual(visible(), [])
  release(response("stale-first-model"))
  await Promise.all([pending, switched])
  assert.deepEqual(visible(), [])
  fetch = async () => response("second-model")
  await changed()
  assert.deepEqual(visible(), ["second-model"])
  conn.state.credential = undefined
  await changed()
  assert.deepEqual(visible(), [])
})

test("a prepared request picks up the replacement credential after its first 401", async () => {
  const conn = fakeConnection({ type: "key", key: "first-key" })
  const { hook } = await gateway(conn.connection)
  const prepared = { model, headers: { Authorization: "Bearer user" }, sessionID: "ses_1" }
  await hook("model.request")(prepared)
  assert.equal(prepared.headers.Authorization, undefined)
  assert.equal(prepared.headers.authorization, undefined)
  const send = async () => {
    const event = { model, request: new Request(url + "/v1/chat/completions", { headers: prepared.headers }) }
    await hook("http.request")(event)
    return event.request.headers.get("authorization")
  }
  assert.equal(await send(), "Bearer first-key")
  conn.state.credential = { type: "key", key: "replacement-key" }
  const retry = { model, error: { status: 401 }, attempt: 2, decision: { retry: false } }
  await hook("retry")(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 0 })
  assert.equal(await send(), "Bearer replacement-key")
  for (const ignored of [
    { model, error: { status: 401 }, attempt: 3 },
    { model, error: { status: 500 }, attempt: 2 },
    { model: { providerID: "other" }, error: { status: 401 }, attempt: 2 },
  ]) {
    const event = { ...ignored, decision: { retry: false } }
    await hook("retry")(event)
    assert.deepEqual(event.decision, { retry: false })
  }
})

test("a failed forced lookup does not request a retry or erase the last good key", async () => {
  let fail = false
  const connection = {
    active: async () => { if (fail) throw new Error("offline"); return { id: "active" } },
    resolve: async () => ({ type: "key", key: "last-good" }),
  }
  const { hook } = await gateway(connection)
  fail = true
  const retry = { model, error: { status: 401 }, attempt: 2, decision: { retry: false } }
  await hook("retry")(retry)
  assert.deepEqual(retry.decision, { retry: false })
  const event = { model, request: new Request(url + "/v1/chat/completions") }
  await hook("http.request")(event)
  assert.equal(event.request.headers.get("authorization"), "Bearer last-good")
})

test("explicit disconnect clears the last good credential", async () => {
  const conn = fakeConnection({ type: "key", key: "connected" })
  const { hook, changed } = await gateway(conn.connection)
  conn.state.credential = undefined
  await changed()
  const event = { model, request: new Request(url + "/v1/chat/completions", { headers: { authorization: "Bearer stale" } }) }
  await hook("http.request")(event)
  assert.equal(event.request.headers.get("authorization"), null)
})

test("disconnect while a cached credential is awaited prevents its header attachment", async () => {
  const conn = fakeConnection({ type: "key", key: "connected" })
  const { hook, changed } = await gateway(conn.connection)
  const event = { model, request: new Request(url + "/v1/chat/completions") }
  const sending = hook("http.request")(event)
  conn.state.credential = undefined
  const disconnected = changed()
  await Promise.all([sending, disconnected])
  assert.equal(event.request.headers.get("authorization"), null)
})

test("per-send auth never attaches a credential to another origin or a foreign provider", async () => {
  const conn = fakeConnection({ type: "key", key: "private" })
  const { hook } = await gateway(conn.connection)
  const otherOrigin = { model, request: new Request("https://gw.example.com.evil/v1", { headers: { authorization: "Bearer stale" } }) }
  await hook("http.request")(otherOrigin)
  assert.equal(otherOrigin.request.headers.get("authorization"), null)
  const foreign = { model: { providerID: "other" }, request: new Request("https://other.example/v1", { headers: { authorization: "Bearer other" } }) }
  await hook("http.request")(foreign)
  assert.equal(foreign.request.headers.get("authorization"), "Bearer other")
})

test("expired-cache lookup failure retains the last good key until explicit invalidation", async () => {
  let clock = 0
  let fail = false
  const resolver = createCredentialResolver({ url, ttlMs: 1, now: () => clock, integration: { connection: {
    active: async () => { if (fail) throw new Error("offline"); return { id: "active" } },
    resolve: async () => ({ type: "key", key: "last-good" }),
  } } })
  assert.equal(await resolver(), "last-good")
  clock = 2; fail = true
  assert.equal(await resolver(), "last-good")
  assert.equal(await resolver.refresh(), undefined)
  resolver.invalidate()
  assert.equal(await resolver(), undefined)
})

test("concurrent refreshes share one lookup and a disconnected pending lookup cannot repopulate credentials", async () => {
  let release
  let reads = 0
  const waiting = new Promise((resolve) => { release = resolve })
  const resolver = createCredentialResolver({ url, integration: { connection: {
    active: async () => ({ id: "active" }),
    resolve: async () => { reads += 1; await waiting; return { type: "key", key: "disconnected" } },
  } } })
  const first = resolver.refresh()
  const second = resolver.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  resolver.invalidate()
  release()
  assert.equal(await first, undefined)
  assert.equal(await second, undefined)
})

test("a real HTTP retry sends the rotated key while reusing the prepared model request", async (t) => {
  let valid = "first-key"
  const seen = []
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization)
    response.writeHead(request.headers.authorization === `Bearer ${valid}` ? 200 : 401)
    response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.address().port}`
  const conn = fakeConnection({ type: "key", key: "first-key" })
  const { ctx, reg } = fakeCtx({}, { connection: conn.connection })
  await registerGateway(ctx, { url: base, headers: {}, models: [] }, offline)
  const hook = (name) => reg.hooks.find((hook) => hook.name === name).cb
  const prepared = { model, headers: {}, sessionID: "ses_real" }
  await hook("model.request")(prepared)
  const send = async () => {
    const event = { model, request: new Request(base + "/v1/chat/completions", { headers: prepared.headers }) }
    await hook("http.request")(event)
    return (await fetch(event.request)).status
  }
  assert.equal(await send(), 200)
  valid = "replacement-key"
  conn.state.credential = { type: "key", key: valid }
  assert.equal(await send(), 401)
  const retry = { model, error: { status: 401 }, attempt: 2, decision: { retry: false } }
  await hook("retry")(retry)
  assert.equal(retry.decision.retry, true)
  assert.equal(await send(), 200)
  assert.deepEqual(seen, ["Bearer first-key", "Bearer first-key", "Bearer replacement-key"])
})
