import { PROVIDER_ID, SESSION_HEADER, resolveOptions } from "./options.js"
import { createSyncRunner, SYNC_EVENT } from "./sync.js"
import { createTokenSource } from "./token.js"

export const PLUGIN_ID = "forgebench"

/** Each slice registers only when its flag is on; with all flags off this does nothing. */
export async function setup(ctx, deps = {}) {
  const { gateway, sync, mcp } = resolveOptions(ctx.options)

  if (gateway) {
    // No `apiKey`: the key is set per HTTP send in `http.request` below.
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: PROVIDER_ID,
          name: "Forgebench Gateway",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${gateway.url}/v1` },
          headers: gateway.headers,
        },
        models: gateway.models,
      })
    })
    const getToken = createTokenSource({ executable: gateway.executable, url: gateway.url, ...deps.token })
    await ctx.session.hook(
      "model.request",
      async (event) => {
        if (event.model?.providerID !== PROVIDER_ID) return
        for (const name of Object.keys(event.headers)) {
          if (name.toLowerCase() === "authorization") delete event.headers[name]
        }
        if (typeof event.sessionID === "string") event.headers[SESSION_HEADER] = event.sessionID
      },
      { providerID: PROVIDER_ID },
    )
    // The key goes on each physical send, not the prepared request: compaction retries resend
    // the request `model.request` prepared once, so a key set there would stay stale after a 401.
    await ctx.session.hook(
      "http.request",
      async (event) => {
        if (event.model?.providerID !== PROVIDER_ID) return
        event.request.headers.delete("authorization")
        // Without a last good key, send no Authorization: the gateway answers 401.
        const token = await getToken().catch(() => undefined)
        if (token) event.request.headers.set("authorization", `Bearer ${token}`)
      },
      { providerID: PROVIDER_ID },
    )
    await ctx.session.hook(
      "retry",
      async (event) => {
        if (event.error?.status !== 401 || event.attempt !== 2) return
        // No fresh key means the retry would only earn a second 401.
        if (await getToken.refresh().catch(() => undefined)) event.decision = { retry: true, delay: 0 }
      },
      { providerID: PROVIDER_ID },
    )
  }

  if (mcp) {
    await ctx.mcp.transform((editor) => {
      editor.set("forgebench", { type: "remote", url: mcp.url, oauth: {} })
    })
  }

  if (!sync) return undefined
  const runSync = createSyncRunner({ ...sync, ...deps.sync })
  const stop = new AbortController()
  ;(async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      if (SYNC_EVENT.test(event.type)) runSync()
    }
  })().catch(() => {})
  return () => stop.abort()
}
