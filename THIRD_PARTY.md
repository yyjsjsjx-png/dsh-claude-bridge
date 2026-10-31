# 第三方来源

兼容目标为 DeepSeek Harness `0.2.1-rc.5`，官方提交
`b830ec950faba0a46dda564be3e2d854afed94f1`。

- `plugin/compat/agent-loop.original.mjs` 来自该版本的官方安装包；`agent-loop.mjs` 仅适配桥接构造入口和远程轮次收尾。来源和 SHA-256 见同目录 `provenance.json`，许可证见 `LICENSE`。
- `plugin/session-client/client.js` 为该版本官方客户端原样副本；同目录保留 `provenance.json` 和 MIT `LICENSE`。
- Claude Agent SDK 与官方 CLI 仅在远端独立安装；本仓库不分发其程序或账号认证数据。固定版本见 `remote/package.json`。

官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
