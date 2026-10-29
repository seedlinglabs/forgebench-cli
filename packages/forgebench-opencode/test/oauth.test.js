import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import http from "node:http"
import os from "node:os"
import { test } from "node:test"

import {
  DEFAULT_TIMEOUT_MS,
  exchangeLoginCode,
  inferenceOptions,
  pkcePair,
  redeemCode,
  ssoLoginUrl,
  startSignIn,
} from "../src/oauth.js"

const sha256b64url = (value) => createHash("sha256").update(value).digest("base64url")
const drain = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sendJson(res, doc, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(doc))
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
}

function request(urlString) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString)
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port || 80, path: `${parsed.pathname}${parsed.search}`, method: "GET", agent: false },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

/**
 * Fake control plane on 127.0.0.1:0 for startSignIn scenarios. `log` keeps the
 * request line, query, body and Authorization header of every request.
 */
async function startFakeControlPlane(handlers) {
  const log = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1")
      const entry = {
        method: req.method,
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: req.headers.authorization ?? "",
      }
      log.push(entry)
      const handler = handlers[entry.path]
      if (!handler) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        handler({ res, json: entry.body ? JSON.parse(entry.body) : {}, ...entry })
      } catch {
        res.writeHead(500)
        res.end()
      }
    })
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
    server.closeAllConnections?.()
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { url: `http://127.0.0.1:${server.address().port}`, close, log }
}

/** Stub fetch for the non-browser endpoints: records (urlString, init), no network. */
function stubFetch(responder) {
  const calls = []
  const fetchImpl = async (urlString, init) => {
    const call = { urlString, init }
    calls.push(call)
    return responder(call)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const jsonResponse = (doc, status = 200) => new Response(JSON.stringify(doc), { status, headers: { "Content-Type": "application/json" } })

test("pkcePair produces distinct RFC 7636 S256 pairs", () => {
  const { verifier, challenge } = pkcePair()
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/)
  assert.equal(challenge, sha256b64url(verifier))
  const other = pkcePair()
  assert.notEqual(other.verifier, verifier)
  assert.notEqual(other.challenge, challenge)
})

test("ssoLoginUrl contains only the challenge, never the verifier", () => {
  const { verifier, challenge } = pkcePair()
  const redirect = "http://127.0.0.1:39481/callback"
  const built = ssoLoginUrl({ url: "https://gw.example.com/", redirect, challenge })
  assert.equal(built, `https://gw.example.com/v1/auth/oidc/login?redirect=${encodeURIComponent(redirect)}&cli_challenge=${encodeURIComponent(challenge)}`)
  assert.ok(!built.includes(verifier))
  assert.ok(!built.includes("sk_"))
})

test("exchangeLoginCode posts code, verifier and hostname; maps api_key/name/prefix", async () => {
  const fake = await startFakeControlPlane({
    "/v1/auth/cli/exchange": ({ res }) =>
      sendJson(res, { id: "id1", name: "ForgeBench Demo", prefix: "ayush", scopes: [], api_key: "sk_login_1", created_at: "2026-01-01T00:00:00Z" }),
  })
  try {
    const result = await exchangeLoginCode({ url: fake.url, code: "c1", verifier: "v1", hostname: "box1" })
    assert.deepEqual(result, { apiKey: "sk_login_1", name: "ForgeBench Demo", prefix: "ayush" })
    assert.equal(fake.log.length, 1)
    const [call] = fake.log
    assert.equal(call.method, "POST")
    assert.equal(call.path, "/v1/auth/cli/exchange")
    assert.deepEqual(JSON.parse(call.body), { code: "c1", verifier: "v1", hostname: "box1" })
    assert.equal(call.authorization, "")
  } finally {
    fake.close()
  }
})

test("exchangeLoginCode surfaces a short server message, never the raw body", async () => {
  const fake = await startFakeControlPlane({
    "/v1/auth/cli/exchange": ({ res }) => sendJson(res, { detail: { code: "bad_code", message: "code already used or expired", trace: ["x", "y"] } }, 409),
  })
  try {
    await assert.rejects(exchangeLoginCode({ url: fake.url, code: "c2", verifier: "v2", hostname: "box1" }), (error) => {
      assert.match(error.message, /HTTP 409/)
      assert.match(error.message, /code already used or expired/)
      assert.ok(!error.message.includes('{"detail"'))
      assert.ok(!error.message.includes("trace"))
      return true
    })
  } finally {
    fake.close()
  }
})

test("inferenceOptions sends the login key as Bearer and maps the response", async () => {
  const fetchImpl = stubFetch(() =>
    jsonResponse({ eligible: true, keys: [{ name: "k" }], consent_url: "https://gw.example.com/consent/page", expires_at: null, denial: null }),
  )
  const result = await inferenceOptions({
    url: "https://gw.example.com",
    token: "sk_login_1",
    challenge: "chal43chars",
    redirect: "http://127.0.0.1:45123/consent",
    deviceName: "dev",
    hostname: "box",
    fetchImpl,
  })
  assert.deepEqual(result, { eligible: true, consentUrl: "https://gw.example.com/consent/page", denial: null })
  assert.equal(fetchImpl.calls.length, 1)
  const [call] = fetchImpl.calls
  assert.equal(call.urlString, "https://gw.example.com/v1/auth/cli/inference/options")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.headers.Authorization, "Bearer sk_login_1")
  assert.equal(call.init.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(call.init.body), {
    challenge: "chal43chars",
    redirect: "http://127.0.0.1:45123/consent",
    device_name: "dev",
    hostname: "box",
  })
  assert.ok(call.init.signal instanceof AbortSignal)
})

test("inferenceOptions: ineligibility maps the denial; 401 reads as an expired login", async () => {
  const fetchImpl = stubFetch(() =>
    jsonResponse({
      eligible: false,
      keys: [],
      consent_url: null,
      expires_at: null,
      denial: { code: "no_key", message: "this workspace has no inference key to authorize", next_steps: ["ask an admin"] },
    }),
  )
  const result = await inferenceOptions({
    url: "https://gw.example.com",
    token: "sk_login_1",
    challenge: "chal43chars",
    redirect: "http://127.0.0.1:45123/consent",
    deviceName: "dev",
    hostname: "box",
    fetchImpl,
  })
  assert.equal(result.eligible, false)
  assert.equal(result.consentUrl, undefined)
  assert.deepEqual(result.denial, {
    code: "no_key",
    message: "this workspace has no inference key to authorize",
    next_steps: ["ask an admin"],
  })

  const expired = stubFetch(() => jsonResponse({ detail: "token expired" }, 401))
  await assert.rejects(
    inferenceOptions({
      url: "https://gw.example.com",
      token: "sk_login_1",
      challenge: "chal43chars",
      redirect: "http://127.0.0.1:45123/consent",
      deviceName: "dev",
      hostname: "box",
      fetchImpl: expired,
    }),
    /your ForgeBench login expired — try signing in again/,
  )
})

test("redeemCode posts code and verifier without a token", async () => {
  const fetchImpl = stubFetch(() =>
    jsonResponse({ via: "handoff", api_key: "sk_final_1", name: "ForgeBench Inference", prefix: "ayush", daily_limit_usd: 10 }),
  )
  const result = await redeemCode({ url: "https://gw.example.com", code: "c3", verifier: "v3", fetchImpl })
  assert.deepEqual(result, { apiKey: "sk_final_1", name: "ForgeBench Inference", prefix: "ayush" })
  const [call] = fetchImpl.calls
  assert.equal(call.urlString, "https://gw.example.com/v1/auth/cli/inference/redeem")
  assert.deepEqual(JSON.parse(call.init.body), { code: "c3", verifier: "v3" })
  assert.equal(call.init.headers.Authorization, undefined)
})

test("startSignIn happy path: both stages land the key and the server closes", async () => {
  const fake = await startFakeControlPlane({
    "/v1/auth/oidc/login": ({ res, query }) => {
      assert.match(query.cli_challenge, /^[A-Za-z0-9_-]{43}$/)
      sendRedirect(res, `${query.redirect}?code=c1`)
    },
    "/v1/auth/cli/exchange": ({ res }) =>
      sendJson(res, { id: "id1", name: "ForgeBench Demo", prefix: "ayush", api_key: "sk_login_1", created_at: "2026-01-01T00:00:00Z" }),
    "/v1/auth/cli/inference/options": ({ res, json, authorization }) => {
      assert.equal(authorization, "Bearer sk_login_1")
      assert.match(json.redirect, /^http:\/\/127\.0\.0\.1:\d+\/consent$/)
      sendRedirectTargetOptions(res, fake.url, json.redirect)
    },
    "/v1/auth/oidc/consent": ({ res, query }) => sendRedirect(res, `${query.redirect}?code=c2`),
    "/v1/auth/cli/inference/redeem": ({ res, json }) => {
      assert.equal(json.code, "c2")
      sendJson(res, { via: "handoff", api_key: "sk_final_1", name: "ForgeBench Inference", prefix: "ayush", daily_limit_usd: 10 })
    },
  })
  let session = null
  function sendRedirectTargetOptions(res, baseUrl, pluginConsentUrl) {
    sendJson(res, {
      eligible: true,
      keys: [],
      consent_url: `${baseUrl}/v1/auth/oidc/consent?redirect=${encodeURIComponent(pluginConsentUrl)}`,
      expires_at: null,
      denial: null,
    })
  }
  try {
    session = await startSignIn({ url: fake.url })
    const callbackUrl = new URL(session.url).searchParams.get("redirect")
    const consentCallbackUrl = `${callbackUrl.slice(0, -"/callback".length)}/consent`

    // First hop: the browser lands on our /callback with a one-time code.
    const hop1 = await request(session.url)
    assert.equal(hop1.status, 302)
    assert.equal(hop1.headers.location, `${callbackUrl}?code=c1`)

    // The callback handler exchanges the code and fetches the consent URL.
    const hop2 = await request(`${callbackUrl}?code=c1`)
    assert.equal(hop2.status, 302)
    assert.match(hop2.headers.location, /\/v1\/auth\/oidc\/consent\?redirect=/)

    // Browser opens the consent page, which sends the consent code back.
    const hop3 = await request(hop2.headers.location)
    assert.equal(hop3.status, 302)
    assert.equal(hop3.headers.location, `${consentCallbackUrl}?code=c2`)

    const [result, hop4] = await Promise.all([session.promise, request(`${consentCallbackUrl}?code=c2`)])
    assert.deepEqual(result, { access: "sk_final_1", name: "ForgeBench Inference", prefix: "ayush" })
    assert.equal(hop4.status, 200)
    assert.match(hop4.body, /ForgeBench connected/)
    assert.ok(!hop4.body.includes("sk_final_1"))

    // PKCE wiring: separate pairs, each challenge hashes its own verifier.
    const login = fake.log.find((entry) => entry.path === "/v1/auth/oidc/login")
    const exchange = fake.log.find((entry) => entry.path === "/v1/auth/cli/exchange")
    const options = fake.log.find((entry) => entry.path === "/v1/auth/cli/inference/options")
    const redeem = fake.log.find((entry) => entry.path === "/v1/auth/cli/inference/redeem")
    assert.equal(sha256b64url(JSON.parse(exchange.body).verifier), login.query.cli_challenge)
    assert.equal(sha256b64url(JSON.parse(redeem.body).verifier), JSON.parse(options.body).challenge)
    assert.notEqual(JSON.parse(exchange.body).verifier, JSON.parse(redeem.body).verifier)

    // Defaults are resolved in the module: hostname/device_name reach the options call.
    const optionsBody = JSON.parse(options.body)
    assert.equal(optionsBody.hostname, os.hostname())
    assert.ok(optionsBody.device_name.includes(os.platform()))
    assert.ok(optionsBody.device_name.length <= 120)
    assert.deepEqual(JSON.parse(exchange.body), { code: "c1", verifier: JSON.parse(exchange.body).verifier, hostname: os.hostname() })
    assert.equal(JSON.parse(exchange.body).hostname.length <= 255, true)
    assert.equal(exchange.authorization, "") // Bearer is only for the options call
    assert.equal(redeem.authorization, "")

    // No key rides any request; the login key only appears in the options Bearer.
    const trail = fake.log.map((entry) => `${entry.method} ${entry.path} ${entry.body}`).join("\n")
    assert.ok(!trail.includes("sk_final_1"))
    assert.ok(!trail.includes("sk_login_1"))
    const withKey = fake.log.filter((entry) => entry.authorization.includes("sk_login_1"))
    assert.deepEqual(withKey.map((entry) => entry.path), ["/v1/auth/cli/inference/options"])

    // The server closed once the promise settled: further requests are refused.
    await drain(20)
    await assert.rejects(() => request(`${callbackUrl}?code=c1`))
  } finally {
    fake.close()
  }
})

test("startSignIn: a declined model authorization rejects mentioning the decline", async () => {
  const fake = await startFakeControlPlane({
    "/v1/auth/oidc/login": ({ res, query }) => sendRedirect(res, `${query.redirect}?code=c1`),
    "/v1/auth/cli/exchange": ({ res }) => sendJson(res, { api_key: "sk_login_2", name: "ForgeBench Demo", prefix: "ayush" }),
    "/v1/auth/cli/inference/options": ({ res, json }) =>
      sendJson(res, {
        eligible: true,
        keys: [],
        consent_url: `${fake.url}/v1/auth/oidc/consent?redirect=${encodeURIComponent(json.redirect)}`,
        expires_at: null,
        denial: null,
      }),
    "/v1/auth/oidc/consent": ({ res, query }) => sendRedirect(res, `${query.redirect}?error=access_denied&error_description=no`),
  })
  let session = null
  try {
    session = await startSignIn({ url: fake.url, hostname: "box", deviceName: "dev" })
    const callbackUrl = new URL(session.url).searchParams.get("redirect")
    const consentCallbackUrl = `${callbackUrl.slice(0, -"/callback".length)}/consent`

    const hop1 = await request(session.url)
    assert.equal(hop1.headers.location, `${callbackUrl}?code=c1`)
    const hop2 = await request(`${callbackUrl}?code=c1`)
    assert.equal(hop2.status, 302)
    const hop3 = await request(hop2.headers.location)
    assert.equal(hop3.headers.location, `${consentCallbackUrl}?error=access_denied&error_description=no`)

    const [error, page] = await Promise.all([
      assert.rejects(session.promise, (reason) => {
        assert.match(reason.message, /declined/)
        assert.match(reason.message, /\(no\)/)
        return true
      }),
      request(hop3.headers.location),
    ])
    assert.equal(page.status, 200)
    assert.match(page.body, /Model authorization declined/)
    assert.ok(!page.body.includes("sk_login_2"))
    assert.ok(!error)

    // Explicit hostname/device_name were sent verbatim on the options call.
    const options = fake.log.find((entry) => entry.path === "/v1/auth/cli/inference/options")
    assert.deepEqual(JSON.parse(options.body).hostname, "box")
    assert.equal(JSON.parse(options.body).device_name, "dev")
  } finally {
    fake.close()
  }
})

test("startSignIn: an ineligible workspace surfaces the denial and closes the server", async () => {
  const fake = await startFakeControlPlane({
    "/v1/auth/oidc/login": ({ res, query }) => sendRedirect(res, `${query.redirect}?code=c1`),
    "/v1/auth/cli/exchange": ({ res }) => sendJson(res, { api_key: "sk_login_3", name: "ForgeBench Demo", prefix: "ayush" }),
    "/v1/auth/cli/inference/options": ({ res }) =>
      sendJson(res, {
        eligible: false,
        keys: [],
        consent_url: null,
        expires_at: null,
        denial: { code: "no_key", message: "this workspace has no inference key to authorize", next_steps: ["ask an admin"] },
      }),
  })
  let session = null
  try {
    session = await startSignIn({ url: fake.url })
    const callbackUrl = new URL(session.url).searchParams.get("redirect")

    const hop1 = await request(session.url)
    assert.equal(hop1.headers.location, `${callbackUrl}?code=c1`)

    const [error, page] = await Promise.all([
      assert.rejects(
        session.promise,
        (reason) => {
          assert.match(reason.message, /this workspace has no inference key to authorize/)
          assert.match(reason.message, /ask an admin/)
          return true
        },
        "promise must reject with the denial text",
      ),
      request(`${callbackUrl}?code=c1`),
    ])
    assert.equal(page.status, 200)
    assert.match(page.body, /this workspace has no inference key to authorize/)
    assert.ok(!page.body.includes("sk_login_3"))
    assert.ok(!error)

    await drain(20)
    await assert.rejects(() => request(`${callbackUrl}?code=c1`))
  } finally {
    fake.close()
  }
})

test("startSignIn times out and closes the loopback server", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 16 * 60 * 1000)
  const session = await startSignIn({ url: "http://127.0.0.1:9", timeoutMs: 50 })
  await assert.rejects(session.promise, /timed out waiting for the browser sign-in/)
  const callbackUrl = new URL(session.url).searchParams.get("redirect")
  await drain(20)
  await assert.rejects(() => request(callbackUrl))
})
