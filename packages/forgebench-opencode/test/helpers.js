import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

export const URL_BASE = "https://gw.example.com"

/**
 * A `forgebench` executable that records every invocation, put FIRST on PATH.
 * The plugin must never call it, so the log must stay empty. This is a real
 * tripwire, not a mocked absence: the real CLI could be anywhere on PATH.
 */
export function installTripwire() {
  const dir = mkdtempSync(join(tmpdir(), "fb-tripwire-"))
  const log = join(dir, "calls.log")
  for (const name of ["forgebench", "fb"]) {
    const exe = join(dir, name)
    writeFileSync(exe, `#!/bin/sh\necho "$0 $*" >> "${log}"\nexit 1\n`)
    chmodSync(exe, 0o755)
  }
  const previous = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${previous}`
  return {
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim() : ""),
    restore() { process.env.PATH = previous },
  }
}

/** Plugin storage stand-in with the scan/prefix semantics the queue relies on. */
export function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: async (key, value) => { map.set(key, structuredClone(value)) },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix, limit = 1000 }) => ({
      entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) })),
    }),
  }
}

/** Minimal V2 plugin context: records registrations and replays provider transforms on reload. */
export function fakeCtx(options, { events = [], connection, sessions = {}, messages = {}, storage = fakeStorage(), providers = new Map(), mcpExisting = {} } = {}) {
  const reg = { provider: [], hooks: [], mcp: [], methods: [], toolHooks: [], statuses: [], subscribed: 0, aborted: false, reloads: 0 }
  const transforms = []
  const editor = () => ({
    add: (input) => {
      if (providers.has(input.info.id)) throw new Error(`provider ${input.info.id} already exists`)
      providers.set(input.info.id, { provider: input.info, models: new Map(input.models.map((m) => [m.id, m])) })
      reg.provider.push(input)
    },
    get: (id) => providers.get(id),
    update: (id, fn) => { const record = providers.get(id); if (record) fn(record.provider) },
    models: { set: (id, list) => { const record = providers.get(id); if (record) record.models = new Map(list.map((m) => [m.id, m])) } },
  })
  const integrationConnection = connection ?? { active: async () => undefined, resolve: async () => undefined }
  const ctx = {
    options,
    storage,
    location: { directory: "/work/forgebench" },
    vcs: { get: async () => ({ data: { branch: { current: "fix/ENG-1" } } }) },
    provider: {
      transform: async (cb) => { transforms.push(cb); cb(editor()) },
      reload: async () => { reg.reloads += 1; for (const cb of transforms) cb(editor()) },
    },
    integration: {
      transform: async (cb) => { cb({ method: { update: (input) => reg.methods.push(input) } }) },
      connection: { ...integrationConnection, status: async (input) => { reg.statuses.push(input.status) } },
    },
    session: {
      hook: async (name, cb, opts) => { reg.hooks.push({ name, cb, opts }) },
      get: async ({ sessionID }) => sessions[sessionID] ?? { time: { created: 1_700_000_000_000 } },
      context: async ({ sessionID }) => messages[sessionID] ?? [],
    },
    tool: { hook: async (name, cb) => { reg.toolHooks.push({ name, cb }) } },
    mcp: { transform: async (cb) => { cb({ get: (name) => mcpExisting[name], set: (name, config) => reg.mcp.push({ name, config }) }) } },
    event: {
      subscribe: ({ signal }) => {
        reg.subscribed += 1
        signal?.addEventListener?.("abort", () => { reg.aborted = true })
        return (async function* () { yield* events })()
      },
    },
  }
  return { ctx, reg, providers, storage }
}

/** A connection whose credential can be swapped between calls. */
export function fakeConnection(initial) {
  const state = { credential: initial }
  return {
    state,
    connection: {
      active: async () => (state.credential ? { id: "active" } : undefined),
      resolve: async () => state.credential,
    },
  }
}

/** Fake Forgebench backend over fetch: records requests, answers from a handler table. */
export function fakeBackend(handlers = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search
    const body = init.body ? JSON.parse(init.body) : undefined
    const auth = init.headers?.Authorization ?? init.headers?.authorization
    calls.push({ method: init.method ?? "GET", path, body, auth })
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`
    const handler = handlers[key] ?? handlers[new URL(url).pathname]
    if (!handler) return Response.json({ detail: { error: "not_found" } }, { status: 404 })
    const out = typeof handler === "function" ? await handler({ body, auth, calls }) : handler
    if (out instanceof Response) return out
    return Response.json(out)
  }
  return { calls, fetchImpl, count: (path) => calls.filter((c) => c.path.startsWith(path)).length }
}
