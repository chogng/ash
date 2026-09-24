# ash-network-proxy

后续命令网络能力与各平台验收门槛见[代理规划](../docs/network-proxy.md)。产品模型 API key 的进程边界见[凭据说明](../../docs/secrets.md#12-模型-api-key-的进程边界)。

- 提供 HTTP 正向代理、HTTPS CONNECT 和 SOCKS5 TCP 转发。
- 在 DNS 查询和连接上游前，将每个真实目标交给主机授权。
- 固定已检查的解析地址，阻止域名解析到私有地址后绕过目标限制。
- 为每次命令执行创建独立端口，统一准备子进程代理环境变量。
- 支持 HTTP 与 SOCKS5 共用一个监听端口，供 MXC SDK 的单个代理端点使用。
- 在执行结束、取消和超时后关闭监听、连接与等待授权的请求。
- 用 `server` feature 隔离监听和 HTTP 实现依赖；只消费授权接口的 crate 不启用它。

## 产品接入

本地工具配置中存在 `Network`、`ActionKind::NetworkRequest` 或 `network` capability selector 时，Shell
使用 `NetworkAccess::Managed`。没有网络规则时继续使用禁止网络策略；`rg` 保持断网。
嵌套 `All` selector 同样参与判断。规则由现有 `execPolicy/rule/upsert` 或 User Config 保存。

例如，下面的规则要求每次访问指定 HTTPS 目标都经过审批：

```json
{
  "id": "ask-api",
  "selector": {
    "type": "network",
    "protocol": "https_connect",
    "host": { "type": "exact", "value": "api.example.com" },
    "port": 443
  },
  "effect": { "type": "requireApproval" }
}
```

代理观察协议名为 `http`、`https_connect` 和 `socks5_tcp`。CONNECT 表示隧道，不保证隧道内使用 TLS。未匹配的网络请求按本地
策略默认拒绝。`AllowUnsandboxed` 命中网络请求时仅批准该连接，保持命令的文件与进程限制。
命令自身获准扩大文件权限时，已配置的受管网络限制仍然生效。
网络动作不携带命令前缀匹配输入，命令前缀规则不会自动批准连接。

Core 复用既有 `AgentRequest::Approval` / `AgentResponse::Approval` 协议，批准绑定执行、
请求序号、协议、目标、端口、HTTP 方法和策略版本。批准后继续等待中的请求；不重跑 Shell，
不把一次批准保存为域名长期许可。
本地策略与审查协议版本已更新，恢复中的旧 Turn 不会沿用旧版本自动取得新的网络能力。

## 职责边界

| 组件 | 负责 |
| --- | --- |
| `network-proxy` | 协议解析、地址检查、代理环境、监听与连接生命周期 |
| `execpolicy` / `action-policy` | 规则优先级、拒绝、授权与审查 |
| Core | Turn 审批模式、持久交互和取消 |
| `tool-executor` | 创建代理、应用启动环境、输出预算、取消与超时 |
| `sandboxing` / `mxc-sandbox` | 进程生命周期、平台限制与对应代理端口开放 |
| `http-client` / `websocket-client` | 普通客户端的路由、TLS、连接池与握手 |

配置读取、持久化、组织策略分发和凭据来源不由代理持有。代理不读取宿主的代理环境作为自身上游，
避免子进程代理设置形成递归转发。

## 强制执行与支持范围

- macOS 通过 MXC SDK 使用 Seatbelt，禁止直连并只开放本次代理端口。
- Linux 通过 MXC 的 Bubblewrap 后端建立网络隔离与代理路径，需要 slirp4netns、util-linux 和 iptables。
- Windows 当前普通宿主代理无法满足 SDK 的身份及入站约束，严格受管网络请求明确拒绝；不能因此开放更宽网络。
- 后端不能实施受管网络时，命令不会自动改为不受限执行。
- 域名解析为非公网地址时拒绝；显式 IP 和 `localhost` 仍须通过请求授权。
- HTTPS CONNECT 和 SOCKS5 TCP 按目标授权，不检查隧道内的方法、路径或内容。
- SOCKS5 UDP、TLS 解密、证书签发、凭据替换和上游代理链不在当前能力范围。

## 验证入口

```sh
just check ash-network-proxy --features server
just test ash-network-proxy --features server
just test ash-tool-executor managed_command_can_reach_only_its_authorized_proxy_destinations
just test ash-app-server managed_network_approval_resumes_the_same_shell_process_through_rpc
```

后两项需要真实 macOS。平台不可用不计为强制执行验收通过。
Linux/Windows 场景分别位于 `mxc-sandbox/tests/linux.rs`、`mxc-sandbox/tests/windows.rs`，已加入 Platform checks。
Windows 场景分别验证 SDK 文件/断网执行及严格受管网络的明确拒绝。
当前开发主机仅完成交叉编译与跨平台单测；真实 Linux/Windows 内核验收结果仍待 CI 或测试机回填。
