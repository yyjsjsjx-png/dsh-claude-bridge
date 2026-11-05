import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { executeNativeTool } from './fixtures/native-tools.mjs'

const native = Boolean(process.platform === 'win32' && process.versions.electron
  && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const quotePwsh = value => `'${value.replaceAll("'", "''")}'`
const outputText = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

// Uses the installed executor, subprocess provider, filesystem, tool pipeline,
// approval service and Session. Only the Agent carrier and approval answerer
// are controlled here; this does not exercise the desktop approval UI or SDK.
test('实际 rc5 Windows：PowerShell 执行、审批、超时、取消及原生日志回放', {
  skip: !native, timeout: 45000,
}, async t => {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    return module.default ?? module
  }
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'))
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const { TOOL_ABORTED } = await import(resolveDshModule('@deepseek-ai/dsh-tools'))
  const { createAssistantMessage, createToolResultMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-shell-'))
  const workdir = join(directory, 'workspace')
  await mkdir(workdir)
  const ctx = new Context()
  try {
    for (const [name, config] of [
      ['dsh-system-prompt', {}], ['dsh-tools', {}], ['dsh-session-projection', {}],
      ['dsh-fs-local', { cwd: workdir }], ['dsh-working-directory', { defaultDirectory: workdir }],
      ['dsh-shell-env', { dshHome: directory }], ['dsh-subprocess-local', {}],
      ['dsh-pwsh-local', { cwd: workdir, timeoutMs: 10000, maxTimeoutMs: 15000, graceMs: 100 }],
      ['dsh-user-approval', { policy: 'ask' }],
      ['dsh-tool-pwsh', { enableRunInBackground: false, promoteOnTimeout: false }],
    ]) await ctx.plugin(await official(name), config)
    if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {})

    const header = { version: SESSION_FORMAT_VERSION, id: 'native-shell', createdAt: 0,
      isSeeded: false, delegationDepth: 0, agentPreset: 'claude-sdk-remote', cwd: workdir }
    const session = Session.create(header.id, undefined, header)
    const agent = { id: header.id, ctx, session, inject() {} }
    let answer = 'allowed-once', approvals = 0, step = 0
    ctx.on('tools/pre-execute', () => ({ kind: 'ask', reason: '隔离 shell 验证' }))
    ctx.on('approval/request', req => {
      assert.equal(req.agent, agent)
      assert.equal(req.toolName, 'pwsh')
      approvals++
      return answer
    })
    assert.ok(ctx.tools.get('pwsh', agent))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { reason: 'initial', header: {
      config: { provider: 'claude-sdk-remote', model: 'no-model-fixture' },
      tools: ctx.tools.schemas(agent),
    } })

    const execute = async (command, options = {}, signal = new AbortController().signal) => {
      step++
      const callId = `shell-${step}`
      const args = { description: '验证隔离命令', command, ...options }
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, stream: [], message: createAssistantMessage({
        source: { provider: 'claude-sdk-remote', model: 'no-model-fixture' },
        content: [{ type: 'tool-call', id: callId, name: 'pwsh', arguments: JSON.stringify(args) }],
      }) }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step, callId, name: 'pwsh', arguments: JSON.stringify(args) })
      const result = await executeNativeTool(ctx, { name: 'pwsh', callId, arguments: args, signal, agent })
      session.append('tool/result', { turn: 1, step,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('step/end', { turn: 1, step })
      return result
    }

    await t.test('实际返回中文输出及会话工作目录，审批允许后才执行', async () => {
      const result = await execute("Write-Output 'shell-中文'; Write-Output ('DSH_NATIVE_CWD=' + (ConvertTo-Json -InputObject (Get-Location).Path -Compress))")
      assert.equal(result.isError, false, outputText(result))
      assert.equal(result.value.exitCode, 0)
      assert.equal(result.value.cwd, workdir)
      assert.match(outputText(result), /shell-中文/)
      const cwdLine = outputText(result).match(/^DSH_NATIVE_CWD=(.+)$/m)
      assert.ok(cwdLine, `缺少实际工作目录输出：${outputText(result)}`)
      const actualCwd = JSON.parse(cwdLine[1])
      // PowerShell expands Windows 8.3 aliases; compare the actual directories.
      assert.equal(await realpath(actualCwd), await realpath(workdir),
        `工作目录不一致：expected=${JSON.stringify(workdir)}, actual=${JSON.stringify(actualCwd)}`)
      assert.equal(approvals, 1)
    })

    await t.test('拒绝审批不启动命令也不产生文件', async () => {
      answer = 'rejected'
      const target = join(workdir, 'rejected.txt')
      const result = await execute(`[IO.File]::WriteAllText(${quotePwsh(target)}, 'should-not-exist')`)
      assert.equal(result.isError, true)
      assert.match(outputText(result), /rejected/)
      await assert.rejects(access(target), { code: 'ENOENT' })
      assert.equal(approvals, 2)
      answer = 'allowed-once'
    })

    await t.test('超时终止前台命令并保留超时结果', async () => {
      const result = await execute('Start-Sleep -Seconds 10', { timeoutMs: 500 })
      assert.equal(result.isError, false, outputText(result))
      assert.equal(result.value.timedOut, true)
      assert.equal(result.value.aborted, false)
      assert.match(outputText(result), /timed out after 500ms/)
    })

    await t.test('命令开始后取消，停止后续副作用并返回中止结果', async () => {
      const started = join(workdir, 'started.signal'), effect = join(workdir, 'cancelled-effect.txt')
      const controller = new AbortController()
      const pending = execute(`[IO.File]::WriteAllText(${quotePwsh(started)}, 'started'); Start-Sleep -Seconds 10; [IO.File]::WriteAllText(${quotePwsh(effect)}, 'should-not-exist')`, {}, controller.signal)
      try {
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          if (await access(started).then(() => true, () => false)) break
          await delay(25)
        }
        await access(started)
      } finally {
        controller.abort(new Error('隔离测试取消'))
      }
      const result = await pending
      assert.equal(result.isError, true)
      assert.equal(result.error.info.code, TOOL_ABORTED)
      await assert.rejects(access(effect), { code: 'ENOENT' })
    })

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await t.test('输出、拒绝、超时和取消随原生日志保存及严格重放', async () => {
      const artifact = await strictSession(session)
      const file = join(directory, 'session.json')
      await writeFile(file, JSON.stringify({ header: session.header, events: artifact.events }))
      const saved = JSON.parse(await readFile(file, 'utf8'))
      const restored = Session.create(saved.header.id, saved.events, saved.header)
      const events = restored.snapshotEvents()
      assert.equal(events.filter(event => event.type === 'tool/result').length, 4)
      assert.equal(events.filter(event => event.type === 'approval/asked').length, 4)
      assert.deepEqual(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome),
        ['allowed-once', 'rejected', 'allowed-once', 'allowed-once'])
      const results = events.filter(event => event.type === 'tool/result').map(event => event.data.message)
      assert.match(results[0].content[0].text, /shell-中文/)
      assert.equal(results[1].isError, true)
      assert.match(results[2].content[0].text, /timed out/)
      assert.equal(results[3].isError, true)
    })
  } finally {
    await ctx.fiber.dispose()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-bridge-shell-'))
    await rm(directory, { recursive: true, force: true })
  }
})
