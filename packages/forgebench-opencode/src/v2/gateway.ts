import { randomUUID } from "node:crypto"
import type { Plugin, Provider } from "@opencode/plugin"
import { createCredentialResolver } from "./auth.js"
import { CLIENT_REQUEST_HEADER, HARNESS_HEADER, PROVIDER_ID, SESSION_HEADER } from "./options.js"
import type { GatewayOptions } from "./options.js"
import { DEFAULT_TIMEOUT_MS, fetchModels } from "./models.js"
import type { ModelFetchOptions } from "./models.js"

/**
 * How long setup waits for the first catalog before continuing on the fallback list. Cold model
 * selection snapshots the provider as soon as setup finishes, and /v1/models takes 4-6 s on a cold
 * tenant, so this equals the catalog fetch timeout: a slow answer is never abandoned at startup.
 */
export const FIRST_DISCOVERY_MS = DEFAULT_TIMEOUT_MS
/**
 * Background retries after a transient discovery failure (timeout, network, 5xx), so a slow or
 * flapping gateway recovers in-session. A 401/403 is not an error here: fetchModels returns an
 * empty catalog for it, which clears the picker, and the next credential event refreshes.
 */
export const DISCOVERY_RETRY_MS = [5_000, 15_000, 45_000, 120_000]
export type GatewayDependencies = {
  models?: Partial<Omit<ModelFetchOptions, "url" | "key">>
  /** Test seams for the discovery timings above. */
  firstDiscoveryMs?: number
  discoveryRetryMs?: number[]
}
/**
 * Refreshes the model list after a credential event. `credentialChanged` (default true) hides the
 * previous account's list until the current key answers; `dispose` stops pending retries.
 */
export type ModelRefresh = ((credentialChanged?: boolean) => Promise<void>) & { dispose(): void }
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
): Promise<ModelRefresh> {
  const state = { models: gateway.models, conflict: false }
  const baseURL = `${gateway.url}/v1`
  const resolveCredential = createCredentialResolver({ url: gateway.url, apiKey: gateway.apiKey, integration: ctx.integration })

  const providerInfo: Provider.Info = {
    id: PROVIDER_ID,
    name: "Forgebench Gateway",
    activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL },
    // No `apiKey` in settings: credentials are set on each physical HTTP send.
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

  let lastCatalog: { key: string; models: GatewayOptions["models"] } | undefined
  // The configured fallback belongs to the key in use at startup, and only until the gateway answers
  // for that key (a catalog, empty, or 401/403): after a switch to another key, or after that answer,
  // it is never shown again, and only a key's confirmed catalog can be restored.
  let fallbackKey: string | undefined
  let fallbackSpent = false
  const discover = async () => {
    if (state.conflict) return
    const generation = resolveCredential.generation()
    const credential = await resolveCredential()
    if (generation !== resolveCredential.generation()) return
    if (lastCatalog && lastCatalog.key !== credential) {
      lastCatalog = undefined
      state.models = []
      await ctx.provider.reload?.()
    }
    if (!credential) return
    fallbackKey ??= credential
    // A transient failure restores what belongs to this key (its last catalog, or the configured
    // fallback while it is still the startup key) and is rethrown so refreshModels schedules a
    // bounded retry. 401/403 arrive as an empty catalog.
    let failure: unknown
    const models = await fetchModels({ url: gateway.url, key: credential, ...(deps.models ?? {}) })
      .then(catalog => catalog.models, (error: unknown) => {
        failure = error ?? new Error("catalog fetch failed")
        return lastCatalog?.models ?? (credential === fallbackKey && !fallbackSpent ? gateway.models : undefined)
      })
    if (generation !== resolveCredential.generation() || state.conflict) return
    if (!failure && credential === fallbackKey) fallbackSpent = true
    if (models) {
      lastCatalog = { key: credential, models }
      state.models = models
      await ctx.provider.reload?.()
    }
    if (failure) throw failure
  }
  let inflight: Promise<void> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let disposed = false
  const retryDelays = deps.discoveryRetryMs ?? DISCOVERY_RETRY_MS
  const scheduleRetry = () => {
    if (disposed || retryTimer || attempt >= retryDelays.length) return
    retryTimer = setTimeout(() => { retryTimer = undefined; void refreshModels() }, retryDelays[attempt++])
    retryTimer.unref?.()
  }
  const refreshModels = (): Promise<void> => {
    if (inflight) return inflight
    inflight = discover()
      .then(() => { attempt = 0 }, () => scheduleRetry())
      .finally(() => { inflight = undefined })
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

  await ctx.session.hook(
    "http.request",
    async (event) => {
      if (event.model?.providerID !== PROVIDER_ID) return
      event.request.headers.delete("authorization")
      if (state.conflict || !sameOrigin(event.request.url, gateway.url)) return
      const generation = resolveCredential.generation()
      const credential = await resolveCredential().catch(() => undefined)
      if (credential && generation === resolveCredential.generation()) event.request.headers.set("authorization", `Bearer ${credential}`)
    },
    { providerID: PROVIDER_ID },
  )
  await ctx.session.hook(
    "retry",
    async (event) => {
      if (state.conflict || event.model?.providerID !== PROVIDER_ID || event.error?.status !== 401 || event.attempt !== 2) return
      const generation = resolveCredential.generation()
      const credential = await resolveCredential.refresh().catch(() => undefined)
      if (credential && generation === resolveCredential.generation()) event.decision = { retry: true, delay: 0 }
    },
    { providerID: PROVIDER_ID },
  )

  // Cold model selection snapshots the provider as soon as setup finishes.
  // Give discovery its catalog deadline before exposing the fallback list.
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      refreshModels(),
      new Promise<void>((resolve) => {
        startupTimer = setTimeout(resolve, deps.firstDiscoveryMs ?? deps.models?.timeoutMs ?? FIRST_DISCOVERY_MS)
        startupTimer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(startupTimer)
  }
  // A credential event: the cached key may be the one that was just replaced or removed.
  return Object.assign(
    async (credentialChanged = true) => {
      resolveCredential.invalidate()
      // Hide whatever is shown (a catalog or the configured fallback) until the current key answers.
      if (credentialChanged && state.models.length) {
        state.models = []
        await ctx.provider.reload?.()
      }
      await inflight
      // After the old discovery settles: its failure may have armed a retry for the old key.
      clearTimeout(retryTimer)
      retryTimer = undefined
      attempt = 0
      await refreshModels()
    },
    { dispose() { disposed = true; clearTimeout(retryTimer); retryTimer = undefined } },
  )
}
