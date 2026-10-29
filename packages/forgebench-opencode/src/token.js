import { execFile } from "node:child_process"

export const DEFAULT_TTL_MS = 5 * 60 * 1000
const SPAWN_TIMEOUT_MS = 10 * 1000

function runToken(executable, url) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["gateway", "token", "--forgebench-url", url],
      { timeout: SPAWN_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        // Never put stdout/stderr in the error: stdout is the key.
        if (error) return reject(new Error(`\`${executable} gateway token\` failed (${error.code ?? error.signal ?? "error"})`))
        resolve(String(stdout))
      },
    )
  })
}

/**
 * Gateway key for this deployment (stdout is the key only).
 * The in-flight promise is shared: title and primary requests start concurrently,
 * so a check-then-set cache would spawn once per request. Failures are not cached.
 */
export function createTokenSource({ executable, url, ttlMs = DEFAULT_TTL_MS, run = runToken, now = Date.now }) {
  let cached = null
  let inflight = null
  return function getToken() {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.token)
    if (inflight) return inflight
    inflight = run(executable, url)
      .then((stdout) => {
        const token = stdout.trim()
        if (!token) throw new Error(`\`${executable} gateway token\` printed no key`)
        cached = { token, at: now() }
        return token
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}
