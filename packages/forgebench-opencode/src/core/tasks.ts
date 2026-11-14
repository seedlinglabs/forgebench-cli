/** Task references are validated by shape here; the backend alone decides whether a task is real. */
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,127}$/

export type TaskSelection = { connectionId: string; taskId: string }

/** Returns a normalized selection, or undefined when it is not a well-formed explicit selection. */
export function parseTaskSelection(value: unknown): TaskSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const { connectionId, taskId } = value as Record<string, unknown>
  if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId.trim())) return undefined
  if (typeof taskId !== "string" || !TASK_ID.test(taskId.trim())) return undefined
  return { connectionId: connectionId.trim().toLowerCase(), taskId: taskId.trim() }
}
