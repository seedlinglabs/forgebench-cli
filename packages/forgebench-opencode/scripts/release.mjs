#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkNewer } from "./check-published.mjs"
import { parseVersion, verifyChannel, checkAgreement, distTag, inspectPackFiles, packFiles, readVersion, scanSecrets, stageSource, stampPackageJson } from "./release-lib.mjs"

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const dir = path.resolve(flag("--dir") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."))
const cmd = argv[0]

try {
  switch (cmd) {
    case "version": console.log(readVersion(dir)); break
    case "stamp": console.log(`stamped ${stampPackageJson(dir)}`); break
    case "check": console.log(`ok ${checkAgreement(dir)}`); break
    case "tag": console.log(distTag(checkAgreement(dir))); break
    case "inspect": {
      const files = packFiles(dir)
      console.log(files.join("\n"))
      const problems = inspectPackFiles(files)
      if (problems.length) throw new Error(`pack inspection failed:\n${problems.join("\n")}`)
      console.log(`pack ok (${files.length} files)`)
      break
    }
    case "scan": {
      const hits = scanSecrets(dir)
      if (hits.length) throw new Error(`secret scan failed:\n${hits.map((h) => `${h.file}: ${h.label}`).join("\n")}`)
      console.log("secret scan ok")
      break
    }
    case "guard": {
      checkAgreement(dir)
      const inPublisher = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY === "seedlinglabs/forgebench-cli"
      if (!inPublisher && process.env.npm_config_dry_run !== "true") {
        throw new Error("publishing is only allowed from the public publisher workflow (or with --dry-run); see RELEASING.md for the H1 bootstrap")
      }
      break
    }
    case "verify-requested": {
      const requested = parseVersion(process.env.REQUESTED_VERSION)
      const actual = readVersion(dir)
      if (requested !== actual) throw new Error(`requested ${requested} but VERSION is ${actual}`)
      console.log(`ok ${actual}`)
      break
    }
    case "verify-channel": {
      const channel = verifyChannel(readVersion(dir), process.env.PUBLISH_REF)
      console.log(`ok ${channel}`)
      break
    }
    case "verify-newer": {
      const res = await checkNewer({ version: readVersion(dir), registry: process.env.FORGEBENCH_NPM_REGISTRY || undefined })
      if (!res.ok) throw new Error(`version gate failed: ${res.reason}`)
      console.log(`ok ${res.latest ? `> ${res.latest}` : res.reason}`)
      break
    }
    case "stage": {
      const dest = flag("--destination")
      if (!dest) throw new Error("--destination is required")
      const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" })
      const sha = git("rev-parse", "HEAD")
      if (argv.includes("--require-clean")) {
        if (sha.status !== 0) throw new Error("--require-clean needs a git checkout")
        if (git("status", "--porcelain", "--", ".").stdout.trim()) throw new Error("working tree is dirty; stage from a clean checkout of a named commit")
      }
      const channel = flag("--channel")
      console.log(`staged ${stageSource(dir, dest, { channel, build: flag("--build") })}`)
      if (sha.status === 0) console.log(`source SHA ${sha.stdout.trim()}`)
      break
    }
    default: throw new Error("usage: release.mjs version|stamp|check|tag|inspect|scan|guard|stage --destination <dir> [--channel dev|staging --build <n>]|verify-requested|verify-channel")
  }
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
