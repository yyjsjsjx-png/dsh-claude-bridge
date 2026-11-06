# 第三方来源

内置兼容代码分别来自 DeepSeek Harness：

- `0.2.1-rc.5`：官方提交 `b830ec950faba0a46dda564be3e2d854afed94f1`。
- `0.2.2-rc.1`：官方提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。

这些版本用于标注源码来源和复现构建；运行时按 Host 能力检查并选择对应驱动，不按版本字符串锁定安装版。

- `plugin/compat/agent-loop.original.mjs` 来自 `0.2.1-rc.5` 的官方安装包；`agent-loop.mjs` 仅适配桥接构造入口和远程轮次收尾。来源和 SHA-256 见同目录 `provenance.json`，许可证见 `LICENSE`。
- `plugin/compat/desktop-022/` 保留新版官方执行循环及相同两处适配，构造时原样传递原生投影和轮次。来源、摘要和 MIT 许可证保留在该目录；可用 `scripts/prepare-dsh-compat-022.mjs` 从准确的官方 ASAR 重建。
- `plugin/session-client/client.js` 为 `0.2.1-rc.5` 官方客户端原样副本；同目录保留 `provenance.json` 和 MIT `LICENSE`。
- `src/remote-prompt-policy.mjs` 的原生文案签名取自上述两版 `system-prompt/src/index.ts` 与 `harness-dev-context/src/index.ts`。只用于精确识别原生提示片段，未知或自定义文案不按名称删除；来源项目采用 MIT 许可证，见 `plugin/compat/LICENSE`。
- Claude Agent SDK 与官方 CLI 仅在远端独立安装；本仓库不分发其程序或账号认证数据。固定版本见 `remote/package.json`。Agent SDK 与 Claude Code 的使用受 Anthropic 条款约束。

本项目与 Anthropic、DeepSeek 均无隶属、合作或背书关系。Claude、Claude Code 为 Anthropic 的商标，DeepSeek 为其所有者的商标，此处仅用于说明兼容对象。

官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
