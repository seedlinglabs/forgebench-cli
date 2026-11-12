import { spawn } from "node:child_process"

export const DEFAULT_TTL_MS = 5 * 60 * 1000
const SPAWN_TIMEOUT_MS = 30 * 1000
export const KILL_GRACE_MS = 2 * 1000
const POSIX = process.platform !== "win32"

/** Signal everything the command started: the onefile bootstrap runs the real CLI as its child. */
function killTree(pid, signal) {
  if (!pid) return // spawn failed: nothing started
  if (POSIX) {
    try { process.kill(-pid, signal) } catch {} // ESRCH: the group has already exited
    return
  }
  // No process groups on Windows: taskkill /T walks the tree from the bootstrap.
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {})
}

function runToken(executable, url, { signal }) {
  return new Promise((resolve, reject) => {
    // Own process group (POSIX), so the deadline reaches descendants and not only the bootstrap.
    const child = spawn(executable, ["gateway", "token", "--forgebench-url", url], {
      detached: POSIX, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    })
    const chunks = []
    let stdoutBytes = 0
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 64 * 1024) {
        killTree(child.pid, "SIGKILL")
        reject(Object.assign(new Error("gateway token output too large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }))
        return
      }
      chunks.push(chunk)
    })
    const abort = () => {
      killTree(child.pid, "SIGTERM")
      setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS).unref()
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    // Never put stdout in the error: stdout is the key.
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort)
      reject(Object.assign(new Error("gateway token failed"), { code: error.code }))
    })
    child.on("close", (code, killed) => {
      signal.removeEventListener("abort", abort)
      // A one-shot command: nothing it started may outlive it.
      if (POSIX && !signal.aborted) killTree(child.pid, "SIGKILL")
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"))
      else reject(Object.assign(new Error("gateway token failed"), { code: code ?? undefined, signal: killed ?? undefined }))
    })
  })
}

/**
 * Gateway key for this deployment (stdout is the key only).
 * Serve cached keys immediately while one shared refresh runs in the background.
 * Failed refreshes leave the TTL unchanged; only startup and explicit refresh wait.
 */
export function createTokenSource({ executable, url, ttlMs = DEFAULT_TTL_MS, timeoutMs = SPAWN_TIMEOUT_MS, run = runToken, now = Date.now }) {
  let cached = null
  let inflight = null
  let failing = false
  function refresh() {
    if (inflight) return inflight
    const controller = new AbortController()
    let timer
    // A killed onefile bootstrap can leave stdout open in its child: do not wait for close.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error("gateway token timed out"), { code: "TOKEN_TIMEOUT" }))
        controller.abort()
      }, timeoutMs)
    })
    inflight = Promise.race([
      Promise.resolve().then(() => run(executable, url, { signal: controller.signal, timeoutMs })),
      deadline,
    ])
      .then((stdout) => {
        const token = stdout.trim()
        if (!token) throw Object.assign(new Error("printed no key"), { code: "EMPTY_TOKEN" })
        cached = { token, at: now() }
        failing = false
        return token
      })
      .catch((error) => {
        const reason = error?.code === "TOKEN_TIMEOUT" ? `timed out after ${timeoutMs / 1000}s`
          : error?.code === "EMPTY_TOKEN" ? "printed no key"
          : error?.code ?? error?.signal ?? "error"
        const failure = new Error(`\`${executable} gateway token\` failed (${reason})`)
        if (!failing) console.error(`[forgebench] ${failure.message}`)
        failing = true
        throw failure
      })
      .finally(() => {
        clearTimeout(timer)
        inflight = null
      })
    return inflight
  }
  function getToken() {
    if (!cached) return refresh()
    if (now() - cached.at >= ttlMs) refresh().catch(() => {})
    return Promise.resolve(cached.token)
  }
  // Keep the last good key: a failed forced refresh must not leave requests keyless.
  getToken.refresh = () => refresh()
  return getToken
}
