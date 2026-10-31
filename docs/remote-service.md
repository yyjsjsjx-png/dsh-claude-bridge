# 远程服务部署

本项目支持**个人账号、多设备自用**：各客户端运行 DSH 和插件，共用自己的服务地址与桥接口令；Linux 服务器的独立非 root 用户运行固定版本的 Claude Code 与 Agent SDK。桥接服务只绑定回环地址，可由受信任 TLS 反向代理提供公网 WSS，或使用 SSH 加密转发。

此说明供账号所有者部署自己的 VPS 和 Claude 账号使用，不提供维护者的账号、公共服务或测试口令。先完成本页，再按 [首次使用指南](getting-started.md) 安装客户端。示例中的用户、目录及 `bridge.example.invalid` 都是占位符，必须换成自己的值；`.invalid` 不能申请公网证书。

## 已验证的版本范围

| 组件 | 本项目要求或实测基线 |
| --- | --- |
| 客户端插件 | `v0.1.4` |
| DSH Desktop | 实测 `0.2.1-rc.5`，其他版本按接口能力检查，仍需实际确认 |
| 服务器 Node.js | `>=24.9`，须准备可独立执行的 Node 和 npm |
| Claude Agent SDK | 锁定 `0.3.314` |
| 官方 Claude Code CLI | 锁定 `2.1.314` |

这些是本项目的兼容范围，不表示它们是上游最新版。不要为升级本插件顺便升级 SDK 或 CLI；其他版本需要重新验证。

## 目录与依赖

由服务器管理员先准备独立非 root 用户，例如 `bridge`，以及供账号所有者完成官方交互登录的服务器桌面环境。不要复用其他 Claude、网关或日常服务的账号目录。以下下载、依赖安装、生成口令和登录操作均以该服务用户执行；systemd 安装命令才使用管理员权限。

从 [v0.1.4 Release](https://github.com/yyjsjsjx-png/dsh-claude-bridge/releases/tag/v0.1.4) 解压插件包，或用已有 Git 获取固定标签源码，放到独立目录：

```sh
git clone --branch v0.1.4 --depth 1 https://github.com/yyjsjsjx-png/dsh-claude-bridge.git /home/bridge/dsh-claude-bridge
cd /home/bridge/dsh-claude-bridge
chmod 700 /home/bridge/dsh-claude-bridge
```

该目录及后续私有文件须由 `bridge` 用户持有；从其他位置复制的源码先由管理员核对归属，不能以 root 运行桥接来绕过权限问题。下文路径均须替换为自己的实际路径。

```text
dsh-claude-bridge/
  remote/                 服务、worker、SDK 依赖和锁文件
  src/                    RPC、历史、台账和协议
  runtime/bin/node        指向现有 Node >=24.9 的路径
  claude-config/          仅该账号可访问的官方配置
  sessions/               SDK 原生会话、归属与私有回执
  private/                独立桥接口令
```

先检查现有运行环境。若缺少 Node/npm，按 [Node.js 官方安装页](https://nodejs.org/en/download) 为自己的 Linux 架构准备符合要求的版本，再继续；这里不会自动安装工具链。将实际 Node 路径固定给 systemd 使用，避免只在交互式 shell 的版本管理器中可见：

```sh
node --version
npm --version
cd /home/bridge/dsh-claude-bridge
mkdir -p runtime/bin
ln -s "$(command -v node)" runtime/bin/node
runtime/bin/node --version
```

`runtime/bin/node` 已存在时先核对它指向的版本，不要盲目覆盖。仅在服务器的 `remote` 目录中，按本项目锁文件安装依赖：

```sh
cd /home/bridge/dsh-claude-bridge/remote
npm ci --omit=optional --ignore-scripts
```

安装后可在 `remote` 目录用 `npm ls @anthropic-ai/claude-agent-sdk --depth=0` 核对 SDK 为 `0.3.314`。本机 DSH 客户端不需要安装这些依赖。

## 官方 CLI 与独立登录

官方原生安装器支持指定版本，具体方式见 [Claude Code 官方安装说明](https://code.claude.com/docs/en/setup#install-a-specific-version)。全新独立服务用户可执行：

```sh
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.314
"$HOME/.local/share/claude/versions/2.1.314" --version
```

本项目默认直接使用上述带版本的二进制路径，不使用可能指向新版的 `claude` 快捷入口；如果实际安装路径不同，在服务中设置 `BRIDGE_CLAUDE_PATH`。先确认输出以 `2.1.314` 开头。固定版本无法取得时停止部署并明确记录缺口，不把其他版本当作已验证版本。

在部署根目录、仍以服务用户创建独立私有目录：

```sh
cd /home/bridge/dsh-claude-bridge
umask 077
mkdir -p private sessions claude-config
chmod 700 private sessions claude-config
```

账号所有者在服务器桌面打开该用户的终端，运行固定版本 CLI 并亲自在官方页面完成登录：

```sh
cd /home/bridge/dsh-claude-bridge
CLAUDE_CONFIG_DIR="$PWD/claude-config" DISABLE_AUTOUPDATER=1 "$HOME/.local/share/claude/versions/2.1.314"
```

只完成登录即可退出，不必发送聊天请求。使用自己具备 Claude Code 使用权限的 `claude.ai` 账号；本桥接当前拒绝其他认证方式，不将 API key、Console、云厂商或其他网关配置视为等价登录。官方流程见 [认证说明](https://code.claude.com/docs/en/authentication)。不要把授权 URL、登录令牌、认证文件或账号信息发给维护者，也不将它们复制到客户端。

服务会将 worker 的 `CLAUDE_CONFIG_DIR` 固定为 `<BRIDGE_REMOTE_ROOT>/claude-config`，必须与本次登录一致；仅在另一个默认 `.claude` 目录登录不会登录此服务。凭据、配置、会话由服务用户持有，私有目录 `700`、私有文件 `600`。

生成独立桥接口令，不复用 Claude 登录令牌；以下命令应在部署根目录、以服务用户运行：

```sh
umask 077
./runtime/bin/node --input-type=module -e 'import fs from "node:fs"; import {randomBytes} from "node:crypto"; fs.writeFileSync("private/service-token", randomBytes(32).toString("base64url"), {mode:0o600,flag:"wx"})'
stat -c '%U %a %n' private/service-token
```

核对文件归属为服务用户、权限为 `600`。服务拒绝符号链接、其他用户所有或向组/其他人开放的口令文件。生成命令遇到已有文件会失败，避免更新时覆盖现有口令。仅通过自己的受信任私密通道将桥接口令填入本机 DSH 设置，不放进 URL、shell 命令参数、截图或公开报告。

## 配置

| 环境变量 | 含义 |
| --- | --- |
| `HOME` | 独立服务用户的实际 home，模板须与系统账号一致，不能靠修改它冒充其他用户 |
| `BRIDGE_REMOTE_ROOT` | 部署根目录的绝对路径 |
| `BRIDGE_PORT` | 回环服务端口，默认 `18944` |
| `BRIDGE_TOKEN_FILE` | 私有桥接口令文件的绝对路径 |
| `BRIDGE_CLAUDE_PATH` | 可选，固定版本 CLI 的绝对路径 |
| `BRIDGE_CLAUDE_VERSION` | 默认 `2.1.314`；升级须重新验证兼容性 |
| `BRIDGE_MAX_BUDGET_USD` | SDK 每轮费用估算上限，默认 `0.15`；不是订阅剩余额度 |
| `BRIDGE_WORKER_PATH` | 可选，独立 worker 的绝对路径 |

worker 仅接收必要的白名单配置，不继承桥接口令；CLI/SDK 版本不匹配会拒绝启动。每台设备独立 worker，会话绑定校验设备、工作区、系统提示摘要和原生 session ID。

命令行入口 `remote/server.mjs` 不提供 host 参数，也不读取 `BRIDGE_HOST`，始终监听 `127.0.0.1`。不要将修改该环境变量当成开放公网的方式。上表列出的配置通过 systemd 的 `Environment=` 设置；默认 CLI 路径不同时，额外增加 `Environment=BRIDGE_CLAUDE_PATH=/自己的绝对路径/2.1.314`。

也可在前台先核对服务能否监听，使用另一终端检查后按 Ctrl+C 退出，再交给 systemd：

```sh
BRIDGE_REMOTE_ROOT=/home/bridge/dsh-claude-bridge BRIDGE_PORT=18944 BRIDGE_TOKEN_FILE=/home/bridge/dsh-claude-bridge/private/service-token ./runtime/bin/node remote/server.mjs
```

监听成功尚未验证官方登录或模型可用性；worker 在客户端认证连接后才启动，后续还需执行客户端的“测试连接并刷新模型”。

## systemd

使用 [bridge.service.example](../deploy/bridge.service.example) 生成自己的系统服务，替换其中 `__USER__`、`__HOME__`、`__ROOT__`、`__PORT__` 和 `__TOKEN_FILE__`。`ExecStart` 的 Node 路径须实际存在。目录含空格时按 systemd 规则引用路径。

此服务由系统 systemd 管理，通过 `User=` 降权运行；启用后可在用户未登录图形桌面时启动，不依赖用户服务的 linger。模板设置异常重启、控制组停止、私有临时目录、只读系统及 home，仅 `sessions` 和 `claude-config` 可写。

可先将模板复制为系统服务，再编辑全部占位符：

```sh
sudo install -m 644 deploy/bridge.service.example /etc/systemd/system/dsh-claude-bridge.service
sudoedit /etc/systemd/system/dsh-claude-bridge.service
```

例如独立用户为 `bridge` 时，`__USER__` 为 `bridge`、`__HOME__` 为 `/home/bridge`、`__ROOT__` 为 `/home/bridge/dsh-claude-bridge`、`__PORT__` 为 `18944`、`__TOKEN_FILE__` 为该目录下 `private/service-token` 的绝对路径。确认没有剩余占位符后：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-claude-bridge.service
sudo systemctl is-active dsh-claude-bridge.service
ss -lnt 'sport = :18944'
```

监听应为 `127.0.0.1:18944`。维护前先确认没有活动运行；更新只替换本次源码，保留私有目录并备份旧文件。不要通过重发 query 检查部署是否成功，使用 `initialize` 和模型目录即可，无需推理。

## 客户端连接

有公网 WSS 时，客户端只需在 DSH“远程 Claude”页填写地址和独立桥接口令，保存后测试连接；不需要在客户端运行 SSH。

例如域名已经指向服务器、Caddy 管理可信证书时，独立站点可转发到回环桥接：

```caddyfile
bridge.example.invalid {
    reverse_proxy 127.0.0.1:18944
}
```

将占位域名换为自己已经配置 DNS 和可信 TLS 证书的域名，客户端填写 `wss://自己的域名/`；不要关闭客户端证书校验来掩盖域名或证书错误。反向代理须支持 WebSocket Upgrade。将新站点加入现有代理前应备份并校验配置，再平滑重载；临时测试入口使用独立后端、独立口令和明确的到期停用机制。桥接后端本身仍保持回环监听，不在防火墙或云安全组直接开放 `18944`。

没有公网 WSS 时，可选 SSH 转发：

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18944:127.0.0.1:18944 bridge@bridge.example.invalid
```

在 DSH 的“远程 Claude”页保存 `ws://127.0.0.1:18944/` 和独立桥接口令，再测试连接。本地地址只在转发已经建立的那台机器有效。客户端拒绝公网明文 `ws` 和 URL 中嵌入的口令。

私人连接包可复用 `scripts/connect-ssh.ps1`、`scripts/connect-ssh.sh`，包内放独立私钥、通过可信管理通道核实的 `known_hosts`，以及 `ssh.json`：

```json
{"host":"bridge.example.invalid","port":22,"user":"bridge-test","localPort":18944,"remotePort":18944}
```

Windows 脚本按当前用户限制私钥权限，保持转发并退避重连。Linux/macOS 使用 `sh connect-ssh.sh HOST USER SSH_PORT LOCAL_PORT REMOTE_PORT`。SSH 账号可配置为仅本地转发、固定 `PermitOpen`、禁止终端，并给测试公钥设置到期时间。服务器地址、公钥固定文件、密钥和口令不随公开安装包分发。

开发启动器的 `--ssh-target` 管理自己启动的转发，退出后自动重建；端口被占用会明确报错，不终止其他进程。

## 恢复机制

- 认证后协商 `resume-v1`。短断保留原 RPC 和 worker，客户端最多重连 60 秒、服务器保留 90 秒；15 秒心跳、45 秒无消息判定半开。恢复身份丢失不冒充接续。
- 每侧最多 4096 帧及 4 倍单帧大小的字节预算。持久化通知后 ACK，按序补漏和去重；取消优先于业务帧。
- Host/worker/服务重启后，查询 SDK 原生 `getSessionMessages`，补齐显示尾部，按本机事件与云端匹配回执核实工具。未知副作用不自动重执行。
- 当前会话挂载、轮末、恢复网络及恢复可见时自动同步，前台空闲每 30 秒增量核对；执行、停止或压缩时暂停，失败有退避。完成后可直接继续对话。消失的调用栈不自动恢复。
- 恢复说明只包含已核实事实和安全处理建议，随下一条用户消息送达，按 hash 去重。它不包含原始命令、stderr、账号资料或聊天全文。
- 传输还可协商逐消息压缩；只有足够大的非图片帧且确有收益时使用。解压、队列及历史分页均有上限。

停止只取消后续执行，不撤销已经发生的副作用。恢复后新一轮正常对话会更新当前上下文；旧未知工具结果仍保留核实记录。模型正常结束一轮不会由桥接自动发起另一轮。运行中追加的文本在工具批次边界作为 SDK hook 附加上下文送达，模型对其响应存在差异，不能将它当成强制打断；需要停止时使用 DSH 停止按钮。

## 初次连接与常见问题

客户端安装和使用步骤见 [首次使用指南](getting-started.md)。先用“测试连接并刷新模型”核对 TLS、桥接口令、官方登录、固定版本及模型目录；该操作不发送聊天提示词，不能替代实际一轮对话验收。不要以循环发送模型请求作为健康检查。

| 现象 | 检查方向 |
| --- | --- |
| 服务无法启动或不监听 | 查看 `systemctl status dsh-claude-bridge.service`，核对非 root 用户、Node 路径、源码依赖、端口及口令文件归属/权限；原始日志仅在自己的服务器检查 |
| 连得上 TLS，却认证失败 | 核对独立桥接口令与客户端保存值；它与 Claude 官方登录是两层认证 |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | 账号所有者在同一服务用户、同一 `claude-config` 目录重新完成官方登录 |
| `SDK_VERSION_MISMATCH` / `CLI_VERSION_MISMATCH` | 核对锁定 SDK 和固定 CLI 绝对路径，不直接升级依赖来消除报错 |
| `MODEL_UNAVAILABLE` / `EFFORT_UNSUPPORTED` | 刷新账号目录，选择实际返回的明确模型及受支持强度 |
| `BUDGET_EXHAUSTED` | 本轮达到服务配置的 SDK 费用估算上限；与订阅剩余额度不是同一个值 |
| 连接后仍无模型目录或 RPC 关闭 | 检查自己服务器 worker 的简短启动错误；主服务 active 只证明监听进程存在 |
| 工具结果待核实 | 先检查实际文件、进程或外部状态，再决定是否重做；不能凭超时推断未执行 |

## 私有数据与运维

DSH 会话和受保护的本机连接设置、服务器 `claude-config`、`sessions`、`private`、备份及诊断均不属于公开源码。rc.5 本机凭据采用用户受保护文件，不能等同于操作系统加密保险库。

桥接口令是共享服务访问凭据，device ID 只是会话命名空间。本版本面向账号所有者自己的设备，不把它当作多人租户隔离服务。临时测试凭据应独立生成、限制用途和有效期；撤销时移除对应 SSH 公钥并停用该测试入口。

客户端“清除已保存连接”只删除该客户端的地址和桥接口令，并关闭其连接；不会退出服务器 Claude，也不会使其他设备持有的同一口令失效。需要全局撤销时，在服务端更换桥接口令并重启相应服务。

不同 device ID 使用独立 worker，不同 SDK session 可并发；相同 SDK session 由运行门禁和跨 worker 文件锁保护。多个窗口连接同一 Host 时共用连接；复制完整 DSH_HOME 后运行两个 Host 会因相同 device ID 冲突。所有任务仍共享账号和机器资源，未实现账号级公平排队；默认 16 个连接槽位包含断线保留项，不等于订阅允许的模型并发数。

公网 WSS 由反向代理终止 TLS，认证仍由桥接服务在 WebSocket 内完成。地址中不包含口令，公开源码不保存实际测试入口或凭据。

云端从 v0.1.2 开始把白名单诊断写入 `sessions/_diagnostics/<device-id>/bridge.jsonl`，断线时仍保留。每个设备最多当前与上一份日志，各 2 MiB。双端采集、合并报告及时间字段解释见 [性能诊断](performance.md)。更新远端源码后需在请求空闲时重启相应服务；仅更新客户端不会给旧服务器增加日志能力。

远端升级按固定标签更新公开源码和确实变化的依赖，保持原服务用户、目录、`claude-config`、`sessions`、`private` 及口令不变。停服务前确认没有活动任务，备份私有数据并限制备份权限；备份中可能含账号登录和会话正文，不上传。客户端原地更新方式见 [更新说明](updating.md)，两端更新不等于需要重新登录或重建会话。
