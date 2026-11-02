import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolCalls } from '../remote/tool-calls.mjs'

const registry = controller => createToolCalls({ signal: controller.signal, eventTimeoutMs: 1000,
  createError: (code, message, details) => Object.assign(new Error(message), { code, ...details }) })

test('工具登记按最终规范参数关联，审批冲突只撤销对应调用', () => {
  const calls = registry(new AbortController())
  const name = 'mcp__dsh__command'
  assert.equal(calls.register(name, { command: 'one', cwd: 'project' }, 'one'), true)
  assert.equal(calls.register(name, { cwd: 'project', command: 'one' }, 'duplicate'), false)
  assert.equal(calls.register(name, { command: 'other' }, 'one'), false)
  assert.equal(calls.rebind(name, { command: 'edited' }, 'one'), true)
  assert.equal(calls.take(name, { cwd: 'project', command: 'one' }), undefined)
  assert.equal(calls.take(name, { command: 'edited' }), 'one')
  assert.equal(calls.register(name, { command: 'one' }, 'one'), true)
  assert.equal(calls.register(name, { command: 'two' }, 'two'), true)
  assert.equal(calls.rebind(name, { command: 'two' }, 'one'), false)
  assert.equal(calls.take(name, { command: 'one' }), undefined)
  assert.equal(calls.take(name, { command: 'two' }), 'two')
  assert.equal(calls.register(name, { command: 'one' }, 'one'), true)
  calls.forget('one')
  assert.equal(calls.register(name, { command: 'one' }, 'replacement'), true)
})

test('事件等待支持先转发、后转发及释放，释放后不遗留等待器', async () => {
  const calls = registry(new AbortController())
  calls.markForwarded('before')
  await calls.waitForEvent('before')
  const after = calls.waitForEvent('after')
  calls.markForwarded('after')
  await after
  const pending = calls.waitForEvent('missing')
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  calls.dispose()
  await rejected
  calls.dispose()
})
