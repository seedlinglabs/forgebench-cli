import { reportingBoundary } from "./reporting-boundary.js"
import type { Plugin } from "@opencode/plugin"
import { createDelivery } from "../core/delivery.js"
import type { DeliveryDeps } from "../core/delivery.js"
import { isNativeSessionId, spanId, traceId } from "../core/idempotency.js"
import { record } from "../core/json.js"
import type { Json } from "../core/json.js"
import { observationsBody } from "../core/proposed.js"
import type { ObservationSpan } from "../core/proposed.js"
import { toolName } from "../core/redact.js"
import { buildSessionMeta, iso, sessionMeasurements } from "../core/sessions.js"
import type { KeyValueStore } from "../core/store.js"
import { reportingKey } from "./auth.js"
import { executionContext } from "./context.js"
import { createInstallId } from "./identity.js"
import { PROVIDER_ID } from "./options.js"
import type { ReportingOptions } from "./options.js"

type ReportingContext = Pick<Plugin.Context, "session" | "integration" | "storage" | "location" | "vcs" | "tool">
type SessionID = Parameters<ReportingContext["session"]["get"]>[0]["sessionID"]
export type ReportingDependencies = {
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
  context?: typeof executionContext
  autoRetry?: boolean
  sdkVersion?: string
  installId?: () => Promise<string>
  rpcTimeoutMs?: number
}

const START_EVENT = /^session\.created$/
const EXEC_START = /^session\.execution\.started$/
const EXEC_END = /^session\.(idle|execution\.(succeeded|failed|interrupted))$/
const MAX_ANCESTORS = 8
const MAX_SPANS = 500

type Execution = { startedAt: number; spans: ObservationSpan[]; open: Map<string, { name: string; start: number }> }

/**
 * OpenCode adapter for direct delivery. It translates native session events,
 * messages and tool hooks into the runtime-independent core payloads; the core
 * owns the queue, retries, policy and idempotency. Spans come from the plugin's
 * own tool hooks (OpenCode has no native OTel exporter) and carry metadata only.
 */
export function createReporting(ctx: ReportingContext, options: ReportingOptions & { url: string }, deps: ReportingDependencies = {}) {
  const now = deps.now ?? Date.now
  let reporter = { state: "ready", since: now(), dropped_events: 0 }
  let diagnostic: Promise<void> | undefined
  let diagnosticDirty = false
  // Diagnostics have their own key and one writer. They never touch spool keys
  // or start a replacement reporting worker, even if the SDK itself is stalled.
  function persistReporter() {
    diagnosticDirty = true
    if (diagnostic) return
    diagnostic = (async () => {
      while (diagnosticDirty) {
        diagnosticDirty = false
        await ctx.storage.set("reporter-status", { ...reporter, ...(reporter.state === "ready" ? {} : { reason: "sdk_timeout" }) }).catch(() => {})
      }
    })().finally(() => { diagnostic = undefined; if (diagnosticDirty) persistReporter() })
  }
  let lateRejections = 0
  const boundary = reportingBoundary(deps.rpcTimeoutMs, (paused, rejected) => {
    if (rejected) lateRejections++
    reporter = { ...reporter, state: paused ? "paused" : "resumed", since: now() }
    console.warn(JSON.stringify({ component: "forgebench.reporter", ...reporter, reason: "sdk_timeout" }))
    persistReporter()
  })
  const resolveInstallId = deps.installId ?? createInstallId(ctx.storage)
  const installId = () => boundary.call(resolveInstallId)
  let deliveryStatus: Record<string, unknown> = {}
  const store: KeyValueStore = {
    get: (key) => boundary.call(() => ctx.storage.get(key)),
    set: (key, value) => {
      if (key === "status") deliveryStatus = record(value)
      return boundary.call(() => ctx.storage.set(key, value as never))
    },
    remove: (key) => boundary.call(() => ctx.storage.remove(key)),
    scan: (scan) => boundary.call(() => ctx.storage.scan(scan)),
  }
  const delivery = createDelivery({
    url: options.url,
    store,
    deviceId: installId,
    reportingKey: () => boundary.call(() => reportingKey(ctx.integration, options.url)).catch(() => undefined),
    options: { context: options.context, traces: options.traces, tasks: options.tasks, sdkVersion: deps.sdkVersion ?? "0.0.0" },
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    random: deps.random,
    autoRetry: deps.autoRetry,
    onAuthFailure: () => { void flagReconnect() },
  } satisfies DeliveryDeps)

  async function flagReconnect(clear = false) {
    try {
      const connection = await boundary.call(() => ctx.integration.connection.active(PROVIDER_ID))
      if (!connection) return
      await boundary.call(() => ctx.integration.connection.status({
        integrationID: PROVIDER_ID, connection,
        status: clear ? undefined : { status: "needs_auth", message: "The Forgebench reporting credential was rejected. Sign in again." },
      }))
    } catch {}
  }

  const executions = new Map<string, Execution>()
  const announced = new Set<string>()
  const declared = new Set<string>()
  let chain: Promise<void> = Promise.resolve()
  let disposed = false
  type Work = { start: boolean; finish: boolean; failed: boolean }
  const pending = new Map<string, Work>()
  let working = false
  const MAX_EVENTS = 128

  function kick() {
    if (working || disposed) return
    working = true
    chain = (async () => {
      while (pending.size && !disposed) {
        const next = pending.entries().next().value
        if (!next) break
        const [id, work] = next
        pending.delete(id)
        if (work.start) { executions.delete(id); execution(id) }
        const failures = lateRejections
        try {
          if (work.finish) await finishExecution(id, work.failed)
          await capture(id)
          // Delivery deliberately absorbs SDK errors. Recapture after a late
          // rejection even when a credential lookup or spool write swallowed it.
          if (lateRejections !== failures && !disposed) await capture(id)
        } catch {
          // A late rejection releases the boundary too. Retry the snapshot once;
          // repeated SDK failures wait for the next native event, avoiding a spin.
          try { if (!disposed) await capture(id) } catch {
            await store.set("status", { state: "retrying", at: now() } as Json).catch(() => {})
          }
        }
      }
    })().finally(() => { working = false; if (pending.size && !disposed) kick() })
  }

  async function snapshot(sessionID: string) {
    const [native, messages, context] = await Promise.all([
      boundary.call(() => ctx.session.get({ sessionID: sessionID as SessionID })),
      boundary.call(() => ctx.session.context({ sessionID: sessionID as SessionID })),
      options.context ? boundary.call(() => (deps.context ?? executionContext)(ctx)).catch(() => ({})) : Promise.resolve({}),
    ])
    const startedAt = iso(native.time.created)
    return {
      native, startedAt,
      meta: buildSessionMeta({
        sessionID, startedAt, endedAt: iso(native.time.idle),
        parentSessionID: native.parentID ?? undefined,
        context, measurements: sessionMeasurements(messages),
      }),
    }
  }

  /** Report a session after its real native ancestors (parent first), never inferred from branches. */
  async function capture(sessionID: string) {
    if (!isNativeSessionId(sessionID)) return
    const lineage: string[] = []
    let cursor: string | undefined = sessionID
    for (let depth = 0; cursor && depth <= MAX_ANCESTORS; depth++) {
      lineage.unshift(cursor)
      const ancestor: string = cursor
      const parent: string | undefined = (await boundary.call(() => ctx.session.get({ sessionID: ancestor as SessionID })))?.parentID ?? undefined
      cursor = parent && isNativeSessionId(parent) ? parent : undefined
    }
    let startedAt: string | undefined
    for (const id of lineage) {
      if (id !== sessionID && announced.has(id)) continue
      const taken = await snapshot(id)
      const meta = taken.meta
      if (id === sessionID) startedAt = taken.startedAt
      if (meta) await delivery.enqueueSession(id, meta)
      if (id !== sessionID) announced.add(id)
    }
    if (options.task && startedAt && !declared.has(sessionID)) {
      declared.add(sessionID)
      await delivery.enqueueTask(sessionID, {
        connection_id: options.task.connectionId, task_id: options.task.taskId, source: "opencode",
        session_id: sessionID, started_at: startedAt, mechanism: "SessionStart",
      })
    }
    await delivery.drain()
  }

  async function finishExecution(sessionID: string, failed: boolean) {
    const execution = executions.get(sessionID)
    if (!execution) return
    executions.delete(sessionID)
    if (!options.traces || !isNativeSessionId(sessionID)) return
    const endedAt = now()
    const root = spanId(sessionID, "execution", String(execution.startedAt))
    const trace = traceId(sessionID)
    for (const [call, open] of execution.open) {
      execution.spans.push({
        id: spanId(sessionID, "tool", call), trace_id: trace, parent_observation_id: root, type: "tool", name: open.name,
        start_time: new Date(open.start).toISOString(), end_time: new Date(endedAt).toISOString(), level: "WARNING",
      })
    }
    const spans: ObservationSpan[] = [{
      id: root, trace_id: trace, parent_observation_id: null, type: "agent", name: "session.execution",
      start_time: new Date(execution.startedAt).toISOString(), end_time: new Date(endedAt).toISOString(), level: failed ? "ERROR" : "DEFAULT",
    }, ...execution.spans.slice(0, MAX_SPANS)]
    const sdkVersion = deps.sdkVersion ?? "0.0.0"
    const deviceId = await installId()
    await delivery.enqueueObservations(sessionID, observationsBody({ deviceId, sessionID, traceId: trace, sdkVersion, spans }))
  }

  const execution = (sessionID: string, startedAt = now()) => {
    let current = executions.get(sessionID)
    if (!current) { current = { startedAt, spans: [], open: new Map() }; executions.set(sessionID, current) }
    return current
  }

  async function registerToolHooks() {
    if (!options.traces) return
    await ctx.tool.hook("execute.before", (event) => {
      if (disposed || !isNativeSessionId(event.sessionID)) return
      execution(event.sessionID).open.set(String(event.id), { name: toolName(event.tool), start: now() })
    })
    await ctx.tool.hook("execute.after", (event) => {
      if (disposed || !isNativeSessionId(event.sessionID)) return
      const current = execution(event.sessionID)
      const call = String(event.id)
      const open = current.open.get(call)
      current.open.delete(call)
      if (current.spans.length >= MAX_SPANS) return
      current.spans.push({
        id: spanId(event.sessionID, "tool", call), trace_id: traceId(event.sessionID),
        parent_observation_id: spanId(event.sessionID, "execution", String(current.startedAt)), type: "tool",
        name: open?.name ?? toolName(event.tool),
        start_time: new Date(open?.start ?? now()).toISOString(), end_time: new Date(now()).toISOString(),
        level: event.status === "error" ? "ERROR" : "DEFAULT",
      })
    })
  }

  return {
    registerToolHooks,
    observe(event: unknown): void {
      if (disposed) return
      const value = record(event)
      const type = String(value.type)
      const data = record(value.data)
      const id = data.sessionID ?? record(data.session).id
      if (typeof id !== "string" || !isNativeSessionId(id)) return
      if (!START_EVENT.test(type) && !EXEC_START.test(type) && !EXEC_END.test(type)) return
      const previous = pending.get(id)
      if (!previous && pending.size >= MAX_EVENTS) {
        // Keep the newest session rather than dropping its only created event.
        const oldest = pending.keys().next().value
        if (oldest) pending.delete(oldest)
        reporter = { ...reporter, dropped_events: reporter.dropped_events + 1 }
        persistReporter()
      }
      pending.set(id, {
        start: EXEC_START.test(type) || (previous?.start ?? false),
        finish: !EXEC_START.test(type) && (EXEC_END.test(type) || (previous?.finish ?? false)),
        failed: EXEC_END.test(type) ? /failed$/.test(type) : (previous?.failed ?? false),
      })
      kick()
    },
    /** The credential changed: lift an auth pause and retry the spool. */
    async resume() { await flagReconnect(true); await delivery.resume() },
    /** Clears the reconnect flag only when a pause was really lifted, so clearing it cannot feed another event. */
    async credentialChanged() { if (await delivery.credentialChanged()) await flagReconnect(true) },
    async status() {
      const current = { ...reporter, ...(reporter.state === "ready" ? {} : { reason: "sdk_timeout" }) }
      if (reporter.state === "paused") return current
      return { ...deliveryStatus, reporter: current, dropped_events: reporter.dropped_events }
    },
    async flush() { await chain; await delivery.flush(); await diagnostic },
    dispose() { disposed = true; boundary.stop(); delivery.dispose() },
  }
}
export type Reporting = ReturnType<typeof createReporting>
