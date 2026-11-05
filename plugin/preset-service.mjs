/** Prefer the installed standard, with an owned complete declaration fallback. */
import { Service, entryListSchema, loadYaml } from './compat/runtime.mjs';
import { readShippedStandardPreset, resolveDshModule } from './compat/resolve-dsh-module.mjs';
import { createRemoteClaudePreset, createOwnedRemoteClaudePreset, createBasicRemoteClaudePreset, containRemotePreset } from './preset.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));

export default class ClaudePreset {
  // Commands inside the remote composition depend on this service. Wait for
  // its publication instead of conservatively disabling them during startup.
  static inject = ['agentPresets', 'claudeBridge'];

  constructor(ctx) { this.ctx = ctx; }

  async* [Service.init]() {
    // Core Host checks are never bypassed. Compatible standard additions remain
    // available without an update to the owned fallback declaration.
    let baseUrl = resolveDshModule('@deepseek-ai/cordis');
    let mode = 'full';
    const reasons = [];
    const noticeReasons = [];
    let subagentFields;
    try {
      const nativeSubagent = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href);
      subagentFields = nativeSubagent.Config?.dict ?? {};
    } catch { subagentFields = {}; }
    let preset;
    try {
      const shipped = readShippedStandardPreset();
      baseUrl = shipped.baseUrl;
      const patches = loadYaml(shipped.content, { schema: entryListSchema });
      if (!Array.isArray(patches)) throw new Error('DSH 标准预设文件格式无效。');
      const matches = patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])
        .filter(row => row?.id === 'preset-standard' && row?.config?.id === 'standard');
      if (matches.length !== 1) throw new Error('DSH 标准预设定义不唯一。');
      preset = createRemoteClaudePreset(matches[0].config, subagentFields);
    } catch {
      try {
        preset = createOwnedRemoteClaudePreset(subagentFields);
        // A declaration-source change alone must not change an equivalent SDK
        // system prompt. Publish this notice to the user, not to the model.
        noticeReasons.push('安装版标准预设无法读取或适配，已采用插件维护的完整预设。');
      } catch {
        preset = createBasicRemoteClaudePreset();
        mode = 'basic';
        reasons.push('安装版标准预设及插件完整预设无法构建，已采用插件维护的基础预设。');
      }
    }
    // Resolve the standard plugin names from the installation, not from the
    // external bridge directory. This also preserves existing DSH singletons.
    const officialContext = this.ctx.extend({ baseUrl });
    yield await officialContext.agentPresets.register(containRemotePreset(preset, { baseUrl, mode, reasons, noticeReasons }));
  }
}
