import { record } from "./json.js"

export type FailureKind = "auth" | "rate" | "payment" | "terminal" | "retry"

/** A refused or failed backend call. Carries status and a bounded code only, never a body. */
export class BackendError extends Error {
  readonly status: number
  readonly code?: string
  readonly retryAfterMs?: number
  constructor(status: number, code?: string, retryAfterMs?: number) {
    super(`Forgebench request failed (HTTP ${status}${code ? `, ${code}` : ""})`)
    this.name = "BackendError"
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

/** Deployment origin: https, or plain http only for loopback development. No credentials, path or query. */
export function normalizeOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error("Forgebench url is not a valid origin") }
  if (parsed.username || parsed.password) throw new Error("Forgebench url must not contain credentials")
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
    throw new Error("Forgebench url must be https (http is allowed only on loopback)")
  }
  const path = parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${path}`
}

/** Machine code from `{detail:{error}}`, `{detail:{code}}`, `{detail:{reason}}` or `{error}`; never free text. */
export function errorCode(body: unknown): string | undefined {
  const doc = record(body)
  const detail = record(doc.detail)
  for (const candidate of [detail.error, detail.code, detail.reason, doc.error, record(doc.error).code]) {
    if (typeof candidate === "string" && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) return candidate
  }
  return undefined
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 3_600_000) : undefined
}

export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof BackendError)) return "retry"
  if (error.status === 401) return "auth"
  if (error.status === 429) return "rate"
  if (error.status === 402) return "payment"
  if (error.status >= 500 || error.status === 408) return "retry"
  return "terminal"
}

/** Timeout plus optional caller cancellation (AbortSignal.any needs Node 20.3). */
export function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  const merged = new AbortController()
  const abort = () => merged.abort()
  if (signal.aborted || timeout.aborted) merged.abort()
  signal.addEventListener("abort", abort, { once: true })
  timeout.addEventListener("abort", abort, { once: true })
  return merged.signal
}

export type RequestOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** The credential travels only in the Authorization header, only to the selected deployment. */
export async function request(
  origin: string,
  path: string,
  key: string,
  body?: unknown,
  { fetchImpl = globalThis.fetch, timeoutMs = 8000, signal, headers = {} }: RequestOptions = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: deadline(timeoutMs, signal),
    redirect: "error",
  })
  if (!response.ok) {
    let code: string | undefined
    try { code = errorCode(await response.json()) } catch {}
    throw new BackendError(response.status, code, retryAfter(response.headers.get("retry-after")))
  }
  try { return record(await response.json()) } catch { return {} }
}
