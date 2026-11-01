import test from 'node:test'
import assert from 'node:assert/strict'
import { toMcpToolDefinitions } from '../src/dsh-content.mjs'
import { requiredShellName, assertRemoteShell, admittedRemoteAssembly, remoteCapabilityPrompt,
  shellInfrastructureFailure } from '../src/remote-capabilities.mjs'

const shellDefinition = name => ({ name, description: '执行基础命令', parameters: { type: 'object',
  properties: { command: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' } },
  required: ['command'], additionalProperties: false } })
const services = () => ({ tools: { execute() {} }, agents: { withInitiator() {} },
  approval: { request() {} }, sessions: { flush() {} } })
const agent = { session: { append() {} } }

test('Windows 最低执行能力必须是可调用 pwsh，Unix 使用 bash', () => {
  assert.equal(requiredShellName('win32'), 'pwsh')
  for (const platform of ['linux', 'darwin']) assert.equal(requiredShellName(platform), 'bash')
  const assembly = { tools: [shellDefinition('pwsh')] }
  assert.equal(assertRemoteShell(assembly, toMcpToolDefinitions(assembly.tools), services(), agent, 'win32').status, 'ready')
  assert.throws(() => assertRemoteShell({ tools: [shellDefinition('bash')] },
    toMcpToolDefinitions([shellDefinition('bash')]), services(), agent, 'win32'), { code: 'REMOTE_SHELL_UNAVAILABLE' })
})

test('基础 shell 不能转换或缺工作目录、超时及执行审批记录接口时明确阻止', () => {
  const assembly = { tools: [shellDefinition('pwsh')] }
  for (const field of ['command', 'workdir', 'timeoutMs']) {
    const broken = structuredClone(assembly)
    delete broken.tools[0].parameters.properties[field]
    assert.throws(() => assertRemoteShell(broken, toMcpToolDefinitions(broken.tools), services(), agent, 'win32'),
      { code: 'REMOTE_SHELL_UNAVAILABLE' })
  }
  const broken = { tools: [{ ...shellDefinition('pwsh'), parameters: { $ref: '#/unsupported' } }] }
  assert.throws(() => assertRemoteShell(broken, toMcpToolDefinitions(broken.tools), services(), agent, 'win32'),
    /pwsh 无法转换/)
  for (const [service, method] of [['tools', 'execute'], ['agents', 'withInitiator'], ['sessions', 'flush'], ['approval', 'request']]) {
    const ctx = services(); delete ctx[service][method]
    assert.throws(() => assertRemoteShell(assembly, toMcpToolDefinitions(assembly.tools), ctx, agent, 'win32'),
      { code: 'REMOTE_SHELL_UNAVAILABLE' })
  }
})

test('关闭高级工具时移除原生说明并保留自定义与用户指令，能力说明明确列出原因', () => {
  const tools = [shellDefinition('pwsh'), { name: 'advanced', description: '不可用工具', parameters: { $ref: '#/unsupported' } }]
  const assembly = { tools, sections: [{ name: 'tool:advanced', text: 'Use advanced.' },
    { name: 'tool:pwsh', text: 'Use PowerShell.' }, { name: 'user:instructions', text: '保留用户全部指令。' }] }
  const converted = toMcpToolDefinitions(tools)
  const admitted = admittedRemoteAssembly(assembly, converted)
  assert.deepEqual(admitted.tools.map(tool => tool.name), ['pwsh'])
  assert.deepEqual(admitted.sections.map(section => section.name), ['tool:pwsh', 'user:instructions'])
  assert.equal(assembly.sections.length, 3)
  assert.match(remoteCapabilityPrompt('原有系统提示', converted), /原有系统提示[\s\S]*advanced：/)
  assert.equal(remoteCapabilityPrompt('原有系统提示', toMcpToolDefinitions([shellDefinition('pwsh')])), '原有系统提示')
})

test('仅确定的 shell 基础设施失败使插件不可用，命令失败、拒绝及超时保持原生结果', () => {
  for (const code of ['UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT', 'REMOTE_SHELL_EXECUTOR_FAILED']) {
    assert.equal(shellInfrastructureFailure('pwsh', { error: { info: { code } } }, 'pwsh').code, 'REMOTE_SHELL_UNAVAILABLE')
  }
  assert.equal(shellInfrastructureFailure('pwsh', { value: { sandbox: { runnerFailed: true } } }, 'pwsh').code, 'REMOTE_SHELL_UNAVAILABLE')
  for (const result of [{ isError: true, value: { exitCode: 1 } }, { error: { info: { code: 'DENIED' } } },
    { value: { timedOut: true } }, { error: { info: { code: 'ABORTED' } } },
    { error: { info: { code: 'SANDBOX_UNAVAILABLE' } } },
    Object.assign(new Error('ACL 准备权限不足'), { name: 'Win32Error', api: 'SetNamedSecurityInfoW', win32Code: 5 })]) {
    assert.equal(shellInfrastructureFailure('pwsh', result, 'pwsh'), undefined)
  }
  assert.equal(shellInfrastructureFailure('advanced', { error: { info: { code: 'UNKNOWN_TOOL' } } }, 'pwsh'), undefined)
})
