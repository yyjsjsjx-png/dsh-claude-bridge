# DSH Claude Bridge

在本机 DSH 中使用远程官方 Claude Agent SDK：界面、历史、文件、命令、提问和审批留在本机，Claude 的原生会话、上下文和压缩由服务器上的 SDK 管理。

本项目面向个人账号的生产试用。客户端不需要安装 Claude Code 或 Agent SDK。

## 兼容版本

| 组件 | 版本 |
| --- | --- |
| DSH Desktop 实测基线 | **[0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)** |
| 兼容代码来源提交 | `b830ec950faba0a46dda564be3e2d854afed94f1` |
| Claude Agent SDK（仅服务器） | `0.3.314` |
| Claude Code（仅服务器） | `2.1.314` |
| Node.js（服务器或开发启动脚本） | `>=24.9` |

插件包含构建好的运行文件。DSH 版本号不设白名单，也不再要求安装版源码摘要相同；启动时检查必需接口、RPC 参数及原生会话回放协议，标准预设按当前安装版读取并检查结构。普通更新和新增接口可以继续加载，发现不兼容接口时会明确提示“远程 Claude 插件无法加载”及原因。上表是实测基线，其他版本仍需实际使用验证；服务器 SDK 和 CLI 继续固定版本。

## 安装与连接

1. 安装 DSH。已有日常数据时使用独立配置和数据目录；全新测试虚拟机可直接使用新安装。
2. 在 **插件 → 添加插件** 中填入：

   ```text
   https://github.com/yyjsjsjx-png/dsh-claude-bridge#v0.1.1
   ```

   也可解压 Release 的插件 ZIP，添加其中**包含 package.json 的目录**。启用 bundle，按 DSH 提示重载。
3. 在 **设置 → 远程 Claude** 保存服务提供方给出的 **`wss://…` 服务器地址**和**独立桥接口令**，点击“测试连接并刷新模型”。公网 WSS 直接连接，不需要 SSH、密钥文件或额外启动脚本。
4. 在会话首页点击“新建远程 Claude”，选择账号实际返回的模型与推理强度，再开始对话。

如果服务器只提供回环入口，可选择 SSH 转发。标准内网端口为 `18944`；专用测试入口以提供方说明为准：

   ```sh
   ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
     -L 127.0.0.1:18944:127.0.0.1:18944 your-user@your-server
   ```

转发建立后，服务器地址改填 `ws://127.0.0.1:18944/`。此地址通过 SSH 加密传输；公网明文 WebSocket 会被拒绝。

公开仓库和公开安装包不含服务器访问凭据。WSS 测试地址和口令由部署方单独提供；只有使用 SSH 方式时才需要连接脚本。

现有 DSH CLI 也可执行：

```sh
dsh plugin --profile your-test-profile add https://github.com/yyjsjsjx-png/dsh-claude-bridge#v0.1.1
```

## 已实现

- 本机 DSH 工具经结构化双向 RPC 提供给 SDK，保留原审批、提问、路径权限和取消。
- 文本、图片附件、本机路径读图、思考摘要、模型和 effort 目录；模型列表可自行筛选。
- 底栏精简上下文浮层、SDK 原生 `/compact`、5h 额度及明细浮层。周额度和专用额度仅在接口实际返回时显示。
- 额度前台每 60 秒检查，自动请求至少间隔 30 秒，轮末延迟 3 秒；隐藏、离线暂停。失败退避，鉴权失效暂停；过期数据不继续显示。
- 短断接回原 worker，按序补漏、确认和去重；本机工具等待连接恢复，离线停止优先。SSH 启动脚本只重建自己管理的转发。
- Host、worker 或服务崩溃后，从 SDK 原生记录补齐云端尾部，核对本机已保存结果及匹配的云端工具回执。界面显示恢复情况，用户可直接发下一条消息。
- 无法确认的工具结果保留为“待核实”，不重发原请求。下一条用户输入可附带已核实的恢复事实和只读核实建议，成功送达后去重，不额外发模型请求。
- 设置页打开时刷新本设备用量，前台每 5 秒更新，隐藏或离线暂停；兼容性和诊断明细默认收起。

## 恢复边界

短断重连窗口为 60 秒，服务保留原 worker 90 秒；心跳、缓冲和历史同步均有容量与时间上限。Host、worker、服务重启后恢复原生记录和后续对话，不能恢复已经消失的进程调用栈，也不自动续跑未知副作用。

`/bridge-recovery` 可查看未知状态；用户核实后可用 `/bridge-recovery confirm` 解除后续运行门禁，原未知结果保持原样。停止不代表撤销已经产生的副作用。

会话分叉、`subagent_fork`、计划模式和 DSH 本机压缩保持关闭。步骤和工具附加上下文只接受文本。多设备各自拥有独立历史，device ID 不是多用户授权边界。

## 部署与验证

服务器部署、systemd 和私有数据边界见 [远程服务说明](docs/remote-service.md)；功能状态和证据范围见 [兼容清单](docs/compatibility-inventory.md)。第三方兼容代码的来源与许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。

```sh
npm test
```

普通检查不安装 SDK。ASAR 专用检查使用已有 DSH Electron 的 Node 模式。`scripts/recovery-e2e.mjs` 使用实际 SSH、WebSocket、worker、DSH 持久化和本机工具进程，仅 SDK 是确定性替身；七类故障链路已通过，验收期间新增模型请求为 0。它需要现有独立测试服务器，运行方法见兼容清单。

开发用隔离 Host 可用 `node scripts/launch-isolated.mjs <DSH-resources目录> --ssh-target <已有SSH别名>` 启动，数据保存在本项目 `.local/harness`。认证入口和该目录内的数据均须保密。

MIT License。Claude 官方认证由账号所有者在服务器完成；本项目不分发账号登录材料。
