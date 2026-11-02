/** Remote-only selection view over the installed native delegation tool.
 * The native runtime still owns admission, policy records, depth, child scopes,
 * cancellation, result delivery and persistence. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveDshModule } from './compat/resolve-dsh-module.mjs';
import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs';
import { MODEL_DEFAULT_EFFORT, subagentModels, assertRemoteSubagentRoute, withModelDefault } from './subagent-selection.mjs';

const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
const native = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href);
const { scopeOf, scopeChainOf } = await import(resolveDshModule('@deepseek-ai/dsh-scope'));

export const Config = native.Config;
export const inject = [...native.inject, 'agents', 'llm', 'claudeBridge'];

// No enabled models is a valid live preference. Native rc5 cannot persist an
// empty selection policy, so initial capture below still degrades to inherit.
function visibleModels(catalog) {
  if (catalog?.status === 'ok' && Array.isArray(catalog.models) && catalog.models.length === 0) return [];
  return subagentModels(catalog);
}

function requireVisibleModel(models, model) {
  const found = models.find(row => row.id === model);
  if (!found) throw Object.assign(new Error('该远程模型不在当前启用的型号中；请先在模型设置中勾选。'),
    { code: 'SUBAGENT_MODEL_DISABLED' });
  return found;
}

function selectionContext(ctx, readCatalog, allowedModels, toolName) {
  const settings = { current: () => ({ enabled: true, allowedModels }) };
  const llm = new Proxy(ctx.llm, { get(target, key) {
    if (key === 'listProviders') return () => target.listProviders().filter(row => row.id === CLAUDE_PROVIDER);
    if (key === 'listModels' || key === 'resolveModelInfo') return async (provider, model, signal) => {
      // listModels(provider, signal) and resolveModelInfo(provider, id, signal).
      if (key === 'listModels') { signal = model; model = undefined; }
      assertRemoteSubagentRoute({ provider });
      signal?.throwIfAborted();
      const models = visibleModels(await readCatalog());
      signal?.throwIfAborted();
      if (key === 'listModels') return models;
      return requireVisibleModel(models, model);
    };
    if (key === 'resolveCallConfig') return async (options, signal) => {
      assertRemoteSubagentRoute(options);
      // Resolve against the real adapter on every explicit selection. The
      // durable native allowlist cannot authorize a removed model or effort.
      const prepared = await target.prepareCall(withModelDefault(options), signal);
      // Check device preferences after the adapter's await, so a model disabled
      // while preflight was pending cannot be admitted by its old policy/cache.
      signal?.throwIfAborted();
      requireVisibleModel(visibleModels(await readCatalog()), options.model);
      signal?.throwIfAborted();
      return prepared.config;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const subagents = new Proxy(ctx.subagents, { get(target, key) {
    if (key === 'startActivation') return spec => {
      const options = withModelDefault(spec.request.agentOptions);
      return target.startActivation(options === spec.request.agentOptions ? spec
        : { ...spec, request: { ...spec.request, agentOptions: options } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const tools = new Proxy(ctx.tools, { get(target, key) {
    if (key === 'register') return definition => {
      // Mutate this newly created, Agent-owned definition: native guidance
      // compares the registered object with its retained definition by identity.
      if (definition.name === toolName && definition.parameters?.properties?.reasoning_effort) {
        definition.parameters.properties.reasoning_effort.description +=
          ` Use the reserved value "${MODEL_DEFAULT_EFFORT}" to explicitly use the selected model's default, even for the parent's current model.`;
        definition.description += ' Explicit choices are restricted to this Session\'s captured routes and Claude models currently enabled in this device\'s model settings; execution revalidates the catalog and settings.';
      }
      if (definition.name === toolName && allowedModels === undefined) definition.description +=
        ' No verified enabled Claude model snapshot is available. This tool only inherits the parent model and effort; explicit selection becomes available after enabling models and reloading the session with a verified snapshot.';
      if (definition.name === 'list_subagent_models') definition.description =
        `Inspect Claude models currently enabled in this device's model settings and their reasoning efforts for subagents. Only routes also captured for this Session are selectable; execution revalidates the live catalog and settings. reasoning_effort="${MODEL_DEFAULT_EFFORT}" explicitly clears an inherited effort. Omitted fields inherit the parent selection.`;
      return target.register(definition);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(ctx, { get(target, key) {
    if (key === 'get') return (name, ...args) => name === 'subagentModelSelection' ? settings
      : name === 'llm' ? llm : target.get(name, ...args);
    if (key === 'llm') return llm;
    if (key === 'subagents') return subagents;
    if (key === 'tools') return tools;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function apply(ctx, config) {
  if (config.provider !== 'spawn' || config.agentPreset !== undefined || config.allowedAgentPresets !== undefined
    || typeof native.apply !== 'function' || typeof ctx.llm.prepareCall !== 'function'
    || typeof ctx.claudeBridge.backend?.displayCatalog !== 'function'
    || typeof ctx.claudeBridge.backend?.visibleCatalog !== 'function') {
    throw new Error('远程子任务只能使用原生独立 spawn 与继承的远程预设。');
  }
  const generation = scopeOf(ctx);
  const installs = new WeakMap();
  const fibers = new Set();
  let disposed = false;
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.all([...fibers].map(fiber => fiber.dispose()));
    fibers.clear();
  }, '远程子任务工具清理');
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = installs.get(agent);
    installs.delete(agent);
    if (entry?.fiber) { fibers.delete(entry.fiber); return entry.fiber.dispose(); }
  });
  const install = (agent, signal) => {
    if (agent?.session.header.agentPreset !== CLAUDE_PRESET
      || !scopeChainOf(scopeOf(agent.ctx)).includes(generation)) return;
    let entry = installs.get(agent);
    if (!entry) {
      entry = {};
      installs.set(agent, entry);
      entry.ready = (async () => {
        signal?.throwIfAborted();
        let allowedModels;
        // Attaching/resuming a session must not depend on a live remote call.
        // A missing display snapshot degrades only explicit child selection.
        try {
          allowedModels = subagentModels(await ctx.claudeBridge.backend.displayCatalog({ visible: true }))
            .map(model => ({ provider: CLAUDE_PROVIDER, model: model.id }));
        } catch {}
        signal?.throwIfAborted();
        if (disposed) throw new Error('远程子任务预设已卸载。');
        entry.fiber = agent.ctx.inject(native.inject, inner => native.apply(
          selectionContext(inner, () => ctx.claudeBridge.backend.visibleCatalog(), allowedModels, config.toolName ?? 'subagent'),
          { ...config, modelSelectionSettings: allowedModels !== undefined }, agent.session));
        fibers.add(entry.fiber);
        await entry.fiber;
      })().catch(async error => {
        installs.delete(agent);
        if (entry.fiber) { fibers.delete(entry.fiber); await entry.fiber.dispose(); }
        throw error;
      });
    }
    return entry.ready;
  };
  // Native publish awaits agent/created after its setup has joined the preset
  // generation. Install before the first prompt collects its tool definitions.
  ctx.on('agent/created', ({ agent, signal }) => install(agent, signal));
  await Promise.all(ctx.agents.list().map(agent => install(agent)));
}
