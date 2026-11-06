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
  const installId = deps.installId ?? createInstallId(ctx.storage)
  const store: KeyValueStore = {
    get: (key) => ctx.storage.get(key),
    set: (key, value) => ctx.storage.set(key, value as never),
    remove: (key) => ctx.storage.remove(key),
    scan: (scan) => ctx.storage.scan(scan),
  }
  const delivery = createDelivery({
    url: options.url,
    store,
    deviceId: installId,
    reportingKey: () => reportingKey(ctx.integration, options.url).catch(() => undefined),
    options: { context: options.context, traces: options.traces, tasks: options.tasks, sdkVersion: deps.sdkVersion ?? "0.0.0" },
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    random: deps.random,
    autoRetry: deps.autoRetry,
    onAuthFailure: () => { void flagReconnect() },
  } satisfies DeliveryDeps)

  async function flagReconnect(clear = false) {
    try {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      if (!connection) return
      await ctx.integration.connection.status({
        integrationID: PROVIDER_ID, connection,
        status: clear ? undefined : { status: "needs_auth", message: "The Forgebench reporting credential was rejected. Sign in again." },
      })
    } catch {}
  }

  const executions = new Map<string, Execution>()
  const announced = new Set<string>()
  const declared = new Set<string>()
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  async function snapshot(sessionID: string) {
    const [native, messages, context] = await Promise.all([
      ctx.session.get({ sessionID: sessionID as SessionID }),
      ctx.session.context({ sessionID: sessionID as SessionID }),
      options.context ? (deps.context ?? executionContext)(ctx).catch(() => ({})) : Promise.resolve({}),
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
      const parent: string | undefined = (await ctx.session.get({ sessionID: cursor as SessionID }).catch(() => undefined))?.parentID ?? undefined
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
      if (typeof id !== "string") return
      const run = async () => {
        if (EXEC_START.test(type)) { executions.delete(id); execution(id); return }
        if (START_EVENT.test(type)) { await capture(id); return }
        if (EXEC_END.test(type)) {
          await finishExecution(id, /failed$/.test(type))
          await capture(id)
        }
      }
      chain = chain.then(run).catch(async () => { await store.set("status", { state: "retrying", at: now() } as Json).catch(() => {}) })
    },
    /** The credential changed: lift an auth pause and retry the spool. */
    async resume() { await flagReconnect(true); await delivery.resume() },
    /** Clears the reconnect flag only when a pause was really lifted, so clearing it cannot feed another event. */
    async credentialChanged() { if (await delivery.credentialChanged()) await flagReconnect(true) },
    status: () => delivery.status(),
    async flush() { await chain; await delivery.flush() },
    dispose() { disposed = true; delivery.dispose() },
  }
}
export type Reporting = ReturnType<typeof createReporting>
