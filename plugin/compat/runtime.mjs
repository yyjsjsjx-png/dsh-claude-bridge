// Generated from the installed rc.5 ASAR; do not edit.
import { resolveDshModule } from './resolve-dsh-module.mjs';
export const { Service } = await import(resolveDshModule("@deepseek-ai/cordis"));
export const { default: schema } = await import(resolveDshModule("@deepseek-ai/schemastery"));
export const { LlmAdapter, createAssistantMessage, createToolResultMessage, createSystemMessage, AssistantStreamAccumulator, BlockAssembler } = await import(resolveDshModule("@deepseek-ai/dsh-llm"));
export const { renderPrompt, renderContextSections, joinContextSections } = await import(resolveDshModule("@deepseek-ai/dsh-system-prompt"));
export const { assembleContextFor } = await import(resolveDshModule("@deepseek-ai/dsh-agent"));
export const { SessionController } = await import(resolveDshModule("@deepseek-ai/dsh-api-session-controller"));
export const { AgentPresetRegistry } = await import(resolveDshModule("@deepseek-ai/dsh-agent-preset-registry"));
export const { RemoteError, Remote, TypertRemoteService, principalOf, remoteMethods } = await import(resolveDshModule("@deepseek-ai/dsh-typert-protocol"));
export const { entryListSchema } = await import(resolveDshModule("@deepseek-ai/cordis-plugin-include"));
export const { load: loadYaml } = await import(resolveDshModule("js-yaml"));
export const { resolveDshHome } = await import(resolveDshModule("@deepseek-ai/dsh-home-paths"));
export const { credentialKey } = await import(resolveDshModule("@deepseek-ai/dsh-credentials"));
