import test from 'node:test'
import assert from 'node:assert/strict'
import { createNetworkProbe, networkPongTiming, networkTimingSample } from '../src/network-timing.mjs'

test('四时间戳扣除服务端驻留，偏移范围及单程只报告估计', () => {
  assert.deepEqual(networkTimingSample({ t1: 1000, t2: 1110, t3: 1114, t4: 1024 }), {
    version: 1, stage: 'sample', roundTripMs: 24, serverResidenceMs: 4, networkRoundTripMs: 20,
    clockOffsetMs: 100, offsetLowerMs: 90, offsetUpperMs: 110,
    oneWayEstimateMs: 10, uncertaintyMs: 10, assumption: 'symmetric-path',
  })
  const asymmetric = networkTimingSample({ t1: 1000, t2: 1102, t3: 1106, t4: 1024 })
  assert.equal(asymmetric.clockOffsetMs, 92)
  assert.ok(asymmetric.offsetLowerMs <= 100 && asymmetric.offsetUpperMs >= 100)
  for (const input of [{ t1: 2, t2: 3, t3: 4, t4: 1 }, { t1: 0, t2: 3, t3: 2, t4: 10 },
    { t1: 0, t2: 3, t3: 30, t4: 10 }, { t1: 0, t2: NaN, t3: 2, t4: 10 }]) {
    assert.equal(networkTimingSample(input), undefined)
  }
})

test('服务端仅回显已验证数值，旧或无效timing不改变普通pong', () => {
  assert.deepEqual(networkPongTiming({ version: 1, probeId: 1, t1: 100, body: 'PRIVATE' }, 200, 201),
    { version: 1, probeId: 1, t1: 100, t2: 200, t3: 201 })
  for (const request of [undefined, {}, { version: 2, probeId: 1, t1: 100 },
    { version: 1, probeId: 0, t1: 100 }, { version: 1, probeId: 1, t1: Infinity }]) {
    assert.equal(networkPongTiming(request, 200, 201), undefined)
  }
})

test('单pending隔离重复、错ID、超时和关闭，旧端及无效响应诊断有界', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1000
  const diagnostics = []
  const probe = createNetworkProbe({ now: () => clock, timeoutMs: 100, onDiagnostic: row => diagnostics.push(row) })
  const first = probe.ping()
  assert.equal(probe.ping(), undefined)
  probe.pong({ ...first, probeId: 99, t2: 1105, t3: 1106 }, 1010)
  assert.equal(diagnostics.length, 0)
  const response = { ...first, t2: 1110, t3: 1114 }
  probe.pong(response, 1024)
  probe.pong(response, 1025)
  assert.equal(diagnostics.filter(row => row.stage === 'sample').length, 1)
  clock = 1050
  const second = probe.ping()
  probe.pong(response, 1060) // The prior probe cannot consume the current one.
  t.mock.timers.tick(100)
  assert.deepEqual(diagnostics.at(-1), { version: 1, stage: 'timeout' })
  probe.pong({ ...second, t2: 1160, t3: 1161 }, 1062)
  assert.equal(diagnostics.filter(row => row.stage === 'sample').length, 1)
  clock = 1200
  probe.ping(); probe.pong(undefined, 1201)
  clock = 1210
  const bad = probe.ping(); probe.pong({ ...bad, t2: null, t3: 1210 }, 1211)
  assert.equal(diagnostics.filter(row => row.stage === 'unsupported').length, 1)
  clock = 1220
  probe.ping(); probe.close()
  t.mock.timers.tick(1000)
  assert.equal(diagnostics.filter(row => row.stage === 'timeout').length, 1)
  assert.equal(probe.ping(), undefined)
})

test('晚到响应即使deadline回调尚未执行也不记录，坏时钟不抛给心跳', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1000
  const rows = []
  const probe = createNetworkProbe({ now: () => clock, timeoutMs: 100, onDiagnostic: row => rows.push(row) })
  const request = probe.ping()
  probe.pong({ ...request, t2: 1010, t3: 1011 }, 1100)
  assert.deepEqual(rows, [{ version: 1, stage: 'timeout' }])
  clock = NaN
  assert.equal(probe.ping(), undefined)
  assert.equal(rows.at(-1).code, 'NETWORK_CLOCK_INVALID')
  const broken = createNetworkProbe({ now: () => { throw Error('private error') }, timeoutMs: 100,
    onDiagnostic: () => { throw Error('optional diagnostics') } })
  assert.doesNotThrow(() => broken.ping())
  broken.close(); probe.close()
})
