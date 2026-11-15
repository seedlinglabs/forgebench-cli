import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { record } from "../core/json.js"
import { createCredentialResolver } from "./auth.js"
import type { GatewayOptions } from "./options.js"

const ID = /^ses_[A-Za-z0-9_-]{1,120}$/
const START = "<forgebench-opencode>"

/** Context is owned by OpenCode, never the subscription gateway. A promise is
 * installed before awaiting network I/O so concurrent first turns share one pin.
 * Storage survives plugin restart; failures pin identity only rather than changing a
 * cached prefix on a later turn. New sessions can recover from a failed fetch. */
export async function registerClaudeContext(ctx: Plugin.Context, gateway: GatewayOptions) {
  const credential = createCredentialResolver({ ...gateway, integration: ctx.integration })
  const pending = new Map<string, Promise<string>>()
  const pin = (key: string, load: () => Promise<string>): Promise<string> => {
    const active = pending.get(key)
    if (active) return active
    // Bound active-session memory. Refuse new contexts rather than evicting a pin.
    if (pending.size >= 4096) return Promise.resolve("")
    const result = (async () => {
      const stored = await ctx.storage.get(key).catch(() => "")
      if (typeof stored === "string" && stored) return stored
      const value = await load().catch(() => "")
      await ctx.storage.set(key, value).catch(() => {})
      return value
    })()
    pending.set(key, result)
    return result
  }
  return ctx.session.hook("context", async (input) => {
    if (input.model.providerID !== "claude-agent" || !ID.test(input.sessionID)) return
    try {
      const key = await credential()
      if (!key) return
      const scope = createHash("sha256").update(gateway.url + "\0" + key).digest("hex")
      const block = await pin(`claude-context:${scope}:${input.sessionID}`, async () => {
        const session = await ctx.session.get({ sessionID: input.sessionID })
        const parent = session.parentID
        if (parent && !ID.test(parent)) return ""
        const identity = (version: number | "-", advice = "") =>
          `${START}\nForgeBench-OpenCode: session=${input.sessionID} parent=${parent ?? "-"} policy=${version}\n${parent || !advice ? "" : advice + "\n"}</forgebench-opencode>`
        try {
          const response = await fetch(`${gateway.url}/v1/meta-harness/effective?harness=opencode`, {
            headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000), redirect: "error",
          })
          if (!response.ok) return identity("-")
          const policy = record(await response.json())
          if (!["advise", "enforce"].includes(String(policy.mode)) || !Number.isSafeInteger(policy.version) || Number(policy.version) < 1) return identity("-")
          const advice = record(policy.advice)
          if (typeof advice.text !== "string" || advice.text.length > 65536) return identity("-")
          return identity(Number(policy.version), advice.text)
        } catch { return identity("-") }
      })
      if (!block) return
      if (!input.system.some(p => p.text.includes(START))) input.system.push({ type: "text", text: block })
      // The built-in Claude plugin snapshots system parts into this provider
      // option. If it ran first, update its snapshot too; if it runs later,
      // it reads the appended system part. Both hook orders deliver one block.
      const instructions = input.options.claudeCodeInstructions
      if (typeof instructions === "string" && !instructions.includes(START)) {
        input.options.claudeCodeInstructions = instructions ? `${instructions}\n\n${block}` : block
      }
    } catch { /* Context failure must never prevent the user's Claude turn. */ }
  }, { providerID: "claude-agent" })
}
