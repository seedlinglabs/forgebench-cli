#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseVersion, readVersion, stableGreater } from "./release-lib.mjs"

export const PACKAGE_NAME = "@forgebench/opencode"
const REGISTRY = "https://registry.npmjs.org"

export async function checkPublished({ name = PACKAGE_NAME, version, fetch: doFetch = globalThis.fetch, registry = REGISTRY, timeoutMs = 10_000 }) {
  parseVersion(version)
  const url = `${registry}/${name.replace("/", "%2f")}/${version}`
  try {
    const res = await doFetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { state: "not-published", name, version }
    if (res.status !== 200) return { state: "unverifiable", name, version, reason: `registry answered HTTP ${res.status}` }
    const body = await res.json()
    if (body?.name === name && body?.version === version) return { state: "published", name, version }
    return { state: "unverifiable", name, version, reason: "registry response did not name the exact package and version" }
  } catch (err) {
    return { state: "unverifiable", name, version, reason: `registry unreachable: ${err?.message ?? err}` }
  }
}

export async function checkNewer({ name = PACKAGE_NAME, version, fetch: doFetch = globalThis.fetch, registry = REGISTRY, timeoutMs = 10_000 }) {
  parseVersion(version)
  if (version.includes("-")) return { ok: true, reason: "prerelease is not compared with latest" }
  try {
    const res = await doFetch(`${registry}/${name.replace("/", "%2f")}/latest`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { ok: true, reason: "no latest published yet" }
    if (res.status !== 200) return { ok: false, reason: `registry answered HTTP ${res.status}` }
    const body = await res.json()
    parseVersion(body?.version)
    return stableGreater(version, body.version)
      ? { ok: true, latest: body.version }
      : { ok: false, latest: body.version, reason: `${version} is not greater than latest ${body.version}` }
  } catch (err) {
    return { ok: false, reason: `cannot verify latest: ${err?.message ?? err}` }
  }
}

const EXIT = { published: 0, "not-published": 3, unverifiable: 4 }

async function main(argv) {
  const json = argv.includes("--json")
  const i = argv.indexOf("--version")
  let version
  try {
    version = i >= 0 ? argv[i + 1] : readVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
    parseVersion(version)
  } catch (err) {
    console.error(err.message)
    return 2
  }
  const r = await checkPublished({ version, registry: process.env.FORGEBENCH_NPM_REGISTRY || REGISTRY })
  console.log(json ? JSON.stringify(r) : `${r.name}@${r.version}: ${r.state}${r.reason ? ` (${r.reason})` : ""}`)
  return EXIT[r.state]
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
