/** Register a Claude preset from this installation's compatible standard. */
import { Service, entryListSchema, loadYaml } from './compat/runtime.mjs';
import { readShippedStandardPreset, resolveDshModule } from './compat/resolve-dsh-module.mjs';
import { createRemoteClaudePreset, createBasicRemoteClaudePreset, containRemotePreset } from './preset.mjs';

export default class ClaudePreset {
  // Commands inside the remote composition depend on this service. Wait for
  // its publication instead of conservatively disabling them during startup.
  static inject = ['agentPresets', 'claudeBridge'];

  constructor(ctx) { this.ctx = ctx; }

  async* [Service.init]() {
    // A broken standard declaration is optional; core Host checks still run
    // before this service and are never bypassed by the fallback.
    let baseUrl = resolveDshModule('@deepseek-ai/cordis');
    let mode = 'full';
    const reasons = [];
    let preset;
    try {
      const shipped = readShippedStandardPreset();
      baseUrl = shipped.baseUrl;
      const { content } = shipped;
      const patches = loadYaml(content, { schema: entryListSchema });
      if (!Array.isArray(patches)) throw new Error('DSH 标准预设文件格式无效。');
      const matches = patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])
        .filter(row => row?.id === 'preset-standard' && row?.config?.id === 'standard');
      if (matches.length !== 1) throw new Error('DSH 标准预设定义不唯一。');
      preset = createRemoteClaudePreset(matches[0].config);
    } catch {
      preset = createBasicRemoteClaudePreset();
      mode = 'basic';
      reasons.push('安装版标准预设无法读取或适配，已采用插件维护的基础预设。');
    }
    // Resolve the standard plugin names from the installation, not from the
    // external bridge directory. This also preserves existing DSH singletons.
    const officialContext = this.ctx.extend({ baseUrl });
    yield await officialContext.agentPresets.register(containRemotePreset(preset, { baseUrl, mode, reasons }));
  }
}
