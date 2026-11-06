import { createRequire } from "node:module"
import type { Plugin } from "@opencode/plugin"
import { registerGateway } from "./gateway.js"
import type { GatewayDependencies } from "./gateway.js"
import { registerOnboarding } from "./onboarding.js"
import type { OnboardingDependencies } from "./onboarding.js"
import { resolveOptions } from "./options.js"
import { createInstallId } from "./identity.js"
import { createReporting } from "./reporting.js"
import type { ReportingDependencies } from "./reporting.js"

export const PLUGIN_ID = "forgebench"
const REFRESH_EVENT = /^(credential\.(updated|switched|removed)|integration\.updated)$/
export type PluginDependencies = GatewayDependencies & {
  oauth?: OnboardingDependencies
  reporting?: ReportingDependencies
}

function packageVersion(): string {
  try { return String((createRequire(import.meta.url)("../../package.json") as { version?: unknown }).version ?? "0.0.0") } catch { return "0.0.0" }
}

/**
 * V2 adapter: composes independent features, each failing closed on its own.
 * The plugin is self-contained. It never installs, locates, reads credentials
 * from, or spawns the Forgebench CLI; the CLI is an optional manager only.
 */
export async function setup(ctx: Plugin.Context, deps: PluginDependencies = {}): Promise<Plugin.Cleanup | void> {
  const resolved = resolveOptions(ctx.options)
  // A malformed or non-https deployment url disables every network feature (fail closed).
  if (resolved.urlError || !resolved.url) { await ctx.storage.set("config-error", "invalid-url").catch(() => {}); return }
  const { gateway, reporting, mcp } = resolved
  if (!gateway && !reporting && !mcp) return

  const installId = deps.reporting?.installId ?? createInstallId(ctx.storage)
  const conflicts = (what: string) => { void ctx.storage.set(`config-conflict:${what}`, true).catch(() => {}) }

  let refreshModels: (() => Promise<void>) | undefined
  if (gateway) {
    refreshModels = await registerGateway(ctx, gateway, deps, { onConflict: conflicts })
    await registerOnboarding(ctx.integration, gateway, reporting !== undefined, installId, deps.oauth)
  }
  if (mcp) {
    await ctx.mcp.transform((editor) => {
      const existing = editor.get("forgebench")
      // An existing `forgebench` MCP entry is user config: leave it exactly as it is.
      if (existing) { if (existing.type !== "remote" || existing.url !== mcp.url) conflicts("mcp"); return }
      editor.set("forgebench", { type: "remote", url: mcp.url, oauth: { client_id: "forgebench-opencode" } })
    })
  }

  const report = reporting
    ? createReporting(ctx, { ...reporting, url: resolved.url }, { sdkVersion: packageVersion(), installId, ...deps.reporting })
    : undefined
  await report?.registerToolHooks()
  if (!report && !refreshModels) return
  const stop = new AbortController()
  const subscription = (async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      report?.observe(event)
      if (REFRESH_EVENT.test(event.type)) {
        if (refreshModels) void refreshModels()
        void report?.credentialChanged()
      }
    }
  })().catch(() => {})
  return async () => {
    stop.abort()
    await subscription
    await report?.flush()
    report?.dispose()
  }
}
