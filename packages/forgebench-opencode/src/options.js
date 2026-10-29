export const PROVIDER_ID = "forgebench"
export const SESSION_HEADER = "X-Forgebench-Session-Id"
export const HARNESS_HEADER = "X-Forgebench-Harness"

const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function model(entry) {
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

/** Plugin options -> the resolved config. Every slice is off unless its flag is `true` (D8). */
export function resolveOptions(options) {
  const o = options && typeof options === "object" ? options : {}
  const url = str(o.url)?.replace(/\/+$/, "")
  const executable = str(o.executable)
  // `apiKey` is never read: the key comes from `<executable> gateway token` per request.
  const headers = { [HARNESS_HEADER]: "opencode" }
  for (const [name, value] of Object.entries(o.headers && typeof o.headers === "object" ? o.headers : {})) {
    if (name.toLowerCase() !== "authorization" && typeof value === "string") headers[name] = value
  }
  const mcpUrl = str(o.mcpUrl) ?? (url ? `${url}/mcp` : undefined)
  return {
    gateway: o.gateway === true && !!url && !!executable ? { url, executable, headers, models: (Array.isArray(o.models) ? o.models : []).map(model).filter(Boolean) } : undefined,
    sync: o.sync === true && !!executable ? { executable, url } : undefined,
    mcp: o.mcp === true && mcpUrl ? { url: mcpUrl } : undefined,
  }
}
