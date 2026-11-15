/**
 * Forgebench browser sign-in (loopback PKCE). Runtime-independent: it needs
 * only Node's http/crypto and the selected deployment. No CLI, no shared state.
 *
 * The same OIDC login the Forgebench CLI uses, in two stages:
 *   1. browser signs in; the loopback receives a PKCE-bound reporting `code`;
 *      it is exchanged ONCE for a reporting key (`sessions:write` only), which
 *      asks for an inference consent URL;
 *   2. the browser approves the consent page; its code is redeemed ONCE for the
 *      model-gateway key.
 *
 * Secrets never appear in URLs, error messages or HTML pages. The reporting
 * code is replayable for 120 s server-side, so a repeated callback hit is
 * answered without a second exchange (a second exchange would rotate the key).
 */
import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { deadline, failureKind, request } from "./backend.js"
import { record } from "./json.js"

export const DEFAULT_TIMEOUT_MS = 16 * 60 * 1000
const CONNECT_TIMEOUT_MS = 10_000
const WHOAMI_ATTEMPTS = 3
const WHOAMI_RETRY_MS = 500
const GENERIC_ERROR = "Forgebench sign-in failed. Try again."
const trimUrl = (value: unknown): string => String(value ?? "").replace(/\/+$/, "")

export type ApiOptions = { url: string; fetchImpl?: typeof fetch; timeoutMs?: number }

function issuedKey(doc: Record<string, unknown>): string {
  const key = doc.api_key
  if (typeof key !== "string" || !/^[\x21-\x7e]+$/.test(key)) throw new Error("The control plane returned an invalid credential")
  return key
}
const bounded = (value: unknown, fallback: string, max: number): string => {
  const raw = typeof value === "string" ? value : value ? String(value) : ""
  return (raw || fallback).slice(0, max)
}
const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

/** RFC 7636 S256: verifier is base64url(48 random bytes), challenge is base64url(sha256(verifier)). */
export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

/**
 * Per-install descriptor for the named server-side key row. It is distinct from
 * the optional CLI's descriptor, so signing in here never rotates the CLI's key.
 */
export const installHostname = (installId: string): string => `opencode-${installId}`.slice(0, 64)

export function ssoLoginUrl(input: { url: string; redirect: string; challenge: string }) {
  const params = new URLSearchParams({ redirect: input.redirect, cli_challenge: input.challenge })
  return `${trimUrl(input.url)}/v1/auth/oidc/login?${params}`
}

function denialMessage(denial: { message?: string; next_steps?: string[] } | null): string {
  const steps = Array.isArray(denial?.next_steps) ? denial.next_steps : []
  const parts = [denial?.message, ...steps].filter((part) => typeof part === "string" && part.trim())
  return parts.join(" ") || "Forgebench model access is not available for this workspace"
}

async function postPublic(path: string, body: Record<string, unknown>, base: string, fetchImpl: typeof fetch, timeoutMs: number) {
  // Code redemption endpoints are unauthenticated: the PKCE verifier is the proof.
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: deadline(timeoutMs),
    redirect: "error",
  })
  if (!response.ok) throw Object.assign(new Error(`control plane request failed with HTTP ${response.status}`), { status: response.status })
  return record(await response.json())
}

/** POST /v1/auth/cli/exchange: the browser code becomes the reporting key (shown once). */
export async function exchangeLoginCode({ url, code, verifier, hostname, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }: ApiOptions & { code: string; verifier: string; hostname: string }) {
  const doc = await postPublic("/v1/auth/cli/exchange", { code, verifier, hostname }, trimUrl(url), fetchImpl, timeoutMs)
  return { apiKey: issuedKey(doc), name: typeof doc.name === "string" ? doc.name : undefined, prefix: typeof doc.prefix === "string" ? doc.prefix : undefined }
}

/** POST /v1/auth/cli/inference/options, bearer = the reporting key. */
export async function inferenceOptions({ url, token, challenge, redirect, deviceName, hostname, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }: ApiOptions & { token: string; challenge: string; redirect: string; deviceName: string; hostname: string }) {
  const doc = await request(trimUrl(url), "/v1/auth/cli/inference/options", token, { challenge, redirect, device_name: deviceName, hostname }, { fetchImpl, timeoutMs })
  const raw = doc.denial ? record(doc.denial) : null
  const eligible = doc.eligible === true
  return {
    eligible,
    consentUrl: eligible && typeof doc.consent_url === "string" && doc.consent_url ? doc.consent_url : undefined,
    denial: raw ? {
      code: typeof raw.code === "string" ? raw.code : undefined,
      message: typeof raw.message === "string" ? raw.message : undefined,
      next_steps: Array.isArray(raw.next_steps) ? raw.next_steps.filter((step): step is string => typeof step === "string") : undefined,
    } : null,
  }
}

/** POST /v1/auth/cli/inference/redeem: single use. Never retried; a lost response needs explicit recovery. */
export async function redeemCode({ url, code, verifier, fetchImpl = globalThis.fetch, timeoutMs = CONNECT_TIMEOUT_MS }: ApiOptions & { code: string; verifier: string }) {
  const doc = await postPublic("/v1/auth/cli/inference/redeem", { code, verifier }, trimUrl(url), fetchImpl, timeoutMs)
  return { apiKey: issuedKey(doc), name: typeof doc.name === "string" ? doc.name : undefined, prefix: typeof doc.prefix === "string" ? doc.prefix : undefined }
}

/** GET /v1/auth/whoami: the authenticated tenant and identity behind a credential. */
export async function whoami(url: string, key: string, fetchImpl: typeof fetch, timeoutMs = CONNECT_TIMEOUT_MS) {
  const doc = await request(trimUrl(url), "/v1/auth/whoami", key, undefined, { fetchImpl, timeoutMs })
  return { tenantId: typeof doc.tenant_id === "string" ? doc.tenant_id : undefined, identityId: typeof doc.identity_id === "string" ? doc.identity_id : undefined }
}

export type SignInOptions = ApiOptions & {
  /** Stable per-install id; becomes the `opencode-<id>` key descriptor. */
  installId: string
  deviceName?: string
  signal?: AbortSignal
  /**
   * The model key of the connection this sign-in replaces, if any. Every exchange
   * replaces this install's reporting key server-side, so a reconnect that comes
   * back without model access keeps this key instead of losing the connection.
   */
  currentAccess?: () => Promise<{ access: string; name?: string; prefix?: string } | undefined>
}
export type SignInGrant = { access: string; reportingKey: string; name?: string; prefix?: string }

const UNCONFIRMED = "Forgebench could not confirm this sign-in because the server did not respond. Start sign-in again from OpenCode's connect menu."
const CLAIMED_UNCONFIRMED = "Forgebench could not confirm this sign-in because the server did not respond, and the model key it issued can only be handed over once. "
  + "Ask a workspace admin to rotate that key, then sign in again."
const DIFFERENT_WORKSPACES = "The reporting and model grants belong to different workspaces. Sign in again."

class WorkspaceMismatch extends Error {
  constructor() { super(DIFFERENT_WORKSPACES) }
}

/** A definite answer (401, 403) is final. A timeout, 429 or 5xx says nothing about the key, so it is tried again. */
async function whoamiWithRetry(base: string, key: string, fetchImpl: typeof fetch) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await whoami(base, key, fetchImpl)
    } catch (error) {
      const kind = failureKind(error)
      if (attempt >= WHOAMI_ATTEMPTS || (kind !== "retry" && kind !== "rate")) throw error
      await new Promise((resolve) => setTimeout(resolve, WHOAMI_RETRY_MS * attempt))
    }
  }
}

/**
 * Binds one loopback server on 127.0.0.1 (random paths) and returns the browser
 * URL plus a promise that settles with both grants, or an Error that never
 * contains a secret or an HTTP body. The server closes exactly once.
 */
export async function startSignIn({ url, installId, deviceName, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal, currentAccess }: SignInOptions) {
  const base = trimUrl(url)
  const hostname = installHostname(installId)
  const device = bounded(deviceName, "OpenCode on this device", 120)
  const loginPair = pkcePair()
  const consentPair = pkcePair()
  const callbackPath = `/cb-${randomBytes(12).toString("hex")}`
  const consentPath = `/consent-${randomBytes(12).toString("hex")}`

  let reportingKey: string | undefined
  let settled = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolvePromise: (value: SignInGrant) => void = () => {}
  let rejectPromise: (reason: Error) => void = () => {}
  const promise = new Promise<SignInGrant>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  promise.catch(() => {})

  let serverClosed = false
  const closeServer = () => { if (!serverClosed) { serverClosed = true; clearTimeout(timer); server.close() } }
  const settle = (error?: Error, value?: SignInGrant) => {
    if (settled) return
    settled = true
    if (error) rejectPromise(error); else if (value) resolvePromise(value)
    closeServer()
  }
  timer = setTimeout(() => settle(new Error("Timed out waiting for the browser sign-in. Start sign-in again from OpenCode's connect menu.")), timeoutMs)
  timer.unref?.()
  signal?.addEventListener("abort", () => settle(new Error("Sign-in was cancelled")), { once: true })

  const page = (response: http.ServerResponse, heading: string, message: string) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
    response.end(`<!doctype html><html><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></body></html>`)
  }
  const fail = (response: http.ServerResponse, message: string) => { page(response, "Sign-in failed", message); settle(new Error(message)) }

  /** Both grants must resolve to one identity and tenant on the selected deployment. */
  async function verified(gateway: string, reporting: string) {
    const [a, b] = await Promise.all([whoamiWithRetry(base, reporting, fetchImpl), whoamiWithRetry(base, gateway, fetchImpl)])
    if (!a.tenantId || a.tenantId !== b.tenantId || (a.identityId ?? "") !== (b.identityId ?? "")) throw new WorkspaceMismatch()
  }
  async function finish(response: http.ServerResponse, redeemed: { apiKey: string; name?: string; prefix?: string }) {
    try {
      await verified(redeemed.apiKey, reportingKey!)
    } catch (error) {
      await reportingOnly(response, error instanceof WorkspaceMismatch ? DIFFERENT_WORKSPACES : CLAIMED_UNCONFIRMED)
      return
    }
    page(response, "Forgebench connected", "Forgebench connected. You can close this tab and return to OpenCode.")
    settle(undefined, { access: redeemed.apiKey, reportingKey: reportingKey!, name: redeemed.name, prefix: redeemed.prefix })
  }
  /**
   * The exchange has replaced this install's reporting key on the server, but no
   * new model key came back. A reconnect keeps the current model key with the new
   * reporting key, so the connection keeps working. A first connection cannot be
   * used without a model key and fails with `message`; the next sign-in from this
   * install replaces the unused reporting key.
   */
  async function reportingOnly(response: http.ServerResponse, message: string) {
    const kept = await currentAccess?.().catch(() => undefined)
    if (!kept) { fail(response, message); return }
    try {
      await verified(kept.access, reportingKey!)
    } catch (error) {
      if (error instanceof WorkspaceMismatch) fail(response, DIFFERENT_WORKSPACES)
      else fail(response, failureKind(error) === "auth" ? message : UNCONFIRMED)
      return
    }
    page(response, "Forgebench reporting reconnected", "Session reporting is reconnected and OpenCode keeps its current model key. You can close this tab.")
    settle(undefined, { access: kept.access, reportingKey: reportingKey!, name: kept.name, prefix: kept.prefix })
  }

  const onCallback = async (query: URLSearchParams, response: http.ServerResponse) => {
    // The first hit owns the exchange. A refresh or prefetch must not exchange again (that rotates the key).
    if (started) { page(response, "Sign-in in progress", "Return to OpenCode. You can close this tab."); return }
    const errorCode = query.get("error") ?? ""
    const code = query.get("code") ?? ""
    if (errorCode || !code) {
      const detail = query.get("error_description") || errorCode
      fail(response, errorCode ? `Forgebench sign-in failed: ${bounded(detail, errorCode, 120)}` : "Forgebench sign-in failed: no sign-in code was returned")
      return
    }
    started = true
    try {
      reportingKey = (await exchangeLoginCode({ url: base, code, verifier: loginPair.verifier, hostname, fetchImpl })).apiKey
    } catch {
      fail(response, GENERIC_ERROR)
      return
    }
    try {
      const options = await inferenceOptions({ url: base, token: reportingKey, challenge: consentPair.challenge, redirect: consentUrl, deviceName: device, hostname, fetchImpl })
      if (!options.eligible) { await reportingOnly(response, denialMessage(options.denial)); return }
      if (!options.consentUrl) throw new Error("no consent URL")
      response.writeHead(302, { Location: options.consentUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      response.end()
    } catch {
      await reportingOnly(response, GENERIC_ERROR)
    }
  }

  let consentUsed = false
  const onConsent = async (query: URLSearchParams, response: http.ServerResponse) => {
    if (!started || !reportingKey || consentUsed) { page(response, "Sign-in in progress", "Return to OpenCode. You can close this tab."); return }
    consentUsed = true
    const code = query.get("code") ?? ""
    if (query.get("error") || !code) {
      await reportingOnly(response, `Model authorization was declined in the browser (${bounded(query.get("error_description") || query.get("error"), "no code", 120)})`)
      return
    }
    let redeemed: Awaited<ReturnType<typeof redeemCode>>
    try {
      redeemed = await redeemCode({ url: base, code, verifier: consentPair.verifier, fetchImpl })
    } catch {
      await reportingOnly(response, GENERIC_ERROR)
      return
    }
    await finish(response, redeemed)
  }

  const server = http.createServer((req, response) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1")
    const host = (req.headers.host ?? "").toLowerCase()
    const port = (server.address() as AddressInfo | null)?.port
    const route = host === `127.0.0.1:${port}` && req.method === "GET"
      ? (parsed.pathname === callbackPath ? onCallback : parsed.pathname === consentPath ? onConsent : undefined)
      : undefined
    if (!route) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("not found"); return }
    Promise.resolve(route(parsed.searchParams, response)).catch(() => { try { page(response, "Sign-in failed", GENERIC_ERROR) } catch {} })
  })
  server.on("error", () => {})
  await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen) })
  const port = (server.address() as AddressInfo).port
  const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`
  const consentUrl = `http://127.0.0.1:${port}${consentPath}`

  return {
    url: ssoLoginUrl({ url: base, redirect: callbackUrl, challenge: loginPair.challenge }),
    promise,
    cancel: () => settle(new Error("Sign-in was cancelled")),
  }
}
