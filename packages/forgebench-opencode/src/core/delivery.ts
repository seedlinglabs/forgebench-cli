import { BackendError, failureKind, request } from "./backend.js"
import type { RequestOptions } from "./backend.js"
import { digest, ownerOf, queueOwnerOf } from "./idempotency.js"
import { record } from "./json.js"
import type { Json } from "./json.js"
import {
  UNSUPPORTED_STATUSES, declareTask, nativeContextAcknowledged, nativeMetaBody, observationsReceipt,
} from "./proposed.js"
import type { TaskDeclaration } from "./proposed.js"
import { whoami } from "./oauth.js"
import { DeliveryQueue, backoff } from "./queue.js"
import type { Job } from "./queue.js"
import type { KeyValueStore } from "./store.js"

export const SOURCE = "opencode"
const FEATURE_RETRY_MS = 60 * 60 * 1000
const BATCH = 10
const POLICY_MODES = new Set(["legacy", "local", "both", "otel", "off"])

export type DeliveryState =
  | "idle" | "delivered" | "needs-sign-in" | "auth-paused" | "capture-off" | "refused" | "retrying"
  | "backpressure" | "waiting-backend-contract" | "traces-unsupported" | "tasks-unsupported" | "task-rejected"
  | "plan-required" | "principal-held"
export type DeliveryStatus = { state: DeliveryState; at: number; status?: number; code?: string; session_id?: string; held_jobs?: number }

export type DeliveryOptions = { context: boolean; traces: boolean; tasks: boolean; sdkVersion: string }
export type DeliveryDeps = {
  url: string
  store: KeyValueStore
  deviceId: () => Promise<string>
  /** Re-resolved before every upload; principal binding separately fences queued data. */
  reportingKey: () => Promise<string | undefined>
  options: DeliveryOptions
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
  /** Called once when the backend rejects the reporting credential (revoked or expired). */
  onAuthFailure?: () => void
  /** Called once per credential when the workspace plan does not include session insights (402). */
  onPlanRequired?: (code?: string) => void
  /** Retry timer. Tests pass `false` and drive `drain()` with a fake clock. */
  autoRetry?: boolean
  timeoutMs?: number
}

/**
 * Direct, policy-governed delivery of session context, tool/session spans and
 * task declarations to the backend. Runtime-independent: it is given storage,
 * a credential source and a clock, and never imports an OpenCode API or a CLI.
 */
export function createDelivery(deps: DeliveryDeps) {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const queue = new DeliveryQueue(deps.store, now)
  const http: RequestOptions = { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs }
  let chain: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const setStatus = async (state: DeliveryState, extra: Omit<DeliveryStatus, "state" | "at"> = {}) => {
    await deps.store.set("status", { state, at: now(), ...extra } as Json).catch(() => {})
  }
  const pausedFor = async () => {
    const value = await deps.store.get("auth-paused")
    return typeof value === "string" ? value : undefined
  }
  const featureOff = async (name: string) => Number(await deps.store.get(`off:${name}`)) > now()
  const markOff = (name: string) => deps.store.set(`off:${name}`, now() + FEATURE_RETRY_MS)

  async function principalOf(key: string): Promise<string> {
    const identity = await whoami(deps.url, key, deps.fetchImpl ?? globalThis.fetch, deps.timeoutMs)
    if (!identity.tenantId || !identity.identityId) throw new Error("Reporting credential has no owning person")
    return digest([identity.tenantId, identity.identityId])
  }

  async function enqueue(kind: "meta" | "observations" | "task", slotId: string, payload: Json) {
    const key = await deps.reportingKey()
    if (!key) { await setStatus("needs-sign-in"); return }
    const owner = queueOwnerOf(deps.url, await deps.deviceId())
    const credential = ownerOf(deps.url, key)
    // Offline capture remains bound to this exact key. Only that key can establish
    // its principal later; an arbitrary replacement key cannot claim the job.
    const principal = await principalOf(key).catch(() => undefined)
    const binding = { credential, ...(principal ? { principal } : {}) }
    const result = await queue.put(owner, kind, DeliveryQueue.slot(kind, digest([principal ?? credential, slotId])), payload, binding)
    if (result === "full") await setStatus("backpressure")
  }

  async function policy(key: string, deviceId: string) {
    const doc = await request(deps.url, `/v1/sessions/capture-policy?source=${SOURCE}&device_id=${encodeURIComponent(deviceId)}`, key, undefined, http)
    const effective = record(doc.effective)
    const mode = String(effective.mode)
    if (!POLICY_MODES.has(mode)) throw new Error("Capture policy is unavailable")
    const revision = Number(effective.revision) || 0
    if (mode !== "legacy" && revision > 0 && (await deps.store.get("policy-ack")) !== revision) {
      try {
        await request(deps.url, "/v1/sessions/capture-policy/ack", key, { revision, source: SOURCE, device_id: deviceId, mode, status: "applied" }, http)
        await deps.store.set("policy-ack", revision)
      } catch {}
    }
    return mode
  }

  async function deliver(job: Job, key: string, deviceId: string, mode: string): Promise<"done" | "stop"> {
    const payload = record(job.payload)
    if (job.kind === "meta") {
      const session = record(payload.session)
      const result = await request(deps.url, "/v1/sessions/meta", key, nativeMetaBody(deviceId, [session as Json]), http)
      // Under OTel capture an old server skips context silently: that is not delivery.
      if (mode === "otel" && !nativeContextAcknowledged(result)) {
        await queue.defer(job, FEATURE_RETRY_MS, false)
        await setStatus("waiting-backend-contract", { session_id: String(session.session_id) })
        return "done"
      }
      if (!(Number(result.accepted) >= 1)) {
        // The server's receipt says it dropped this session on purpose (off interval, erasure, retention): retrying cannot change that.
        if (nativeContextAcknowledged(result) && Number(record(result.receipt).skipped) >= 1) {
          await queue.ack(job)
          await setStatus("refused", { code: "skipped_by_server", session_id: String(session.session_id) })
          return "done"
        }
        throw new BackendError(502, "not_confirmed")
      }
      await queue.ack(job)
      await setStatus("delivered", { session_id: String(session.session_id) })
      return "done"
    }
    if (job.kind === "observations") {
      if (!deps.options.traces || (await featureOff("observations"))) { await queue.ack(job); return "done" }
      try {
        const result = await request(deps.url, "/v1/observations/batch", key, payload.body, http)
        if (!observationsReceipt(result)) throw new BackendError(422, "capture_unsupported")
      } catch (error) {
        if (error instanceof BackendError && UNSUPPORTED_STATUSES.has(error.status)) {
          await markOff("observations")
          await queue.ack(job)
          await setStatus("traces-unsupported", { status: error.status, ...(error.code ? { code: error.code } : {}) })
          return "done"
        }
        throw error
      }
      await queue.ack(job)
      return "done"
    }
    // task declaration
    if (!deps.options.tasks || (await featureOff("tasks"))) { await queue.ack(job); return "done" }
    try {
      await declareTask(deps.url, key, payload.declaration as TaskDeclaration, http)
    } catch (error) {
      // A refusal that names a reason (unknown task, ambiguous, not connected) concerns this one
      // declaration. Only a bare 403/404/405 means the endpoint itself is missing.
      if (error instanceof BackendError && error.code && [403, 404, 409, 422].includes(error.status)) {
        await queue.ack(job)
        await setStatus("task-rejected", { status: error.status, code: error.code })
        return "done"
      }
      if (error instanceof BackendError && [403, 404, 405].includes(error.status)) {
        await markOff("tasks")
        await queue.ack(job)
        await setStatus("tasks-unsupported", { status: error.status })
        return "done"
      }
      throw error
    }
    await queue.ack(job)
    return "done"
  }

  async function run(): Promise<void> {
    const key = await deps.reportingKey()
    if (!key) { await setStatus("needs-sign-in"); return }
    const owner = ownerOf(deps.url, key)
    if ((await pausedFor()) === owner) { await setStatus("auth-paused"); return }
    const queueOwner = queueOwnerOf(deps.url, await deps.deviceId())
    const pending = await queue.list(queueOwner)
    if (!pending.length) return
    let principal: string
    try { principal = await principalOf(key) } catch (error) {
      // Identity endpoint refusals must never terminally acknowledge context.
      if (failureKind(error) === "auth") {
        await deps.store.set("auth-paused", owner)
        deps.onAuthFailure?.()
      }
      await setStatus("principal-held", { code: "identity_unavailable", held_jobs: pending.length })
      return
    }
    const belongs = (job: Job) => job.binding?.principal
      ? job.binding.principal === principal
      : job.binding?.credential === owner
    // Held work is never posted under another principal; past its age it is dropped
    // locally like any expired job, so held spool cannot pin queue capacity.
    for (const job of pending.filter(job => !belongs(job) && queue.expired(job))) await queue.ack(job)
    const held = pending.filter(job => !belongs(job) && !queue.expired(job)).length
    const heldStatus = () => setStatus("principal-held", { code: "principal_mismatch_or_legacy", held_jobs: held })
    const jobs = pending.filter(job => belongs(job) && job.notBefore <= now()).slice(0, BATCH)
    if (!jobs.length) { if (held) await heldStatus(); return }
    // Persist a verified principal before any upload so restart/rotation cannot
    // lose the proof. Legacy jobs without any binding are never adopted.
    for (const job of jobs) {
      if (job.binding && !job.binding.principal) {
        job.binding.principal = principal
        await queue.defer(job, 0, false)
      }
    }
    let mode: string
    let deviceId: string
    try {
      deviceId = await deps.deviceId()
      mode = await policy(key, deviceId)
    } catch (error) {
      await handleFailure(error, owner, jobs)
      return
    }
    if (mode === "off") {
      for (const job of pending.filter(belongs)) await queue.ack(job)
      await setStatus("capture-off")
      if (held) await heldStatus()
      return
    }
    for (const job of jobs) {
      const current = await deps.reportingKey()
      if (!current || ownerOf(deps.url, current) !== owner) return
      if (queue.expired(job)) { await queue.ack(job); await setStatus("refused", { code: "expired" }); continue }
      try {
        await deliver(job, key, deviceId, mode)
      } catch (error) {
        const keepGoing = await handleFailure(error, owner, [job])
        if (!keepGoing) return
      }
    }
    if (held) await heldStatus()
  }

  /** Returns true when later jobs may still be attempted this pass. */
  async function handleFailure(error: unknown, owner: string, failed: Job[]): Promise<boolean> {
    const kind = failureKind(error)
    const status = error instanceof BackendError ? error.status : undefined
    const code = error instanceof BackendError ? error.code : undefined
    if (kind === "auth") {
      // Revoked or expired: stop sending until the credential changes. Never replay a 401.
      await deps.store.set("auth-paused", owner)
      await setStatus("auth-paused", { status: 401 })
      deps.onAuthFailure?.()
      return false
    }
    if (kind === "terminal") {
      for (const job of failed) await queue.ack(job)
      await setStatus("refused", { ...(status ? { status } : {}), ...(code ? { code } : {}) })
      return true
    }
    if (kind === "payment") {
      for (const job of failed) await queue.defer(job, FEATURE_RETRY_MS)
      await setStatus("plan-required", { ...(status ? { status } : {}), ...(code ? { code } : {}) })
      if ((await deps.store.get("plan-notified")) !== owner) {
        await deps.store.set("plan-notified", owner).catch(() => {})
        deps.onPlanRequired?.(code)
      }
      return true
    }
    // Offline or overloaded: every affected job waits out its own backoff (no hot retry loop).
    const retryAfter = error instanceof BackendError ? error.retryAfterMs : undefined
    for (const job of failed) {
      await queue.defer(job, backoff(job.attempts, random, retryAfter))
    }
    await setStatus("retrying", { ...(status ? { status } : {}), ...(code ? { code } : {}) })
    return kind !== "rate"
  }

  async function schedule() {
    if (disposed || deps.autoRetry === false) return
    const key = await deps.reportingKey().catch(() => undefined)
    if (!key) return
    const pending = await queue.list(queueOwnerOf(deps.url, await deps.deviceId())).catch(() => [])
    if (!pending.length || (await pausedFor()) === ownerOf(deps.url, key)) return
    const wait = record(await deps.store.get("status")).state === "principal-held"
      ? FEATURE_RETRY_MS
      : Math.max(1000, Math.min(...pending.map((job) => job.notBefore)) - now())
    clearTimeout(timer)
    timer = setTimeout(() => { void drain() }, Math.min(wait, 15 * 60 * 1000))
    timer.unref?.()
  }

  const serialize = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(async () => { await setStatus("retrying").catch(() => {}) })
    return chain
  }
  function drain(): Promise<void> {
    return serialize(async () => { await run(); await schedule() })
  }

  return {
    drain,
    /** One snapshot per native session; a newer snapshot replaces the unsent one. Parents go first. */
    enqueueSession: (sessionID: string, session: Json) => serialize(() => enqueue("meta", sessionID, { session })),
    /** Persisted before upload, so a retry resends the identical payload. */
    enqueueObservations: (sessionID: string, body: Json) =>
      serialize(() => enqueue("observations", `${sessionID}:${digest(body)}`, { body })),
    enqueueTask: (sessionID: string, declaration: TaskDeclaration) =>
      serialize(() => enqueue("task", `${sessionID}:${digest(declaration)}`, { declaration: declaration as unknown as Json })),
    /** Credential changed or the user reconnected: lift an auth pause and try again. */
    async resume() { await deps.store.remove("auth-paused"); await deps.store.remove("off:tasks"); return drain() },
    /**
     * Any credential event, possibly for another provider. A key that was rejected
     * stays paused until the key itself changes. Returns true when a pause was lifted.
     */
    async credentialChanged(): Promise<boolean> {
      const paused = await pausedFor()
      if (paused) {
        const key = await deps.reportingKey().catch(() => undefined)
        if (key && ownerOf(deps.url, key) === paused) return false
        await deps.store.remove("auth-paused")
        await deps.store.remove("off:tasks")
      }
      await drain()
      return paused !== undefined
    },
    async status(): Promise<DeliveryStatus | undefined> {
      const value = record(await deps.store.get("status"))
      return typeof value.state === "string" ? value as unknown as DeliveryStatus : undefined
    },
    flush: () => chain,
    dispose() { disposed = true; clearTimeout(timer) },
  }
}
export type Delivery = ReturnType<typeof createDelivery>
