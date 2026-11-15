import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"

/**
 * Stable per-install id kept in this plugin's private OpenCode storage. It names the
 * `opencode-<id>` server-side key row and the `device_id` of every report; it is
 * deliberately unrelated to any other Forgebench client's identifier.
 */
export function createInstallId(storage: Pick<Plugin.Context["storage"], "get" | "set">): () => Promise<string> {
  let pending: Promise<string> | undefined
  return () => (pending ??= (async () => {
    const saved = await storage.get("device-id")
    if (typeof saved === "string" && /^[A-Za-z0-9-]{1,48}$/.test(saved)) return saved
    const id = randomUUID()
    await storage.set("device-id", id)
    return id
  })())
}
