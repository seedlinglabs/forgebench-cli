import assert from "node:assert/strict"
import { test } from "node:test"
import { createTokenSource, DEFAULT_TTL_MS } from "../src/token.js"

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("failed background refreshes back off from 30 seconds to five minutes", async (t) => {
  t.mock.method(console, "error", () => {})
  let clock = 0
  let calls = 0
  const token = createTokenSource({
    executable: "forgebench", now: () => clock,
    run: async () => { if (++calls === 1) return "last-good"; throw new Error("offline") },
  })
  assert.equal(await token(), "last-good")
  clock += DEFAULT_TTL_MS
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    const before = calls
    assert.equal(await token(), "last-good")
    await settle()
    assert.equal(calls, before + 1)
    for (let request = 0; request < 5; request++) assert.equal(await token(), "last-good")
    await settle()
    assert.equal(calls, before + 1, "each request restarted the failed CLI")
    clock += delay - 1
    assert.equal(await token(), "last-good")
    await settle()
    assert.equal(calls, before + 1, "refresh retried before the backoff expired")
    clock += 1
  }
})

test("401 recovery bypasses background backoff and success resets the delay", async (t) => {
  t.mock.method(console, "error", () => {})
  let clock = 0
  let calls = 0
  let fail = false
  const token = createTokenSource({
    executable: "forgebench", now: () => clock,
    run: async () => { calls++; if (fail) throw new Error("offline"); return `key-${calls}` },
  })
  assert.equal(await token(), "key-1")
  fail = true
  await assert.rejects(token.refresh())
  await assert.rejects(token.refresh())
  fail = false
  assert.equal(await token.refresh(), "key-4", "a forced recovery waited for backoff")
  fail = true
  clock += DEFAULT_TTL_MS
  assert.equal(await token(), "key-4")
  await settle()
  assert.equal(calls, 5)
  clock += 30_000
  assert.equal(await token(), "key-4")
  await settle()
  assert.equal(calls, 6, "successful recovery did not reset the backoff")
})

test("foreground lookups retain a bounded 30-second cold-start deadline", async (t) => {
  t.mock.method(console, "error", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let signal
  const token = createTokenSource({
    executable: "forgebench",
    run: (_executable, _url, options) => {
      assert.equal(options.timeoutMs, 30_000)
      signal = options.signal
      return new Promise(() => {})
    },
  })
  const timedOut = assert.rejects(token(), /timed out after 30s/)
  await settle()
  t.mock.timers.tick(29_999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await timedOut
  assert.equal(signal.aborted, true)
})
