import { PROVIDER_ID } from "./options.js"

export const DEFAULT_CONTEXT = 200000
export const DEFAULT_OUTPUT = 32000
export const DEFAULT_TIMEOUT_MS = 15_000

const MAX_NAME_LENGTH = 120
// `detail` is included only for tiny error bodies, never for a full page.
const MAX_DETAIL_BODY_LENGTH = 200

const positive = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0

/**
 * One gateway catalog entry -> an OpenCode `Model.Info`, the same shape as the
 * static option mapping in `options.js`. Chat models only: everything else
 * (embeddings, audio, image, retired or unavailable) is not pickable here.
 * Server costs are USD per 1k tokens; OpenCode costs are USD per million.
 */
export function fromCatalog(entry) {
  if (!entry || typeof entry !== "object") return undefined
  const id = typeof entry.id === "string" ? entry.id.trim() : ""
  if (!id) return undefined
  if (entry.kind !== "chat") return undefined
  if (entry.retired === true || entry.available === false) return undefined
  const described = typeof entry.description === "string" ? entry.description.trim() : ""
  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: described ? described.slice(0, MAX_NAME_LENGTH) : id,
    capabilities: {
      tools: entry.tool_call !== false,
      input: entry.vision === true ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: finiteNonNegative(entry.input_per_1k_usd) && finiteNonNegative(entry.output_per_1k_usd)
      ? [{ input: entry.input_per_1k_usd * 1000, output: entry.output_per_1k_usd * 1000, cache: { read: 0, write: 0 } }]
      : [],
    status: "active",
    enabled: true,
    limit: {
      context: positive(entry.context_window) ?? DEFAULT_CONTEXT,
      output: positive(entry.max_output_tokens) ?? DEFAULT_OUTPUT,
    },
  }
}

/** Catalog entries -> the pickable models. First occurrence of an id wins. */
export function toCatalog(entries) {
  const seen = new Set()
  const models = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = fromCatalog(entry)
    if (model && !seen.has(model.id)) {
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/**
 * The live model catalog from the gateway (`GET <url>/v1/models`, Bearer = a
 * ForgeBench `sk_` gateway key). The key only ever travels in the Authorization
 * header; no error message contains it, stdout, or a raw body.
 */
export async function fetchModels({ url, key, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : ""
  const response = await fetchImpl(`${base}/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body = ""
  try {
    body = await response.text()
  } catch {
    body = ""
  }
  if (!response.ok) {
    let message = `GET /v1/models failed (HTTP ${response.status})`
    if (body.length <= MAX_DETAIL_BODY_LENGTH) {
      let detail
      try {
        detail = JSON.parse(body)?.detail
      } catch {
        detail = undefined
      }
      if (typeof detail === "string" && detail) message = `${message}: ${detail}`
    }
    throw new Error(message)
  }
  let doc
  try {
    doc = JSON.parse(body)
  } catch {
    doc = undefined
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.data)) {
    throw new Error("GET /v1/models returned an unreadable catalog")
  }
  return {
    models: toCatalog(doc.data),
    defaultModel: typeof doc.default_model === "string" ? doc.default_model : undefined,
  }
}
