import { createCredentialResolver } from "./auth.js"
import { PROVIDER_ID, SESSION_HEADER, resolveOptions } from "./options.js"
import { fetchModels } from "./models.js"
import { startSignIn } from "./oauth.js"
import { createSyncRunner, SYNC_EVENT } from "./sync.js"

export const PLUGIN_ID = "forgebench"
const OAUTH_METHOD_ID = "oauth"
// Credential events that can change the key or the catalog; the platform emits
// these when `/connect` adds a connection or the active connection is switched.
const REFRESH_EVENT = /^(credential\.(updated|switched)|integration\.updated)$/
// Nothing to refresh: a ForgeBench gateway key is static until rotated; the
// refresh callback just confirms the (long-lived) credential and stores nothing.
const OAUTH_EXPIRES_IN_MS = 10 * 365 * 24 * 60 * 60 * 1000
/** How long setup may block on the first model discovery before falling back to options.models. */
const FIRST_DISCOVERY_MS = 15000

/** Each slice registers only when its flag is on; with all flags off this does nothing. */
export async function setup(ctx, deps = {}) {
  const { gateway, sync, mcp } = resolveOptions(ctx.options)
  if (!gateway && !sync && !mcp) return undefined

  let runSync
  if (sync) runSync = createSyncRunner({ ...sync, ...deps.sync })

  // --- gateway slice ---------------------------------------------------------
  let discover
  if (gateway) {
    // One provider-registering transform, re-run on every `provider.reload()`;
    // it always writes the CURRENT `state.models`, so discovery swaps the list
    // without a second registration.
    const state = { models: gateway.models }
    const resolveCredential = createCredentialResolver({
      url: gateway.url,
      executable: gateway.executable,
      apiKey: gateway.apiKey,
      integration: ctx.integration,
      token: deps.token,
    })

    const providerInfo = {
      id: PROVIDER_ID,
      name: "Forgebench Gateway",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${gateway.url}/v1` },
      // No `apiKey` in settings: setting it overrides the `Authorization` set in `model.request`.
      headers: gateway.headers,
    }
    await ctx.provider.transform((editor) => {
      if (!editor.get?.(PROVIDER_ID)) {
        editor.add({
          info: { ...providerInfo, settings: { ...providerInfo.settings }, headers: { ...providerInfo.headers } },
          models: state.models,
        })
      } else {
        editor.update(PROVIDER_ID, (provider) => {
          provider.settings = { ...providerInfo.settings }
          provider.headers = { ...providerInfo.headers }
          provider.activation = "enabled"
        })
      }
      // Authoritative source definitions for THIS provider only.
      editor.models.set(PROVIDER_ID, state.models)
    })

    discover = async () => {
      const credential = await resolveCredential()
      if (!credential) return
      const catalog = await fetchModels({ url: gateway.url, key: credential, ...(deps.models ?? {}) })
      if (!catalog.models.length) return
      state.models = catalog.models
      await ctx.provider.reload?.()
    }
    let inflight
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
        // On failure send no Authorization: the gateway answers 401 and the
        // next request re-walks the credential chain.
        const credential = await resolveCredential()
        if (credential) event.headers.authorization = `Bearer ${credential}`
        if (typeof event.sessionID === "string") event.headers[SESSION_HEADER] = event.sessionID
      },
      { providerID: PROVIDER_ID },
    )

    // <connect> methods. `authorize` runs the two-stage browser sign-in and its
    // promise resolves with the transferred gateway key; the key method simply
    // accepts a pasted `sk_...` key. Both land in OpenCode's credential store.
    if (gateway.auth !== "none") {
      await ctx.integration.transform((editor) => {
        if (gateway.auth === "auto" || gateway.auth === "oauth") {
          editor.method.update({
            integrationID: PROVIDER_ID,
            method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with ForgeBench" },
            async authorize() {
              const session = await (deps.oauth?.startSignIn ?? startSignIn)({
                url: gateway.url,
                ...(deps.oauth ?? {}),
              })
              // The host opens `session.url`; the loopback server redirects the
              // same tab through the consent page (it is already signed in).
              return {
                url: session.url,
                instructions: "Sign in to ForgeBench in the browser that opens, then approve the model-authorization screen. You can close the tab when ForgeBench says you are connected.",
                mode: "auto",
                callback: session.promise.then((granted) => ({
                  type: "oauth",
                  methodID: OAUTH_METHOD_ID,
                  refresh: "forgebench-gateway-key",
                  access: granted.access,
                  expires: Date.now() + OAUTH_EXPIRES_IN_MS,
                  metadata: {
                    url: gateway.url,
                    name: granted.name ?? undefined,
                    prefix: granted.prefix ?? undefined,
                  },
                })),
              }
            },
            async refresh(credential) {
              return credential
            },
            label(credential) {
              return credential?.metadata?.name ? `ForgeBench · ${credential.metadata.name}` : undefined
            },
          })
        }
        if (gateway.auth === "auto" || gateway.auth === "key") {
          editor.method.update({
            integrationID: PROVIDER_ID,
            method: { type: "key", label: "ForgeBench gateway key" },
          })
        }
      })
    }

    // First catalog read, raced with a short timeout: with no reachable
    // gateway (or no credential yet) the setup continues on the fallback list.
    await Promise.race([
      refreshModels(),
      new Promise((resolve) => setTimeout(resolve, FIRST_DISCOVERY_MS).unref?.()),
    ])
  }

  if (mcp) {
    await ctx.mcp.transform((editor) => {
      editor.set("forgebench", { type: "remote", url: mcp.url, oauth: {} })
    })
  }

  // --- shared event loop (sync + model refresh) ------------------------------
  if (!runSync && !discover) return undefined
  const stop = new AbortController()
  ;(async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      const type = event?.type ?? ""
      if (runSync && SYNC_EVENT.test(type)) runSync()
      if (discover && REFRESH_EVENT.test(type)) discover()
    }
  })().catch(() => {})

  return () => stop.abort()
}
