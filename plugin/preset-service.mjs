/** Register a Claude preset from this installation's compatible standard. */
import { Service, entryListSchema, loadYaml } from './compat/runtime.mjs';
import { readShippedStandardPreset } from './compat/resolve-dsh-module.mjs';
import { createRemoteClaudePreset } from './preset.mjs';
import { DshCompatibilityError } from './compat/host-contract.mjs';

export default class ClaudePreset {
  static inject = ['agentPresets'];

  constructor(ctx) { this.ctx = ctx; }

  async* [Service.init]() {
    const { content, baseUrl, version } = readShippedStandardPreset();
    let preset;
    try {
      const patches = loadYaml(content, { schema: entryListSchema });
      if (!Array.isArray(patches)) throw new Error('DSH 标准预设文件格式无效。');
      const matches = patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])
        .filter(row => row?.id === 'preset-standard' && row?.config?.id === 'standard');
      if (matches.length !== 1) throw new Error('DSH 标准预设定义不唯一。');
      preset = createRemoteClaudePreset(matches[0].config);
    } catch (error) {
      throw new DshCompatibilityError(version, '标准预设结构不兼容', { cause: error });
    }
    // Resolve the standard plugin names from the installation, not from the
    // external bridge directory. This also preserves existing DSH singletons.
    const officialContext = this.ctx.extend({ baseUrl });
    yield await officialContext.agentPresets.register(preset);
  }
}
