import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { DEFAULT_CONTEXT, DEFAULT_OUTPUT, fetchModels, fromCatalog, toCatalog } from "../src/models.js"

const KEY = "sk_gateway_secret_never_leak_9f2c"

const chatEntry = {
  id: "claude-sonnet-x",
  provider: "anthropic",
  vendor: "anthropic",
  kind: "chat",
  tier: "standard",
  context_window: 300000,
  max_output_tokens: 64000,
  reasoning: true,
  tool_call: true,
  vision: true,
  local: false,
  available: true,
  requires_key: true,
  input_per_1k_usd: 0.003,
  output_per_1k_usd: 0.015,
  description: "  Claude Sonnet X ",
  retired: false,
}

test("fromCatalog maps a full chat entry", () => {
  const model = fromCatalog(chatEntry)
  assert.deepEqual(model, {
    id: "claude-sonnet-x",
    modelID: "claude-sonnet-x",
    providerID: "forgebench",
    name: "Claude Sonnet X",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 3, output: 15, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 300000, output: 64000 },
  })
})

test("fromCatalog applies defaults for nulls", () => {
  assert.deepEqual(fromCatalog({ id: "m", kind: "chat" }), {
    id: "m",
    modelID: "m",
    providerID: "forgebench",
    name: "m",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
  })
  for (const bad of [null, "x", 0, -5, "1px"]) {
    assert.equal(fromCatalog({ id: "m", kind: "chat", context_window: bad, max_output_tokens: bad }).limit.context, DEFAULT_CONTEXT)
    assert.equal(fromCatalog({ id: "m", kind: "chat", context_window: bad, max_output_tokens: bad }).limit.output, DEFAULT_OUTPUT)
  }
})

test("fromCatalog keeps tools on unless false, and vision only on true", () => {
  assert.equal(fromCatalog({ id: "m", kind: "chat", tool_call: undefined }).capabilities.tools, true)
  assert.equal(fromCatalog({ id: "m", kind: "chat", tool_call: false }).capabilities.tools, false)
  assert.deepEqual(fromCatalog({ id: "m", kind: "chat" }).capabilities.input, ["text"])
  assert.deepEqual(fromCatalog({ id: "m", kind: "chat", vision: true }).capabilities.input, ["text", "image"])
  assert.deepEqual(fromCatalog({ id: "m", kind: "chat", vision: "yes" }).capabilities.input, ["text"])
})

test("fromCatalog skips unusable models", () => {
  assert.equal(fromCatalog({ id: "e", kind: "embedding" }), undefined)
  assert.equal(fromCatalog({ id: "i", kind: "image" }), undefined)
  assert.equal(fromCatalog({ id: "d", kind: "decision" }), undefined)
  assert.equal(fromCatalog({ id: "k" }), undefined)
  assert.equal(fromCatalog({ id: "r", kind: "chat", retired: true }), undefined)
  assert.equal(fromCatalog({ id: "a", kind: "chat", available: false }), undefined)
  assert.equal(fromCatalog({ id: "" }), undefined)
  assert.equal(fromCatalog({ id: 42 }), undefined)
  assert.equal(fromCatalog("gpt-5"), undefined)
  assert.equal(fromCatalog(null), undefined)
  assert.equal(fromCatalog(undefined), undefined)
})

test("fromCatalog zero cost stays a cost entry", () => {
  assert.deepEqual(fromCatalog({ id: "free", kind: "chat", input_per_1k_usd: 0, output_per_1k_usd: 0 }).cost, [
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
  ])
  for (const bad of [undefined, null, "3", Infinity, -1, NaN]) {
    assert.deepEqual(
      fromCatalog({ id: "m", kind: "chat", input_per_1k_usd: chatEntry.input_per_1k_usd, output_per_1k_usd: bad }).cost,
      [],
    )
    assert.deepEqual(
      fromCatalog({ id: "m", kind: "chat", input_per_1k_usd: bad, output_per_1k_usd: chatEntry.output_per_1k_usd }).cost,
      [],
    )
  }
})

test("fromCatalog name: description trim and 120-char cap", () => {
  assert.equal(fromCatalog({ id: "m", kind: "chat", description: "  Nice model  " }).name, "Nice model")
  assert.equal(fromCatalog({ id: "m", kind: "chat", description: "   " }).name, "m")
  assert.equal(fromCatalog({ id: "m", kind: "chat", description: 7 }).name, "m")
  const long = fromCatalog({ id: "m", kind: "chat", description: "y".repeat(200) })
  assert.equal(long.name.length, 120)
  assert.equal(long.name, "y".repeat(120))
})

test("toCatalog filters, dedupes first-wins, preserves order", () => {
  const models = toCatalog([
    chatEntry,
    { id: "claude-sonnet-x", kind: "chat", description: "A LATER DUPLICATE" },
    { id: "emb", kind: "embedding" },
    { id: "gone", kind: "chat", retired: true },
    { id: "local", kind: "chat" },
  ])
  assert.deepEqual(
    models.map((m) => m.id),
    ["claude-sonnet-x", "local"],
  )
  assert.equal(models[0].name, "Claude Sonnet X")
})

test("toCatalog tolerates non-arrays", () => {
  assert.deepEqual(toCatalog(undefined), [])
  assert.deepEqual(toCatalog(null), [])
  assert.deepEqual(toCatalog("nope"), [])
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

const respond = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

test("fetchModels happy path: method, path, headers, mapping", async () => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, accept: req.headers.accept, method: req.method })
    respond(
      res,
      200,
      JSON.stringify({
        object: "list",
        data: [chatEntry, { id: "claude-sonnet-x", kind: "chat", description: "DUP" }, { id: "emb", kind: "embedding" }],
        default_model: "claude-sonnet-x",
        gateway: { owner: "studio_app" },
      }),
    )
  })
  const url = await listen(server)
  try {
    const { models, defaultModel } = await fetchModels({ url, key: KEY })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "GET")
    assert.equal(requests[0].path, "/v1/models")
    assert.equal(requests[0].auth, `Bearer ${KEY}`)
    assert.equal(requests[0].accept, "application/json")
    assert.equal(defaultModel, "claude-sonnet-x")
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-sonnet-x"],
    )
    assert.equal(models[0].name, "Claude Sonnet X")
  } finally {
    server.close()
  }
})

test("fetchModels trims whitespace and trailing slashes off the url", async () => {
  let path
  const server = createServer((req, res) => {
    path = req.url
    respond(res, 200, JSON.stringify({ object: "list", data: [], default_model: "" }))
  })
  try {
    const url = await listen(server)
    const { models, defaultModel } = await fetchModels({ url: ` ${url}/ `, key: KEY })
    assert.equal(path, "/v1/models")
    assert.deepEqual(models, [])
    assert.equal(defaultModel, "")
  } finally {
    server.close()
  }
})

test("fetchModels 401 mentions HTTP 401, the detail, and never the key", async () => {
  const server = createServer((req, res) => respond(res, 401, JSON.stringify({ detail: "invalid gateway key" })))
  try {
    const url = await listen(server)
    await assert.rejects(
      fetchModels({ url, key: KEY }),
      (error) => {
        assert.match(error.message, /HTTP 401/)
        assert.match(error.message, /invalid gateway key/)
        assert.ok(!error.message.includes(KEY))
        return true
      },
    )
  } finally {
    server.close()
  }
})

test("fetchModels 500 without a tiny parseable detail dumps nothing", async () => {
  const big = JSON.stringify({ detail: "boom".repeat(200) })
  assert.ok(big.length > 200)
  const server = createServer((req, res) => respond(res, 500, big))
  try {
    const url = await listen(server)
    await assert.rejects(
      fetchModels({ url, key: KEY }),
      (error) => {
        assert.equal(error.message, "GET /v1/models failed (HTTP 500)")
        assert.ok(!error.message.includes(KEY))
        return true
      },
    )
  } finally {
    server.close()
  }
})

test("fetchModels rejects garbage and non-list bodies", async () => {
  const bodies = ["not json", "null", "42", JSON.stringify({ object: "list", data: null })]
  for (const body of bodies) {
    const server = createServer((req, res) => respond(res, 200, body))
    try {
      const url = await listen(server)
      await assert.rejects(
        fetchModels({ url, key: KEY }),
        (error) => {
          assert.match(error.message, /unreadable catalog/)
          assert.ok(!error.message.includes(KEY))
          return true
        },
      )
    } finally {
      server.close()
    }
  }
})

test("fetchModels times out against a silent server", async () => {
  const server = createServer((req, res) => {
    // Never respond, and prevent the default socket timeout from completing.
    req.socket.setTimeout(10_000)
    req.on("error", () => {})
  })
  try {
    const url = await listen(server)
    await assert.rejects(fetchModels({ url, key: KEY, timeoutMs: 50 }), (error) => {
      assert.match(error.name, /AbortError|TimeoutError|Error/)
      assert.ok(!String(error).includes(KEY))
      return true
    })
  } finally {
    server.close()
  }
})
