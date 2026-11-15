/** SDK RPCs cannot be cancelled. Keep the worker attached to the original
 * promise after its deadline; only settlement releases the next SDK call. */
export function reportingBoundary(timeoutMs = 5000, onPause: (paused: boolean, rejected?: boolean) => void = () => {}) {
  let stopped = false
  let chain: Promise<unknown> = Promise.resolve()
  return {
    stop() { stopped = true },
    call<T>(operation: () => Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        if (stopped) throw new Error("Reporting stopped")
        let paused = false
        const timer = setTimeout(() => { paused = true; onPause(true) }, timeoutMs)
        let rejected = true
        try {
          const value = await operation()
          rejected = false
          return value
        } finally {
          clearTimeout(timer)
          if (paused) onPause(false, rejected)
        }
      })
      chain = result.catch(() => {})
      return result
    },
  }
}
