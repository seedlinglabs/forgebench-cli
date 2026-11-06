import type { Credential, Plugin } from "@opencode/plugin"
import { startSignIn } from "../core/oauth.js"
import type { SignInOptions } from "../core/oauth.js"
import { LEGACY_REFRESH } from "./auth.js"
import { PROVIDER_ID } from "./options.js"
import type { GatewayOptions } from "./options.js"

const OAUTH_METHOD_ID = "oauth"
const OAUTH_EXPIRES_IN_MS = 10 * 365 * 24 * 60 * 60 * 1000
export type OnboardingDependencies = Partial<Omit<SignInOptions, "url" | "installId">> & { startSignIn?: typeof startSignIn }

/** The model key of the active Forgebench connection on this deployment, kept when a reconnect grants reporting only. */
async function currentAccess(integration: Plugin.Context["integration"], url: string) {
  const connection = await integration.connection.active(PROVIDER_ID)
  if (!connection) return undefined
  const credential = await integration.connection.resolve(connection)
  if (credential?.type === "oauth" && credential.metadata?.url === url && credential.access?.trim()) {
    const meta = credential.metadata
    return {
      access: credential.access.trim(),
      name: typeof meta?.name === "string" ? meta.name : undefined,
      prefix: typeof meta?.prefix === "string" ? meta.prefix : undefined,
    }
  }
  if (credential?.type === "key" && credential.key?.trim()) return { access: credential.key.trim() }
  return undefined
}

/**
 * Registers OpenCode's native `/connect` methods. Browser sign-in stores two
 * distinct grants in OpenCode's own credential store: the model key (`access`)
 * and the reporting key (secret `refresh`). Nothing here installs, locates or
 * runs any Forgebench program.
 */
export async function registerOnboarding(
  integration: Plugin.Context["integration"],
  gateway: GatewayOptions,
  reportingEnabled: boolean,
  installId: () => Promise<string>,
  oauth: OnboardingDependencies = {},
): Promise<void> {
  if (gateway.auth === "none") return
  await integration.transform((editor) => {
    if (gateway.auth === "auto" || gateway.auth === "oauth") {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with ForgeBench" },
        async authorize() {
          const { startSignIn: start, ...rest } = oauth
          const session = await (start ?? startSignIn)({
            currentAccess: () => currentAccess(integration, gateway.url),
            ...rest, url: gateway.url, installId: await installId(),
          })
          // The host opens `session.url` in the browser; the loopback listener finishes the flow.
          return {
            url: session.url,
            instructions: "Sign in to Forgebench in the browser that opens, then enter your password again and approve the model-authorization screen. "
              + (reportingEnabled ? "OpenCode session reporting will use the separate reporting credential from this sign-in. " : "")
              + "You can close the tab when Forgebench says you are connected.",
            mode: "auto",
            callback: session.promise.then((granted): Credential.OAuth => ({
              type: "oauth",
              methodID: OAUTH_METHOD_ID as Credential.OAuth["methodID"],
              refresh: reportingEnabled && granted.reportingKey ? granted.reportingKey : LEGACY_REFRESH,
              access: granted.access,
              expires: Date.now() + OAUTH_EXPIRES_IN_MS,
              metadata: { url: gateway.url, name: granted.name ?? undefined, prefix: granted.prefix ?? undefined },
            })),
          }
        },
        async refresh(credential) { return credential },
        label(credential) {
          return typeof credential.metadata?.name === "string" ? `ForgeBench · ${credential.metadata.name}` : undefined
        },
      })
    }
    if (gateway.auth === "auto" || gateway.auth === "key") {
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "ForgeBench gateway key" } })
    }
  })
}
