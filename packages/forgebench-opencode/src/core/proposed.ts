/**
 * PROPOSED-CONTRACT ISOLATION.
 *
 * Every branch in this package that depends on a backend capability marked
 * "proposed / not yet available" in docs/plans/2026-10-30-standalone-plugins-
 * backend-contract.md lives in this one module. Each helper feature-detects
 * and fails closed: an older server (extra fields ignored, 403/404/405) is
 * reported as "unsupported", never as delivered and never retried hot.
 *
 *  B. Native context:          `capture_transport:"native"` on /v1/sessions/meta,
 *                              answered with `capture_contract:1`.
 *  B. Owned task operations:   /v1/sessions/value/task-validation and
 *                              /task-declarations with a `sessions:write` key.
 *  C. Owned observations:      `capture` envelope on /v1/observations/batch,
 *                              answered with `capture_contract:1` + `receipt`.
 *
 * Nothing here talks to the Forgebench CLI, and no native OTLP trace export is
 * attempted: OpenCode has no verified native OTel exporter.
 */
import { request } from "./backend.js"
import type { RequestOptions } from "./backend.js"
import { record } from "./json.js"
import type { Json } from "./json.js"

export const CAPTURE_CONTRACT = 1
export const PLUGIN_CLIENT = "opencode"
/** Statuses that mean "this server does not offer the capability" (as opposed to a transient fault). */
export const UNSUPPORTED_STATUSES = new Set([403, 404, 405, 422])

/** B. Context-only metadata batch. The backend must never read it as a usage snapshot. */
export function nativeMetaBody(deviceId: string, sessions: Json[]): Json {
  return { device_id: deviceId, capture_transport: "native", sessions }
}

/** B. True when the server acknowledged the native-context discriminator. */
export const nativeContextAcknowledged = (result: Record<string, unknown>): boolean => result.capture_contract === CAPTURE_CONTRACT

/** B. Connection-qualified task validation with the owned reporting key. */
export async function validateTask(origin: string, key: string, input: { connectionId: string; taskId: string }, options?: RequestOptions) {
  const doc = await request(origin, "/v1/sessions/value/task-validation", key, { connection_id: input.connectionId, task_id: input.taskId }, options)
  return { valid: doc.valid === true, taskObjectId: typeof doc.task_object_id === "string" ? doc.task_object_id : undefined }
}

export type TaskDeclaration = {
  connection_id: string
  task_id: string
  source: "opencode"
  session_id: string
  started_at: string
  mechanism: "SessionStart" | "PreToolUse" | "ui" | "cli"
}

/** B. Deliberate selection. Never synthesized from a branch name; review status stays the server's word. */
export async function declareTask(origin: string, key: string, declaration: TaskDeclaration, options?: RequestOptions) {
  const doc = await request(origin, "/v1/sessions/value/task-declarations", key, declaration, options)
  return { reviewStatus: typeof doc.review_status === "string" ? doc.review_status : undefined, linkId: doc.link_id }
}

export type ObservationSpan = {
  id: string
  trace_id: string
  parent_observation_id: string | null
  type: "agent" | "tool" | "span"
  name: string
  start_time: string
  end_time: string
  level: "DEFAULT" | "WARNING" | "ERROR"
}

/** C. The owned capture envelope. Metadata only: no input, output, command text, path or message. */
export function observationsBody(input: {
  deviceId: string; sessionID: string; traceId: string; sdkVersion: string; spans: ObservationSpan[]
}): Json {
  return {
    capture: { source: PLUGIN_CLIENT, session_id: input.sessionID, device_id: input.deviceId },
    sdk: { name: "forgebench-opencode", version: input.sdkVersion },
    traces: [{ id: input.traceId, session_id: input.sessionID }],
    observations: input.spans.map((span) => ({ ...span, input: null, output: null, metadata: {} })),
  } as Json
}

/** C. Storage receipt. HTTP 200/202 without `capture_contract:1` + `receipt` is NOT storage. */
export function observationsReceipt(result: Record<string, unknown>): { stored: number; duplicates: number } | undefined {
  if (result.capture_contract !== CAPTURE_CONTRACT) return undefined
  const receipt = record(result.receipt)
  const { stored, duplicates } = receipt
  if (typeof stored !== "number" || typeof duplicates !== "number") return undefined
  if (result.accepted !== stored + duplicates) return undefined
  return { stored, duplicates }
}
