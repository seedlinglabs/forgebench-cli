import { record } from "./json.js"

export const DEFAULT_TIMEOUT_MS = 15_000
const MAX_NAME_LENGTH = 120
// `detail` is included only for tiny error bodies, never for a full page.
const MAX_DETAIL_BODY_LENGTH = 200

/** Runtime-neutral view of one gateway catalog entry; each adapter maps it to its host's model type. */
export type CatalogModel = {
  id: string
  name: string
  tools: boolean
  vision: boolean
  contextWindow?: number
  maxOutput?: number
  /** USD per 1k tokens, as the gateway reports them. */
  inputPer1kUsd?: number
  outputPer1kUsd?: number
}

const positive = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/** Chat models only: embeddings, audio, image, retired or unavailable entries are not pickable. */
export function parseCatalogEntry(value: unknown): CatalogModel | undefined {
  const entry = record(value)
  const id = typeof entry.id === "string" ? entry.id.trim() : ""
  if (!id || entry.kind !== "chat") return undefined
  if (entry.retired === true || entry.available === false) return undefined
  const described = typeof entry.description === "string" ? entry.description.trim() : ""
  return {
    id,
    name: described ? described.slice(0, MAX_NAME_LENGTH) : id,
    tools: entry.tool_call !== false,
    vision: entry.vision === true,
    contextWindow: positive(entry.context_window),
    maxOutput: positive(entry.max_output_tokens),
    inputPer1kUsd: nonNegative(entry.input_per_1k_usd),
    outputPer1kUsd: nonNegative(entry.output_per_1k_usd),
  }
}

/** First occurrence of an id wins. */
export function parseCatalog(entries: unknown): CatalogModel[] {
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = parseCatalogEntry(entry)
    if (model && !seen.has(model.id)) { seen.add(model.id); models.push(model) }
  }
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
