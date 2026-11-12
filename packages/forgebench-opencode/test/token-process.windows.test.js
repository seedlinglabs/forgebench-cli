import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createTokenSource } from "../src/token.js"
import { until } from "./support/gateway-e2e.js"

test("Windows token deadline ends the bootstrap and its child", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forgebench token tree "))
  const executable = join(directory, "forgebench.exe")
  const pidFile = join(directory, "pids.json")
  const originalCwd = process.cwd()
  let pids = []
  t.after(async () => {
    process.chdir(originalCwd)
    for (const pid of pids) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  // Node interprets the CLI's first argument, `gateway`, as this fixture script.
  await copyFile(process.execPath, executable)
  await writeFile(join(directory, "gateway"), `
    const { spawn } = require("node:child_process")
    const { writeFileSync } = require("node:fs")
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] })
    writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]))
    setInterval(() => {}, 1000)
  `)
  process.chdir(directory)
  const token = createTokenSource({ executable, url: "http://127.0.0.1:9", timeoutMs: 10_000 })
  const timedOut = assert.rejects(token(), /timed out/)
  assert.ok(await until(async () => {
    try { pids = JSON.parse(await readFile(pidFile, "utf8")); return pids.length === 2 } catch { return false }
  }, 8000), "the fixture did not start both owned processes")
  const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  assert.equal(alive().length, 2)
  await timedOut
  assert.ok(await until(() => alive().length === 0, 8000), `owned processes survived the deadline: ${alive()}`)
})
