# `ash-remote-host`

`ash-remote-host` 是本机 Remote Tunnel 的生命周期工具层。它位于
[`ash-remote-connections`](../remote-connections/README.md) 的 SSH/Tunnel primitive 之上，
为产品宿主提供可复用的 Tunnel 启动、就绪检测、取消、进程退出恢复和类型化事件。

它不是 App Server host，也不是 Remote App Server client。App Server 的横向产品边界由
`ash-app-server-client::AppServerSession` 提供；Local 与 Remote 都必须交付同一个 client/session
contract。这个 crate 只服务于需要 loopback Tunnel 的产品能力。

## Ownership

本 crate 负责活跃 Tunnel 的运行时生命周期：

- 为一个 Remote target 创建和持有多个逻辑 Tunnel；
- 监听 OpenSSH 子进程退出；
- 在固定的恢复窗口内以退避策略重建 Tunnel；
- 保持恢复时的本地 loopback 端口；
- 通过 `RemoteTunnelEvent` 向宿主发布状态。

本 crate 不负责：

- `RemoteConnectionCatalog` 或产品配置文件的读取；
- credentials、UI、窗口和命令注册；
- `WorkbenchEvent`、`AppProxy`、`ElementId` 或任何具体应用类型；
- 远端 runtime 的安装策略。

产品应先解析自己的 profile/catalog，再将 `SshHost` 和 SSH executable 交给
`RemoteTunnelHost`。产品宿主负责把 `RemoteTunnelEvent` 映射到自己的事件循环和 UI state。

## App Server 与 Tunnel 的边界

```text
product AppServerHost (app / Desktop)
  -> ash-app-server-client  # typed session, initialize, events, shutdown
      ├─ Local App Server
      └─ Remote backend
          -> ash-remote
          -> ash-remote-connections
          -> OpenSSH / remote-server

product Tunnel coordinator (optional)
  -> ash-remote-host        # Tunnel lifecycle only
  -> ash-remote-connections # OpenSSH/Tunnel primitives
  -> ash-remote              # target identity and validation
```

`RemoteTunnelHost` 是本机 host-side supervisor，不是远端服务端；远端运行时仍由
`ash-remote-server` 负责。

## Verification

```bash
cargo test -p ash-remote-host
```
