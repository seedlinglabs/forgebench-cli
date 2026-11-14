import { createHash } from "node:crypto"

export const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex")

/** Stable owner of queued work: the deployment plus the exact reporting credential. Never stored in clear. */
export const ownerOf = (url: string, key: string): string => fingerprint(`${url}:${key}`).slice(0, 32)

/** Deployment/install spool namespace; NOT an authentication boundary. */
export const queueOwnerOf = (url: string, installId: string): string => fingerprint(`queue:${url}:${installId}`).slice(0, 32)

/** Canonical JSON (sorted keys) so equal payloads always digest equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
export const digest = (value: unknown): string => fingerprint(canonical(value))

/** 32 lowercase hex: one trace per native session. */
export const traceId = (sessionID: string): string => fingerprint(`trace:${sessionID}`).slice(0, 32)
/** 16 lowercase hex, deterministic: replaying a span never changes its identity. */
export const spanId = (...parts: string[]): string => fingerprint(`span:${parts.join("\u0000")}`).slice(0, 16)

/** Full native ids only; never cropped. */
export const isNativeSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
