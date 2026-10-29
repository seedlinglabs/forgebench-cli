import { spawn } from "node:child_process"

export const SYNC_EVENT = /^session\.(idle|execution\.(succeeded|failed|interrupted))$/

function spawnDetached(executable, args) {
  const child = spawn(executable, args, { stdio: "ignore", detached: true, windowsHide: true })
  child.on("error", () => {})
  child.unref()
  return child
}

/** Detached `<executable> sync --quiet [--url U]`; one at a time, a burst of events re-runs it once. */
export function createSyncRunner({ executable, url, start = spawnDetached }) {
  const args = ["sync", "--quiet", ...(url ? ["--url", url] : [])]
  let running = false
  let dirty = false
  function run() {
    running = true
    dirty = false
    const child = start(executable, args)
    const done = () => {
      running = false
      if (dirty) run()
    }
    child.once?.("exit", done)
    child.once?.("error", done)
  }
  return function sync() {
    if (running) dirty = true
    else run()
  }
}
