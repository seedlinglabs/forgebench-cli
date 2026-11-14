// Smoke test against a real OpenCode 2.x: packs this package, installs it with `opencode plugin add`,
// and drives browser sign-in, model discovery, a streamed request and session reporting against a
// fake Forgebench backend, inside a throwaway HOME/XDG tree under /tmp. A recording `forgebench`
// tripwire sits FIRST on PATH: the plugin must never call it. Skips (exit 0) when `opencode` 2.x is
// not installed. Never touches ~/.config/opencode.
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Async: the mock server lives in this process, so a blocking spawn would starve it.
const opencode = (args, opts) =>
  new Promise((resolve) => {
    const child = execFile("opencode", args, { ...opts, encoding: "utf8" }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    child.stdin.end() // `opencode run` waits on a piped stdin otherwise
  })

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
const KEY = "smoke-key-1"
const REPORTING_KEY = "smoke-reporting-key"

async function until(check, timeoutMs = 20_000, detail = () => "") {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for OpenCode smoke-test state: ${detail()}`)
}

let version = ""
try {
  version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()
} catch {}
if (!/^(opencode )?v?2\./.test(version)) {
  console.log(`skip: opencode 2.x not installed (${version || "not found"})`)
  process.exit(0)
}

const base = mkdtempSync(join(tmpdir(), "fb-opencode-smoke-"))
const env = {
  ...process.env,
  HOME: join(base, "home"),
  XDG_CONFIG_HOME: join(base, "config"),
  XDG_DATA_HOME: join(base, "data"),
  XDG_CACHE_HOME: join(base, "cache"),
  XDG_STATE_HOME: join(base, "state"),
}
for (const name of Object.keys(env)) {
  if (name.startsWith("OPENCODE_") || name.startsWith("FORGEBENCH_")) delete env[name]
}
for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(dir, { recursive: true })
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", base], {
  cwd: pkgDir, encoding: "utf8",
}))[0]
const tarball = readFileSync(join(base, packed.filename))
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`

// Tripwire, not a mock: a `forgebench` that records every call and fails. The plugin is CLI-free, so
// the log must stay empty. It shadows any real CLI on PATH.
const tripwire = join(base, "bin", "forgebench")
const tripwireLog = join(base, "tripwire.log")
mkdirSync(dirname(tripwire), { recursive: true })
env.PATH = `${dirname(tripwire)}${process.platform === "win32" ? ";" : ":"}${env.PATH}`
writeFileSync(tripwire, `#!/bin/sh\necho "$0 $*" >> "${tripwireLog}"\nexit 1\n`)
chmodSync(tripwire, 0o755)

const requests = []
const reports = []
let consentRedirect
const catalogBody = JSON.stringify({
  object: "list",
  data: [
    { id: "smoke-model", kind: "chat", available: true, context_window: 9000, max_output_tokens: 777, description: "Smoke Model", input_per_1k_usd: 0.001, output_per_1k_usd: 0.002 },
    { id: "smoke-embed", kind: "embedding", available: true },
  ],
  default_model: "smoke-model",
})
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    if (req.url.startsWith("/v1/sessions/meta")) reports.push({ authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined })
    requests.push({ path: req.url, authorization: req.headers.authorization, session: req.headers["x-forgebench-session-id"], requestId: req.headers["x-client-request-id"], harness: req.headers["x-forgebench-harness"], profile: req.headers["x-forgebench-profile"] })
    if (decodeURIComponent(req.url).startsWith(`/${pkg.name}`)) {
      const published = { ...pkg, dist: { tarball: `${url}/package.tgz`, integrity } }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: published } }))
      return
    }
    if (req.url === "/package.tgz") {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end(tarball)
      return
    }
    const pathname = new URL(req.url, url).pathname
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)) }
    if (pathname === "/v1/auth/oidc/login") {
      const callback = new URL(new URL(req.url, url).searchParams.get("redirect"))
      callback.searchParams.set("code", "login-code")
      res.writeHead(302, { Location: callback.href }); res.end(); return
    }
    if (pathname === "/v1/auth/whoami") { reply({ tenant_id: "smoke-tenant", identity_id: "smoke-identity" }); return }
    if (pathname === "/v1/sessions/capture-policy") { reply({ effective: { mode: "legacy", revision: 0 } }); return }
    if (pathname === "/v1/sessions/meta") { reply({ accepted: 1 }); return }
    if (pathname === "/v1/auth/cli/exchange") { reply({ api_key: REPORTING_KEY }); return }
    if (pathname === "/v1/auth/cli/inference/options") {
      assert.equal(req.headers.authorization, `Bearer ${REPORTING_KEY}`)
      consentRedirect = JSON.parse(body).redirect
      reply({ eligible: true, consent_url: `${url}/consent` }); return
    }
    if (pathname === "/consent") {
      res.writeHead(302, { Location: `${consentRedirect}?code=consent-code` }); res.end(); return
    }
    if (pathname === "/v1/auth/cli/inference/redeem") { reply({ api_key: `${KEY}-1`, name: "Smoke gateway" }); return }
    if (req.url.startsWith("/mcp")) {
      const message = body ? JSON.parse(body) : {}
      if (message.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1" } }
        : { tools: [] } }))
      return
    }
    // <url>/v1/models: the model catalog the plugin discovers from.
    if (req.url.startsWith("/v1/models")) {
      if (!req.headers.authorization?.startsWith(`Bearer ${KEY}-`)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ detail: "bad key" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(catalogBody)
      return
    }
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(chunk({ role: "assistant", content: "mock reply" }) + chunk({}, "stop") + "data: [DONE]\n\n")
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}`
// Exercise `plugin add` against the packed release without publishing anything.
env.npm_config_registry = url
env.NPM_CONFIG_REGISTRY = url
writeFileSync(join(env.HOME, ".npmrc"), `registry=${url}/\n@forgebench:registry=${url}/\n`)

let daemon
try {
  mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  const configFile = join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")
  const added = await opencode(["plugin", "add", `${pkg.name}@${pkg.version}`], {
    env, cwd: base, timeout: 60000,
  })
  assert.equal(added.error, null, `plugin add failed: ${added.stderr}`)
  const connect = await opencode(["api", "GET", "/api/integration", "--standalone"], {
    env, cwd: base, timeout: 60000,
  })
  assert.equal(connect.error, null, `connect catalog failed: ${connect.stderr}`)
  const integration = JSON.parse(connect.stdout).data.find((entry) => entry.id === "forgebench")
  assert.ok(integration, "Forgebench absent from /connect after an options-free install")
  assert.deepEqual(integration.methods.map((method) => method.type), ["oauth", "key"])

  // Override only the endpoint for the mock server. Every feature and the CLI
  // on PATH still use the defaults; no fallback model list is configured.
  writeFileSync(configFile, JSON.stringify({ plugins: [{
    package: pkgDir, options: { url, headers: { "X-Forgebench-Profile": "smoke" } },
  }] }))

  // Exercise the same native OAuth operation that `auth login --method oauth`
  // invokes, following its browser redirects against the fixture control plane.
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const api = `http://127.0.0.1:${port}`
  const apiHeaders = { Authorization: `Basic ${Buffer.from("opencode:smoke-server-password").toString("base64")}` }
  env.OPENCODE_SERVER_PASSWORD = "smoke-server-password"
  daemon = execFile("opencode", ["serve", "--print-logs", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...env, OPENCODE_SERVER_PASSWORD: "smoke-server-password" }, cwd: base,
  }, () => {})
  let diagnostics = ""
  let errorDiagnostics = ""
  daemon.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-3000)
    errorDiagnostics += String(data).split("\n").filter((line) => /error|defect|cause|exception/i.test(line)).join("\n")
  })
  daemon.stdout.on("data", (data) => { diagnostics = (diagnostics + data).slice(-3000) })
  await until(async () => {
    if (daemon.exitCode !== null) throw new Error(`OpenCode serve exited ${daemon.exitCode}: ${diagnostics}`)
    try { await fetch(`${api}/api/integration`, { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
  }, 20_000, () => diagnostics.replaceAll(KEY, "<REDACTED>").replaceAll(REPORTING_KEY, "<REDACTED>"))
  const listed = await fetch(`${api}/api/integration`, { headers: apiHeaders })
  assert.equal(listed.status, 200, `Authenticated API catalog failed (${listed.status})`)
  assert.ok((await listed.json()).data.some((entry) => entry.id === "forgebench"))
  const authorized = await fetch(`${api}/api/integration/forgebench/connect/oauth`, {
    method: "POST", headers: { ...apiHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ methodID: "oauth" }),
  })
  const authorizationBody = await authorized.text()
  if (authorized.status !== 200) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(authorized.status, 200, `OAuth did not start (${authorized.status}): ${authorizationBody} ${errorDiagnostics || diagnostics}`.replaceAll(KEY, "<REDACTED>").replaceAll(REPORTING_KEY, "<REDACTED>"))
  const attempt = JSON.parse(authorizationBody).data
  const browser = await fetch(attempt.url)
  const page = await browser.text()
  assert.ok(page.includes("connected") && !page.includes(KEY) && !page.includes(REPORTING_KEY))
  await until(async () => {
    const status = (await (await fetch(`${api}/api/integration/forgebench/connect/oauth/${attempt.attemptID}`, { headers: apiHeaders })).json()).data
    assert.notEqual(status.status, "failed", status.message)
    return status.status === "complete"
  })
  const models = await opencode(["models", "--server", api], { env, timeout: 60000 })
  assert.match(models.stdout, /forgebench\/smoke-model/, `provider not registered:\n${models.stdout}${models.stderr}`)

  const run = await opencode(["run", "--server", api, "--auto", "-m", "forgebench/smoke-model", "say hello"], { env, cwd: base, timeout: 120000 })
  const chat = requests.filter((r) => r.path.endsWith("/chat/completions"))
  assert.ok(chat.length >= 1, `no gateway request (${JSON.stringify(requests)}):\n${run.stdout}${run.stderr}${run.error ?? ""}`)
  for (const r of chat) {
    assert.match(r.authorization, new RegExp(`^Bearer ${KEY}-\\d+$`))
    assert.match(r.session, /^ses_/)
    assert.equal(r.harness, "opencode")
    assert.match(r.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(r.profile, "smoke")
  }
  // Discovery fetched the /v1/models catalog with the resolved key at setup time.
  const discovery = requests.filter((r) => r.path === "/v1/models")
  assert.ok(discovery.length >= 1, `no /v1/models discovery request (${JSON.stringify(requests.map((r) => r.path))})`)
  assert.match(discovery[0].authorization, new RegExp(`^Bearer ${KEY}-\\d+$`))
  assert.equal(discovery[0].session, undefined)
  // Reporting is delivered by the plugin itself, with the separate reporting key. The idle event can
  // arrive after `opencode run` exits on a loaded machine, so poll briefly before judging.
  for (let i = 0; i < 20 && !reports.length; i++) await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(reports.length >= 1, "no direct session report reached the backend")
  for (const report of reports) {
    assert.equal(report.authorization, `Bearer ${REPORTING_KEY}`, "reports must use the reporting key, not the model key")
    assert.equal(report.body.capture_transport, "native")
    assert.equal(report.body.sessions[0].source, "opencode")
    assert.match(report.body.sessions[0].session_id, /^ses_/)
    assert.ok(!("usage_by_model" in report.body.sessions[0]))
  }
  const authCalls = requests.filter((r) => r.path.includes("/auth/cli/")).length
  assert.ok(authCalls >= 3, "sign-in did not run the exchange, options and redeem stages")
  const stopped = new Promise((resolve) => daemon.once("exit", resolve))
  daemon.kill("SIGTERM")
  await stopped
  daemon = undefined
  // Informational: `opencode run` exits right after the reply, so on a loaded machine the host can stop
  // before the idle event reaches the plugin. The unit tests cover the event -> spawn path.
  // The tripwire is the proof: nothing ever executed a forgebench binary.
  assert.ok(!existsSync(tripwireLog) || readFileSync(tripwireLog, "utf8").trim() === "", `the plugin invoked forgebench: ${existsSync(tripwireLog) ? readFileSync(tripwireLog, "utf8") : ""}`)
  // No key in stdout/stderr or in any log file OpenCode wrote under the throwaway tree
  // 
  assert.ok(!`${run.stdout}${run.stderr}`.includes(KEY) && !`${run.stdout}${run.stderr}`.includes(REPORTING_KEY), "key leaked into opencode output")
  const leaks = []
  // OpenCode owns the secret credential store; sign-in must persist both keys
  // there. The throwaway home is private, and no other output may contain them.
  const credentialDatabase = join(env.XDG_DATA_HOME, "opencode", "opencode.db")
  assert.equal(statSync(base).mode & 0o777, 0o700)
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (entry.isFile() && path !== credentialDatabase) {
        const bytes = readFileSync(path)
        if (bytes.includes(KEY) || bytes.includes(REPORTING_KEY)) leaks.push(path)
      }
    }
  }
  scan(base)
  assert.deepEqual(leaks, [], "key found in files under the throwaway tree")
  console.log(`ok: ${version}: npm plugin add without options, CLI-free browser OAuth, ${chat.length} chat request(s), model discovery, ${reports.length} direct session report(s) with the separate reporting credential, forgebench tripwire silent`)
} finally {
  daemon?.kill("SIGTERM")
  server.close()
  rmSync(base, { recursive: true, force: true })
}
