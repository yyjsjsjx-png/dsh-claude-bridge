# 远程服务部署

客户端运行 DSH 和插件；Linux 服务器的独立非 root 用户运行固定版本的 Claude Code 与 Agent SDK。桥接服务只绑定回环地址，可由受信任 TLS 反向代理提供公网 WSS，或使用 SSH 加密转发。

## 目录与依赖

将源码部署到独立目录，例如 `/home/bridge/dsh-claude-bridge`。下文的服务用户、目录和端口均须替换为自己的值。

```text
dsh-claude-bridge/
  remote/                 服务、worker、SDK 依赖和锁文件
  src/                    RPC、历史、台账和协议
  runtime/bin/node        指向现有 Node >=24.9 的路径
  claude-config/          仅该账号可访问的官方配置
  sessions/               SDK 原生会话、归属与私有回执
  private/                独立桥接口令
```

仅在服务器的 `remote` 目录中，按现有锁文件安装依赖：

```sh
cd /home/bridge/dsh-claude-bridge/remote
npm ci --omit=optional --ignore-scripts
```

SDK 固定 `0.3.314`；官方 CLI 固定 `2.1.314`，默认路径为服务用户的 `$HOME/.local/share/claude/versions/2.1.314`。使用现有工具链，在服务器上完成相应版本准备和 `--version` 检查。本机不需要这些依赖。

账号所有者在服务器的官方登录界面完成认证，`CLAUDE_CONFIG_DIR` 应为部署根目录下的 `claude-config`。不把登录材料复制到客户端或源码。凭据、配置、会话由服务用户持有，目录权限 `700`、私有文件 `600`。

生成独立桥接口令，不复用 Claude 登录令牌；以下命令应在部署根目录、以服务用户运行：

```sh
umask 077
mkdir -p private sessions claude-config
node --input-type=module -e 'import fs from "node:fs"; import {randomBytes} from "node:crypto"; fs.writeFileSync("private/service-token", randomBytes(32).toString("base64url"), {mode:0o600,flag:"wx"})'
```

## 配置

| 环境变量 | 含义 |
| --- | --- |
| `HOME` | 独立服务用户的实际 home |
| `BRIDGE_REMOTE_ROOT` | 部署根目录的绝对路径 |
| `BRIDGE_HOST` | 固定为回环地址，默认 `127.0.0.1` |
| `BRIDGE_PORT` | 回环服务端口，默认 `18944` |
| `BRIDGE_TOKEN_FILE` | 私有桥接口令文件的绝对路径 |
| `BRIDGE_CLAUDE_PATH` | 可选，固定版本 CLI 的绝对路径 |
| `BRIDGE_CLAUDE_VERSION` | 默认 `2.1.314`；升级须重新验证兼容性 |
| `BRIDGE_MAX_BUDGET_USD` | SDK 每轮费用估算上限，默认 `0.15`；不是订阅剩余额度 |
| `BRIDGE_WORKER_PATH` | 可选，独立 worker 的绝对路径 |

worker 仅接收必要的白名单配置，不继承桥接口令；CLI/SDK 版本不匹配会拒绝启动。每台设备独立 worker，会话绑定校验设备、工作区、系统提示摘要和原生 session ID。

## systemd

使用 [bridge.service.example](../deploy/bridge.service.example) 生成自己的系统服务，替换其中 `__USER__`、`__HOME__`、`__ROOT__`、`__PORT__` 和 `__TOKEN_FILE__`。`ExecStart` 的 Node 路径须实际存在。目录含空格时按 systemd 规则引用路径。

此服务由系统 systemd 管理，通过 `User=` 降权运行；启用后可在用户未登录图形桌面时启动，不依赖用户服务的 linger。模板设置异常重启、控制组停止、私有临时目录、只读系统及 home，仅 `sessions` 和 `claude-config` 可写。

安装到 `/etc/systemd/system/dsh-claude-bridge.service` 后：

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
bridge.example.com {
    reverse_proxy 127.0.0.1:18944
}
```

客户端填写 `wss://bridge.example.com/`。将新站点加入现有代理前应备份并校验配置，再平滑重载；临时测试入口使用独立后端、独立口令和明确的到期停用机制。桥接后端本身仍保持回环监听。

没有公网 WSS 时，可选 SSH 转发：

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18944:127.0.0.1:18944 your-user@your-server
```

在 DSH 的“远程 Claude”页保存 `ws://127.0.0.1:18944/` 和独立桥接口令，再测试连接。本地地址只在转发已经建立的那台机器有效。客户端拒绝公网明文 `ws` 和 URL 中嵌入的口令。

私人连接包可复用 `scripts/connect-ssh.ps1`、`scripts/connect-ssh.sh`，包内放独立私钥、通过可信管理通道核实的 `known_hosts`，以及 `ssh.json`：

```json
{"host":"your-server.example","port":22,"user":"bridge-test","localPort":18944,"remotePort":18944}
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

## 私有数据与运维

DSH 会话和受保护的本机连接设置、服务器 `claude-config`、`sessions`、`private`、备份及诊断均不属于公开源码。rc.5 本机凭据采用用户受保护文件，不能等同于操作系统加密保险库。

桥接口令是共享服务访问凭据，device ID 只是会话命名空间。本版本面向账号所有者自己的设备，不把它当作多人租户隔离服务。临时测试凭据应独立生成、限制用途和有效期；撤销时移除对应 SSH 公钥并停用该测试入口。

客户端“清除已保存连接”只删除该客户端的地址和桥接口令，并关闭其连接；不会退出服务器 Claude，也不会使其他设备持有的同一口令失效。需要全局撤销时，在服务端更换桥接口令并重启相应服务。

不同 device ID 使用独立 worker，不同 SDK session 可并发；相同 SDK session 由运行门禁和跨 worker 文件锁保护。多个窗口连接同一 Host 时共用连接；复制完整 DSH_HOME 后运行两个 Host 会因相同 device ID 冲突。所有任务仍共享账号和机器资源，未实现账号级公平排队；默认 16 个连接槽位包含断线保留项，不等于订阅允许的模型并发数。

公网 WSS 由反向代理终止 TLS，认证仍由桥接服务在 WebSocket 内完成。地址中不包含口令，公开源码不保存实际测试入口或凭据。

云端从 v0.1.2 开始把白名单诊断写入 `sessions/_diagnostics/<device-id>/bridge.jsonl`，断线时仍保留。每个设备最多当前与上一份日志，各 2 MiB。双端采集、合并报告及时间字段解释见 [性能诊断](performance.md)。更新远端源码后需在请求空闲时重启相应服务；仅更新客户端不会给旧服务器增加日志能力。
