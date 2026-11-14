import { normalizeOrigin } from "./backend.js"
import { record, str } from "./json.js"
import { parseTaskSelection } from "./tasks.js"
import type { TaskSelection } from "./tasks.js"

export const PROVIDER_ID_VALUE = "forgebench"
export const SESSION_HEADER = "X-Forgebench-Session-Id"
export const HARNESS_HEADER = "X-Forgebench-Harness"
export const CLIENT_REQUEST_HEADER = "X-Client-Request-Id"
/** Explicit user/deployment override, documented for headless use. Never written by this plugin. */
export const GATEWAY_KEY_ENV = "FORGEBENCH_GATEWAY_KEY"
/** Explicit reporting override for headless use. Never written by this plugin. */
export const REPORTING_KEY_ENV = "FORGEBENCH_API_KEY"
export const DEFAULT_URL = "https://api.forgebench.ai"

export type AuthMode = "auto" | "oauth" | "key" | "none"
const AUTH_MODES = new Set(["auto", "oauth", "key", "none"])

export type CoreOptions = {
  claudeAgentContext: boolean
  url?: string
  /** Set when `url` is malformed: every network feature fails closed. */
  urlError?: string
  gateway?: { auth: AuthMode; apiKey?: string; headers: Record<string, string>; models: unknown[] }
  /** Direct session/context/trace/task reporting. `sync:false` is kept as the opt-out alias. */
  reporting?: { context: boolean; traces: boolean; tasks: boolean; task?: TaskSelection }
  mcp?: { url: string }
}

/**
 * Plugin options -> resolved config, runtime-independent. Features default on;
 * explicit `false` (or any non-boolean) disables them. `executable` is accepted
 * and ignored: the plugin never runs another program.
 */
export function resolveCoreOptions(options: unknown): CoreOptions {
  const o = record(options)
  const on = (...names: string[]) => names.every((name) => o[name] === undefined || o[name] === true)
  let url: string | undefined
  let urlError: string | undefined
  try { url = normalizeOrigin(str(o.url) ?? DEFAULT_URL) } catch (error) { urlError = (error as Error).message }
  const headers: Record<string, string> = { [HARNESS_HEADER]: "opencode" }
  for (const [name, value] of Object.entries(record(o.headers))) {
    if (name.toLowerCase() !== "authorization" && typeof value === "string") headers[name] = value
  }
  const task = parseTaskSelection(o.task)
  return {
    url, urlError, claudeAgentContext: o.claudeAgentContext === true,
    gateway: on("gateway") ? {
      auth: typeof o.auth === "string" && AUTH_MODES.has(o.auth) ? o.auth as AuthMode : "auto",
      apiKey: str(o.apiKey), headers, models: Array.isArray(o.models) ? o.models : [],
    } : undefined,
    reporting: on("reporting", "sync") ? { context: o.context !== false, traces: o.traces !== false, tasks: task !== undefined, ...(task ? { task } : {}) } : undefined,
    mcp: on("mcp") ? { url: str(o.mcpUrl) ?? (url ? `${url}/mcp` : "") } : undefined,
  }
}
