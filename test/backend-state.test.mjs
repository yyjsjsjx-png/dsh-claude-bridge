import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalogState, DisplayCatalogState, DISPLAY_CATALOG_RETRY_MS } from '../src/catalog-state.mjs'
import { MODEL_CATALOG_CACHE_MS } from '../src/catalog-cache-policy.mjs'
import { PlanUsageState, PLAN_USAGE_RETRY_MS } from '../src/plan-usage-state.mjs'
import { HistoryVerification } from '../src/history-verification.mjs'

test('模型目录状态：缓存新鲜度、在途合并与认证栅栏', () => {
  const catalog = new ModelCatalogState()
  const reply = { status: 'ok', models: [{ value: 'm' }] }
  catalog.store(reply)
  reply.models[0].value = 'changed'
  assert.equal(catalog.isFresh(), true)
  assert.deepEqual(catalog.cachedReply(), { status: 'ok', models: [{ value: 'm' }] })
  catalog.cache.time = Date.now() - MODEL_CATALOG_CACHE_MS - 1
  assert.equal(catalog.isFresh(), false)

  const owner = catalog.request(), other = catalog.request()
  const pending = Promise.resolve()
  catalog.track(pending, true, owner)
  assert.equal(catalog.joinable(), true)
  catalog.fence(owner)
  assert.equal(catalog.cache, undefined)
  assert.equal(catalog.isCurrent(owner), true, '持有复核的显式刷新采用新代次')
  assert.equal(catalog.isCurrent(other), false, '其他在途读取保持旧代次')
  catalog.fence()
  assert.equal(catalog.joinable(), false)
  catalog.settle(Promise.resolve())
  assert.equal(catalog.pending, pending, '只结算自己的在途请求')
  catalog.settle(pending)
  assert.equal(catalog.pending, undefined); assert.equal(catalog.pendingContext, undefined)

  const generation = catalog.generation
  catalog.store(reply); catalog.track(pending, false, catalog.request())
  catalog.reset()
  assert.equal(catalog.cache, undefined); assert.equal(catalog.pending, undefined)
  assert.equal(catalog.generation, generation, '换连接不推进认证代次')
})

test('显示目录状态：刷新在途与重试冷却', () => {
  const display = new DisplayCatalogState()
  assert.equal(display.refreshBlocked(), false)
  const pending = Promise.resolve()
  display.trackRefresh(pending)
  assert.equal(display.refreshBlocked(), true)
  const before = Date.now()
  display.settleRefresh(pending)
  assert.equal(display.refreshPending, undefined)
  assert.ok(display.refreshAfter >= before + DISPLAY_CATALOG_RETRY_MS)
  assert.equal(display.refreshBlocked(), true)
  display.status = { status: 'ready' }
  display.reset()
  assert.equal(display.refreshAfter, 0); assert.equal(display.status, undefined)
  assert.equal(display.refreshBlocked(), false)
})

test('额度状态：快照缓存、短期重试与失效', () => {
  const usage = new PlanUsageState()
  assert.equal(usage.isFresh(), false)
  const before = Date.now()
  usage.store({ status: 'unavailable', code: 'X' })
  assert.ok(usage.cache.until >= before + PLAN_USAGE_RETRY_MS)
  assert.deepEqual(usage.cachedValue(), { status: 'unavailable', code: 'X' })
  const pending = Promise.resolve()
  usage.track(pending)
  usage.invalidate()
  assert.equal(usage.cache, undefined); assert.equal(usage.pending, pending, '失效不丢弃在途读取')
  usage.reset()
  assert.equal(usage.pending, undefined)
})

test('历史核验：仅在同一连接与代次内有效', () => {
  const history = new HistoryVerification()
  const session = {}, transport = {}
  history.remember(session, transport, history.generation)
  assert.equal(history.matches(session, transport), true)
  assert.equal(history.matches(session, {}), false)
  history.fence()
  assert.equal(history.matches(session, transport), false)
  history.remember(session, transport, history.generation)
  history.forget(session)
  assert.equal(history.matches(session, transport), false)
})
