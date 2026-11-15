import { createHash } from "node:crypto"
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerClaudeContext } from '../dist/v2/claude-context.js'
import { fakeStorage } from './helpers.js'

test('Claude context pins once across concurrent turns and restarts; children get identity only', async () => {
  let callback, calls = 0
  const storage = fakeStorage()
  const ctx = { storage, session: {
    get: async ({sessionID}) => ({ parentID: sessionID === 'ses_child' ? 'ses_main' : undefined }),
    hook: async (name, cb, opts) => { assert.equal(name, 'context'); assert.equal(opts.providerID, 'claude-agent'); callback = cb; return {dispose: async()=>{}} },
  } }
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; await new Promise(r=>setImmediate(r)); return Response.json({ mode:'advise', version:1, advice:{text:'Delegate reviews to forgebench/reviewer.'} }) }
  try {
    await registerClaudeContext(ctx, {url:'https://gateway.example',apiKey:'private-test-key'})
    const turn = (sessionID='ses_main',providerID='claude-agent') => ({sessionID,model:{providerID},system:[],options:{claudeCodeInstructions:"base"}})
    const a=turn(), b=turn(); await Promise.all([callback(a),callback(b)])
    assert.deepEqual(a.system,b.system); assert.match(a.options.claudeCodeInstructions, /ForgeBench-OpenCode:/); assert.equal(calls,1)
    await callback(a); assert.equal(a.system.length,1)
    await registerClaudeContext(ctx, {url:'https://gateway.example',apiKey:'private-test-key'})
    const c=turn(); await callback(c); assert.deepEqual(c.system,a.system); assert.equal(calls,1)
    const child=turn('ses_child'); await callback(child)
    assert.match(child.system[0].text,/parent=ses_main/); assert.doesNotMatch(child.system[0].text,/Delegate reviews/)
    const api=turn('ses_api','forgebench'); await callback(api); assert.deepEqual(api.system,[])
  } finally { globalThis.fetch=original }
})

test('off, missing and failed policy reads pin identity without advice', async () => {
  for (const response of [()=>Response.json({mode:'off',version:1}),()=>Response.json({detail:'missing'},{status:404}),()=>{throw Error('offline')}]) {
    let cb, calls=0
    const original=globalThis.fetch
    globalThis.fetch=async()=>{calls++; return response()}
    try {
      await registerClaudeContext({ storage:fakeStorage(), session:{get:async()=>({}),hook:async(_,fn)=>{cb=fn}} },{url:'https://gateway.example',apiKey:'test'})
      for(let n=0;n<2;n++){const input={sessionID:'ses_off',model:{providerID:'claude-agent'},system:[],options:{claudeCodeInstructions:"base"}};await cb(input);assert.match(input.system[0].text,/session=ses_off parent=- policy=-/);assert.doesNotMatch(input.system[0].text,/Delegate reviews/)}
      assert.equal(calls,1)
    } finally {globalThis.fetch=original}
  }
})

test('legacy empty pin upgrades to stable identity and stays fixed after publish', async () => {
  const storage=fakeStorage();let cb,calls=0
  const scope=createHash("sha256").update("https://gateway.example\0test").digest("hex")
  await storage.set(`claude-context:${scope}:ses_legacy`, "")
  const original=globalThis.fetch
  globalThis.fetch=async()=>{calls++;return Response.json(calls===1?{mode:'off'}:{mode:'advise',version:2,advice:{text:'new advice'}})}
  const ctx={storage,session:{get:async()=>({}),hook:async(_,fn)=>{cb=fn}}}
  try {
    await registerClaudeContext(ctx,{url:'https://gateway.example',apiKey:'test'})
    const input=()=>({sessionID:'ses_legacy',model:{providerID:'claude-agent'},system:[],options:{}})
    const first=input();await cb(first)
    await registerClaudeContext(ctx,{url:'https://gateway.example',apiKey:'test'})
    const next=input();await cb(next)
    assert.deepEqual(first.system,next.system);assert.equal(calls,1)
  } finally {globalThis.fetch=original}
})
