import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  parseVersion, readVersion, checkAgreement, stampPackageJson, distTag,
  inspectPackFiles, scanSecrets, packFiles, stageSource, verifyChannel,
} from "../scripts/release-lib.mjs"
import { checkPublished, checkNewer } from "../scripts/check-published.mjs"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SYNC_WF = path.resolve(PKG, "../../.github/workflows/release-forgebench-opencode.yml")
const PLUGIN_WF = path.resolve(PKG, "../../.github/workflows/release-forgebench-plugin.yml")
const IS_SOURCE = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).private === true && fs.existsSync(SYNC_WF)
const SRC = { skip: !IS_SOURCE && "monorepo source only" }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fb-oc-rel-"))
const seed = (version, pkgVersion = version, extra = {}) => {
  const d = tmp()
  fs.writeFileSync(path.join(d, "VERSION"), version)
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "@forgebench/opencode", version: pkgVersion, private: true, ...extra }, null, 2) + "\n")
  return d
}

test("parseVersion accepts exact semver, including prerelease", () => {
  assert.equal(parseVersion("1.2.3"), "1.2.3")
  assert.equal(parseVersion("0.1.0-rc.1"), "0.1.0-rc.1")
})

test("parseVersion refuses ranges, prefixes, build metadata, padding and junk", () => {
  for (const bad of ["^1.2.3", "~1.2.3", ">=1.0.0", "1.x", "1.2", "v1.2.3", "01.2.3", "1.2.3+build", "1.2.3 ", " 1.2.3", "1.2.3\n1.2.4", "latest", "", "1.2.3 - 1.3.0"]) {
    assert.throws(() => parseVersion(bad), /version/i, JSON.stringify(bad))
  }
  assert.throws(() => parseVersion(undefined), /version/i)
})

test("readVersion tolerates one trailing newline only", () => {
  assert.equal(readVersion(seed("1.0.0\n")), "1.0.0")
  assert.throws(() => readVersion(seed("1.0.0\n\n")), /version/i)
  assert.throws(() => readVersion(tmp()), /VERSION/)
})

test("checkAgreement passes when equal and fails when package.json drifts", () => {
  assert.equal(checkAgreement(seed("1.0.0")), "1.0.0")
  assert.throws(() => checkAgreement(seed("1.0.0", "1.0.1")), /disagree/i)
  assert.throws(() => checkAgreement(seed("1.0.0", "^1.0.0")), /disagree|version/i)
})

test("stampPackageJson writes the VERSION value and keeps private and other keys", () => {
  const d = seed("2.0.0", "0.0.1", { description: "keep" })
  stampPackageJson(d)
  const pj = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"))
  assert.equal(pj.version, "2.0.0")
  assert.equal(pj.description, "keep")
  assert.equal(pj.private, true)
})

test("stampPackageJson refuses an invalid VERSION and leaves package.json untouched", () => {
  const d = seed("^2.0.0", "0.0.1")
  const before = fs.readFileSync(path.join(d, "package.json"), "utf8")
  assert.throws(() => stampPackageJson(d), /version/i)
  assert.equal(fs.readFileSync(path.join(d, "package.json"), "utf8"), before)
})

test("distTag keeps prereleases off latest", () => {
  assert.equal(distTag("1.2.3"), "latest")
  assert.equal(distTag("1.2.3-rc.1"), "next")
  assert.equal(distTag("1.2.3-dev.7"), "dev")
  assert.equal(distTag("1.2.3-staging.7"), "staging")
  assert.equal(distTag("1.2.3-devel.7"), "next")
})

test("verifyChannel binds dev and staging versions to their own branch", () => {
  assert.equal(verifyChannel("1.2.3", "main"), "stable")
  assert.equal(verifyChannel("1.2.3-rc.1", "main"), "stable")
  assert.equal(verifyChannel("1.2.3-dev.4", "opencode-dev"), "dev")
  assert.equal(verifyChannel("1.2.3-staging.4", "opencode-staging"), "staging")
  assert.throws(() => verifyChannel("1.2.3-dev.4", "main"), /dev release/)
  assert.throws(() => verifyChannel("1.2.3", "opencode-dev"), /stable release/)
  assert.throws(() => verifyChannel("1.2.3-staging.4", "opencode-dev"), /staging release/)
  assert.throws(() => verifyChannel("1.2.3", "feature/x"), /not a publishing branch/)
})

test("the committed source package agrees with VERSION and stays private; publishConfig is public", SRC, () => {
  const v = checkAgreement(PKG)
  const pj = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"))
  assert.equal(pj.version, v)
  assert.equal(pj.private, true)
  assert.equal(pj.publishConfig.access, "public")
})

test("inspectPackFiles requires server.js, src, package.json, LICENSE, README and refuses dev artifacts", () => {
  const ok = ["server.js", "src/plugin.js", "package.json", "LICENSE", "README.md"]
  assert.deepEqual(inspectPackFiles(ok), [])
  assert.ok(inspectPackFiles(["server.js", "package.json"]).some((p) => /missing.*LICENSE/i.test(p)))
  for (const bad of ["test/plugin.test.js", "scripts/smoke.mjs", ".env", ".env.local", ".npmrc", "key.pem", "node_modules/x/index.js", ".DS_Store", "src/a.test.js", "RELEASING.md", "publisher/x.yml", "VERSION.bak", "id_rsa", "credentials.json"]) {
    assert.ok(inspectPackFiles([...ok, bad]).some((p) => p.includes(bad)), bad)
  }
})

test("npm pack of the real package passes inspection and contains root server.js", () => {
  const files = packFiles(PKG)
  assert.deepEqual(inspectPackFiles(files), [])
  assert.ok(files.includes("server.js"))
  assert.ok(files.includes("LICENSE"))
  assert.ok(!files.some((f) => f.startsWith("test/") || f.startsWith("scripts/")))
})

test("scanSecrets finds tokens and private keys, ignores clean files", () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, "ok.js"), "export const a = 1\n")
  assert.deepEqual(scanSecrets(d), [])
  fs.writeFileSync(path.join(d, "a.js"), "const t = 'npm_" + "a".repeat(36) + "'\n")
  fs.writeFileSync(path.join(d, "b.txt"), "-----BEGIN RSA " + "PRIVATE KEY-----\n")
  fs.writeFileSync(path.join(d, "c.js"), "x = 'ghp_" + "b".repeat(36) + "'\n")
  fs.writeFileSync(path.join(d, "d.js"), "x = 'AKIA" + "C".repeat(16) + "'\n")
  const hits = scanSecrets(d).map((h) => h.file).sort()
  assert.deepEqual(hits, ["a.js", "b.txt", "c.js", "d.js"])
})

test("scanSecrets does not walk node_modules", () => {
  const d = tmp()
  fs.mkdirSync(path.join(d, "node_modules/x"), { recursive: true })
  fs.writeFileSync(path.join(d, "node_modules/x/a.js"), "npm_" + "a".repeat(36))
  assert.deepEqual(scanSecrets(d), [])
})

test("the real package source has no secrets", () => {
  assert.deepEqual(scanSecrets(PKG), [])
})

test("stageSource copies source for the public mirror, without node_modules, and refuses a non-empty destination", () => {
  const dest = path.join(tmp(), "out")
  stageSource(PKG, dest)
  for (const f of ["server.js", "VERSION", "package.json", "LICENSE", "test/plugin.test.js", "publisher/publish-opencode-plugin.yml"]) {
    assert.ok(fs.existsSync(path.join(dest, f)), f)
  }
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")))
  const staged = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"))
  assert.equal("private" in staged, false)
  assert.equal(staged.version, fs.readFileSync(path.join(PKG, "VERSION"), "utf8").trim())
  if (IS_SOURCE) assert.equal(JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).private, true)
  assert.throws(() => stageSource(PKG, dest), /empty/)
  assert.throws(() => stageSource(PKG, path.join(PKG, "inside")), /inside|source/)
})

test("stageSource stamps a dev or staging build into VERSION and package.json of the copy only", () => {
  // The publisher runs this suite on an already-stamped public mirror too.
  // Exercise stamping from a stable fixture, independently of that mirror's version.
  const source = tmp()
  fs.cpSync(PKG, source, { recursive: true, filter: (p) => !p.includes("node_modules") })
  const base = "1.2.3"
  fs.writeFileSync(path.join(source, "VERSION"), base + "\n")
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ ...pkg, version: base }))
  const dest = path.join(tmp(), "dev")
  stageSource(source, dest, { channel: "dev", build: "12" })
  assert.equal(fs.readFileSync(path.join(dest, "VERSION"), "utf8").trim(), `${base}-dev.12`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).version, `${base}-dev.12`)
  assert.equal(fs.readFileSync(path.join(source, "VERSION"), "utf8").trim(), base)
  assert.equal(checkAgreement(dest), `${base}-dev.12`)
  assert.throws(() => stageSource(PKG, path.join(tmp(), "a"), { channel: "prod", build: "1" }), /channel/)
  assert.throws(() => stageSource(PKG, path.join(tmp(), "b"), { channel: "dev", build: "x" }), /build/)
})

test("stageSource refuses a source whose VERSION and package.json disagree", () => {
  const src = tmp()
  fs.cpSync(PKG, src, { recursive: true, filter: (p) => !p.includes("node_modules") })
  fs.writeFileSync(path.join(src, "VERSION"), "9.9.9\n")
  assert.throws(() => stageSource(src, path.join(tmp(), "o")), /disagree/i)
})

test("the publisher workflow has least permissions, the npm token only in the publish step, provenance, and a manual trigger", () => {
  const y = fs.readFileSync(path.join(PKG, "publisher/publish-opencode-plugin.yml"), "utf8")
  assert.match(y, /^permissions:\n  contents: read\n/m)
  assert.match(y, /id-token: write/)
  assert.equal((y.match(/secrets\./g) || []).length, 1)
  assert.match(y, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  assert.ok(y.indexOf("secrets.NPM_TOKEN") > y.indexOf("Publish with provenance"))
  assert.match(y, /npm publish[^\n]*--provenance/)
  assert.match(y, /workflow_dispatch:/)
  assert.doesNotMatch(y, /^\s+push:/m)
  assert.match(y, /npm test/)
  assert.match(y, /release\.mjs scan/)
  assert.match(y, /release\.mjs inspect/)
  assert.doesNotMatch(y, /(?:contents|packages|actions|workflows):\s*write/)
  assert.equal((y.match(/id-token: write/g) ?? []).length, 1)
  const [, testJob, publishJob] = y.split(/^  (?=test:|publish:)/m)
  assert.doesNotMatch(testJob, /id-token/)
  assert.match(testJob, /contents: read/)
  assert.match(publishJob, /needs: test/)
  assert.match(publishJob, /id-token: write/)
  assert.match(publishJob, /environment: npm-publish/)
  assert.doesNotMatch(publishJob, /npm test/)
  assert.match(testJob, /npm test/)
  assert.match(testJob, /cmp /)
  assert.match(testJob, /verify-newer/)
  assert.match(publishJob, /DIST_TAG/)
  assert.doesNotMatch(publishJob.match(/run: npm publish[^\n]*/)[0], /\$\(/)
})

test("the source-sync workflow only writes outside .github of the public repo", SRC, () => {
  const y = fs.readFileSync(SYNC_WF, "utf8")
  assert.match(y, /seedlinglabs\/forgebench-cli/)
  assert.match(y, /github\.ref_name == 'main'/)
  assert.match(y, /opencode-dev/)
  assert.match(y, /opencode-staging/)
  assert.doesNotMatch(y, /git add[^\n]*\.github/)
  assert.doesNotMatch(y, /npm publish\b/)
})

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })

test("checkPublished: 200 with matching name and version is published", async () => {
  const r = await checkPublished({ name: "@forgebench/opencode", version: "1.0.0", fetch: reply(200, { name: "@forgebench/opencode", version: "1.0.0" }) })
  assert.equal(r.state, "published")
})

test("checkPublished: 404 is not-published", async () => {
  const r = await checkPublished({ name: "@forgebench/opencode", version: "1.0.0", fetch: reply(404, { error: "Not found" }) })
  assert.equal(r.state, "not-published")
})

test("checkPublished: anything else is unverifiable, never published", async () => {
  for (const f of [reply(500, {}), reply(403, {}), reply(200, { name: "other", version: "1.0.0" }), reply(200, { name: "@forgebench/opencode", version: "1.0.1" }), reply(200, null), async () => { throw new Error("offline") }]) {
    const r = await checkPublished({ name: "@forgebench/opencode", version: "1.0.0", fetch: f })
    assert.equal(r.state, "unverifiable")
  }
})

test("checkPublished: refuses a range and sends only a GET to the registry with a timeout", async () => {
  await assert.rejects(checkPublished({ name: "@forgebench/opencode", version: "^1.0.0", fetch: reply(200, {}) }), /version/i)
  let seen
  await checkPublished({ name: "@forgebench/opencode", version: "1.0.0", fetch: async (url, init) => { seen = { url, init }; return { status: 404, ok: false, json: async () => ({}) } } })
  assert.equal(seen.url, "https://registry.npmjs.org/@forgebench%2fopencode/1.0.0")
  assert.ok(!seen.init?.method || seen.init.method === "GET")
  assert.ok(seen.init.signal)
  assert.equal(seen.init.headers?.authorization, undefined)
})

test("check-published CLI exit codes: 0 published, 3 not-published, 4 unverifiable (offline)", () => {
  const run = (env) => spawnSync(process.execPath, [path.join(PKG, "scripts/check-published.mjs"), "--json"], { encoding: "utf8", env: { ...process.env, ...env } })
  const r = run({ FORGEBENCH_NPM_REGISTRY: "http://127.0.0.1:9" })
  assert.equal(r.status, 4, r.stderr)
  assert.equal(JSON.parse(r.stdout).state, "unverifiable")
})

const WORKFLOWS = [path.join(PKG, "publisher/publish-opencode-plugin.yml"), SYNC_WF].filter((f) => fs.existsSync(f))

test("no workflow interpolates inputs or event data inside a run block", () => {
  for (const f of WORKFLOWS) {
    const lines = fs.readFileSync(f, "utf8").split("\n")
    let inRun = false, indent = 0
    lines.forEach((line, n) => {
      const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/)
      if (m) { inRun = true; indent = m[1].length; if (/\$\{\{\s*(inputs|github\.event)/.test(m[2])) assert.fail(`${f}:${n + 1}`); return }
      if (inRun && line.trim() && line.search(/\S/) <= indent) inRun = false
      if (inRun && /\$\{\{\s*(inputs|github\.event)/.test(line)) assert.fail(`${f}:${n + 1}: ${line}`)
    })
  }
})

test("the publisher passes the requested version through env and validates it", () => {
  const y = fs.readFileSync(WORKFLOWS[0], "utf8")
  assert.match(y, /REQUESTED_VERSION: \$\{\{ inputs\.version \}\}/)
  assert.match(y, /release\.mjs verify-requested/)
})

test("workflows pin actions by commit SHA and set job timeouts", () => {
  for (const f of WORKFLOWS) {
    const y = fs.readFileSync(f, "utf8")
    const uses = [...y.matchAll(/uses:\s*(\S+)(.*)/g)]
    assert.ok(uses.length > 0)
    for (const [, ref, rest] of uses) {
      assert.match(ref, /@[0-9a-f]{40}$/, ref)
      assert.match(rest, /#\s*v\d+\.\d+\.\d+/, ref)
    }
    const jobs = (y.match(/^  [a-z-]+:\n(?:    .*\n)*?    runs-on:/gm) ?? []).length
    assert.equal((y.match(/timeout-minutes:/g) ?? []).length, jobs)
    assert.ok(jobs > 0)
  }
})

test("verify-requested accepts only the exact VERSION", () => {
  const run = (v) => spawnSync(process.execPath, [path.join(PKG, "scripts/release.mjs"), "verify-requested"], { encoding: "utf8", env: { ...process.env, REQUESTED_VERSION: v } })
  const current = fs.readFileSync(path.join(PKG, "VERSION"), "utf8").trim()
  assert.equal(run(current).status, 0)
  for (const bad of ['x"; echo pwned; "', "^" + current, "9.9.9", ""]) assert.equal(run(bad).status, 1, bad)
})

test("guard needs the public repository in GitHub Actions, or a dry run", () => {
  const run = (env) => spawnSync(process.execPath, [path.join(PKG, "scripts/release.mjs"), "guard"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } })
  assert.equal(run({}).status, 1)
  assert.equal(run({ GITHUB_ACTIONS: "true" }).status, 1)
  assert.equal(run({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "seedlinglabs/forgebench" }).status, 1)
  assert.equal(run({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "seedlinglabs/forgebench-cli" }).status, 0)
  assert.equal(run({ npm_config_dry_run: "true" }).status, 0)
})

test("a real npm publish of the private source package is refused (EPRIVATE, before ENEEDAUTH) before any upload, with scripts off", SRC, async () => {
  const puts = []
  const server = http.createServer((q, r) => { if (q.method !== "GET") puts.push(q.method); r.writeHead(500); r.end("{}") })
  await new Promise((res) => server.listen(0, "127.0.0.1", res))
  const port = server.address().port
  const home = tmp()
  const out = await new Promise((res) => {
    const c = spawn("npm", ["publish", "--ignore-scripts", "--fetch-retries=0", `--registry=http://127.0.0.1:${port}`, `--//127.0.0.1:${port}/:_authToken=x`], { cwd: PKG, env: { ...process.env, HOME: home } })
    let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("close", (code) => res({ code, err }))
  })
  server.close()
  assert.notEqual(out.code, 0)
  assert.match(out.err, /EPRIVATE/)
  assert.deepEqual(puts, [])
})

test("a staged copy passes npm publish --dry-run", async () => {
  const dest = path.join(tmp(), "out")
  stageSource(PKG, dest)
  // Publication state is tested separately; this test checks the staged artifact.
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found" }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = server.address().port
    const result = await new Promise((resolve, reject) => {
      const child = spawn("npm", ["publish", "--dry-run", "--ignore-scripts", "--fetch-retries=0", `--registry=http://127.0.0.1:${port}`], { cwd: dest, env: { ...process.env, HOME: tmp() } })
      let err = ""
      child.stderr.on("data", (data) => (err += data))
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, err }))
    })
    assert.equal(result.code, 0, result.err)
  } finally {
    server.close()
  }
})

test("scanSecrets finds forgebench sk_ keys and ignores risk_ lookalikes", () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, "k.js"), "x = 'sk_" + "A1".repeat(20) + "'\n")
  fs.writeFileSync(path.join(d, "ok.js"), "x = 'risk_" + "A1".repeat(20) + "'\ny = 'sk_" + "a".repeat(39) + "'\n")
  assert.deepEqual(scanSecrets(d).map((h) => h.file), ["k.js"])
})

test("source-sync token is down-scoped, staging precedes the public checkout, the group is its own and the push rebases and retries", SRC, () => {
  const y = fs.readFileSync(SYNC_WF, "utf8")
  assert.match(y, /permission-contents: write/)
  assert.ok(y.indexOf("Stage source") < y.indexOf("Check out public repo"))
  assert.doesNotMatch(y, /forgebench-cli-main-sync/)
  assert.doesNotMatch(fs.readFileSync(PLUGIN_WF, "utf8"), /forgebench-cli-main-sync/)
  assert.match(y, /group: release-forgebench-opencode-/)
  assert.match(y, /for attempt in 1 2 3/)
  assert.match(y, /git fetch origin main\n\s+git rebase origin\/main/)
  assert.match(y, /test "\$pushed" -eq 1/)
})

test("source validate job tests the staged mirror shape", SRC, () => {
  const y = fs.readFileSync(SYNC_WF, "utf8")
  const v = y.slice(y.indexOf("  validate:"), y.indexOf("  sync:"))
  assert.match(v, /release\.mjs stage --destination "\$RUNNER_TEMP\/x"/)
  for (const c of ["npm test", "release.mjs scan", "release.mjs inspect"]) assert.match(v.slice(v.indexOf("RUNNER_TEMP/x")), new RegExp(c.replace(".", "\\.")))
})

test("the tarball README carries no pre-publication status", () => {
  const readme = fs.readFileSync(path.join(PKG, "README.md"), "utf8")
  assert.doesNotMatch(readme, /not published|private|H1|#1061/i)
  assert.match(fs.readFileSync(path.join(PKG, "RELEASING.md"), "utf8"), /Not published to npm yet/)
})

test("RELEASING.md carries the H1 bootstrap requirements", () => {
  const r = fs.readFileSync(path.join(PKG, "RELEASING.md"), "utf8")
  for (const re of [/explicit publication approval/i, /npm pack/, /integrity/i, /source SHA/i, /--require-clean/, /--registry https:\/\/registry\.npmjs\.org/, /www\.npmjs\.com\/package\/@forgebench\/opencode\/v\//, /provenance/i, /npm-publish/, /required reviewer/i, /SHAR=|STAGE=/]) assert.match(r, re, String(re))
  assert.doesNotMatch(r, /--destination "\$\(mktemp/)
  assert.match(r, /cd "\$STAGE"/)
})

test("stage --require-clean refuses a dirty tree and prints the source SHA", () => {
  const repo = tmp()
  fs.cpSync(PKG, repo, { recursive: true, filter: (p) => !p.includes("node_modules") })
  const git = (...a) => spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" })
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "x")
  const stage = () => spawnSync(process.execPath, [path.join(repo, "scripts/release.mjs"), "stage", "--require-clean", "--destination", path.join(tmp(), "o")], { encoding: "utf8" })
  const clean = stage()
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /source SHA [0-9a-f]{40}/)
  fs.writeFileSync(path.join(repo, "src/dirty.js"), "x")
  assert.equal(stage().status, 1)
})

test("verify-newer: stable must exceed latest; first publish, prerelease and unverifiable cases", async () => {
  const latest = (v) => reply(200, { name: "@forgebench/opencode", version: v })
  const q = (version, fetch) => checkNewer({ version, fetch })
  assert.equal((await q("1.0.0", reply(404, {}))).ok, true)
  assert.equal((await q("1.0.1", latest("1.0.0"))).ok, true)
  assert.equal((await q("1.10.0", latest("1.9.0"))).ok, true)
  assert.equal((await q("1.0.0", latest("1.0.0"))).ok, false)
  assert.equal((await q("0.9.9", latest("1.0.0"))).ok, false)
  assert.equal((await q("2.0.0-rc.1", latest("1.0.0"))).ok, true)
  assert.equal((await q("1.0.1", reply(500, {}))).ok, false)
  assert.equal((await q("1.0.1", async () => { throw new Error("x") })).ok, false)
})
