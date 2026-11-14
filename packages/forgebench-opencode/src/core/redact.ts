/**
 * Redaction and identity sanitizers. Names and repository identity only: no
 * absolute path, auth URL, secret or free text ever leaves the machine.
 */
const SECRET_LIKE = /(?:sk[_-]|fbk_|gh[pousr]_|github_pat_|xox[baprs]-|npm_)[A-Za-z0-9_-]{6,}/gi
const SECRET_TEST = /(?:sk[_-]|gh[pousr]_|github_pat_|xox[baprs]-)|(?:^|\s)(?:Bearer|Basic)\s/i

/** Mask key-looking tokens and bearer headers in diagnostic text. */
export function scrub(text: unknown, limit = 300): string {
  return String(text ?? "")
    .replace(/(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(SECRET_LIKE, "[redacted]")
    .slice(0, limit)
}

export function safeName(value: unknown, limit = 255): string | undefined {
  if (typeof value !== "string" || !value || value.length > limit
    || /[\x00-\x1f\x7f]/.test(value) || SECRET_TEST.test(value)
    || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) return undefined
  return value
}

/** `git@host:org/repo.git` or an https remote -> `host/org/repo`; anything else -> undefined. */
export function repositoryIdentity(remote: unknown): string | undefined {
  if (typeof remote !== "string") return undefined
  try {
    const ssh = /^[^@\s]+@([^:\s]+):(.+)$/.exec(remote.trim())
    const parsed = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote.trim())
    if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) return undefined
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
    if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(parsed.host)
      || path.split("/").length < 2 || path.split("/").some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) return undefined
    const identity = `${parsed.host.toLowerCase()}/${parsed.hostname.toLowerCase() === "github.com" ? path.toLowerCase() : path}`
    return safeName(identity)
  } catch { return undefined }
}

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
/** Tool names are the only tool-derived text a span carries. */
export function toolName(value: unknown): string {
  return typeof value === "string" && TOOL_NAME.test(value) ? value : "tool"
}
