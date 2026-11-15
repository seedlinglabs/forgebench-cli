import { fingerprint } from "./idempotency.js"
import { record } from "./json.js"
import type { Json } from "./json.js"
import type { KeyValueStore } from "./store.js"

export type JobKind = "meta" | "observations" | "task"
export type Binding = { credential: string; principal?: string }
export type Job = {
  binding?: Binding
  key: string
  kind: JobKind
  /** Monotonic: jobs for one owner are delivered oldest first (a parent session before its child). */
  seq: number
  attempts: number
  notBefore: number
  createdAt: number
  payload: Json
}

export const MAX_JOBS = 100
export const MAX_ATTEMPTS = 12
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 15 * 60 * 1000

/** Exponential backoff with +-20% jitter; a server `Retry-After` always wins. */
export function backoff(attempts: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempts, 10))
  return Math.round(base * (0.8 + random() * 0.4))
}

/**
 * Bounded, private, restart-safe spool of metadata-only jobs. Jobs hold no
 * credentials. Delivery checks the per-job binding before any mutation; the
 * install prefix keeps the capacity limit shared across accounts, including held jobs.
 */
export class DeliveryQueue {
  private seq = 0
  constructor(private readonly store: KeyValueStore, private readonly now: () => number) {}

  private prefix(owner: string) { return `q:${owner}:` }
  static slot(kind: JobKind, id: string) { return `${kind}:${fingerprint(id).slice(0, 24)}` }

  async list(owner: string): Promise<Job[]> {
    const scanned = await this.store.scan({ prefix: this.prefix(owner), limit: MAX_JOBS + 1 })
    const jobs: Job[] = []
    for (const entry of scanned.entries) {
      const value = record(entry.value)
      if (typeof value.seq !== "number" || typeof value.kind !== "string") continue
      jobs.push({
        binding: parseBinding(value.binding),
        key: entry.key, kind: value.kind as JobKind, seq: value.seq,
        attempts: Number(value.attempts) || 0, notBefore: Number(value.notBefore) || 0,
        createdAt: Number(value.createdAt) || 0, payload: value.payload as Json,
      })
    }
    return jobs.sort((a, b) => a.seq - b.seq)
  }

  /** Same slot replaces the older payload (latest snapshot wins, nothing is added twice). */
  async put(owner: string, kind: JobKind, slot: string, payload: Json, binding?: Binding): Promise<"queued" | "full"> {
    const key = `${this.prefix(owner)}${slot}`
    const existing = await this.store.get(key)
    if (existing === undefined) {
      const count = (await this.store.scan({ prefix: this.prefix(owner), limit: MAX_JOBS })).entries.length
      if (count >= MAX_JOBS) return "full"
    }
    const prior = record(existing)
    this.seq = Math.max(this.seq + 1, this.now())
    await this.store.set(key, {
      ...(binding ? { binding } : {}),
      kind, seq: typeof prior.seq === "number" ? prior.seq : this.seq, attempts: 0, notBefore: 0,
      createdAt: typeof prior.createdAt === "number" ? prior.createdAt : this.now(), payload,
    })
    return "queued"
  }

  async ack(job: Job) { await this.store.remove(job.key) }

  async defer(job: Job, delayMs: number, countAttempt = true) {
    await this.store.set(job.key, {
      ...(job.binding ? { binding: job.binding } : {}),
      kind: job.kind, seq: job.seq, attempts: job.attempts + (countAttempt ? 1 : 0),
      notBefore: this.now() + delayMs, createdAt: job.createdAt, payload: job.payload,
    })
  }

  async clear(owner: string) {
    for (const job of await this.list(owner)) await this.store.remove(job.key)
  }

  expired(job: Job) { return job.attempts >= MAX_ATTEMPTS || this.now() - job.createdAt > MAX_AGE_MS }
}

function parseBinding(value: unknown): Binding | undefined {
  const doc = record(value)
  if (typeof doc.credential !== "string" || !/^[a-f0-9]{32}$/.test(doc.credential)) return undefined
  if (doc.principal !== undefined && (typeof doc.principal !== "string" || !/^[a-f0-9]{64}$/.test(doc.principal))) return undefined
  return { credential: doc.credential, ...(typeof doc.principal === "string" ? { principal: doc.principal } : {}) }
}
