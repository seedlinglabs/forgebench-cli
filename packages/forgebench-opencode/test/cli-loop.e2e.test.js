// FB-242 full loop: the plugin's executable is the real CLI (`python -m forgebench_session_reviewer.cli`)
// reading its own per-URL key store. Needs a python that can import the CLI, so it runs from the CLI's
// pytest suite (tests/test_gateway_token_e2e.py), which sets FORGEBENCH_CLI_PYTHON.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { setup } from "../src/plugin.js"
import { assertNoKey, captureOutput, fakeCtx, send, startGateway, until } from "./support/gateway-e2e.js"

const PYTHON = process.env.FORGEBENCH_CLI_PYTHON
const CLI_ROOT = process.env.FORGEBENCH_CLI_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../cli-session-reviewer")
const K1 = "fbk_fb242_cli_saved_key"
const K2 = "fbk_fb242_cli_rotated_key"
const TTL = 1000
const sh = (value) => `'${value.replaceAll("'", `'\\''`)}'`

test("14. the plugin keeps the last good key when the real CLI's store goes bad", {
  skip: PYTHON ? false : "set FORGEBENCH_CLI_PYTHON to a python that can import forgebench_session_reviewer",
}, async (t) => {
  const logs = captureOutput(t)
  const dir = await mkdtemp(join(tmpdir(), "fb242 cli loop "))
  const state = join(dir, "state")
  const spawnLog = join(dir, "spawns.log")
  const gateway = await startGateway([K1, K2])
  t.after(async () => {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  const env = { ...process.env, HOME: join(dir, "home"), FORGEBENCH_STATE_DIR: state, PYTHONPATH: CLI_ROOT }
  delete env.FORGEBENCH_GATEWAY_KEY
  const saveKey = (key) => promisify(execFile)(PYTHON, ["-c",
    "import sys; from forgebench_session_reviewer import auth; auth.save_gateway_key(sys.argv[1], sys.argv[2])",
    gateway.url, key], { env })
  const executable = join(dir, "forgebench")
  await writeFile(executable, `#!/bin/sh
unset FORGEBENCH_GATEWAY_KEY
echo start >> ${sh(spawnLog)}
HOME=${sh(env.HOME)} FORGEBENCH_STATE_DIR=${sh(state)} PYTHONPATH=${sh(CLI_ROOT)} ${sh(PYTHON)} -m forgebench_session_reviewer.cli "$@"
rc=$?
echo end >> ${sh(spawnLog)}
exit $rc
`, { mode: 0o755 })
  const count = async (word) => (await readFile(spawnLog, "utf8").catch(() => "")).split("\n").filter((l) => l === word).length

  await saveKey(K1)
  let clock = 0
  const { ctx, reg } = fakeCtx({ gateway: true, url: `${gateway.url}/`, executable, models: ["gpt-5"] })
  await setup(ctx, { token: { ttlMs: TTL, now: () => clock } })
  const request = () => send(reg, gateway, { retry: false })
  const sent = (attempts, key) => {
    assert.equal(attempts[0].status, 200, JSON.stringify(attempts))
    assert.equal(attempts[0].authorization, `Bearer ${key}`)
  }

  sent(await request(), K1)
  sent(await request(), K1)
  assert.equal(await count("start"), 1)

  for (const breakStore of [
    () => writeFile(join(state, "gateway-keys.json"), "{not json"),
    () => rm(join(state, "gateway-keys.json"), { force: true }),
  ]) {
    clock += TTL
    await breakStore()
    const spawned = await count("end")
    sent(await request(), K1)
    assert.ok(await until(() => count("end").then((n) => n > spawned), 15000), "the CLI refresh never finished")
    sent(await request(), K1)
  }

  await saveKey(K2)
  clock += TTL
  let last
  assert.ok(await until(async () => {
    last = await request()
    return last[0].authorization === `Bearer ${K2}`
  }, 15000), `never picked up the re-saved key: ${JSON.stringify(last)}`)
  assertNoKey(logs(), K1, K2)
})
