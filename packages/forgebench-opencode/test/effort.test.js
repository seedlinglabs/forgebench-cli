import test from 'node:test'
import assert from 'node:assert/strict'
import { toCatalog } from '../dist/v2/models.js'
import { model } from '../dist/v2/options.js'

test('catalog capabilities advertise wire-level effort variants', () => {
  const [entry] = toCatalog([{ id: 'reasoner', kind: 'chat', reasoning_efforts: ['low', 'high', 'turbo', 'high'] }])
  assert.deepEqual(entry.variants, [
    { id: 'low', body: { reasoning_effort: 'low' } },
    { id: 'high', body: { reasoning_effort: 'high' } },
  ])
  assert.deepEqual(toCatalog([{ id: 'plain', kind: 'chat' }])[0].variants, [])
})
test('fallback config remains compatible and accepts explicit capabilities', () => {
  assert.deepEqual(model('existing').variants, [])
  assert.deepEqual(model({ id: 'reasoner', reasoning_efforts: ['medium'] }).variants,
    [{ id: 'medium', body: { reasoning_effort: 'medium' } }])
})
