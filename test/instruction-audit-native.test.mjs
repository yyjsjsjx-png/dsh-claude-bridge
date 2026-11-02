import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { BridgeBackend } from '../src/backend.mjs'
import { assertPreparedInstructionAudit } from '../src/instruction-audit.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-instruction-audit-'))
  const homes = [join(directory, 'dsh-home'), join(directory, 'agents-home')]
  for (const home of homes) await mkdir(home)
  const previous = [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME]
  ;[process.env.DSH_HOME, process.env.DSH_AGENTS_HOME] = homes
  let ctx
  const scopes = []
  t.after(async () => {
    try {
      for (const scope of scopes.reverse()) await scope.dispose()
      await ctx?.fiber.dispose()
    } finally {
      for (const [index, key] of ['DSH_HOME', 'DSH_AGENTS_HOME'].entries()) {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]
      }
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('dsh-instruction-audit-')) throw new Error('测试目录无效')
      await rm(directory, { recursive: true, force: true })
    }
  })
  // Homes are isolated before importing or mounting the native instruction loader.
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
  const [{ Context }, { createScope, scopeTarget }, { Session, SESSION_FORMAT_VERSION }, { AgentRegistry, agentEvents }, loop]
    = await Promise.all([load('cordis'), load('dsh-scope'), load('dsh-session'), load('dsh-agent'), load('dsh-agent-loop')])
  ctx = new Context()
  for (const [name, config] of [['dsh-system-prompt', {}], ['dsh-session-projection', {}],
    ['dsh-fs-local', { cwd: directory }], ['dsh-working-directory', { defaultDirectory: directory }]]) {
    const module = await load(name)
    await ctx.plugin(module.default ?? module, config)
  }
  await ctx.plugin(AgentRegistry)
  ctx.sessionProjections.register(loop.turnBoundaryProjectionDefinition)
  const failures = new Set(), metadataFailures = new Set(), unknownVersions = new Set(), hiddenSizes = new Set()
  const ensureGates = new Map(), streamGates = new Map(), failedReads = new Map(), targetPaths = new Map()
  const originalResolve = ctx.fs.resolve.bind(ctx.fs), originalStat = ctx.fs.stat.bind(ctx.fs)
  const originalStream = ctx.fs.streamText.bind(ctx.fs), originalEnsure = ctx.workingDirectory.ensure.bind(ctx.workingDirectory)
  t.mock.method(ctx.fs, 'resolve', async (...args) => {
    const target = await originalResolve(...args); targetPaths.set(target, resolve(args[0])); return target
  })
  t.mock.method(ctx.fs, 'stat', async (...args) => {
    const path = targetPaths.get(args[0])
    if (metadataFailures.has(path)) throw Object.assign(new Error('controlled metadata failure'), { code: 'EACCES' })
    const info = await originalStat(...args)
    return info && { ...info, ...(unknownVersions.has(path) ? { version: undefined } : {}),
      ...(hiddenSizes.has(path) ? { size: undefined } : {}) }
  })
  t.mock.method(ctx.fs, 'streamText', async (...args) => {
    const path = targetPaths.get(args[0]), gate = streamGates.get(path)
    gate?.entered.resolve()
    if (gate) await gate.release.promise
    if (failures.has(path)) {
      failedReads.get(path)?.resolve()
      throw Object.assign(new Error('controlled read failure'), { code: 'EACCES' })
    }
    return originalStream(...args)
  })
  t.mock.method(ctx.workingDirectory, 'ensure', async (...args) => {
    const cwd = await originalEnsure(...args), gate = ensureGates.get(args[0])
    gate?.entered.resolve()
    if (gate) await gate.release.promise
    return cwd
  })
  const generation = {}, generationScope = createScope(ctx, generation)
  scopes.push(generationScope)
  const wrapped = await import('../plugin/instruction-audit-plugin.mjs')
  await generationScope.ctx.plugin(wrapped, { maxBytes: 65536, maxSourceBytes: 128 })
  let nextId = 0
  const workspace = async name => {
    const path = join(directory, name); await mkdir(join(path, '.git'), { recursive: true }); return path
  }
  const agent = async (cwd, ordinary = false) => {
    const key = { id: `instruction-agent-${++nextId}`, inject(message) { this.inbox.nextStep.push(message) } }
    const scope = createScope(ctx, key, ordinary ? undefined : { parent: generation })
    scopes.push(scope); key.ctx = scope.ctx
    key.session = Session.create(key.id, undefined, { id: key.id, version: SESSION_FORMAT_VERSION,
      createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: ordinary ? 'standard' : 'claude-sdk-remote', cwd })
    key.inbox = { nextStep: [], remove(id) { this.nextStep = this.nextStep.filter(message => message.id !== id) },
      prepend(_queue, message) { this.nextStep.unshift(message) },
      replace(id, message) { this.nextStep.splice(this.nextStep.findIndex(item => item.id === id), 1, message) } }
    key.runtimeContext = { project() { return undefined } }
    if (ordinary) {
      const official = await load('dsh-agent-instructions')
      await scope.ctx.plugin(official, { maxBytes: 65536, maxSourceBytes: 128 })
    }
    return key
  }
  const step = (key, number = 1) => {
    const messages = [{ id: `synthetic-${key.id}-${number}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '合成指令验收请求' }] }]
    return agentEvents(ctx, key).waterfall('agent/pre-step', {
      messages, turn: 1, step: number, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages }))
  }
  const persist = (key, decision) => {
    for (const message of decision.messages.filter(message => message.source.kind === 'agent-instructions')) {
      key.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  const backend = { helpers: { assembleContextFor() { return {} }, renderContextSections() { return [] }, joinContextSections() { return '' } },
    ctx: { systemPrompt: { refreshContext() { return {} } } } }
  const prepare = (key, messages) => BridgeBackend.prototype.prepareMessages.call(backend, key, {}, messages, new AbortController().signal)
  const auditRows = key => key.session.snapshotEvents().filter(event => event.type === 'plugin:claude-bridge/instruction-audit')
  return { ctx, homes, directory, workspace, agent, step, persist, prepare, auditRows, agentEvents,
    toolResult: (key, exec, result) => ctx.emit(scopeTarget(ctx, key), 'tools/result', exec, result),
    failures, metadataFailures, unknownVersions, hiddenSizes, ensureGates, streamGates, failedReads }
}

test('实际 rc5：原生指令来源诊断仅约束远程预设并核对最终请求', { skip: !native, timeout: 30000 }, async t => {
  const f = await fixture(t)
  await t.test('缺失候选、空文件和同组trim去重保持；跨组相同内容分别注入，版本unknown不伪造', async () => {
    const cwd = await f.workspace('dedup'), file = join(cwd, 'AGENTS.md')
    await writeFile(join(f.homes[0], 'AGENTS.md'), ' SHARED_SYNTHETIC ')
    await writeFile(join(f.homes[1], 'AGENTS.md'), 'SHARED_SYNTHETIC')
    await writeFile(file, 'SHARED_SYNTHETIC')
    await writeFile(join(cwd, 'CLAUDE.local.md'), '')
    f.unknownVersions.add(file)
    const agent = await f.agent(cwd), decision = await f.step(agent)
    f.prepare(agent, decision.messages)
    const report = f.auditRows(agent).at(-1).data
    assert.equal(report.phase, 'prepared')
    assert.equal(report.sources.filter(source => source.disposition === 'deduplicated').length, 1)
    assert.equal(report.sources.filter(source => source.disposition === 'represented').length, 3)
    assert.equal(report.sources.find(source => source.scope === '.\0AGENTS.md').providerVersion.status, 'unknown')
    assert.ok(report.sources.some(source => source.bytes === 0))
    assert.equal(JSON.stringify(report).includes('SHARED_SYNTHETIC'), false)
    await unlink(join(f.homes[0], 'AGENTS.md')); await unlink(join(f.homes[1], 'AGENTS.md'))
  })
  await t.test('超大metadata、流超限、探测失败和读取失败分别拒绝；普通scope仍保留原生行为', async () => {
    for (const kind of ['large', 'stream-large', 'metadata', 'read']) {
      const cwd = await f.workspace(kind), file = join(cwd, 'AGENTS.md')
      await writeFile(file, kind.includes('large') ? 'X'.repeat(200) : 'SYNTHETIC_ONLY')
      if (kind === 'stream-large') f.hiddenSizes.add(file)
      if (kind === 'metadata') f.metadataFailures.add(file)
      if (kind === 'read') f.failures.add(file)
      const agent = await f.agent(cwd)
      await assert.rejects(f.step(agent), { code: kind.includes('large') ? 'INSTRUCTION_SOURCE_TOO_LARGE'
        : kind === 'metadata' ? 'INSTRUCTION_SOURCE_UNAVAILABLE' : 'INSTRUCTION_SOURCE_READ_FAILED' })
      assert.equal(f.auditRows(agent).at(-1).data.phase, 'blocked')
      const ordinary = await f.agent(cwd, true)
      const normal = await f.step(ordinary)
      assert.equal(normal.kind, 'enter')
      assert.equal(f.auditRows(ordinary).length, 0)
      assertPreparedInstructionAudit(ordinary, normal.messages)
    }
  })
  await t.test('后续hook删改新指令时最终Backend门禁拒绝，本地先追加同消息也不冒充送达', async () => {
    const cwd = await f.workspace('final-boundary'); await writeFile(join(cwd, 'AGENTS.md'), 'FINAL_SYNTHETIC')
    const agent = await f.agent(cwd), decision = await f.step(agent)
    f.prepare(agent, decision.messages)
    f.persist(agent, decision)
    const removed = decision.messages.filter(message => message.source.kind !== 'agent-instructions')
    assert.throws(() => f.prepare(agent, removed), { code: 'INSTRUCTION_CONTEXT_INCOMPLETE' })
    const modified = decision.messages.map(message => message.source.kind === 'agent-instructions'
      ? { ...message, content: [{ type: 'text', text: 'CHANGED_SYNTHETIC' }] } : message)
    assert.throws(() => f.prepare(agent, modified), { code: 'INSTRUCTION_CONTEXT_INCOMPLETE' })
  })
  await t.test('两个agent交错ensure与stream时失败只归实际compose的agent', async () => {
    const cwdA = await f.workspace('concurrent-a'), cwdB = await f.workspace('concurrent-b')
    const pathA = join(cwdA, 'AGENTS.md'), pathB = join(cwdB, 'AGENTS.md')
    await writeFile(pathA, 'AGENT_A_SYNTHETIC'); await writeFile(pathB, 'AGENT_B_SYNTHETIC')
    const a = await f.agent(cwdA), b = await f.agent(cwdB)
    const ensure = { entered: deferred(), release: deferred() }, stream = { entered: deferred(), release: deferred() }
    f.ensureGates.set(a, ensure); f.streamGates.set(pathB, stream); f.failures.add(pathA)
    const failed = assert.rejects(f.step(a), { code: 'INSTRUCTION_SOURCE_READ_FAILED' })
    await ensure.entered.promise
    const healthy = f.step(b)
    await stream.entered.promise
    ensure.release.resolve(); await failed
    stream.release.resolve()
    const decision = await healthy
    f.prepare(b, decision.messages)
    assert.equal(f.auditRows(b).at(-1).data.phase, 'prepared')
    assert.equal(f.auditRows(a).at(-1).data.phase, 'blocked')
  })
  await t.test('父执行合并子touch的后台失败保留到对应agent下一步，健康重读后解除', async () => {
    const cwdA = await f.workspace('touch-a'), cwdB = await f.workspace('touch-b')
    const pathA = join(cwdA, 'AGENTS.md')
    await writeFile(pathA, 'FIRST_SYNTHETIC'); await writeFile(join(cwdB, 'AGENTS.md'), 'OTHER_SYNTHETIC')
    const a = await f.agent(cwdA), b = await f.agent(cwdB)
    f.persist(a, await f.step(a)); f.persist(b, await f.step(b))
    await writeFile(pathA, 'CHANGED_SYNTHETIC_CONTENT')
    f.failures.add(pathA)
    const observed = deferred(); f.failedReads.set(pathA, observed)
    const rootToken = Symbol('root'), signal = new AbortController().signal
    f.toolResult(a, { token: Symbol('child'), parent: rootToken, agent: a,
      name: 'read', arguments: { file_path: pathA }, signal }, { isError: false })
    f.toolResult(b, { token: rootToken, agent: b, name: 'synthetic-parent', arguments: {}, signal }, { isError: false })
    await observed.promise
    await assert.rejects(f.step(a, 2), { code: 'INSTRUCTION_SOURCE_READ_FAILED' })
    assert.equal((await f.step(b, 2)).kind, 'enter')
    f.failures.delete(pathA)
    f.toolResult(a, { token: Symbol('retry'), agent: a,
      name: 'read', arguments: { file_path: pathA }, signal }, { isError: false })
    const resumed = await f.step(a, 3)
    f.prepare(a, resumed.messages)
    assert.equal(f.auditRows(a).at(-1).data.phase, 'prepared')
  })
  await t.test('原生working-directory改变后采用实际cwd，旧未注入兄弟目录失败不污染新基线', async () => {
    const root = await f.workspace('cwd'), subA = join(root, 'sub-a'), subB = join(root, 'sub-b')
    await mkdir(subA); await mkdir(subB)
    const pathA = join(subA, 'AGENTS.md')
    await writeFile(pathA, 'CWD_A_SYNTHETIC'); await writeFile(join(subB, 'AGENTS.md'), 'CWD_B_SYNTHETIC')
    const agent = await f.agent(root)
    agent.session.append('working-directory/change', { cwd: subA })
    f.failures.add(pathA)
    await assert.rejects(f.step(agent), { code: 'INSTRUCTION_SOURCE_READ_FAILED' })
    agent.session.append('working-directory/change', { cwd: subB })
    const decision = await f.step(agent, 2)
    f.prepare(agent, decision.messages)
    assert.equal(agent.session.header.cwd, root)
    assert.equal(f.auditRows(agent).at(-1).data.phase, 'prepared')
  })
})
