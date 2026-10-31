import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultVisibleIds, validateVisibleIds } from '../src/model-preferences.mjs'

test('默认显示指定三个家族的 5.5，目录和实际 ID 仍由官方提供', () => {
  const models = [
    { value: 'recommended', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
    { value: 'a', displayName: 'Opus 5.5' },
    { value: 'b', displayName: 'Haiku 5.5' },
    { value: 'c', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5-20261001' },
    { value: 'd', displayName: 'Sonnet 5' },
    { value: 'e', displayName: 'Fable 5.5' },
    { value: 'f', displayName: 'Opus 5.50' },
  ]
  assert.deepEqual(defaultVisibleIds(models), ['a', 'b', 'c'])
})

test('模型显示选择允许清空，拒绝重复和异常状态', () => {
  assert.deepEqual(validateVisibleIds({ enabledIds: [] }), [])
  assert.deepEqual(validateVisibleIds({ enabledIds: ['opaque-model-id'] }), ['opaque-model-id'])
  for (const value of [{ enabledIds: ['a', 'a'] }, { enabledIds: [''] }, { enabledIds: ['a'], token: 'extra' }]) {
    assert.throws(() => validateVisibleIds(value), { code: 'MODEL_PREFERENCES_INVALID' })
  }
})
