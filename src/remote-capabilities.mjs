/** Minimum remote-session execution contract; ordinary DSH sessions do not use it. */
export function requiredShellName(platform = process.platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

export function shellUnavailable(reason, shell = requiredShellName()) {
  const error = new Error(`[REMOTE_SHELL_UNAVAILABLE] 远程会话插件不可用：${reason}。请修复基础执行能力后重载插件。`)
  error.code = 'REMOTE_SHELL_UNAVAILABLE'
  error.capabilities = { status: 'unavailable', shell, reason }
  return error
}

/** Check the advertised callable schema and the actual native dispatch/approval/journal services. */
export function assertRemoteShell(assembly, converted, ctx, agent, platform = process.platform) {
  const shell = requiredShellName(platform)
  const source = assembly?.tools?.filter(tool => tool.name === shell) ?? []
  const callable = converted?.tools?.filter(tool => tool.name === shell) ?? []
  if (source.length !== 1 || callable.length !== 1) {
    const report = converted?.compatibility?.find(tool => tool.name === shell && tool.status === 'disabled')
    throw shellUnavailable(report ? `${shell} 无法转换：${report.reason}` : `缺少可调用的 ${shell} 基础 shell`, shell)
  }
  const schema = callable[0].inputSchema
  if (schema?.type !== 'object' || schema.properties?.command?.type !== 'string'
    || !schema.required?.includes('command') || schema.properties?.workdir?.type !== 'string'
    || !['number', 'integer'].includes(schema.properties?.timeoutMs?.type)) {
    throw shellUnavailable(`${shell} 缺少命令、工作目录或超时参数`, shell)
  }
  for (const [service, method] of [['tools', 'execute'], ['agents', 'withInitiator'],
    ['sessions', 'flush'], ['approval', 'request']]) {
    if (typeof ctx?.[service]?.[method] !== 'function') {
      throw shellUnavailable(`缺少 ${service}.${method}() 基础执行接口`, shell)
    }
  }
  if (typeof agent?.session?.append !== 'function') throw shellUnavailable('缺少会话执行结果记录接口', shell)
  return { status: 'ready', shell, reason: '基础 shell 与执行、审批和记录接口已就绪；实际命令仍通过原生工具链执行。' }
}

/** Keep named native tool instructions aligned without deleting custom/user instruction prose. */
export function admittedRemoteAssembly(assembly, converted) {
  const accepted = new Set(converted.tools.map(tool => tool.name))
  const disabled = new Set(converted.compatibility.filter(tool => tool.status === 'disabled').map(tool => `tool:${tool.name}`))
  return { ...assembly,
    tools: assembly.tools.filter(tool => accepted.has(tool.name)),
    ...(assembly.sections ? { sections: assembly.sections.filter(section => !disabled.has(section.name)) } : {}),
  }
}

export function remoteCapabilityPrompt(prompt, converted) {
  const disabled = converted.compatibility.filter(tool => tool.status === 'disabled')
  if (!disabled.length) return prompt
  return `${prompt}\n\n[远程会话能力说明]\n本轮仅可调用实际提供的工具。以下工具已关闭；其他说明中若仍提及这些工具，不表示它们可用。不得尝试调用或通过其他执行路径绕过其限制。\n`
    + disabled.map(tool => `${tool.name}：${tool.reason}`).join('\n')
}

/** Only explicit infrastructure failures stop the engine; normal command/policy errors stay results. */
export function shellInfrastructureFailure(name, result, shell = requiredShellName()) {
  if (name !== shell) return undefined
  const code = result?.error?.info?.code ?? result?.code
  if (code === 'UNKNOWN_TOOL') return shellUnavailable(`${shell} 已从原生工具注册表移除`, shell)
  if (code === 'INVALID_TOOL_OUTPUT') return shellUnavailable(`${shell} 的执行结果无法按原生接口记录`, shell)
  if (code === 'REMOTE_SHELL_EXECUTOR_FAILED') return shellUnavailable(`${shell} 的基础进程无法启动`, shell)
  if (result?.value?.sandbox?.runnerFailed === true) return shellUnavailable(`${shell} 的沙箱执行器启动失败`, shell)
  return undefined
}
