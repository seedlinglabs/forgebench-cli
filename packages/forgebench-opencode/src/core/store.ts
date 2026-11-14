import type { Json } from "./json.js"

/** Plugin-private durable storage; the adapter maps its native storage onto this. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: Json): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; limit?: number }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }> }>
}
