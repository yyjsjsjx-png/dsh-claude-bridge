import test from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_OBSERVATION_RECORD, sdkModelName, initialModelObservation, applyModelObservation } from '../src/model-observation.mjs'

const header = model => ({ type: 'request/header', data: { header: { config: { provider: 'claude-sdk-remote', model } } } })
const observation = (actualModel, responseId = 'response-1') => ({ type: MODEL_OBSERVATION_RECORD, ignorable: true,
  data: { version: 1, runId: 'run-1', responseId, turn: 1, step: 1, requestedModel: 'sonnet', actualModel,
    source: actualModel === null ? null : 'sdk-message-start' } })

test('独立型号观察只折叠SDK证据；新请求和未知新响应清掉旧实际型号，旧assistant及init不作证明', () => {
  let state = applyModelObservation(initialModelObservation(), header('sonnet'))
  for (const event of [{ type: 'assistant/message', data: { message: { source: { model: 'old-or-requested' } } } },
    { type: 'system', subtype: 'init', model: 'init-only' }, { ...observation('not-ignorable'), ignorable: false }]) {
    state = applyModelObservation(state, event)
    assert.equal(state.current, null)
  }
  state = applyModelObservation(state, observation('claude-sonnet-wire'))
  assert.equal(state.current.actualModel, 'claude-sonnet-wire')
  state = applyModelObservation(state, observation(null, 'response-2'))
  assert.equal(state.current.actualModel, null)
  state = applyModelObservation(state, observation('different-wire', 'response-3'))
  assert.equal(state.current.actualModel, 'different-wire')
  state = applyModelObservation(state, header('sonnet'))
  assert.equal(state.current, null)
  state = applyModelObservation(state, header('haiku'))
  assert.equal(applyModelObservation(state, observation('stale-sonnet')).current, null)
  assert.equal(applyModelObservation(null, observation('ordinary')), null)
})

test('SDK型号保留原始别名或wire字符串，不接受synthetic、空白和控制符，也不推断降级', () => {
  assert.equal(sdkModelName('sonnet'), 'sonnet')
  assert.equal(sdkModelName('claude-sonnet-wire'), 'claude-sonnet-wire')
  for (const value of [undefined, null, '', '<synthetic>', ' sonnet', 'bad\nmodel', 'a'.repeat(257)]) {
    assert.equal(sdkModelName(value), null)
  }
})
