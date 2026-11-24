import { record } from "./json.js"

export const DEFAULT_TIMEOUT_MS = 15_000
const MAX_NAME_LENGTH = 120
// `detail` is included only for tiny error bodies, never for a full page.
const MAX_DETAIL_BODY_LENGTH = 200

/** Runtime-neutral view of one gateway catalog entry; each adapter maps it to its host's model type. */
export type CatalogModel = {
  id: string
  /** Picker text: the model's short name plus its delivery route, e.g. "Gemini 3.8 Flash (OpenRouter)". */
  name: string
  /** Who delivers it ("OpenRouter", "Bedrock US"); undefined for a virtual model. */
  route?: string
  /** An auto/* id: ForgeBench picks the real model per request, so it has no price of its own. */
  virtual: boolean
  /** Same model, route and price as this listed id; the picker shows only that one. */
  duplicateOf?: string
  tools: boolean
  vision: boolean
  reasoningEfforts?: string[]
  contextWindow?: number
  maxOutput?: number
  promptCacheFormat?: "anthropic"
  /** USD per 1k tokens, as the gateway reports them. */
  inputPer1kUsd?: number
  outputPer1kUsd?: number
}

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
export const effortLevels = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && EFFORT_LEVELS.includes(v)))] : []

const positive = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")
const SLUG = /^[a-z0-9][a-z0-9._:/-]*$/

/**
 * The model's short name. `display_name` when the gateway sends it; an older gateway only has
 * `label`, which is the raw id except for curated rows ("Anthropic: Claude Sonnet 5", maker
 * prefix dropped). `description` is help text and never a name.
 */
function shortName(entry: Record<string, unknown>, id: string): string {
  const display = text(entry.display_name)
  if (display) return display
  const label = text(entry.label)
  return label && label !== id && !SLUG.test(label) ? withoutMaker(label) : id
}

/** "Anthropic: Claude Sonnet 5" -> "Claude Sonnet 5", but "DeepSeek: R1" -> "DeepSeek R1" (same rule as the server). */
function withoutMaker(name: string): string {
  const match = /^([^:]{1,30}):\s+/.exec(name)
  if (!match) return name
  const rest = name.slice(match[0].length)
  const words = rest.replace(/\([^)]*\)/g, "").split(/\s+/).filter(Boolean)
  return words.length >= 2 || /^[A-Z]{3,}/.test(words[0] ?? "") ? rest : `${match[1]} ${rest}`
}

/** Chat models only: embeddings, audio, image, retired or unavailable entries are not pickable. */
export function parseCatalogEntry(value: unknown): CatalogModel | undefined {
  const entry = record(value)
  const id = typeof entry.id === "string" ? entry.id.trim() : ""
  if (!id || entry.kind !== "chat") return undefined
  if (entry.retired === true || entry.available === false) return undefined
  const route = text(entry.route) || undefined
  const name = shortName(entry, id)
  // One bracket per name: "Flash (batch)" + OpenRouter -> "Flash (batch, OpenRouter)".
  const bare = route ? name.replace(new RegExp(`\\s*\\(${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`), "") : name
  const routed = !route ? name : bare.endsWith(")") ? `${bare.slice(0, -1)}, ${route})` : `${bare} (${route})`
  return {
    id,
    name: routed.slice(0, MAX_NAME_LENGTH),
    route,
    virtual: id.startsWith("auto/") || entry.provider === "forgebench",
    duplicateOf: text(entry.duplicate_of) || undefined,
    tools: entry.tool_call !== false,
    vision: entry.vision === true,
    reasoningEfforts: effortLevels(entry.reasoning_efforts),
    contextWindow: positive(entry.context_window),
    maxOutput: positive(entry.max_output_tokens),
    promptCacheFormat: entry.prompt_cache_format === "anthropic" ? "anthropic" : undefined,
    inputPer1kUsd: nonNegative(entry.input_per_1k_usd),
    outputPer1kUsd: nonNegative(entry.output_per_1k_usd),
  }
}

/**
 * First occurrence of an id wins. A row marked `duplicate_of` a listed id is hidden (both stay
 * callable). Names that still collide after the route get their id appended.
 */
export function parseCatalog(entries: unknown): CatalogModel[] {
  const seen = new Set<string>()
  const parsed: CatalogModel[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = parseCatalogEntry(entry)
    if (model && !seen.has(model.id)) { seen.add(model.id); parsed.push(model) }
  }
  const models = parsed.filter((model) => !model.duplicateOf || !seen.has(model.duplicateOf))
  const uses = new Map<string, number>()
  for (const model of models) uses.set(model.name, (uses.get(model.name) ?? 0) + 1)
  for (const model of models) if ((uses.get(model.name) ?? 0) > 1) model.name = `${model.name} · ${model.id}`
  return models
}

export type CatalogFetchOptions = { url: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number }

/** `GET <url>/v1/models`. The key travels only in the Authorization header; errors never carry it or a raw body. */
export async function fetchCatalog({ url, key, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: CatalogFetchOptions) {
  const base = url.trim().replace(/\/+$/, "")
  const response = await fetchImpl(`${base}/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  })
  let body = ""
  try { body = await response.text() } catch {}
  if (!response.ok) {
    let message = `GET /v1/models failed (HTTP ${response.status})`
    if (body.length <= MAX_DETAIL_BODY_LENGTH) {
      let detail: unknown
      try { detail = record(JSON.parse(body)).detail } catch {}
      if (typeof detail === "string" && detail) message = `${message}: ${detail}`
    }
    throw Object.assign(new Error(message), { status: response.status })
  }
  let doc: Record<string, unknown> | undefined
  try { doc = record(JSON.parse(body)) } catch {}
  if (!doc || !Array.isArray(doc.data)) throw new Error("GET /v1/models returned an unreadable catalog")
  return {
    models: parseCatalog(doc.data),
    defaultModel: typeof doc.default_model === "string" ? doc.default_model : undefined,
  }
}
