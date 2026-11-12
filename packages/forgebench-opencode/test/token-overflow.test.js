import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createTokenSource } from "../src/token.js"
import { until } from "./support/gateway-e2e.js"

test("overflow stops reading and kills the owned process group once", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forgebench overflow "))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, "forgebench")
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => process.stdout.write("x".repeat(65537)), 1)\n`, { mode: 0o755 })
  const originalKill = process.kill.bind(process)
  const kill = t.mock.method(process, "kill", originalKill)
  t.mock.method(console, "error", () => {})
  const token = createTokenSource({ executable })
  await assert.rejects(token(), /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/)
  const kills = () => kill.mock.calls.filter((call) => call.arguments[1] === "SIGKILL")
  assert.equal(kills().length, 1)
  const group = kills()[0].arguments[0]
  assert.ok(await until(() => { try { originalKill(group, 0); return false } catch { return true } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(kills().length, 1, "later output or close killed the group again")
})
