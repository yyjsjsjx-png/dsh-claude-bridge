# rc.5 回归入口

当前基线为 DSH Desktop **0.2.1-rc.5**。回归分为普通 Node 无密钥层和真实 Windows Electron／ASAR 原生层；两者均不调用 Claude SDK／CLI 模型，不读取现有账号凭据或用户聊天。本轮另做了[实际桌面与远程 SDK 替身验收](#本轮桌面夹具验收)，其结果不能替代真实上游 SDK／模型验收。

## 本机使用

使用现有 Node.js 24.9 或更高版本运行，发行文件 `plugin/index.mjs` 已提交，不需要安装依赖或 TypeScript 编译器。

```powershell
node scripts/run-regression.mjs --layer node --output .local/regression/node
node scripts/run-regression.mjs --layer native --resources '现有DSH目录\resources' --executable '现有DSH目录\DeepSeek Harness.exe' --output .local/regression/native
```

`--layer all` 顺序执行两层；`--preflight-only` 只检查入口环境，不运行测试，报告状态为 `preflight-passed`，不能当作测试通过。路径也可由 `DSH_CLAUDE_BRIDGE_RESOURCES` 和 `DSH_CLAUDE_BRIDGE_EXECUTABLE` 提供。程序只操作测试自己的临时数据，不安装 DSH、不启动桌面图形窗口、不改变现有插件或服务。

UI 源码按状态控制器、视图和 DSH 接线维护在 `plugin/ui/client/`，运行时仍使用单个 `plugin/ui/client.js`。修改源码后运行 `npm run build:client` 并一并提交产物；`npm run check:client` 只核对源码与产物一致。构建使用现有 Node，不安装新依赖。CI 在普通层测试前执行同一产物检查。

每层输出 `report.json`、TAP 原始结果及 stderr 日志。普通层执行项目既有 `npm test` 全集，明确报告通过、失败、取消、跳过与 TODO 数；其中原生用例因缺 Electron 跳过是预期边界，不算已通过原生层。原生层必须有测试且 **0 失败、0 取消、0 跳过、0 TODO**，否则退出码为非零。缺环境、版本不符或缺完整 TAP 汇总同样失败。

## 无密钥覆盖

| 层次 | 现有用例与覆盖 |
| --- | --- |
| Node | `npm test`：Backend／worker、工具与提示词转换、选型和控制器守卫、步骤追加、取消与 settle、台账和未知结果、恢复、传输、降级策略、UI 状态逻辑 |
| 原生加载与注册 | `bundle-native`、`catalog-visibility`、`controller-native`：真实发布包接口、ASAR 模块及客户端身份、目录和 RPC、守卫卸载恢复 |
| 原生预设与 shell | `preset-native`、`shell-native`、`workflow-depth-guard`：Loader／作用域、可选失败隔离、基础回退、实际 PowerShell、审批服务、超时、取消、结果记录与普通会话隔离 |
| 原生记录与展示 | `sdk-projection`、`history-native`：SDK 事件投影、工具关联、停止后续聊展示、严格持久化重放及历史修复 |
| 状态与命令初始化 | `session-status`：真实原生状态日志回放；`compact-command`、`recovery-command`：在同一 Electron 层复验命令参数、取消信号及注销生命周期。实际 Loader 命令初始化另由 `preset-native` 覆盖 |
| 原生更新器 | `update-plugin`：缺少旧 GitHub 包离线缓存时，使用具名本地链接更新隔离 profile，并保留其他配置及备份 |

原生层先检查真实 Win32、Electron 运行时、文件形式的 `resources/app.asar`，再由该 Electron 读取 ASAR 内桌面及 AgentLoop 的版本，二者必须都是 `0.2.1-rc.5`。不会把 npm 发布包或展开的源码目录当成桌面实测。版本固定仅用于本基线，不改变插件运行时按实际能力检查的兼容策略。

## 本地基线结果

2026-11-01 已实际运行统一入口，结果分层保存：

| 运行 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: |
| 普通 Node，全套 250 项 | 219 | 31 | 0 |
| rc.5 原生，原清单 11 文件 | 44 | 0 | 0 |
| `update-plugin` 原生单项补充 | 1 | 0 | 0 |

原始记录为 `.local/rc5-baseline-20261101/report.json`，单项补充为同目录 `update-plugin-native-supplement.json`。补充运行未改写旧报告；原生清单现为 12 文件，未为此重跑全部原生用例。各层存在复验内容，不把上述数字相加作为独立覆盖数量。Node 的 31 项跳过不算通过，原生补充用于闭合原清单遗漏的更新器用例。

## 本轮桌面夹具验收

2026-11-01 使用实际 rc.5 Electron／ASAR、独立 DSH Home 和 Electron user-data，通过 CDP 操作真实桌面界面，未使用 computer-use 输入。远程端运行真实 server、runtime、MCP／RPC 和 history；SDK 使用确定性替身，真实模型请求 **0**，不记为真实上游 SDK 验收。

| 项目 | 已观察的结果 |
| --- | --- |
| 会话与恢复 | 新建、夹具模型选择、停止后续聊、重开后使用同一 SDK 绑定恢复 |
| shell 与审批 | 原生审批界面允许／拒绝；真实 PowerShell 输出与工作目录；启动后取消且无晚发副作用，复用 DSH 原生审批 |
| 后台任务 | 使用真实后台任务 ID 调用 `job_output` 并取回输出 |
| 子代理 | 实际创建子代理，自动 `subagent-settled` 回传后父会话续步成功 |
| 执行中追加消息 | 通过 `PostToolBatch` 附加上下文送达，观察到 1 次投递 |
| 额度底栏 | 两项有效、仅 5h、仅周、两项均无有效额度四种实际界面均通过；仅显示实际有效的窗口 |
| 配置热卸载／重载 | 逐字节备份独立 profile 的 patch 后写入 `[]`，watch 触发卸载：`claudeBridge/status` 返回 404，额度与远程新建入口消失；恢复原文后回到完整预设、pwsh 可用、无禁用组件、连接已配置，额度入口恢复 |
| 最终 Host 重启 | 真正退出并重开本轮独立 Electron，加载最终源码后仍为完整预设、无降级；子代理投递历史恢复，同一 SDK 会话的续聊请求 `resumed=true` 并完成最终回复，原生 `session/list` 只读 RPC 正常，结束为 idle |

子代理最初的自动输入被夹具 worker 拒绝，是其只接受人工验收标记的夹具缺口；已精确补齐自动结算输入，不把该问题归因于产品投递链路。额度接口明确返回无窗口时会清除旧成功缓存；临时网络错误仍可保留未过期快照，不将旧百分比用于“没有额度窗口”的账号。

本轮遇到的 ACL／沙箱错误属于 DSH／Windows 环境错误，保留原生错误，不误锁基础 shell；未修复系统 ACL 或沙箱配置。生命周期检查仅验证独立 profile 的插件配置热卸载／重载，不代表在线更新或实际用户数据迁移。最终截图 `.local/desktop-acceptance-cdp/quota-final.png` 已实际查看，图中 99%／17% 为合成额度数据。

该次验收的自建夹具已停止并核对 `inactive/dead`，独立 Electron 及子进程已退出，调试与本地转发端口已关闭；保留隔离数据及报告供复验。验收未操作日常窗口或生产环境。

## CI

`.github/workflows/rc5-regression.yml` 对 main 推送、PR 和手动触发提供两个独立任务，只申请仓库只读权限。Node 任务使用 Ubuntu；原生任务使用 Windows 2025 runner。两者固定 Node `24.22.2`，不执行 `npm install`、SDK 安装或构建。

Windows 任务仅在 GitHub runner 的临时目录下载固定[官方 rc.5 Windows 安装资产](https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.5-win-x64.exe)。`prepare-ci-dsh.mjs` 使用 runner 已有的 7zip 读取真实 NSIS 清单，唯一定位 `app*.7z` 后提取，再校验 EXE、ASAR 和版本；不执行安装器。布局不符、7zip 缺失或预检失败会明确失败。下载字节数和 SHA-256 写入报告用于追溯；这是本次下载的摘要，未冒充发布方签名。该下载脚本拒绝在普通本机环境运行，本机须提供现有安装路径。

CI 保存本次报告和测试日志 14 天，不上传下载的桌面程序、临时会话或任何真实账号数据。

首次托管 [CI 41298161774](https://github.com/yyjsjsjx-png/dsh-claude-bridge/actions/runs/41298161774) 已在提交 `5c2e0b5` 通过：Node 219 通过／31 跳过，Windows 原生 45 通过／0 跳过，均无失败；官方资产下载、解包及 Electron／ASAR 预检通过。后续改动以对应提交的 CI 结果为准，不将旧结果当作新提交已通过。

## 仍须单独验收的边界

- 真实远程 SDK 新建、续聊、工具往返与模型选择；使用明确选定、已授权的账号模型。
- 断线和崩溃故障可复用 `scripts/recovery-e2e.mjs`，但它会创建独立 VPS 测试服务，属于显式集成验收，不在普通 CI 自动运行。

## 官方来源

2026-11-01 核验：Node 官方 [24.x 发布列表](https://nodejs.org/dist/index.json) 中当前 LTS 补丁为 `24.22.2`；工作流动作固定到官方 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)、[upload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) 的实际 commit SHA。Windows 2025 [官方 runner 清单](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) 包含 7zip，脚本仍在每次运行时检查工具存在。[DSH rc.5 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5) 对应源码提交 `b830ec950faba0a46dda564be3e2d854afed94f1`。
