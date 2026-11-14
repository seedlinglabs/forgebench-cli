import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import { test } from "node:test"
import { createCredentialResolver, reportingKey } from "../dist/v2/auth.js"
import { installHostname, startSignIn } from "../dist/core/oauth.js"

const REPORTING = "fixture-reporting-secret"
const GATEWAY = "fixture-gateway-secret"
const WHO = { tenant_id: "t-1", identity_id: "i-1" }

/** Fake control plane over fetch. `exchanges` counts reporting-code redemptions. */
function controlPlane(overrides = {}) {
  const state = { exchanges: 0, redeems: 0, hostnames: [], consentRedirect: undefined, whoami: 0 }
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body) : {}
    if (path === "/v1/auth/cli/exchange") {
      state.exchanges += 1
      state.hostnames.push(body.hostname)
      assert.ok(body.verifier)
      return Response.json({ api_key: REPORTING })
    }
    if (path === "/v1/auth/cli/inference/options") {
      assert.equal(init.headers.Authorization, `Bearer ${REPORTING}`)
      state.hostnames.push(body.hostname)
      state.consentRedirect = body.redirect
      if (overrides.optionsResponse) return overrides.optionsResponse()
      return Response.json(overrides.options ?? { eligible: true, consent_url: "https://control.example/approve" })
    }
    if (path === "/v1/auth/cli/inference/redeem") {
      state.redeems += 1
      if (overrides.redeemResponse) return overrides.redeemResponse()
      return Response.json({ api_key: GATEWAY, name: "My key", prefix: "sk_fixture" })
    }
    if (path === "/v1/auth/whoami") {
      const auth = init.headers.Authorization
      state.whoami += 1
      const answer = overrides.whoami?.(auth, state.whoami) ?? WHO
      return answer instanceof Response ? answer : Response.json(answer)
    }
    return new Response("nope", { status: 404 })
  }
  return { state, fetchImpl }
}
const start = (cp, extra = {}) => startSignIn({ url: "https://control.example", installId: "install-abc", fetchImpl: cp.fetchImpl, ...extra })
const loginParams = (signIn) => new URL(signIn.url).searchParams

const CURRENT = { access: "current-model-key", name: "Kept key", prefix: "sk_kept" }
const callbackThenConsent = async (signIn, cp, query = "code=consent-code") => {
  await fetch(`${loginParams(signIn).get("redirect")}?code=c`, { redirect: "manual" })
  return (await fetch(`${cp.state.consentRedirect}?${query}`)).text()
}

test("two-stage sign-in returns separate secrets and never puts them in pages or URLs", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  const callback = loginParams(signIn).get("redirect")
  const first = await fetch(`${callback}?code=login-code`, { redirect: "manual" })
  assert.equal(first.status, 302)
  assert.equal(first.headers.get("location"), "https://control.example/approve")
  const html = await (await fetch(`${cp.state.consentRedirect}?code=consent-code`)).text()
  const credential = await signIn.promise
  assert.equal(credential.access, GATEWAY)
  assert.equal(credential.reportingKey, REPORTING)
  assert.ok(!html.includes(REPORTING) && !html.includes(GATEWAY))
  assert.ok(!signIn.url.includes(REPORTING) && !signIn.url.includes(GATEWAY))
  assert.equal(cp.state.exchanges, 1)
  assert.equal(cp.state.redeems, 1)
})

test("the key descriptor is opencode-<install id>, never the machine hostname the CLI uses", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  const params = loginParams(signIn)
  assert.equal(installHostname("x".repeat(100)).length, 64)
  await fetch(`${params.get("redirect")}?code=c`, { redirect: "manual" })
  assert.deepEqual(new Set(cp.state.hostnames), new Set(["opencode-install-abc"]))
  assert.ok(!cp.state.hostnames.includes(os.hostname()))
  signIn.cancel()
  await assert.rejects(signIn.promise, /cancelled/)
})

test("the login URL is the plain OIDC login: a PKCE challenge and a random loopback path, nothing else", async () => {
  const signIn = await start(controlPlane())
  const params = loginParams(signIn)
  assert.deepEqual([...params.keys()].sort(), ["cli_challenge", "redirect"])
  assert.equal(new URL(signIn.url).pathname, "/v1/auth/oidc/login")
  assert.match(params.get("cli_challenge"), /^[A-Za-z0-9_-]{43}$/)
  assert.match(params.get("redirect"), /^http:\/\/127\.0\.0\.1:\d+\/cb-[0-9a-f]{24}$/)
  signIn.cancel()
  await assert.rejects(signIn.promise)
})

test("a first connection with no eligible key fails with the server's explanation", async () => {
  const cp = controlPlane({ options: { eligible: false, denial: { message: "No eligible key.", next_steps: ["Ask an admin."] } } })
  const signIn = await start(cp)
  const page = await (await fetch(`${loginParams(signIn).get("redirect")}?code=c`)).text()
  await assert.rejects(signIn.promise, /No eligible key\. Ask an admin\./)
  assert.match(page, /failed/)
  assert.ok(!page.includes(REPORTING))
})

test("a reconnect with no eligible key keeps the current model key and stores the new reporting key", async () => {
  const cp = controlPlane({ options: { eligible: false, denial: { message: "No eligible key." } } })
  const signIn = await start(cp, { currentAccess: async () => CURRENT })
  const page = await (await fetch(`${loginParams(signIn).get("redirect")}?code=c`)).text()
  assert.deepEqual(await signIn.promise, { access: CURRENT.access, reportingKey: REPORTING, name: "Kept key", prefix: "sk_kept" })
  assert.match(page, /reconnected/)
  assert.ok(!page.includes(REPORTING) && !page.includes(CURRENT.access))
  assert.equal(cp.state.redeems, 0)
})

test("a reconnect whose current model key belongs to another workspace is refused", async () => {
  const cp = controlPlane({ options: { eligible: false }, whoami: (auth) => (auth.includes(CURRENT.access) ? { tenant_id: "t-2", identity_id: "i-1" } : WHO) })
  const signIn = await start(cp, { currentAccess: async () => CURRENT })
  await fetch(`${loginParams(signIn).get("redirect")}?code=c`)
  await assert.rejects(signIn.promise, /different workspaces/)
})

test("a reconnect survives a failure after the exchange: declined consent, or failing options or redeem", async () => {
  const unavailable = () => new Response("{}", { status: 503 })
  const cases = [
    [{}, (signIn, cp) => callbackThenConsent(signIn, cp, "error=access_denied")],
    [{ redeemResponse: unavailable }, (signIn, cp) => callbackThenConsent(signIn, cp)],
    [{ optionsResponse: unavailable }, (signIn) => fetch(`${loginParams(signIn).get("redirect")}?code=c`).then((r) => r.text())],
  ]
  for (const [overrides, drive] of cases) {
    const cp = controlPlane(overrides)
    const signIn = await start(cp, { currentAccess: async () => CURRENT })
    assert.match(await drive(signIn, cp), /reconnected/)
    assert.equal((await signIn.promise).reportingKey, REPORTING)
  }
})

test("a first connection that declines consent fails with that reason", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  await callbackThenConsent(signIn, cp, "error=access_denied")
  await assert.rejects(signIn.promise, /declined/)
})

test("a transient whoami failure is retried and the redeemed key is kept", async () => {
  const cp = controlPlane({ whoami: (_auth, count) => (count <= 2 ? new Response("{}", { status: 503 }) : WHO) })
  const signIn = await start(cp)
  await callbackThenConsent(signIn, cp)
  assert.equal((await signIn.promise).access, GATEWAY)
})

test("when whoami stays unavailable a reconnect says to retry, and a claimed key says how to recover", async () => {
  const down = () => new Response("{}", { status: 503 })
  const reconnect = controlPlane({ options: { eligible: false }, whoami: down })
  const a = await start(reconnect, { currentAccess: async () => CURRENT })
  await fetch(`${loginParams(a).get("redirect")}?code=c`)
  await assert.rejects(a.promise, /did not respond\. Start sign-in again/)
  const first = controlPlane({ whoami: down })
  const b = await start(first)
  await callbackThenConsent(b, first)
  await assert.rejects(b.promise, /rotate that key/)
})

test("a rejected current model key is not retried and falls back to the original message", async () => {
  const cp = controlPlane({ options: { eligible: false, denial: { message: "No eligible key." } }, whoami: (auth) => (auth.includes(CURRENT.access) ? new Response("{}", { status: 401 }) : WHO) })
  const signIn = await start(cp, { currentAccess: async () => CURRENT })
  await fetch(`${loginParams(signIn).get("redirect")}?code=c`)
  await assert.rejects(signIn.promise, /No eligible key/)
  assert.equal(cp.state.whoami, 2)
})

test("a repeated callback hit never exchanges the reporting code twice", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  const callback = `${loginParams(signIn).get("redirect")}?code=login-code`
  const [a, b] = await Promise.all([fetch(callback, { redirect: "manual" }), fetch(callback, { redirect: "manual" })])
  const again = await fetch(callback, { redirect: "manual" })
  assert.deepEqual([a.status, b.status].sort(), [200, 302])
  assert.equal(again.status, 200)
  assert.equal(cp.state.exchanges, 1)
  signIn.cancel()
  await assert.rejects(signIn.promise)
})

test("a consent callback replay redeems the inference code at most once", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  await fetch(`${loginParams(signIn).get("redirect")}?code=l`, { redirect: "manual" })
  const consent = `${cp.state.consentRedirect}?code=consent-code`
  // The listener closes after the first redemption, so a racing replay may also be reset.
  await Promise.all([fetch(consent).catch(() => {}), fetch(consent).catch(() => {})])
  await signIn.promise
  assert.equal(cp.state.redeems, 1)
})

test("grants that resolve to different workspaces are refused", async () => {
  const cp = controlPlane({ whoami: (auth) => (auth.includes(GATEWAY) ? { tenant_id: "t-2", identity_id: "i-1" } : WHO) })
  const signIn = await start(cp)
  await callbackThenConsent(signIn, cp)
  await assert.rejects(signIn.promise, /different workspaces/)
})

test("canceled or failed browser sign-in settles with a clean error and closes the listener", async () => {
  const cp = controlPlane()
  const signIn = await start(cp)
  const callback = loginParams(signIn).get("redirect")
  const page = await (await fetch(`${callback}?error=access_denied&error_description=user+canceled`)).text()
  assert.match(page, /failed/)
  await assert.rejects(signIn.promise, /user canceled/)
  await assert.rejects(fetch(callback), /fetch failed|ECONNREFUSED|connect/i)
  assert.equal(cp.state.exchanges, 0)
})

test("ineligible workspaces surface the server's denial text; the HTTP body is never quoted on errors", async () => {
  const denied = controlPlane({ options: { eligible: false, denial: { code: "no_key", message: "No eligible key.", next_steps: ["Ask an admin."] } } })
  const a = await start(denied)
  await fetch(`${loginParams(a).get("redirect")}?code=c`, { redirect: "manual" })
  await assert.rejects(a.promise, /No eligible key\. Ask an admin\./)
  const broken = { fetchImpl: async () => new Response(JSON.stringify({ detail: `echo ${REPORTING}` }), { status: 500 }) }
  const b = await start(broken)
  await fetch(`${loginParams(b).get("redirect")}?code=c`)
  await assert.rejects(b.promise, (error) => !error.message.includes(REPORTING))
})

test("the loopback only answers its own host and random paths", async () => {
  const signIn = await start(controlPlane())
  const callback = new URL(loginParams(signIn).get("redirect"))
  assert.equal((await fetch(`${callback.origin}/callback?code=x`)).status, 404)
  assert.equal((await fetch(`${callback.origin}/cb-000000000000000000000000?code=x`)).status, 404)
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: callback.port, path: callback.pathname + "?code=x", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on("error", reject)
    req.end()
  })
  assert.equal(rebinding, 404)
  signIn.cancel()
  await assert.rejects(signIn.promise)
})

test("an abort signal cancels sign-in", async () => {
  const controller = new AbortController()
  const signIn = await start(controlPlane(), { signal: controller.signal })
  controller.abort()
  await assert.rejects(signIn.promise, /cancelled/)
})

test("invalidating the credential resolver re-reads a replaced key inside the cache window", async () => {
  let key = "first"
  const integration = { connection: { active: async () => ({ id: "a" }), resolve: async () => ({ type: "key", key }) } }
  const resolve = createCredentialResolver({ url: "https://control.example", integration, env: () => ({}) })
  assert.equal(await resolve(), "first")
  key = "second"
  assert.equal(await resolve(), "first")
  resolve.invalidate()
  assert.equal(await resolve(), "second")
})

test("reporting follows the active connection and refuses another deployment", async () => {
  let credential = { type: "oauth", access: "gateway", refresh: "reporting", metadata: { url: "https://control.example" } }
  const integration = { connection: { active: async () => ({ id: "active" }), resolve: async () => credential } }
  const noEnv = () => ({})
  assert.equal(await reportingKey(integration, "https://control.example", noEnv), "reporting")
  credential = { ...credential, refresh: "second-reporting" }
  assert.equal(await reportingKey(integration, "https://control.example", noEnv), "second-reporting")
  await assert.rejects(reportingKey(integration, "https://other.example", noEnv), /another deployment/)
  credential = { type: "key", key: "gateway" }
  assert.equal(await reportingKey(integration, "https://control.example", noEnv), undefined)
  assert.equal(await reportingKey({}, "https://control.example", noEnv), undefined)
  assert.equal(await reportingKey({}, "https://control.example", () => ({ FORGEBENCH_API_KEY: " env-report " })), "env-report")
})
