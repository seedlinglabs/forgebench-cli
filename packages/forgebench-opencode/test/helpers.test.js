import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { installTripwire } from "./helpers.js"

test("the CLI tripwire records a real executable invocation", () => {
  const tripwire = installTripwire()
  try {
    const child = spawnSync(tripwire.executable, ["gateway", "token"], { windowsHide: true })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 1)
    assert.match(tripwire.calls(), /forgebench/i)
  } finally {
    tripwire.restore()
  }
})
