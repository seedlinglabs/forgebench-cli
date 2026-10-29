// Smoke test against a real OpenCode 2.x: loads this package from a local directory through
// root `server.js`, with a throwaway HOME/XDG tree under /tmp and a mock OpenAI server.
// Skips (exit 0) when `opencode` 2.x is not installed. Never touches ~/.config/opencode.
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const KEY = "smoke-key-1"

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
for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(dir, { recursive: true })

// Fake CLI: `gateway token` prints a counting key (no newline), `sync` logs its argv.
const fake = join(base, "fake-forgebench")
writeFileSync(
  fake,
  `#!/bin/bash
echo "$*" >> "${base}/fake.log"
if [ "$1" = "gateway" ] && [ "$2" = "token" ]; then
  n=$(cat "${base}/counter" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${base}/counter"
  printf '${KEY}-%s' "$n"
fi
`,
)
chmodSync(fake, 0o755)

const requests = []
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
    requests.push({ path: req.url, authorization: req.headers.authorization, session: req.headers["x-forgebench-session-id"], harness: req.headers["x-forgebench-harness"], profile: req.headers["x-forgebench-profile"] })
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

mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
writeFileSync(
  join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
  JSON.stringify({
    plugins: [{
      package: pkgDir,
      options: { gateway: true, sync: true, url, executable: fake, models: ["smoke-model"], headers: { "X-Forgebench-Profile": "smoke" } },
    }],
  }),
)

try {
  const models = await opencode(["models", "--standalone"], { env, timeout: 60000 })
  assert.match(models.stdout, /forgebench\/smoke-model/, `provider not registered:\n${models.stdout}${models.stderr}`)

  const run = await opencode(["run", "--standalone", "--auto", "-m", "forgebench/smoke-model", "say hello"], { env, cwd: base, timeout: 120000 })
  const chat = requests.filter((r) => r.path.endsWith("/chat/completions"))
  assert.ok(chat.length >= 1, `no gateway request (${JSON.stringify(requests)}):\n${run.stdout}${run.stderr}${run.error ?? ""}`)
  for (const r of chat) {
    assert.match(r.authorization, new RegExp(`^Bearer ${KEY}-\\d+$`))
    assert.match(r.session, /^ses_/)
    assert.equal(r.harness, "opencode")
    assert.equal(r.profile, "smoke")
  }
  // Discovery fetched the /v1/models catalog with the resolved key at setup time.
  const discovery = requests.filter((r) => r.path === "/v1/models")
  assert.ok(discovery.length >= 1, `no /v1/models discovery request (${JSON.stringify(requests.map((r) => r.path))})`)
  assert.match(discovery[0].authorization, new RegExp(`^Bearer ${KEY}-\\d+$`))
  assert.equal(discovery[0].session, undefined)
  // The sync is spawned detached after the run ends, so poll briefly for it.
  const readLog = () => readFileSync(join(base, "fake.log"), "utf8").trim().split("\n")
  for (let i = 0; i < 10 && !readLog().some((l) => l.startsWith("sync ")); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  const log = readLog()
  const tokenCalls = log.filter((l) => l.startsWith("gateway token"))
  assert.ok(tokenCalls.length >= 1, "no gateway token call logged")
  assert.ok(tokenCalls.every((l) => l === `gateway token --forgebench-url ${url}`))
  const synced = log.filter((l) => l === `sync --quiet --url ${url}`).length
  // Informational: `opencode run` exits right after the reply, so on a loaded machine the host can stop
  // before the idle event reaches the plugin. The unit tests cover the event -> spawn path.
  assert.ok(!log.join("\n").includes(KEY), "key leaked into argv")
  // No key in stdout/stderr or in any log file OpenCode wrote under the throwaway tree
  // (the fake CLI script is the one file that holds it: it is the key's source).
  assert.ok(!`${run.stdout}${run.stderr}`.includes(KEY), "key leaked into opencode output")
  const leaks = []
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (entry.isFile() && path !== fake && readFileSync(path).includes(KEY)) leaks.push(path)
    }
  }
  scan(base)
  assert.deepEqual(leaks, [], "key found in files under the throwaway tree")
  console.log(`ok: ${version}: ${chat.length} chat request(s), /v1/models discovered at setup, 1 token spawn, ${synced} sync spawn(s) (informational), key never in argv`)
} finally {
  server.close()
  rmSync(base, { recursive: true, force: true })
}
