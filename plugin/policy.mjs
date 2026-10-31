/** Session engine admission for the DSH / remote Claude bridge. */

export const CLAUDE_PROVIDER = 'claude-sdk-remote';
export const CLAUDE_PRESET = 'claude-sdk-remote';
export const CLAUDE_ENGINE = 'claude-sdk-remote';
export const DSH_ENGINE = 'dsh';
export const BINDING_VERSION = 1;
export const REMOTE_CREATE_PREFIX = 'claude-sdk-remote+model-v1:';

/** A policy failure that callers can surface without parsing message text. */
export class EnginePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnginePolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EnginePolicyError(code, message);
}

function requiredName(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()
    || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_SELECTION', `请选择有效的${field}。`);
  }
  return value;
}

function normalizeModel(selection) {
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    fail('MODEL_REQUIRED', '创建会话前必须选择模型。');
  }
  const provider = requiredName(selection.provider, '模型提供方');
  const model = requiredName(selection.model, '模型');
  const normalized = { provider, model };
  if (selection.reasoningEffort !== undefined) {
    normalized.reasoningEffort = requiredName(selection.reasoningEffort, '推理强度');
  }
  return Object.freeze(normalized);
}

function engineForProvider(provider) {
  return provider === CLAUDE_PROVIDER ? CLAUDE_ENGINE : DSH_ENGINE;
}

/** Pack creation-only selection into rc.5's declared agentPreset wire field. */
export function encodeRemoteCreationSelection(selection) {
  const model = normalizeModel(selection);
  if (model.provider !== CLAUDE_PROVIDER) fail('PRESET_ENGINE_MISMATCH', '远程会话需要远程模型。');
  const payload = { model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) };
  return REMOTE_CREATE_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

/** Decode only the reserved creation marker; ordinary preset names pass through. */
export function decodeRemoteCreationSelection(value) {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_CREATE_PREFIX)) return undefined;
  if (value.length > 8192) fail('INVALID_SELECTION', '创建会话的模型信息过长。');
  let payload;
  try { payload = JSON.parse(decodeURIComponent(value.slice(REMOTE_CREATE_PREFIX.length))); }
  catch { fail('INVALID_SELECTION', '创建会话的模型信息无效。'); }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'model' && key !== 'reasoningEffort')) {
    fail('INVALID_SELECTION', '创建会话的模型信息无效。');
  }
  return normalizeModel({ provider: CLAUDE_PROVIDER, ...payload });
}

/**
 * Resolve the immutable binding before creating a Session. Callers must pass
 * DSH's resolved default preset when the user has not chosen one.
 */
export function planSessionCreation({ selection, requestedPreset, defaultPreset } = {}) {
  const initialModel = normalizeModel(selection);
  const engine = engineForProvider(initialModel.provider);
  let preset;
  if (engine === CLAUDE_ENGINE) {
    // A remote model always opens in the bridge's own preset, regardless of
    // the previous composer selection.
    preset = CLAUDE_PRESET;
  } else {
    preset = requiredName(requestedPreset ?? defaultPreset, '会话预设');
    if (preset === CLAUDE_PRESET) {
      fail('PRESET_ENGINE_MISMATCH', '远程会话预设只能用于远程模型。');
    }
  }
  return Object.freeze({ schemaVersion: BINDING_VERSION, engine, preset, initialModel });
}

/** Validate persisted identity before reattaching an Agent; no fallback is inferred. */
export function restoreSessionBinding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== BINDING_VERSION) {
    fail('BINDING_MISSING_OR_UNSUPPORTED', '会话引擎绑定缺失或版本不受支持。');
  }
  if (value.engine !== DSH_ENGINE && value.engine !== CLAUDE_ENGINE) {
    fail('BINDING_INVALID', '会话引擎绑定无效。');
  }
  const preset = requiredName(value.preset, '会话预设');
  const initialModel = normalizeModel(value.initialModel);
  if (engineForProvider(initialModel.provider) !== value.engine
    || (value.engine === CLAUDE_ENGINE) !== (preset === CLAUDE_PRESET)) {
    fail('BINDING_INVALID', '会话引擎、模型和预设绑定不一致。');
  }
  return Object.freeze({ schemaVersion: BINDING_VERSION, engine: value.engine, preset, initialModel });
}

/** Check a proposed model before the DSH Session can record it. */
export function assertModelSelection(bindingValue, selection) {
  const binding = restoreSessionBinding(bindingValue);
  return assertModelForPreset(binding.preset, selection);
}

/** The rc.5 creation preset is durable, and identifies the engine. */
export function assertModelForPreset(currentPreset, selection) {
  const preset = requiredName(currentPreset, '会话预设');
  const model = normalizeModel(selection);
  if ((engineForProvider(model.provider) === CLAUDE_ENGINE) !== (preset === CLAUDE_PRESET)) {
    fail('ENGINE_LOCKED', '会话创建后不能切换执行引擎，请新建会话。');
  }
  return model;
}

/** A Session keeps its exact creation preset, including before its first turn. */
export function assertPresetSelection(bindingValue, requestedPreset) {
  const binding = restoreSessionBinding(bindingValue);
  return assertPresetUnchanged(binding.preset, requestedPreset);
}

/** Check the durable creation preset without inferring a prior model. */
export function assertPresetUnchanged(currentPreset, requestedPreset) {
  const current = requiredName(currentPreset, '会话预设');
  const preset = requiredName(requestedPreset, '会话预设');
  if (preset !== current) {
    fail('PRESET_LOCKED', preset === CLAUDE_PRESET
      ? '请通过“新建远程会话”创建会话。'
      : '会话创建后不能切换预设，请新建会话。');
  }
  return current;
}

/** Run a model-selection operation only after its engine check succeeds. */
export function guardModelSelection(binding, selection, operation) {
  const accepted = assertModelSelection(binding, selection);
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  return operation(accepted);
}

/** A repeat selection is a no-op, so it cannot recompose a locked preset. */
export function guardPresetSelection(binding, requestedPreset) {
  return assertPresetSelection(binding, requestedPreset);
}
