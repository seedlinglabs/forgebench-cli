import { randomUUID } from "node:crypto"
import type { Plugin, Provider } from "@opencode/plugin"
import { createCredentialResolver } from "./auth.js"
import { CLIENT_REQUEST_HEADER, HARNESS_HEADER, PROVIDER_ID, SESSION_HEADER } from "./options.js"
import type { GatewayOptions } from "./options.js"
import { fetchModels } from "./models.js"
import type { ModelFetchOptions } from "./models.js"

const FIRST_DISCOVERY_MS = 3000
export type GatewayDependencies = {
  models?: Partial<Omit<ModelFetchOptions, "url" | "key">>
}
export type GatewayHooks = {
  /** Called when an existing user definition differs from the Forgebench deployment; it is left untouched. */
  onConflict?: (what: "provider") => void
}

const DELEGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRINTABLE = /^[\x21-\x7e]{1,128}$/
const PARENT_HARNESSES = new Set(["claude_code", "opencode", "codex"])
const ROLES = new Set(["explore", "plan", "implement", "review", "test", "debug", "docs"])

/**
 * Attribution for a child started by `forgebench delegate run`, from the variables it exports.
 * Attribution only: the gateway re-applies the key's permissions and treats the run as delegated.
 */
export function delegationHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const id = env.FORGEBENCH_DELEGATION_ID
  if (!id || !DELEGATION_ID.test(id)) return {}
  const headers: Record<string, string> = { [HARNESS_HEADER]: "opencode", "X-Forgebench-Delegation-Id": id }
  const parent = env.FORGEBENCH_PARENT_HARNESS
  if (parent && PARENT_HARNESSES.has(parent)) headers["X-Forgebench-Parent-Harness"] = parent
  const session = env.FORGEBENCH_PARENT_SESSION_ID
  if (session && PRINTABLE.test(session)) headers["X-Forgebench-Parent-Session-Id"] = session
  const role = env.FORGEBENCH_ROLE
  if (role && ROLES.has(role)) headers["X-Forgebench-Role"] = role
  return headers
}

const sameOrigin = (candidate: string | undefined, base: string) =>
  candidate !== undefined && (candidate === base || candidate.startsWith(`${base}/`))

/**
 * Own the provider, governed request headers and its discoverable model catalog.
 * A pre-existing `forgebench` provider that points anywhere else is user config:
 * it is not modified and never receives the Forgebench credential.
 */
export async function registerGateway(
  ctx: Pick<Plugin.Context, "provider" | "session" | "integration">,
  gateway: GatewayOptions,
  deps: GatewayDependencies = {},
  hooks: GatewayHooks = {},
): Promise<() => Promise<void>> {
  const state = { models: gateway.models, conflict: false }
  const baseURL = `${gateway.url}/v1`
  const resolveCredential = createCredentialResolver({ url: gateway.url, apiKey: gateway.apiKey, integration: ctx.integration })

  const providerInfo: Provider.Info = {
    id: PROVIDER_ID,
    name: "Forgebench Gateway",
    activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL },
    // No `apiKey` in settings: setting it overrides the `Authorization` set in `model.request`.
    headers: gateway.headers,
  }
  await ctx.provider.transform((editor) => {
    const existing = editor.get?.(PROVIDER_ID)
    if (!existing) {
      state.conflict = false
      editor.add({
        info: { ...providerInfo, settings: { ...providerInfo.settings }, headers: { ...providerInfo.headers } },
        models: state.models,
      })
    } else {
      const theirs = (existing.provider?.settings as { baseURL?: unknown } | undefined)?.baseURL
      if (typeof theirs === "string" && !sameOrigin(theirs.replace(/\/+$/, ""), gateway.url)) {
        if (!state.conflict) hooks.onConflict?.("provider")
        state.conflict = true
        return
      }
      state.conflict = false
      editor.update(PROVIDER_ID, (provider) => {
        provider.settings = { ...provider.settings, baseURL }
        provider.headers = { ...providerInfo.headers, ...provider.headers }
        provider.activation = "enabled"
      })
    }
    // Authoritative source definitions for THIS provider only.
    editor.models.set(PROVIDER_ID, state.models)
  })

  const discover = async () => {
    if (state.conflict) return
    const credential = await resolveCredential()
    if (!credential) return
    const catalog = await fetchModels({ url: gateway.url, key: credential, ...(deps.models ?? {}) })
    if (!catalog.models.length) return
    state.models = catalog.models
    await ctx.provider.reload?.()
  }
  let inflight: Promise<void> | undefined
  const refreshModels = () => {
    if (inflight) return inflight
    inflight = discover().catch(() => {}).finally(() => { inflight = undefined })
    return inflight
  }

  await ctx.session.hook(
    "model.request",
    async (event) => {
      if (event.model?.providerID !== PROVIDER_ID) return
      for (const name of Object.keys(event.headers)) {
        if (name.toLowerCase() === "authorization") delete event.headers[name]
      }
      // Never attach the Forgebench key to a request headed anywhere else.
      if (state.conflict || (event.baseURL !== undefined && !sameOrigin(event.baseURL.replace(/\/+$/, ""), gateway.url))) return
      // On failure send no Authorization: the gateway answers 401 and the next request re-walks the chain.
      const credential = await resolveCredential()
      if (credential) event.headers.authorization = `Bearer ${credential}`
      if (typeof event.sessionID === "string") event.headers[SESSION_HEADER] = event.sessionID
      // OpenCode v2 exposes the active agent here but does not send its name upstream.
      for (const name of Object.keys(event.headers)) {
        if (name.toLowerCase() === "x-opencode-agent") delete event.headers[name]
      }
      if (typeof event.agent === "string" && PRINTABLE.test(event.agent)) {
        event.headers["x-opencode-agent"] = event.agent
      }
      for (const [name, value] of Object.entries(delegationHeaders())) {
        for (const existing of Object.keys(event.headers)) {
          if (existing.toLowerCase() === name.toLowerCase()) delete event.headers[existing]
        }
        event.headers[name] = value
      }
      if (!Object.keys(event.headers).some((name) => name.toLowerCase() === CLIENT_REQUEST_HEADER.toLowerCase())) {
        event.headers[CLIENT_REQUEST_HEADER] = randomUUID()
      }
    },
    { providerID: PROVIDER_ID },
  )

  // First catalog read, raced with a short timeout: with no reachable gateway
  // (or no credential yet) setup continues on the fallback list.
  await Promise.race([
    refreshModels(),
    new Promise((resolve) => setTimeout(resolve, FIRST_DISCOVERY_MS).unref?.()),
  ])
  // A credential event: the cached key may be the one that was just replaced or removed.
  return async () => {
    resolveCredential.invalidate()
    await inflight
    await refreshModels()
  }
}
