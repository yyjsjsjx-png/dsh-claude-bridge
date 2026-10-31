/** Required host capabilities, independent of DSH's release number or source hash. */
export const HOST_FUNCTIONS = Object.freeze({
  '@deepseek-ai/cordis': ['Service', 'Context'],
  '@deepseek-ai/schemastery': ['default'],
  zod: [],
  '@deepseek-ai/dsh-brand': ['brandString'],
  '@deepseek-ai/dsh-llm': ['LlmAdapter', 'AssistantStreamAccumulator', 'BlockAssembler',
    'LlmAttemptId', 'LlmError', 'createAssistantMessage', 'createDeveloperMessage',
    'createSystemMessage', 'createToolResultMessage', 'createUserMessage', 'errorChain', 'markAgentLoopRequest'],
  '@deepseek-ai/dsh-session': ['Session', 'SessionLogOffset', 'SessionPreparation', 'SessionSeq',
    'ToolCallRecovery', 'canonicalHeader', 'headerEquals', 'interruptedTurnClosers',
    'isReplacementSurfaceEvent', 'appendPluginRecord'],
  '@deepseek-ai/dsh-session-persistence': ['SessionPersistenceNotFoundError'],
  '@deepseek-ai/dsh-agent': ['agentEvents', 'assembleContextFor'],
  '@deepseek-ai/dsh-util-values': ['assertNever', 'deepFreeze'],
  '@deepseek-ai/dsh-scope': ['createScope'],
  '@deepseek-ai/dsh-system-prompt': ['joinContextSections', 'renderContextSections', 'renderPrompt'],
  '@deepseek-ai/dsh-tools': [],
  '@deepseek-ai/dsh-subagent': ['delegationDepthOf'],
  '@deepseek-ai/dsh-api-session-controller': ['SessionController'],
  '@deepseek-ai/dsh-agent-preset-registry': ['AgentPresetRegistry'],
  '@deepseek-ai/dsh-typert-protocol': ['RemoteError', 'Remote', 'TypertRemoteService', 'principalOf', 'remoteMethods'],
  '@deepseek-ai/cordis-plugin-include': [],
  'js-yaml': ['load'],
  '@deepseek-ai/dsh-home-paths': ['resolveDshHome'],
  '@deepseek-ai/dsh-credentials': ['credentialKey'],
});

const HOST_METHODS = {
  '@deepseek-ai/dsh-llm': {
    AssistantStreamAccumulator: ['push', 'snapshot'], BlockAssembler: ['push', 'message'],
  },
  '@deepseek-ai/dsh-session': {
    Session: ['append', 'eventAt', 'snapshotEvents', 'requestHeader', 'requestContext'],
    ToolCallRecovery: ['observe', 'results'],
  },
  '@deepseek-ai/dsh-api-session-controller': {
    SessionController: ['resolveAgent', 'create', 'selectModel', 'prompt', 'fork', 'cancel', 'control', 'page', 'follow'],
  },
  '@deepseek-ai/dsh-agent-preset-registry': {
    AgentPresetRegistry: ['register', 'select', 'activate', 'retain', 'resolve', 'acquireScope'],
  },
};

export class DshCompatibilityError extends Error {
  constructor(version, detail, options) {
    super(`远程 Claude 插件无法加载：DSH ${version || '未知版本'} 的接口不兼容（${detail}）。请更新插件或使用兼容的 DSH。`, options);
    this.name = 'DshCompatibilityError';
    this.code = 'DSH_API_INCOMPATIBLE';
  }
}

function requireValue(value, detail, version, type) {
  if (type === undefined ? value === undefined || value === null : typeof value !== type) {
    throw new DshCompatibilityError(version, detail);
  }
}

/** Extra exports and methods are allowed; only capabilities used by the bridge matter. */
export function assertHostModule(name, module, version) {
  for (const key of HOST_FUNCTIONS[name] ?? []) {
    requireValue(module?.[key], `缺少 ${name}.${key}`, version, 'function');
  }
  for (const [key, methods] of Object.entries(HOST_METHODS[name] ?? {})) {
    for (const method of methods) {
      requireValue(module?.[key]?.prototype?.[method], `缺少 ${name}.${key}.${method}()`, version, 'function');
    }
  }
  if (name === '@deepseek-ai/cordis') requireValue(module.Service.init, '缺少 Service.init', version);
  if (name === '@deepseek-ai/dsh-session') {
    requireValue(module.Session.create, '缺少 Session.create()', version, 'function');
    requireValue(module.SessionPreparation.create, '缺少 SessionPreparation.create()', version, 'function');
    requireValue(module.SESSION_FORMAT_VERSION, '缺少 SESSION_FORMAT_VERSION', version);
  }
  if (name === '@deepseek-ai/dsh-tools') {
    for (const key of ['TOOL_ABORTED_BEFORE_DISPATCH', 'TOOL_RUNTIME_SCHEDULER']) {
      requireValue(module[key], `缺少 ${name}.${key}`, version);
    }
  }
  if (name === '@deepseek-ai/cordis-plugin-include') {
    requireValue(module.entryListSchema, '缺少预设 YAML schema', version);
  }
  if (name === 'zod') {
    for (const key of ['object', 'string', 'number', 'array', 'boolean', 'union', 'literal']) {
      requireValue(module.z?.[key], `缺少 zod.z.${key}()`, version, 'function');
    }
  }
}

/** These overrides use DSH's source-mode RPC, where parameter names are wire fields. */
export function assertRpcParameters(method, expected, label, version) {
  const source = Function.prototype.toString.call(method);
  const match = /^[^(]*\(([^)]*)\)/u.exec(source);
  const parameters = match?.[1].split(',').map(value => value.trim().replace(/\s*=.*$/u, ''));
  if (!parameters || parameters.length < expected.length
    || expected.some((value, index) => value !== parameters[index])) {
    throw new DshCompatibilityError(version, `${label} 的 RPC 参数已改变`);
  }
}

/** Probe native persistence and message shapes entirely in memory, without touching user sessions. */
export function assertHostContract(modules, version) {
  for (const name of Object.keys(HOST_FUNCTIONS)) assertHostModule(name, modules[name], version);
  const controller = modules['@deepseek-ai/dsh-api-session-controller'].SessionController.prototype;
  for (const name of ['create', 'selectModel', 'prompt', 'fork']) {
    assertRpcParameters(controller[name], ['request'], `SessionController.${name}`, version);
  }
  assertRpcParameters(modules['@deepseek-ai/dsh-agent-preset-registry'].AgentPresetRegistry.prototype.select,
    ['agent', 'agentPreset'], 'AgentPresetRegistry.select', version);
  try {
    const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = modules['@deepseek-ai/dsh-session'];
    const id = 'claude-bridge-compatibility-probe';
    const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 0,
      isSeeded: false, agentPreset: 'claude-sdk-remote' };
    const session = Session.create(id, undefined, header);
    appendPluginRecord(session, 'plugin:claude-bridge/compatibility-probe', { version: 1 });
    const events = session.snapshotEvents();
    const restored = Session.create(id, events, header);
    if (events.length !== 1 || events[0].ignorable !== true
      || restored.eventAt(0)?.ignorable !== true || restored.header.agentPreset !== header.agentPreset) {
      throw new Error('原生会话插件记录无法无损回放');
    }
    const message = modules['@deepseek-ai/dsh-llm'].createAssistantMessage({
      content: [{ type: 'text', text: 'compatibility-probe' }],
      source: { provider: 'claude-sdk-remote', model: 'compatibility-probe' },
    });
    if (typeof message.id !== 'string' || message.content?.[0]?.text !== 'compatibility-probe') {
      throw new Error('原生消息结构已改变');
    }
  } catch (error) {
    throw new DshCompatibilityError(version, '原生会话或消息协议已改变', { cause: error });
  }
}
