import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCatalog } from "../dist/core/catalog.js"
import { DEFAULT_CONTEXT, DEFAULT_OUTPUT, fetchModels, toCatalog } from "../dist/v2/models.js"
import { setup } from "../dist/v2/plugin.js"
import { PROVIDER_ID } from "../dist/v2/options.js"
import { fakeConnection, fakeCtx } from "./helpers.js"

const KEY = "fbk_names"
const PROSE = "Openai via OpenRouter (synced catalog, not benchmarked). Key supplied from your tenant vault."
const chat = (fields) => ({ kind: "chat", available: true, input_per_1k_usd: 0.001, output_per_1k_usd: 0.002, description: PROSE, ...fields })
const names = (entries) => parseCatalog(entries).map((m) => m.name)

test("the picker name is the short model name plus its route, never the description", () => {
  assert.deepEqual(names([
    chat({ id: "gemini-3.8-flash", label: "gemini-3.8-flash", display_name: "Gemini 3.8 Flash", route: "Gemini API" }),
    chat({ id: "openrouter-sync-google-gemini-3-8-flash", display_name: "Gemini 3.8 Flash", route: "OpenRouter" }),
    chat({ id: "us.anthropic.claude-sonnet-5", display_name: "Claude Sonnet 5", route: "Bedrock US" }),
  ]), ["Gemini 3.8 Flash (Gemini API)", "Gemini 3.8 Flash (OpenRouter)", "Claude Sonnet 5 (Bedrock US)"])
})

test("a name that already ends in a qualifier takes the route inside the same bracket", () => {
  assert.deepEqual(names([
    chat({ id: "openrouter-sync-google-gemini-3-8-flash-batch", display_name: "Gemini 3.8 Flash (batch)", route: "OpenRouter" }),
    chat({ id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", display_name: "Claude Haiku 4.5 (2025-10-01)", route: "Bedrock US" }),
  ]), ["Gemini 3.8 Flash (batch, OpenRouter)", "Claude Haiku 4.5 (2025-10-01, Bedrock US)"])
})

test("an older gateway without display_name: curated label without its maker prefix, else the id", () => {
  assert.deepEqual(names([
    chat({ id: "openrouter-claude-sonnet-5", label: "Anthropic: Claude Sonnet 5" }),
    chat({ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }),
    chat({ id: "openai-gpt-5.4", label: "gpt-5.4" }),
    chat({ id: "bare" }),
  ]), ["Claude Sonnet 5", "gemini-2.5-flash", "openai-gpt-5.4", "bare"])
})

test("names that still collide after the route are told apart by id", () => {
  assert.deepEqual(names([
    chat({ id: "openrouter-nemotron-3-ultra", display_name: "Nemotron 3 Ultra", route: "OpenRouter" }),
    chat({ id: "openrouter-sync-nvidia-nemotron-3-ultra", display_name: "Nemotron 3 Ultra", route: "OpenRouter" }),
    chat({ id: "gpt-4.1", display_name: "GPT-4.1" }),
  ]), [
    "Nemotron 3 Ultra (OpenRouter) · openrouter-nemotron-3-ultra",
    "Nemotron 3 Ultra (OpenRouter) · openrouter-sync-nvidia-nemotron-3-ultra",
    "GPT-4.1",
  ])
})

test("a row marked duplicate_of a listed id is hidden; it stays when its twin is not listed", () => {
  const benchmarked = chat({ id: "openrouter-claude-sonnet-5", display_name: "Claude Sonnet 5", route: "OpenRouter" })
  const synced = chat({ id: "openrouter-sync-anthropic-claude-sonnet-5", display_name: "Claude Sonnet 5", route: "OpenRouter", duplicate_of: "openrouter-claude-sonnet-5" })
  assert.deepEqual(parseCatalog([benchmarked, synced]).map((m) => m.id), ["openrouter-claude-sonnet-5"])
  // A key allowed only the synced id still sees it, under its plain name.
  assert.deepEqual(names([synced]), ["Claude Sonnet 5 (OpenRouter)"])
})

test("a virtual auto/* model has no price, so OpenCode does not show it as Free", () => {
  const [auto, real, free] = toCatalog([
    chat({ id: "auto/best-coding", display_name: "Auto: Best coding", provider: "forgebench", input_per_1k_usd: 0, output_per_1k_usd: 0 }),
    chat({ id: "gemini-3.8-flash", display_name: "Gemini 3.8 Flash", route: "Gemini API", input_per_1k_usd: 0.00075, output_per_1k_usd: 0.00375 }),
    chat({ id: "openrouter-nemotron-3-super", display_name: "Nemotron 3 Super", route: "OpenRouter", input_per_1k_usd: 0, output_per_1k_usd: 0 }),
  ])
  assert.equal(auto.name, "Auto: Best coding")
  assert.deepEqual(auto.cost, [])
  assert.equal(real.cost[0].input, 0.75)
  // A genuinely free upstream model (OpenRouter ":free") keeps its zero price.
  assert.equal(free.cost[0].input, 0)
})

const options = { url: "https://gw.example.com", apiKey: KEY, models: ["stale-model"], reporting: false, mcp: false }
const live = { data: [chat({ id: "live-model", display_name: "Live Model", route: "Gemini API" })] }
const ids = (providers) => [...(providers.get(PROVIDER_ID)?.models.keys() ?? [])]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("model discovery keeps usable rows when optional token limits are malformed", async () => {
  const badLimits = [
    null, true, false, [123], { valueOf: null, toString: null },
    "", " ", "0x100", "1e3", "12.5", "unknown", "9007199254740993",
    -1, 0, 12.5, Number.MAX_SAFE_INTEGER + 1,
  ]
  const data = [
    chat({ id: "numeric", context_window: 128000, max_output_tokens: 8192 }),
    chat({ id: "decimal-strings", context_window: " 64000 ", max_output_tokens: "4096" }),
    chat({ id: "missing" }),
    ...badLimits.map((limit, i) => chat({
      id: `bad-context-${i}`, context_window: limit, max_output_tokens: 1024,
    })),
    ...badLimits.map((limit, i) => chat({
      id: `bad-output-${i}`, context_window: 16384, max_output_tokens: limit,
    })),
    chat({ id: "trailing", context_window: 32768, max_output_tokens: 2048 }),
  ]
  const { models, defaultModel } = await fetchModels({
    url: options.url,
    key: KEY,
    fetchImpl: async () => Response.json({ data, default_model: "trailing" }),
  })

  assert.equal(defaultModel, "trailing")
  assert.deepEqual(models.map((entry) => entry.id), data.map((entry) => entry.id))
  assert.deepEqual(models.map((entry) => entry.limit), [
    { context: 128000, output: 8192 },
    { context: 64000, output: 4096 },
    { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    ...badLimits.map(() => ({ context: DEFAULT_CONTEXT, output: 1024 })),
    ...badLimits.map(() => ({ context: 16384, output: DEFAULT_OUTPUT })),
    { context: 32768, output: 2048 },
  ])
})

test("a catalog slower than the old 3 s window is ready when setup returns", async () => {
  const { ctx, providers } = fakeCtx(options)
  const slow = async () => { await sleep(80); return Response.json(live) }
  const cleanup = await setup(ctx, { models: { fetchImpl: slow }, firstDiscoveryMs: 1000 })
  assert.deepEqual(ids(providers), ["live-model"])
  await cleanup?.()
})

test("a catalog slower than the startup wait still replaces the fallback list when it lands", async () => {
  const { ctx, providers } = fakeCtx(options)
  const slow = async () => { await sleep(80); return Response.json(live) }
  const cleanup = await setup(ctx, { models: { fetchImpl: slow }, firstDiscoveryMs: 10 })
  assert.deepEqual(ids(providers), ["stale-model"])
  await sleep(150)
  assert.deepEqual(ids(providers), ["live-model"])
  await cleanup?.()
})

test("a failed discovery retries in the background until the catalog loads", async () => {
  const { ctx, providers } = fakeCtx(options)
  let calls = 0
  const flaky = async () => { calls += 1; if (calls < 3) throw new Error("gateway timeout"); return Response.json(live) }
  const cleanup = await setup(ctx, { models: { fetchImpl: flaky }, firstDiscoveryMs: 10, discoveryRetryMs: [10, 10, 10] })
  for (let i = 0; i < 50 && !providers.get(PROVIDER_ID).models.has("live-model"); i++) await sleep(10)
  assert.deepEqual(ids(providers), ["live-model"])
  assert.equal(calls, 3)
  await cleanup?.()
})

test("a rejected key is not retried, and unload stops pending retries", async () => {
  const rejected = fakeCtx(options)
  let denied = 0
  const unauthorized = async () => { denied += 1; return new Response('{"detail":"bad key"}', { status: 401 }) }
  const cleanupRejected = await setup(rejected.ctx, { models: { fetchImpl: unauthorized }, firstDiscoveryMs: 10, discoveryRetryMs: [5, 5, 5] })
  await sleep(60)
  assert.equal(denied, 1)
  await cleanupRejected?.()

  const unloaded = fakeCtx(options)
  let tries = 0
  const down = async () => { tries += 1; throw new Error("down") }
  const cleanup = await setup(unloaded.ctx, { models: { fetchImpl: down }, firstDiscoveryMs: 10, discoveryRetryMs: [30, 30] })
  await cleanup?.()
  await sleep(100)
  assert.equal(tries, 1)
})

test("setup waits as long as the catalog fetch itself, so a slow answer is never abandoned at startup", async () => {
  const { FIRST_DISCOVERY_MS } = await import("../dist/v2/gateway.js")
  const { DEFAULT_TIMEOUT_MS } = await import("../dist/core/catalog.js")
  assert.equal(FIRST_DISCOVERY_MS, DEFAULT_TIMEOUT_MS)
})

test("the route is not repeated when the name already carries it", () => {
  assert.deepEqual(names([chat({ id: "groq-gpt-oss-120b", display_name: "GPT-OSS 120B (Groq)", route: "Groq" })]), ["GPT-OSS 120B (Groq)"])
})

test("an older gateway keeps the maker when the rest cannot stand alone", () => {
  assert.deepEqual(names([
    chat({ id: "openrouter-sync-deepseek-deepseek-r1", label: "DeepSeek: R1" }),
    chat({ id: "openrouter-sync-openai-gpt-5-4", label: "OpenAI: GPT-5.4" }),
  ]), ["DeepSeek R1", "GPT-5.4"])
})

test("a credential change during a failing discovery does not leave a retry for the rejected key", async () => {
  const { registerGateway } = await import("../dist/v2/gateway.js")
  const { resolveOptions } = await import("../dist/v2/options.js")
  const { ctx } = fakeCtx(options)
  const { gateway } = resolveOptions(options)
  let calls = 0
  let rejected = false
  const fetchImpl = async () => {
    calls += 1
    if (!rejected) { await sleep(40); throw new Error("gateway timeout") }
    return new Response('{"detail":"bad key"}', { status: 401 })
  }
  const refresh = await registerGateway(ctx, gateway, { models: { fetchImpl }, firstDiscoveryMs: 5, discoveryRetryMs: [20, 20, 20] })
  // Startup discovery is still in flight when the credential changes to a rejected key.
  rejected = true
  await refresh()
  await sleep(120)
  refresh.dispose()
  // One startup fetch (timed out) + one refresh fetch (401). No stale retry with the rejected key.
  assert.equal(calls, 2)
})

test("FB-481: a transient failure after a credential event restores the key's last list, then a retry refreshes it", async () => {
  const { registerGateway } = await import("../dist/v2/gateway.js")
  const { resolveOptions } = await import("../dist/v2/options.js")
  const { ctx, providers } = fakeCtx(options)
  const { gateway } = resolveOptions(options)
  const second = { data: [chat({ id: "second-model", display_name: "Second Model", route: "Gemini API" })] }
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return Response.json(live)
    if (calls === 2) { await gate; throw new Error("gateway timeout") }
    return Response.json(second)
  }
  const refresh = await registerGateway(ctx, gateway, { models: { fetchImpl }, firstDiscoveryMs: 1000, discoveryRetryMs: [20] })
  assert.deepEqual(ids(providers), ["live-model"])
  // While the current key has not answered, the previous list is hidden...
  const pending = refresh(true)
  await sleep(10)
  assert.deepEqual(ids(providers), [])
  // ...a transient failure for the same key brings it back instead of leaving an empty picker...
  release()
  await pending
  assert.deepEqual(ids(providers), ["live-model"])
  // ...and the bounded retry then loads the fresh catalog.
  for (let i = 0; i < 30 && !providers.get(PROVIDER_ID).models.has("second-model"); i++) await sleep(10)
  assert.deepEqual(ids(providers), ["second-model"])
  assert.equal(calls, 3)
  refresh.dispose()
})

test("FB-481: a 401 clears the visible list and is not retried", async () => {
  const { registerGateway } = await import("../dist/v2/gateway.js")
  const { resolveOptions } = await import("../dist/v2/options.js")
  const { ctx, providers } = fakeCtx(options)
  const { gateway } = resolveOptions(options)
  let calls = 0
  const fetchImpl = async () => { calls += 1; return calls === 1 ? Response.json(live) : new Response('{"detail":"bad key"}', { status: 401 }) }
  const refresh = await registerGateway(ctx, gateway, { models: { fetchImpl }, firstDiscoveryMs: 1000, discoveryRetryMs: [10, 10] })
  assert.deepEqual(ids(providers), ["live-model"])
  await refresh(true)
  await sleep(60)
  assert.deepEqual(ids(providers), [])
  assert.equal(calls, 2)
  refresh.dispose()
})


test("review F1: an account switch during an outage hides the configured fallback models", async () => {
  const { registerGateway } = await import("../dist/v2/gateway.js")
  const { resolveOptions } = await import("../dist/v2/options.js")
  const conn = fakeConnection({ type: "key", key: "key-a" })
  const opts = { url: "https://gw.example.com", models: [{ id: "old-private-model", name: "Old Private Model" }], reporting: false, mcp: false }
  const { ctx, providers } = fakeCtx(opts, { connection: conn.connection })
  const { gateway } = resolveOptions(opts)
  const keys = []
  const fetchImpl = async (_url, init) => { keys.push(init.headers.Authorization); return new Response("{}", { status: 503 }) }
  const refresh = await registerGateway(ctx, gateway, { models: { fetchImpl }, firstDiscoveryMs: 1000, discoveryRetryMs: [] })
  // One account, gateway down: the configured fallback is all there is, and it stays...
  assert.deepEqual(ids(providers), ["old-private-model"])
  await refresh(false)
  assert.deepEqual(ids(providers), ["old-private-model"])
  // ...including across a credential event for the same key (it is hidden, then restored).
  await refresh(true)
  assert.deepEqual(ids(providers), ["old-private-model"])
  // Switch to another account while the gateway is still down: the fallback belongs to the old setup.
  conn.state.credential = { type: "key", key: "key-b" }
  await refresh(true)
  assert.deepEqual(ids(providers), [])
  assert.deepEqual(keys, ["Bearer key-a", "Bearer key-a", "Bearer key-a", "Bearer key-b"])
  refresh.dispose()
})

test("review F6: after a 401, an outage never brings back the configured fallback for that key", async () => {
  const { registerGateway } = await import("../dist/v2/gateway.js")
  const { resolveOptions } = await import("../dist/v2/options.js")
  const conn = fakeConnection({ type: "key", key: "key-a" })
  const opts = { url: "https://gw.example.com", models: [{ id: "revoked-model", name: "Revoked Model" }], reporting: false, mcp: false }
  const { ctx, providers } = fakeCtx(opts, { connection: conn.connection })
  const { gateway } = resolveOptions(opts)
  const b = { data: [chat({ id: "b-model", display_name: "B Model", route: "OpenRouter" })] }
  let phase = "a-denied"
  const fetchImpl = async (_url, init) => {
    const key = init.headers.Authorization
    if (phase === "a-denied" && key === "Bearer key-a") return new Response('{"detail":"revoked"}', { status: 401 })
    if (key === "Bearer key-b") return Response.json(b)
    return new Response("{}", { status: 503 })
  }
  const refresh = await registerGateway(ctx, gateway, { models: { fetchImpl }, firstDiscoveryMs: 1000, discoveryRetryMs: [] })
  assert.deepEqual(ids(providers), [])
  conn.state.credential = { type: "key", key: "key-b" }
  await refresh(true)
  assert.deepEqual(ids(providers), ["b-model"])
  phase = "outage"
  conn.state.credential = { type: "key", key: "key-a" }
  await refresh(true)
  assert.deepEqual(ids(providers), [])
  refresh.dispose()
})

test("uses the cache wire format only when the gateway advertises it", async () => {
  const { model } = await import("../dist/v2/options.js")
  const opus = "vertex-claude-opus-5-5"
  const [advertised] = toCatalog([{ id: opus, kind: "chat", prompt_cache_format: "anthropic" }])
  const [legacy, invalid] = toCatalog([
    { id: opus, kind: "chat" },
    { id: "unknown-format", kind: "chat", prompt_cache_format: "unknown" },
  ])

  assert.deepEqual(advertised.compatibility, { cacheFormat: "anthropic" })
  assert.equal(legacy.compatibility, undefined)
  assert.equal(invalid.compatibility, undefined)
  assert.equal(model(opus).compatibility, undefined)
})
