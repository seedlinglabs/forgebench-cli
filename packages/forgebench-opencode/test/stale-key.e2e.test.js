// FB-242: the gateway key must survive a failed refresh. Real setup(), real execFile against fake
// `forgebench` executables, and a real HTTP gateway stub that answers 401 the way deps.py does.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setup } from "../src/plugin.js"
import { createTokenSource, KILL_GRACE_MS } from "../src/token.js"
import {
  UNAUTHORIZED, assertNoKey, captureOutput, fakeCtx, makeCli, outgoing, requestEvent, runHttpHooks, runRequestHooks, send, settled,
  startGateway, until,
} from "./support/gateway-e2e.js"

const TTL = 1000
const K1 = "fbk_fb242_first_key"
const K2 = "fbk_fb242_rotated_key"
const K3 = "fbk_fb242_server_only_key"
const ALL_KEYS = [K1, K2, K3]
// Real time a request may take once a key is cached: well under a spawn, far under any deadline.
const PROMPT_MS = 3000

async function start(t, { mode = { do: "ok", key: K1 }, valid = [K1] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fb242 e2e "))
  const gateway = await startGateway(valid)
  const cli = await makeCli(dir)
  await cli.setMode(mode)
  let clock = 0
  const { ctx, reg } = fakeCtx({ gateway: true, url: `${gateway.url}/`, executable: cli.executable, models: ["gpt-5"] })
  await setup(ctx, { token: { ttlMs: TTL, now: () => clock } })
  t.after(async () => {
    cli.cleanup()
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { gateway, cli, reg, expire: () => { clock += TTL }, send: (options) => send(reg, gateway, options) }
}

const ok = (attempts, key) => {
  assert.equal(attempts.at(-1).status, 200, JSON.stringify(attempts))
  assert.equal(attempts.at(-1).authorization, `Bearer ${key}`)
}

async function sendUntilKey(e, key) {
  let last
  const seen = await until(async () => {
    last = await e.send({ retry: false })
    return last[0].authorization === `Bearer ${key}`
  })
  assert.ok(seen, `never sent ${key}; last: ${JSON.stringify(last)}`)
}

test("1. a fresh fetch sends the trimmed key and the gateway accepts it", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t)
  const attempts = await e.send()
  ok(attempts, K1)
  assert.equal(attempts.length, 1)
  assert.deepEqual(e.gateway.requests.map((r) => r.authorization), [`Bearer ${K1}`])
  assert.equal(e.cli.spawns(), 1)
  assertNoKey(logs(), ...ALL_KEYS)
})

test("2. within the ttl there is no re-spawn", async (t) => {
  const e = await start(t)
  for (let i = 0; i < 3; i++) ok(await e.send(), K1)
  assert.equal(e.cli.spawns(), 1)
})

test("3/c. after the ttl a successful refresh rotates the key and later requests carry it", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t, { valid: [K1, K2] })
  ok(await e.send(), K1)
  e.expire()
  await e.cli.setMode({ do: "ok", key: K2 })
  await sendUntilKey(e, K2)
  ok(await e.send(), K2)
  assert.equal(e.cli.spawns(), 2)
  assertNoKey(logs(), ...ALL_KEYS)
})

test("a. after the ttl the request returns at once with the cached key and refreshes in the background", async (t) => {
  const e = await start(t, { valid: [K1, K2] })
  ok(await e.send(), K1)
  e.expire()
  await e.cli.setMode({ do: "ok", key: K2, gate: true })
  const first = await settled(e.send(), PROMPT_MS)
  assert.ok(first.done, "the request waited on the refresh spawn")
  ok(first.value, K1)
  assert.ok(await until(() => e.cli.spawns() === 2), "no background refresh started")
  const more = await settled(Promise.all([e.send(), e.send(), e.send()]), PROMPT_MS)
  assert.ok(more.done, "requests during the refresh waited on it")
  for (const attempts of more.value) ok(attempts, K1)
  assert.equal(e.cli.spawns(), 2)
  e.cli.release()
  await sendUntilKey(e, K2)
  assert.equal(e.cli.spawns(), 2)
})

for (const outcome of ["succeeds", "fails"]) {
  test(`9. concurrent requests during a refresh that ${outcome} share one spawn`, async (t) => {
    const e = await start(t, { valid: [K1, K2] })
    ok(await e.send(), K1)
    e.expire()
    await e.cli.setMode(outcome === "succeeds" ? { do: "ok", key: K2, gate: true } : { do: "fail", key: K1, gate: true })
    const inflight = Array.from({ length: 5 }, () => e.send({ retry: false }))
    assert.ok(await until(() => e.cli.spawns() === 2))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(e.cli.spawns(), 2)
    e.cli.release()
    await Promise.all(inflight)
    assert.ok(await until(() => e.cli.ends() === 2))
    assert.equal(e.cli.spawns(), 2)
  })
}

const failures = {
  "4. exits non-zero": (cli) => cli.setMode({ do: "fail", key: K1 }),
  "6. prints empty stdout": (cli) => cli.setMode({ do: "empty" }),
  "7. executable has disappeared (ENOENT)": (cli) => cli.remove(),
}

for (const [name, fail] of Object.entries(failures)) {
  test(`${name}: after the ttl the old key is still sent and the request succeeds`, async (t) => {
    const logs = captureOutput(t)
    const e = await start(t)
    ok(await e.send(), K1)
    e.expire()
    await fail(e.cli)
    ok(await e.send({ retry: false }), K1)
    assert.ok(await until(() => e.cli.spawns() >= 2 || name.includes("ENOENT")))
    await new Promise((resolve) => setTimeout(resolve, 300))
    ok(await e.send({ retry: false }), K1)
    assert.ok(e.gateway.requests.every((r) => r.authorization === `Bearer ${K1}`), "a request went out without the old key")
    assertNoKey(logs(), ...ALL_KEYS)
  })
}

test("5/f. a refresh that hangs with a grandchild holding stdout keeps the old key, and the 30s deadline ends it", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t)
  ok(await e.send(), K1)
  e.expire()
  await e.cli.setMode({ do: "hang" })
  // The plugin's own deadline is a timer; mock it so the test does not wait 30 real seconds.
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const first = await settled(outgoing(e.reg), PROMPT_MS)
  assert.ok(first.done, "the request blocked on a hung refresh")
  assert.equal(first.value.authorization, `Bearer ${K1}`)
  assert.ok(await until(() => e.cli.pids().length === 2), "the fake CLI did not start its grandchild")

  t.mock.timers.tick(29_999)
  await until(() => false, 50)
  assert.doesNotMatch(logs(), /timed? ?out|deadline/i, "the refresh was abandoned before 30s")
  assert.equal((await outgoing(e.reg)).authorization, `Bearer ${K1}`)
  await until(() => false, 200)
  assert.equal(e.cli.spawns(), 2, "the hung refresh was abandoned before 30s")

  t.mock.timers.tick(1)
  await until(() => false, 200)
  assert.match(logs(), /timed? ?out|deadline/i, "the deadline failure was not reported")
  assert.ok(await until(() => e.cli.alive().length === 0), `the deadline left owned processes running: ${e.cli.alive()}`)
  await e.cli.setMode({ do: "ok", key: K2 })
  assert.equal((await outgoing(e.reg)).authorization, `Bearer ${K1}`)
  assert.ok(await until(() => e.cli.spawns() === 3), "the hung refresh still blocks the next one after the deadline")
  assert.ok(await until(async () => (await outgoing(e.reg)).authorization === `Bearer ${K2}`),
    "the refresh after the deadline never swapped in the new key")
  assertNoKey(logs(), ...ALL_KEYS)
  // Hand undici's keep-alive timers back to the real clock before the gateway closes.
  t.mock.timers.reset()
})

test("8. a failure with no key fetched before sends no Authorization and the gateway answers 401", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t, { mode: { do: "fail", key: K1 } })
  const [attempt] = await e.send({ retry: false })
  assert.equal(attempt.status, 401)
  assert.equal(attempt.body.detail, UNAUTHORIZED)
  assert.equal(attempt.headers.authorization, undefined)
  assert.equal(attempt.headers["x-forgebench-session-id"], "ses_1")
  assert.deepEqual(e.gateway.requests, [{ authorization: undefined, session: "ses_1" }])
  assertNoKey(logs(), ...ALL_KEYS)
})

test("10. a recovery after failures replaces the stale key", async (t) => {
  const e = await start(t, { valid: [K1, K2] })
  ok(await e.send(), K1)
  e.expire()
  await e.cli.setMode({ do: "fail", key: K1 })
  ok(await e.send({ retry: false }), K1)
  assert.ok(await until(() => e.cli.ends() >= 2))
  e.expire()
  await e.cli.setMode({ do: "ok", key: K2 })
  await sendUntilKey(e, K2)
  e.gateway.valid.delete(K1)
  ok(await e.send({ retry: false }), K2)
})

test("11/g. a failure reason is reported once, never with the key, and errors never carry the key", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t)
  ok(await e.send(), K1)
  e.expire()
  await e.cli.setMode({ do: "fail", key: K1 })
  ok(await e.send({ retry: false }), K1)
  assert.ok(await until(() => /\b3\b/.test(logs())), `the exit code was not reported: ${JSON.stringify(logs())}`)
  const reported = logs()
  for (const fail of [(cli) => cli.setMode({ do: "empty" }), (cli) => cli.remove()]) {
    e.expire()
    await fail(e.cli)
    ok(await e.send({ retry: false }), K1)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  assert.equal(logs(), reported, "one failure streak was reported more than once")
  assertNoKey(logs(), ...ALL_KEYS)

  const getToken = createTokenSource({ executable: e.cli.executable + ".gone", url: e.gateway.url })
  await assert.rejects(getToken(), (error) => { assertNoKey(`${error.message}\n${error.stack}`, ...ALL_KEYS); return true })
})

test("12. any-case Authorization is stripped, other providers are untouched, the session header is set", async (t) => {
  const e = await start(t)
  const headers = { AUTHORIZATION: "Bearer a", Authorization: "Bearer b", authorization: "Bearer c", "X-Other": "1" }
  const [attempt] = await e.send({ headers, sessionID: "ses_42" })
  assert.equal(attempt.status, 200)
  const { "content-type": _, ...sent } = attempt.headers
  assert.deepEqual(sent, { authorization: `Bearer ${K1}`, "x-other": "1", "x-forgebench-session-id": "ses_42" })
  assert.deepEqual(e.gateway.requests, [{ authorization: `Bearer ${K1}`, session: "ses_42" }])

  const other = await runRequestHooks(e.reg, requestEvent({ providerID: "openai", headers: { Authorization: "Bearer theirs" } }))
  assert.deepEqual(other.headers, { Authorization: "Bearer theirs" })
  // OpenCode never dispatches our scoped hook for another provider; the plugin's own guard holds even if it did.
  const theirs = new Request(`${e.gateway.url}/v1/x`, { headers: { Authorization: "Bearer theirs" } })
  for (const hook of e.reg.hooks.filter((h) => h.name === "http.request")) await hook.cb({ model: { providerID: "openai" }, request: theirs })
  assert.equal(theirs.headers.get("authorization"), "Bearer theirs")
  assert.equal((await runHttpHooks(e.reg, { model: { providerID: "openai" } }, theirs)).headers.get("authorization"), "Bearer theirs")
  assert.equal(e.cli.spawns(), 1)
})

test("d. first fetch fails, the 401 retry forces a refresh, and the retry carries the key", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t, { mode: { do: "fail", key: K1 } })
  const attempts = await e.send({ beforeRetry: () => e.cli.setMode({ do: "ok", key: K1 }) })
  assert.deepEqual(attempts.map((a) => [a.status, a.authorization]), [[401, undefined], [200, `Bearer ${K1}`]])
  assert.equal(e.cli.spawns(), 2)
  assertNoKey(logs(), ...ALL_KEYS)
})

test("e. a key the server rejects is refreshed once on 401, retried once, then given up", async (t) => {
  const e = await start(t)
  ok(await e.send(), K1)

  e.gateway.valid.clear()
  e.gateway.valid.add(K2)
  await e.cli.setMode({ do: "ok", key: K2 })
  const rotated = await e.send()
  assert.deepEqual(rotated.map((a) => [a.status, a.authorization]), [[401, `Bearer ${K1}`], [200, `Bearer ${K2}`]])
  assert.equal(e.cli.spawns(), 2)

  e.gateway.valid.clear()
  e.gateway.valid.add(K3)
  const rejected = await e.send()
  assert.deepEqual(rejected.map((a) => [a.status, a.authorization]), [[401, `Bearer ${K2}`], [401, `Bearer ${K2}`]])
  assert.equal(e.cli.spawns(), 3)
})

// R1: compaction prepares its request once and resends it on retry, so the key must be set per send.
test("R1. a compaction 401 retry resends the prepared request with the refreshed key", async (t) => {
  const logs = captureOutput(t)
  const e = await start(t)
  ok(await e.send({ kind: "compaction" }), K1)
  e.gateway.valid.clear()
  e.gateway.valid.add(K2)
  await e.cli.setMode({ do: "ok", key: K2 })
  const rotated = await e.send({ kind: "compaction" })
  assert.deepEqual(rotated.map((a) => [a.status, a.authorization]), [[401, `Bearer ${K1}`], [200, `Bearer ${K2}`]])
  assert.equal(e.cli.spawns(), 2)
  assertNoKey(logs(), ...ALL_KEYS)
})

test("R1. a compaction whose first fetch failed recovers on the 401 retry", async (t) => {
  const e = await start(t, { mode: { do: "fail", key: K1 } })
  const attempts = await e.send({ kind: "compaction", beforeRetry: () => e.cli.setMode({ do: "ok", key: K1 }) })
  assert.deepEqual(attempts.map((a) => [a.status, a.authorization]), [[401, undefined], [200, `Bearer ${K1}`]])
})

// R2: the deadline must end every process the command started, keep the last good key, and repeat cleanly.
const OWNED = [
  ["the bootstrap and its child hang", { do: "hang" }],
  ["the bootstrap exits and its child holds stdout", { do: "orphan" }],
  ["the child ignores SIGTERM", { do: "hang", ignoreTerm: true }],
]
for (const [name, mode] of OWNED) {
  test(`R2. repeated deadlines end every owned process when ${name}, and the last good key survives`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "fb242 r2 "))
    const cli = await makeCli(dir)
    t.after(async () => { cli.cleanup(); await rm(dir, { recursive: true, force: true }) })
    captureOutput(t)
    await cli.setMode({ do: "ok", key: K1 })
    const getToken = createTokenSource({ executable: cli.executable, url: "http://127.0.0.1:9" })
    assert.equal(await getToken(), K1)
    await cli.setMode(mode)
    t.mock.timers.enable({ apis: ["setTimeout"] })
    for (let round = 1; round <= 3; round++) {
      const rejected = assert.rejects(getToken.refresh(), /timed out/)
      assert.ok(await until(() => cli.pids().length === round * 2), "the bootstrap did not start its child")
      t.mock.timers.tick(30_000)
      await rejected
      assert.equal(await getToken(), K1, "a deadline lost the last good key")
      t.mock.timers.tick(KILL_GRACE_MS)
      assert.ok(await until(() => cli.alive().length === 0), `owned processes outlived the deadline: ${cli.alive()}`)
    }
    assert.equal(cli.pids().length, 6, "every round should have started a bootstrap and a child")
    t.mock.timers.reset()
  })
}

test("R2. a refresh that completes after its deadline cannot overwrite the cache", async () => {
  let finish
  let spawns = 0
  const getToken = createTokenSource({
    executable: "/test/forgebench", timeoutMs: 50,
    run: async () => (++spawns === 1 ? K1 : new Promise((resolve) => { finish = resolve })),
  })
  assert.equal(await getToken(), K1)
  await assert.rejects(getToken.refresh(), /timed out/)
  finish(K2)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await getToken(), K1)
})
