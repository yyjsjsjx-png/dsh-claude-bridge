import test from 'node:test'
import assert from 'node:assert/strict'
import { imageCapability } from '../src/model-capabilities.mjs'

test('视觉能力使用明确目录或已核对的官方型号，未知别名不猜测', () => {
  for (const value of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
    assert.equal(imageCapability({ value }).supported, true)
  }
  assert.equal(imageCapability({ value: 'haiku', resolvedModel: 'claude-haiku-5-5[1m]' }).supported, true)
  assert.equal(imageCapability({ value: 'claude-haiku-5-5', inputModalities: ['text'] }).supported, false)
  assert.equal(imageCapability({ value: 'custom', inputModalities: ['text', 'image'] }).source, 'catalog')
  for (const model of [undefined, { value: 'account-default' }, { value: 'haiku' },
    { value: 'future', displayName: 'Claude Haiku 5.5' },
    { value: 'claude-haiku-5-5', resolvedModel: 'unknown' }, { value: 'claude-haiku-5-6' }]) {
    assert.equal(imageCapability(model).supported, undefined)
  }
})
