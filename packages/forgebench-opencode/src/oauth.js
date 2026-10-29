/**
 * ForgeBench browser sign-in (loopback PKCE, two stages).
 *
 * Stage 1: the browser signs in at the control plane and hands a one-time code
 * back to a loopback server this module binds; the code is exchanged for a
 * login key, which asks for an inference-key consent URL.
 * Stage 2: the browser approves the consent page and its code is redeemed for
 * the final gateway key (an `sk_...` secret, shown once).
 *
 * Secrets never appear in URLs, error messages or HTML pages.
 */

import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import os from "node:os"

export const DEFAULT_TIMEOUT_MS = 16 * 60 * 1000

const CONNECT_TIMEOUT_MS = 10_000
const GENERIC_ERROR = "ForgeBench sign-in failed — try again"

const trimUrl = (value) => String(value ?? "").replace(/\/+$/, "")

/** String-safe coercion: empty/false values fall back, everything capped to `max` chars. */
function boundedText(value, fallback, max) {
  const raw = typeof value === "string" ? value : value ? String(value) : ""
  const text = raw || fallback
  return text.length <= max ? text : text.slice(0, max)
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])

/** RFC 7636 S256: verifier is base64url(48 random bytes), challenge is base64url(sha256(verifier)). */
export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function ssoLoginUrl({ url, redirect, challenge }) {
  const params = new URLSearchParams({ redirect: String(redirect ?? ""), cli_challenge: String(challenge ?? "") })
  return `${trimUrl(url)}/v1/auth/oidc/login?${params}`
}

function denialMessage(denial) {
  const steps = Array.isArray(denial?.next_steps) ? denial.next_steps : []
  const parts = [denial?.message, ...steps].filter((part) => typeof part === "string" && part.trim())
  return parts.join(" ") || "ForgeBench inference is not available for this workspace"
}

/** A short, safe detail for errors: the body is never quoted verbatim. */
async function detailMessage(res) {
  try {
    const doc = await res.json()
    const detail = doc && typeof doc === "object" ? doc.detail : undefined
    if (typeof detail === "string") return detail
    if (detail && typeof detail === "object" && typeof detail.message === "string") return detail.message
  } catch {}
  return undefined
}

async function statusError(res, { unauthorizedMessage } = {}) {
  const status = res.status
  const detail = await detailMessage(res)
  const message =
    status === 401 && unauthorizedMessage
      ? unauthorizedMessage
      : `control plane request failed with HTTP ${status}${detail ? `: ${boundedText(detail, "", 200)}` : ""}`
  const error = new Error(message)
  error.status = status
  return error
}

/** fetchImpl is always called with (urlString, init); body JSON, optional Bearer, abortable. */
async function postJson(path, body, { base, fetchImpl, token, timeoutMs = CONNECT_TIMEOUT_MS, unauthorizedMessage } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const response = await fetchImpl(`${trimUrl(base)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw await statusError(response, { unauthorizedMessage })
  return response.json()
}

/** POST /v1/auth/cli/exchange — the one-time browser code becomes the login key (shown once). */
export async function exchangeLoginCode({ url, code, verifier, hostname, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const doc = await postJson("/v1/auth/cli/exchange", { code, verifier, hostname }, { base: url, fetchImpl, timeoutMs })
  return { apiKey: doc.api_key, name: doc.name, prefix: doc.prefix }
}

/** POST /v1/auth/cli/inference/options — Bearer = the login key from the exchange. */
export async function inferenceOptions({ url, token, challenge, redirect, deviceName, hostname, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const doc = await postJson(
    "/v1/auth/cli/inference/options",
    { challenge, redirect, device_name: deviceName, hostname },
    { base: url, fetchImpl, token, timeoutMs, unauthorizedMessage: "your ForgeBench login expired — try signing in again" },
  )
  const raw = doc && typeof doc.denial === "object" && doc.denial ? doc.denial : null
  const eligible = doc.eligible === true
  return {
    eligible,
    consentUrl: eligible && typeof doc.consent_url === "string" && doc.consent_url ? doc.consent_url : undefined,
    denial: raw
      ? {
          code: typeof raw.code === "string" ? raw.code : undefined,
          message: typeof raw.message === "string" ? raw.message : undefined,
          next_steps: Array.isArray(raw.next_steps) ? raw.next_steps.filter((step) => typeof step === "string") : undefined,
        }
      : null,
  }
}

/** POST /v1/auth/cli/inference/redeem — the consent code becomes the gateway key (shown once). */
export async function redeemCode({ url, code, verifier, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const doc = await postJson("/v1/auth/cli/inference/redeem", { code, verifier }, { base: url, fetchImpl, timeoutMs })
  return { apiKey: doc.api_key, name: doc.name, prefix: doc.prefix }
}

/**
 * Open the browser sign-in flow: binds one loopback server for both stages and
 * returns `{ url, promise }`. The caller opens `url` in a browser; `promise`
 * settles with `{ access, name, prefix }` or an Error (never a secret, never an
 * HTTP body). The server is closed exactly once when the promise settles.
 */
export async function startSignIn({ url, hostname, deviceName, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
  void now
  const base = trimUrl(url)
  const host = boundedText(hostname || os.hostname(), "unknown", 255)
  const device = boundedText(deviceName || `${host} · ${os.platform()} ${os.release()}`, "an unidentified machine", 120)
  const loginPair = pkcePair()
  const consentPair = pkcePair()

  let settled = false
  let timer
  let resolvePromise = () => {}
  let rejectPromise = () => {}
  const settle = (error, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) rejectPromise(error)
    else resolvePromise(value)
  }
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  timer = setTimeout(() => {
    settle(new Error("timed out waiting for the browser sign-in — restart sign-in from OpenCode's connect menu"))
  }, timeoutMs)

  let serverClosed = false
  const closeServer = () => {
    if (serverClosed) return
    serverClosed = true
    server.close()
  }

  const onCallback = async (query, response) => {
    const errorCode = query.get("error") ?? ""
    const errorDescription = query.get("error_description") ?? ""
    const code = query.get("code") ?? ""
    if (errorCode || !code) {
      const message = errorCode
        ? `ForgeBench sign-in failed: ${errorDescription || errorCode}`
        : "ForgeBench sign-in failed: the control plane did not return a sign-in code"
      renderPage(response, "Sign-in failed", message)
      settle(new Error(message))
      return
    }
    try {
      const login = await exchangeLoginCode({ url: base, code, verifier: loginPair.verifier, hostname: host, fetchImpl })
      const options = await inferenceOptions({
        url: base,
        token: login.apiKey,
        challenge: consentPair.challenge,
        redirect: consentUrl,
        deviceName: device,
        hostname: host,
        fetchImpl,
      })
      if (!options.eligible) {
        const message = denialMessage(options.denial)
        renderPage(response, "Sign-in failed", message)
        settle(new Error(message))
        return
      }
      if (!options.consentUrl) throw new Error("the control plane sent no consent URL")
      response.writeHead(302, { Location: options.consentUrl })
      response.end()
    } catch {
      // Never quote the HTTP body here: it may echo request data.
      renderPage(response, "Sign-in failed", GENERIC_ERROR)
      settle(new Error(GENERIC_ERROR))
    }
  }

  const onConsent = async (query, response) => {
    const errorCode = query.get("error") ?? ""
    const errorDescription = query.get("error_description") ?? ""
    const code = query.get("code") ?? ""
    if (errorCode || !code) {
      const message = errorCode
        ? `the model authorization was declined in the browser (${errorDescription || errorCode})`
        : "the model authorization did not return a code"
      renderPage(response, "Model authorization declined", message)
      settle(new Error(message))
      return
    }
    try {
      const granted = await redeemCode({ url: base, code, verifier: consentPair.verifier, fetchImpl })
      renderPage(response, "ForgeBench connected", "ForgeBench connected — you can close this tab and return to OpenCode.")
      settle(undefined, { access: granted.apiKey, name: granted.name, prefix: granted.prefix })
    } catch {
      renderPage(response, "Sign-in failed", GENERIC_ERROR)
      settle(new Error(GENERIC_ERROR))
    }
  }

  function renderPage(response, heading, message) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><html><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></body></html>`)
  }

  const server = http.createServer((request, response) => {
    const parsed = new URL(request.url ?? "/", "http://127.0.0.1")
    const route =
      request.method === "GET" && parsed.pathname === "/callback"
        ? onCallback
        : request.method === "GET" && parsed.pathname === "/consent"
          ? onConsent
          : undefined
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("not found")
      return
    }
    Promise.resolve(route(parsed.searchParams, response)).catch(() => {
      try {
        renderPage(response, "Sign-in failed", GENERIC_ERROR)
      } catch {}
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const port = server.address().port
  const callbackUrl = `http://127.0.0.1:${port}/callback`
  const consentUrl = `http://127.0.0.1:${port}/consent`
  server.on("error", () => {})

  // The catch keeps the rejection handled even if the caller never awaits; the
  // finally closes the bound port exactly once, whatever the outcome.
  promise.catch(() => {})
  promise.finally(closeServer).catch(() => {})

  return { url: ssoLoginUrl({ url: base, redirect: callbackUrl, challenge: loginPair.challenge }), promise }
}
