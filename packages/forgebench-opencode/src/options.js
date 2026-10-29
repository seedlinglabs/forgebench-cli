export const PROVIDER_ID = "forgebench"
export const SESSION_HEADER = "X-Forgebench-Session-Id"
export const HARNESS_HEADER = "X-Forgebench-Harness"
/** The gateway key env the CLI and every routed tool already read (documentation, not config). */
export const GATEWAY_KEY_ENV = "FORGEBENCH_GATEWAY_KEY"

const AUTH_MODES = new Set(["auto", "oauth", "key", "none"])

const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** One plugin-option model entry -> the OpenCode `Model.Info` shape models.js also produces. */
export function model(entry) {
  const raw = typeof entry === "string" ? { id: entry } : entry
  const id = str(raw?.id)
  if (!id) return undefined
  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: str(raw.name) ?? id,
    capabilities: {
      tools: raw.tools !== false,
      input: Array.isArray(raw.input) ? raw.input : ["text", "image"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: Number(raw.context) || 200000, output: Number(raw.output) || 32000 },
  }
}

/**
 * Plugin options -> the resolved config. Every slice is off unless its flag is `true` (D8).
 *
 * Credential paths for the gateway slice, in resolution order (credentials.js):
 *   1. an OpenCode connection (`/connect`: OAuth sign-in or pasted key),
 *   2. `apiKey` (static, for headless configs — it lives in opencode.json, so prefer the others),
 *   3. `FORGEBENCH_GATEWAY_KEY` in the environment at request time,
 *   4. `<executable> gateway token` (the CLI's 0600 key store).
 * `auth` selects which `/connect` methods are registered: `"auto"` (default) both,
 * `"oauth"`/`"key"` one, `"none"` neither (headless). The gateway needs `url` and at
 * least one credential path; `executable` is optional since OAuth exists.
 */
export function resolveOptions(options) {
  const o = options && typeof options === "object" ? options : {}
  const url = str(o.url)?.replace(/\/+$/, "")
  const executable = str(o.executable)
  const auth = AUTH_MODES.has(o.auth) ? o.auth : "auto"
  const apiKey = str(o.apiKey)
  // `apiKey` is resolved per request in credentials.js; it never reaches provider settings,
  // where it would override the `Authorization` the `model.request` hook sets.
  const canAuthenticate = auth !== "none" || !!apiKey || !!executable
  const headers = { [HARNESS_HEADER]: "opencode" }
  for (const [name, value] of Object.entries(o.headers && typeof o.headers === "object" ? o.headers : {})) {
    if (name.toLowerCase() !== "authorization" && typeof value === "string") headers[name] = value
  }
  const mcpUrl = str(o.mcpUrl) ?? (url ? `${url}/mcp` : undefined)
  return {
    gateway: o.gateway === true && !!url && canAuthenticate
      ? { url, executable, auth, apiKey, headers, models: (Array.isArray(o.models) ? o.models : []).map(model).filter(Boolean) }
      : undefined,
    sync: o.sync === true && !!executable ? { executable, url } : undefined,
    mcp: o.mcp === true && mcpUrl ? { url: mcpUrl } : undefined,
  }
}
