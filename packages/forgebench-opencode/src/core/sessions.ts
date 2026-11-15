import { record } from "./json.js"
import type { Json } from "./json.js"

export function iso(value: unknown): string | undefined {
  const date = value instanceof Date ? value : new Date(typeof value === "number" || typeof value === "string" ? value : Number(record(value).epochMillis))
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/**
 * Native messages reduced to counters. No content or token usage is reported.
 * Governed requests are metered by the gateway; direct-provider usage is unknown here.
 */
export function sessionMeasurements(messages: readonly unknown[]) {
  let prompts = 0, turns = 0, tools = 0, failures = 0
  for (const value of messages) {
    const message = record(value)
    if (message.type === "user") { prompts++; turns++ }
    if (message.type !== "assistant") continue
    turns++
    for (const item of Array.isArray(message.content) ? message.content : []) {
      const content = record(item)
      if (content.type === "tool") {
        tools++
        if (record(content.state).status === "error") failures++
      }
    }
  }
  return { prompt_count: prompts, turn_count: turns, tool_call_count: tools, tool_failure_count: failures }
}

export type SessionSnapshotInput = {
  sessionID: string
  startedAt?: string
  endedAt?: string
  parentSessionID?: string
  context?: { repo?: string; branch?: string; repository?: string }
  measurements?: ReturnType<typeof sessionMeasurements>
}

/** One /v1/sessions/meta entry. Real native ids, real parent, safe repository context, no usage. */
export function buildSessionMeta(input: SessionSnapshotInput): Json | undefined {
  if (!input.startedAt) return undefined
  const context = input.context ?? {}
  return {
    source: "opencode",
    session_id: input.sessionID,
    started_at: input.startedAt,
    ...(input.endedAt ? { ended_at: input.endedAt } : {}),
    session_kind: input.parentSessionID ? "subagent" : "main",
    ...(input.parentSessionID ? { parent_session_id: input.parentSessionID } : {}),
    ...(context.repo ? { repo: context.repo } : {}),
    ...(context.repository ? { repository: context.repository } : {}),
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.repo || context.repository || context.branch ? { context_state: "captured" } : {}),
    ...(input.measurements ?? {}),
  }
}
