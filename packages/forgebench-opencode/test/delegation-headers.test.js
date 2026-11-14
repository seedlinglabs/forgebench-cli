import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { setup } from "../dist/v2/plugin.js"
import { delegationHeaders } from "../dist/v2/gateway.js"
import { PROVIDER_ID } from "../dist/v2/options.js"
import { fakeCtx } from "./helpers.js"

const KEY = "fbk_secret_value"
const OFFLINE = { models: { fetchImpl: () => Promise.reject(new Error("offline")) }, reporting: { autoRetry: false } }
const ID = "5f0c2a8e-4b1d-4c7a-9e2f-0a1b2c3d4e5f"
const NAMES = ["FORGEBENCH_DELEGATION_ID", "FORGEBENCH_PARENT_HARNESS", "FORGEBENCH_PARENT_SESSION_ID", "FORGEBENCH_ROLE"]
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const send = async (event) => {
  const { ctx, reg } = fakeCtx({ gateway: true, url: "https://gw.example.com", apiKey: KEY, models: ["m"] })
  await setup(ctx, OFFLINE)
  const hook = reg.hooks.find((h) => h.name === "model.request")
  const input = { model: { providerID: PROVIDER_ID }, headers: {}, sessionID: "ses_child", ...event }
  await hook.cb(input)
  return input
}

test("a delegated child's ForgeBench requests carry the five attribution headers", async () => {
  Object.assign(process.env, { FORGEBENCH_DELEGATION_ID: ID, FORGEBENCH_PARENT_HARNESS: "claude_code",
    FORGEBENCH_PARENT_SESSION_ID: "cc-session-1", FORGEBENCH_ROLE: "review" })
  const out = await send({ headers: { "x-forgebench-delegation-id": "stale" } })
  assert.equal(out.headers["X-Forgebench-Harness"], "opencode")
  assert.equal(out.headers["X-Forgebench-Delegation-Id"], ID)
  assert.equal(out.headers["X-Forgebench-Parent-Harness"], "claude_code")
  assert.equal(out.headers["X-Forgebench-Parent-Session-Id"], "cc-session-1")
  assert.equal(out.headers["X-Forgebench-Role"], "review")
  assert.equal(out.headers["x-forgebench-delegation-id"], undefined, "one header per name, whatever its case")
  assert.equal(out.headers.authorization, `Bearer ${KEY}`)
})

test("requests to another provider or origin never get delegation headers", async () => {
  process.env.FORGEBENCH_DELEGATION_ID = ID
  const other = await send({ model: { providerID: "openai" } })
  assert.deepEqual(other.headers, {})
  const elsewhere = await send({ baseURL: "https://evil.example/v1" })
  assert.equal(elsewhere.headers["X-Forgebench-Delegation-Id"], undefined)
})

test("without a delegation, or with malformed values, nothing is added", async () => {
  for (const name of NAMES) delete process.env[name]
  const plain = await send({})
  assert.equal(plain.headers["X-Forgebench-Delegation-Id"], undefined)
  assert.deepEqual(delegationHeaders({ FORGEBENCH_DELEGATION_ID: "not-a-uuid" }), {})
  assert.deepEqual(delegationHeaders({ FORGEBENCH_DELEGATION_ID: ID, FORGEBENCH_PARENT_HARNESS: "cursor",
    FORGEBENCH_PARENT_SESSION_ID: "has space", FORGEBENCH_ROLE: "admin" }),
  { "X-Forgebench-Harness": "opencode", "X-Forgebench-Delegation-Id": ID })
})


test("v2 model.request forwards the active agent for policy bindings", async () => {
  const out = await send({ agent: "security-auditor", headers: { "X-OpenCode-Agent": "stale" } })
  assert.equal(out.headers["x-opencode-agent"], "security-auditor")
  assert.equal(out.headers["X-OpenCode-Agent"], undefined)
  assert.equal((await send({ agent: "doc-writer" })).headers["x-opencode-agent"], "doc-writer")
  assert.equal((await send({ agent: "bad\nheader" })).headers["x-opencode-agent"], undefined)
  assert.equal((await send({})).headers["x-opencode-agent"], undefined)
  assert.deepEqual((await send({ agent: "security-auditor", model: { providerID: "openai" } })).headers, {})
  assert.equal((await send({ agent: "security-auditor", baseURL: "https://evil.example/v1" })).headers["x-opencode-agent"], undefined)
})
