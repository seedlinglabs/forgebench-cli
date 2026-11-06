import type { Model, Provider } from "@opencode/plugin"
import { record, str } from "../core/json.js"
import { resolveCoreOptions } from "../core/options.js"
import type { CoreOptions } from "../core/options.js"

export { CLIENT_REQUEST_HEADER, GATEWAY_KEY_ENV, HARNESS_HEADER, REPORTING_KEY_ENV, SESSION_HEADER } from "../core/options.js"
export type { AuthMode } from "../core/options.js"
export const PROVIDER_ID = "forgebench" as Provider.ID

/** One plugin-option fallback model entry -> the OpenCode `Model.Info`. */
export function model(entry: unknown): Model.Info | undefined {
  const raw = typeof entry === "string" ? { id: entry } : record(entry)
  const id = str(raw.id)
  if (!id) return undefined
  return {
    id: id as Model.ID,
    modelID: id as Model.ID,
    providerID: PROVIDER_ID,
    name: str(raw.name) ?? id,
    capabilities: {
      tools: raw.tools !== false,
      input: Array.isArray(raw.input) ? raw.input.filter((value): value is "text" | "image" | "audio" | "video" | "pdf" => ["text", "image", "audio", "video", "pdf"].includes(String(value))) : ["text", "image"],
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

export type ResolvedOptions = Omit<CoreOptions, "gateway"> & {
  gateway?: Omit<NonNullable<CoreOptions["gateway"]>, "models"> & { url: string; models: Model.Info[] }
}

/**
 * Plugin options -> the resolved config. Features default on; explicit false disables them.
 * Gateway credential order (v2/auth.ts): OpenCode connection, `apiKey` option, then the
 * `FORGEBENCH_GATEWAY_KEY` environment variable. `auth` picks which `/connect` methods are
 * offered. The hosted deployment is used unless `url` overrides it.
 */
export function resolveOptions(options: unknown): ResolvedOptions {
  const core = resolveCoreOptions(options)
  const { gateway, ...rest } = core
  return {
    ...rest,
    ...(gateway && core.url ? {
      gateway: { ...gateway, url: core.url, models: gateway.models.map(model).filter((value): value is Model.Info => value !== undefined) },
    } : {}),
  }
}

export type GatewayOptions = NonNullable<ResolvedOptions["gateway"]>
export type ReportingOptions = NonNullable<ResolvedOptions["reporting"]>
