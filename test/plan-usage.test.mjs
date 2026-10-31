import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { planUsageSnapshot, sanitizePlanUsage, planUsageFreshUntil, PLAN_USAGE_MAX_AGE_MS } from '../src/plan-usage.mjs'
import { createPlanUsageReader } from '../remote/plan-usage.mjs'

test('额度只取官方窗口百分比，支持 Fable，并剥离账号及聊天统计', () => {
  const now = Date.now()
  const reset = new Date(now + 300_000).toISOString()
  const snapshot = planUsageSnapshot({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 88, resets_at: reset }, seven_day: { utilization: 76, resets_at: reset },
    model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: reset }],
  }, session: { private: 'session-details' }, behaviors: { private: 'transcript-details' } }, now)
  assert.deepEqual(snapshot.windows.map(row => [row.name, 100 - row.usedPercent]), [
    ['5 小时', 12], ['周额度', 24], ['Fable', 60],
  ])
  assert.equal(snapshot.source, 'sdk-plan-usage')
  assert.equal(snapshot.windows[2].scope, 'model-weekly')
  assert.equal(snapshot.expiresAt, now + PLAN_USAGE_MAX_AGE_MS)
  assert.equal(JSON.stringify(snapshot).includes('private'), false)
  assert.deepEqual(sanitizePlanUsage(snapshot, now), snapshot)
  assert.equal(planUsageFreshUntil(snapshot), now + 30_000)
})

test('额度边界保留安全错误分类，未知错误和正文不会透传', () => {
  assert.deepEqual(sanitizePlanUsage({ status: 'unavailable', code: 'AUTH_EXPIRED', private: 'secret' }),
    { status: 'unavailable', code: 'AUTH_EXPIRED' })
  assert.deepEqual(sanitizePlanUsage({ status: 'unavailable', code: 'private-account-detail' }),
    { status: 'unavailable', code: 'QUOTA_READ_FAILED' })
})

test('无额度、空值、非法比例或已重置的窗口不能冒充 100% 剩余', () => {
  const now = Date.now()
  for (const utilization of [null, undefined, -1, 101, '0']) {
    assert.equal(planUsageSnapshot({ rate_limits_available: true,
      rate_limits: { five_hour: { utilization, resets_at: null } } }, now).status, 'unavailable')
  }
  assert.equal(planUsageSnapshot({ rate_limits_available: false,
    rate_limits: { five_hour: { utilization: 0, resets_at: null } } }, now).status, 'unavailable')
  const snapshot = planUsageSnapshot({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 0, resets_at: new Date(now + 1000).toISOString() },
  } }, now)
  assert.equal(snapshot.windows[0].usedPercent, 0)
  assert.equal(planUsageFreshUntil(snapshot), now + 1000)
  assert.equal(sanitizePlanUsage(snapshot, now + 1000).status, 'unavailable')
  assert.equal(sanitizePlanUsage(snapshot, now + PLAN_USAGE_MAX_AGE_MS).status, 'unavailable')
})

test('额度读取不提交提示词、不持久化会话，强制跳过聊天扫描并可靠关闭', async t => {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'dsh-plan-usage-'))
  t.after(async () => {
    if (dirname(resolve(root)) !== parent || !root.startsWith(join(parent, 'dsh-plan-usage-'))) throw new Error('临时目录不匹配')
    await rm(root, { recursive: true, force: true })
  })
  let request, opts, closed = 0, supported = true
  const reader = createPlanUsageReader({ sessionRoot: root, cliPath: '/isolated/claude', childEnv: {}, sdk: {
    query(value) {
      request = value
      return { async initializationResult() {}, close() { closed++ },
        ...(supported ? { async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(value) {
          opts = value
          return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: null } },
            behaviors: null, session: { private: true } }
        } } : {}),
      }
    },
  } })
  const snapshot = await reader.read()
  assert.equal(snapshot.status, 'available')
  assert.deepEqual(opts, { skipBehaviors: true })
  assert.equal(request.options.persistSession, false)
  assert.deepEqual(request.options.tools, [])
  assert.deepEqual(request.options.settingSources, [])
  assert.equal(request.options.strictMcpConfig, true)
  assert.equal((await request.prompt.next()).done, true)
  assert.equal(closed, 1)
  supported = false
  assert.equal((await reader.read()).code, 'SDK_QUOTA_UNAVAILABLE')
  assert.equal(closed, 2)
  await reader.close()
})
