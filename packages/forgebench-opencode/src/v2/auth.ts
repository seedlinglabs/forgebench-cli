import type { Plugin } from "@opencode/plugin"
import { record } from "../core/json.js"
import { GATEWAY_KEY_ENV, PROVIDER_ID, REPORTING_KEY_ENV } from "./options.js"

type Integration = Pick<Plugin.Context["integration"], "connection">

/** The connection/env/apiKey answer is re-checked at most this often. */
export const CONNECTION_TTL_MS = 30 * 1000
/** Placeholder stored in the secret refresh field when reporting is disabled or was not granted. */
export const LEGACY_REFRESH = "forgebench-gateway-key"

/**
 * The reporting credential: the separate key from the same browser sign-in, held
 * in OpenCode's native credential store (secret `refresh` field). Never reuse a
 * key stored for another deployment. With no Forgebench connection at all, the
 * explicit `FORGEBENCH_API_KEY` override is honoured (headless use); nothing here
 * reads another tool's credential store.
 */
export async function reportingKey(
  integration: Integration | undefined,
  url: string,
  env: () => NodeJS.ProcessEnv = () => process.env,
): Promise<string | undefined> {
  const connection = await integration?.connection?.active(PROVIDER_ID)
  if (!connection) return env()[REPORTING_KEY_ENV]?.trim() || undefined
  const credential = await integration!.connection.resolve(connection)
  if (credential?.type !== "oauth") return undefined
  if (credential.metadata?.url !== url) throw new Error("Forgebench reporting connection belongs to another deployment")
  const key = credential.refresh
  return typeof key === "string" && key.trim() && key !== LEGACY_REFRESH ? key.trim() : undefined
}

const keyOf = (input: unknown): string | undefined => {
  const credential = record(input)
  // OAuth credentials carry the gateway key in `access` (Forgebench keys rotate in
  // the console; there is nothing to refresh). A pasted key arrives as `key`.
  const value = credential.type === "oauth" ? credential.access : credential.type === "key" ? credential.key : undefined
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export type CredentialOptions = {
  url: string; apiKey?: string; integration?: Integration
  env?: () => NodeJS.ProcessEnv; ttlMs?: number; now?: () => number
}

/**
 * One model-credential path, in precedence order:
 *   1. the active OpenCode connection (`/connect`: browser sign-in or pasted key),
 *   2. the static `apiKey` plugin option,
 *   3. `FORGEBENCH_GATEWAY_KEY` from the environment.
 * A missing connection or failed lookup falls through. Answers are cached briefly.
 */
export function createCredentialResolver({ url, apiKey, integration, env = () => process.env, ttlMs = CONNECTION_TTL_MS, now = Date.now }: CredentialOptions) {
  let cached: { key: string; at: number } | null = null
  const resolveCredential = async () => {
    if (cached && now() - cached.at < ttlMs) return cached.key
    let key: string | undefined
    try {
      const connection = integration?.connection ? await integration.connection.active(PROVIDER_ID) : undefined
      if (connection && integration) {
        const credential = await integration.connection.resolve(connection)
        if (credential?.type !== "oauth" || credential.metadata?.url === url) key = keyOf(credential)
      }
    } catch {}
    if (!key && apiKey) key = apiKey.trim()
    if (!key) {
      const fromEnv = env()[GATEWAY_KEY_ENV]
      if (typeof fromEnv === "string" && fromEnv.trim()) key = fromEnv.trim()
    }
    if (key) cached = { key, at: now() }
    return key
  }
  return Object.assign(resolveCredential, { invalidate() { cached = null } })
}
