import { GATEWAY_KEY_ENV, PROVIDER_ID } from "./options.js"
import { createTokenSource } from "./token.js"

/** The connection/env/apiKey answer is re-checked at most this often. */
export const CONNECTION_TTL_MS = 30 * 1000

const keyOf = (credential) => {
  if (!credential || typeof credential !== "object") return undefined
  // OAuth credentials carry the gateway key in `access` (there is nothing to
  // refresh: ForgeBench keys rotate in the console, they never expire).
  const value = credential.type === "oauth" ? credential.access : credential.type === "key" ? credential.key : undefined
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * One credential path for every auth method, in precedence order:
 *   1. the active OpenCode connection (`/connect`: OAuth sign-in or pasted key),
 *   2. the static `apiKey` plugin option,
 *   3. `FORGEBENCH_GATEWAY_KEY` read from the environment,
 *   4. `<executable> gateway token` (the CLI's 0600 key store; existing installs).
 * A missing connection or a failed lookup falls through, so a request never
 * fails because `/connect` is unconfigured. Answers are cached briefly so title
 * and primary requests do not each re-walk the chain.
 */
export function createCredentialResolver({
  url,
  executable,
  apiKey,
  integration,
  token,
  env = () => process.env,
  ttlMs = CONNECTION_TTL_MS,
  now = Date.now,
}) {
  const getToken = executable ? createTokenSource({ executable, url, ...(token ?? {}) }) : undefined
  let cached = null
  return async function resolveCredential() {
    if (cached && now() - cached.at < ttlMs) return cached.key
    let key
    try {
      const connection = integration?.connection ? await integration.connection.active(PROVIDER_ID) : undefined
      if (connection) key = keyOf(await integration.connection.resolve(connection))
    } catch {}
    if (!key && apiKey) key = apiKey.trim()
    if (!key) {
      const fromEnv = env()[GATEWAY_KEY_ENV]
      if (typeof fromEnv === "string" && fromEnv.trim()) key = fromEnv.trim()
    }
    if (!key && getToken) key = await getToken().catch(() => undefined)
    if (key) cached = { key, at: now() }
    return key
  }
}
