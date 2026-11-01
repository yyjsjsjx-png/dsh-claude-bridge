import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs';
import { imageCapability } from '../src/model-capabilities.mjs';

const ACCOUNT_DEFAULT = 'account-default';
const DEFAULT_MODEL = Object.freeze({ provider: CLAUDE_PROVIDER, id: ACCOUNT_DEFAULT,
  name: '远程模型（账号默认）', description: '由远程账号选择默认模型。' });
const NO_CONFIGURATION = new Set(['SETTINGS_MISSING', 'TOKEN_MISSING', 'BRIDGE_NOT_CONFIGURED']);

function modelRows(reply) {
  const models = Array.isArray(reply) ? reply : reply?.status === 'ok' ? reply.models : undefined;
  if (!Array.isArray(models)) throw new Error('远程模型目录响应无效。');
  const seen = new Set([ACCOUNT_DEFAULT]);
  return models.map(model => {
    if (!model || typeof model.value !== 'string' || !model.value
      || typeof model.displayName !== 'string' || !model.displayName
      || (model.description !== undefined && typeof model.description !== 'string')
      || seen.has(model.value)) throw new Error('远程模型目录包含无效或重复项目。');
    seen.add(model.value);
    const efforts = model.supportedEffortLevels;
    if (efforts !== undefined && (!Array.isArray(efforts)
      || efforts.some(level => typeof level !== 'string' || !level)
      || new Set(efforts).size !== efforts.length)) throw new Error('远程模型的推理强度目录无效。');
    return { provider: CLAUDE_PROVIDER, id: model.value, name: model.displayName,
      ...(imageCapability(model).supported === true ? { inputModalities: ['text', 'image'] } : {}),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(efforts === undefined || efforts.length === 0 ? {} : {
        reasoning: { efforts: efforts.map(id => ({ id, name: id })) },
      }) };
  });
}

/** Native catalog/selected-model lookups are advisory; execution stays fresh. */
export function createClaudeCatalogAdapter(LlmAdapter) {
  return class ClaudeCatalogAdapter extends LlmAdapter {
    constructor(backend, ctx) { super(); this.backend = backend; this.ctx = ctx; }

    providerInfo(provider) { return { id: provider, name: '远程模型' }; }

    async models(visible = false) {
      const method = visible ? this.backend.visibleCatalog : this.backend.catalog;
      if (typeof method !== 'function') throw new Error('远程模型目录服务尚未就绪。');
      try { return modelRows(await method.call(this.backend)); }
      catch (error) { if (NO_CONFIGURATION.has(error?.code)) return []; throw error; }
    }

    async displayModels(visible = false) {
      try {
        const reply = await this.backend.displayCatalog({ visible });
        this.backend.refreshDisplayCatalog();
        return modelRows(reply);
      } catch { return []; } // A remote listing failure cannot block other providers.
    }

    async listModels(provider) {
      if (provider !== CLAUDE_PROVIDER) throw new Error('远程模型提供方无效。');
      const models = await this.displayModels(true);
      const visible = new Set(models.map(model => model.id));
      const active = new Set();
      for (const session of this.ctx?.sessions?.list?.() ?? []) {
        if (session?.header?.agentPreset !== CLAUDE_PRESET) continue;
        const projected = this.ctx.sessionProjections.stateOf(session, 'modelSelection');
        const selected = projected?.pending ?? projected?.lastUsed ?? session.requestHeader?.()?.config;
        if (selected?.provider === CLAUDE_PROVIDER && typeof selected.model === 'string' && selected.model) active.add(selected.model);
      }
      const hiddenActive = [...active].filter(id => !visible.has(id));
      if (hiddenActive.length) {
        const full = await this.displayModels();
        const byId = new Map([[ACCOUNT_DEFAULT, DEFAULT_MODEL], ...full.map(model => [model.id, model])]);
        for (const id of hiddenActive) {
          const model = byId.get(id) ?? { provider: CLAUDE_PROVIDER, id, name: id };
          models.push({ ...model, name: `${model.name}（已有会话使用中）` });
        }
      }
      return models.map(({ reasoning: _reasoning, ...model }) => model);
    }

    async resolveModel(provider, model, signal) {
      if (provider !== CLAUDE_PROVIDER) throw new Error('远程模型提供方无效。');
      signal?.throwIfAborted();
      if (model === ACCOUNT_DEFAULT) return { ...DEFAULT_MODEL };
      const found = (await this.displayModels()).find(item => item.id === model);
      signal?.throwIfAborted();
      return found ?? { provider, id: model, name: model,
        description: '远程目录尚未验证，实际执行前将重新检查。' };
    }

    async prepareCall(provider, model, signal) {
      if (provider !== CLAUDE_PROVIDER) throw new Error('远程模型提供方无效。');
      signal?.throwIfAborted();
      const models = await this.models();
      const found = model === ACCOUNT_DEFAULT ? { ...DEFAULT_MODEL }
        : models.find(item => item.id === model);
      signal?.throwIfAborted();
      if (!found) throw new Error('该远程模型不在当前账号的官方目录中。');
      return { model: found, stream: options => this.stream(options) };
    }

    async *stream() { throw new Error('远程会话只能由专属会话引擎执行。'); }
  };
}
