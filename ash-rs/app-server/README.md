# `ash-app-server`

`ash-app-server` 组合一个环境中的服务并实现 App Server 协议，具体职责如下：

1. 在每条已建立的连接上执行类型化协议分发，并编排请求取消、Thread、Turn、Project 与通知生命周期；连接建立、鉴权和消息队列由 `ash-app-server-transport` 负责。
2. 在文件、搜索、Git、Terminal、语言服务和目录贡献入口检查对应 Permission，并只把有效 `Authorization` 交给执行服务。
3. 组合 profile 级配置与产品服务；Project 只保存弱关联，目录配置、Instructions、Hooks、Skills、MCP 和 Plugins 只有在获得对应 Permission 与 Grant 后才能生效。

交互式 PTY、输出缓存和重连租约由 [`ash-terminal-service`](../terminal-service/README.md) 管理；
`src/server/terminal_operations.rs` 负责协议转换和调用，环境装配负责传入有效授权。

环境和目录授权语义见 [`docs/environment-access.md`](../../docs/environment-access.md)，wire contract 见
[`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

```text
just test ash-app-server
```

## 进程入口

- `ash-app-server --listen stdio://` 提供直接连接；未设置 `ASH_WORKSPACE_ROOT` 时不继承当前目录授权。
- WebSocket 使用 `--listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 HEX --emit-listen-info stdout-json`，监听成功后输出一条启动记录。
- `src/startup.rs` 负责参数、环境绑定和服务启动；CLI 调用同一 `run`。
- profile 路径和随包产品服务发现由 `install-context` 提供，客户端消费相同契约。
- `arg0` 在普通参数解析前分发内部 worker；启动命令绑定实际宿主可执行路径。
- daemon 的连接和生命周期命令由 [`app-server-daemon`](../app-server-daemon/README.md) 提供。

验证：`just test ash-app-server --test stdio --test websocket --test worker`。

## 受管后台进程

- `ash-app-server --managed` 运行 profile 级共享服务；PID 记录直接指向此进程。
- `src/managed.rs` 拥有服务循环、连接线程、停止期限和空闲退出。
- `src/managed/registry.rs` 拥有目录服务组合，以及共享队列与自动化运行。
- 先取得 profile 端点，再启动后台工作，避免并发启动重复运行任务。
- daemon crate 提供进程管理和控制端点机制，App Server 依赖它；依赖方向保持单向。
