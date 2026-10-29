import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ID = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)"
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${ID}(?:\\.${ID})*))?$`)

export function parseVersion(value) {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`invalid version ${JSON.stringify(value)}: need an exact semantic version such as 1.2.3 or 1.2.3-rc.1`)
  }
  return value
}

export function readVersion(dir) {
  const file = path.join(dir, "VERSION")
  let raw
  try { raw = fs.readFileSync(file, "utf8") } catch { throw new Error(`cannot read ${file}`) }
  return parseVersion(raw.endsWith("\n") ? raw.slice(0, -1) : raw)
}

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))

export function checkAgreement(dir) {
  const version = readVersion(dir)
  const pkg = readPkg(dir).version
  if (pkg !== version) throw new Error(`VERSION (${version}) and package.json (${pkg}) disagree; run: node scripts/release.mjs stamp`)
  return version
}

export function stampPackageJson(dir) {
  const version = readVersion(dir)
  const pkg = readPkg(dir)
  pkg.version = version
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
  return version
}

// Prereleases never take `latest`. The dev and staging editions publish as X.Y.Z-<channel>.<build> under their own tag.
export const CHANNELS = ["dev", "staging"]
export function distTag(version) {
  const pre = parseVersion(version).split("-")[1]
  if (pre === undefined) return "latest"
  const channel = pre.split(".")[0]
  return CHANNELS.includes(channel) ? channel : "next"
}

// The public branch each channel is mirrored to and published from; stable stays on main.
export const CHANNEL_BRANCH = { stable: "main", dev: "opencode-dev", staging: "opencode-staging" }

// The channel a version belongs to: stable, dev, staging, or "next" for any other prerelease.
export function versionChannel(version) {
  const tag = distTag(version)
  return tag === "latest" ? "stable" : tag
}

export function verifyChannel(version, ref) {
  const channel = Object.keys(CHANNEL_BRANCH).find((c) => CHANNEL_BRANCH[c] === ref)
  if (!channel) throw new Error(`ref ${JSON.stringify(ref)} is not a publishing branch (${Object.values(CHANNEL_BRANCH).join(", ")})`)
  const actual = versionChannel(version)
  // main also carries manual prereleases (npm tag next); only dev/staging versions are bound to their branch.
  const ok = channel === "stable" ? actual === "stable" || actual === "next" : actual === channel
  if (!ok) throw new Error(`version ${version} is a ${actual} release and cannot be published from ${ref}`)
  return channel
}

const REQUIRED = ["server.js", "package.json", "LICENSE", "README.md"]
const FORBIDDEN = [
  [/^(test|tests|scripts|publisher|node_modules|\.github)\//, "development directory"],
  [/(^|\/)\.env(\..*)?$/, "environment file"],
  [/(^|\/)\.npmrc$/, "npm credentials"],
  [/\.(pem|key|p12|pfx)$/i, "key material"],
  [/(^|\/)id_(rsa|ed25519|ecdsa)/, "ssh key"],
  [/(^|\/)credentials[^/]*$/i, "credentials file"],
  [/(^|\/)\.DS_Store$/, "OS artifact"],
  [/\.test\.[cm]?js$/, "test file"],
  [/(^|\/)(RELEASING\.md|VERSION[^/]*)$/, "release metadata"],
]

export function inspectPackFiles(files) {
  const problems = []
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`missing ${r}`)
  if (!files.some((f) => f.startsWith("src/"))) problems.push("missing src/")
  for (const f of files) for (const [re, why] of FORBIDDEN) if (re.test(f)) problems.push(`${f}: ${why}`)
  return problems
}

export function packFiles(dir) {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`)
  return JSON.parse(r.stdout)[0].files.map((f) => f.path).sort()
}

const SECRET_PATTERNS = [
  ["npm token", /npm_[A-Za-z0-9]{36}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["API key", /sk-[A-Za-z0-9_-]{32,}/],
  ["ForgeBench API key", /(?<![A-Za-z0-9])sk_[A-Za-z0-9]{40}(?![A-Za-z0-9])/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
]

export function scanSecrets(dir) {
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile()) continue
      const text = fs.readFileSync(p, "latin1")
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(text)) hits.push({ file: path.relative(dir, p), label })
      }
    }
  }
  walk(dir)
  return hits
}

export function stageSource(source, destination, { channel, build } = {}) {
  source = path.resolve(source)
  destination = path.resolve(destination)
  if (destination === source || destination.startsWith(source + path.sep)) {
    throw new Error("destination must not be the source or inside the source")
  }
  checkAgreement(source)
  const leaks = scanSecrets(source)
  if (leaks.length) throw new Error(`secrets found: ${leaks.map((h) => `${h.file} (${h.label})`).join(", ")}`)
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error(`destination must be empty: ${destination}`)
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (p) => !["node_modules", ".git", ".DS_Store"].includes(path.basename(p)) && !p.endsWith(".tgz"),
  })
  const staged = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"))
  delete staged.private
  if (channel) {
    if (!CHANNELS.includes(channel)) throw new Error(`unknown channel ${JSON.stringify(channel)}`)
    if (!/^[1-9]\d*$/.test(String(build))) throw new Error("--build must be a positive integer")
    if (staged.version.includes("-")) throw new Error(`channel builds derive from a stable VERSION, got ${staged.version}`)
    staged.version = parseVersion(`${staged.version}-${channel}.${build}`)
    fs.writeFileSync(path.join(destination, "VERSION"), staged.version + "\n")
  }
  fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify(staged, null, 2) + "\n")
  return destination
}

export function stableGreater(a, b) {
  const n = (v) => parseVersion(v).split("-")[0].split(".").map(Number)
  const [x, y] = [n(a), n(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
