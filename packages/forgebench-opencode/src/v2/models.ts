import type { Model } from "@opencode/plugin"
import { fetchCatalog, parseCatalog, parseCatalogEntry } from "../core/catalog.js"
import type { CatalogFetchOptions, CatalogModel } from "../core/catalog.js"
import { effortVariants, PROVIDER_ID } from "./options.js"

export { DEFAULT_TIMEOUT_MS } from "../core/catalog.js"
export const DEFAULT_CONTEXT = 200000
export const DEFAULT_OUTPUT = 32000

type Price = Model.Info["cost"][number]["input"]
const price = (value: number): Price => value as Price

/** Server costs are USD per 1k tokens; OpenCode costs are USD per million. */
export function toModelInfo(entry: CatalogModel): Model.Info {
  const id = entry.id as Model.ID
  return {
    id, modelID: id, providerID: PROVIDER_ID, name: entry.name,
    capabilities: { tools: entry.tools, input: entry.vision ? ["text", "image"] : ["text"], output: ["text"] },
    variants: effortVariants(entry.reasoningEfforts),
    time: { released: 0 },
    cost: entry.inputPer1kUsd !== undefined && entry.outputPer1kUsd !== undefined
      ? [{ input: price(entry.inputPer1kUsd * 1000), output: price(entry.outputPer1kUsd * 1000), cache: { read: price(0), write: price(0) } }]
      : [],
    status: "active",
    enabled: true,
    limit: { context: entry.contextWindow ?? DEFAULT_CONTEXT, output: entry.maxOutput ?? DEFAULT_OUTPUT },
  }
}

export const fromCatalog = (value: unknown): Model.Info | undefined => {
  const entry = parseCatalogEntry(value)
  return entry ? toModelInfo(entry) : undefined
}
export const toCatalog = (entries: unknown): Model.Info[] => parseCatalog(entries).map(toModelInfo)

export type ModelFetchOptions = CatalogFetchOptions
export async function fetchModels(options: ModelFetchOptions) {
  const catalog = await fetchCatalog(options)
  return { models: catalog.models.map(toModelInfo), defaultModel: catalog.defaultModel }
}
