# `ash-app-server-test-client`

- 提供独立的 App Server 命令行调试入口，隔离调试命令和连接依赖。
- 启动 `ash-app-server --listen stdio://`，或连接已有的带能力令牌鉴权的回环 WebSocket。
- 使用正式协议完成初始化和主版本检查，提供模型列表、会话列表、通用 RPC 请求和通知观察。
- 请求和初始化都有期限；退出时关闭连接，并等待或终止自己启动的子进程。
- 只依赖协议和传输 crate，不依赖 App Server、Core 或产品 CLI；不参与产品打包。

## 运行

从仓库根目录执行；先构建需要调试的服务端：

```text
uv run --frozen --project scripts python -B scripts/cargo.py build -p ash-app-server --bin ash-app-server
uv run --frozen --project scripts python -B scripts/cargo.py run -p ash-app-server-test-client -- --server-bin .build/cargo/debug/ash-app-server --home .build/test-client-profile initialize
```

Windows 下可执行路径加 `.exe`。未指定连接参数时从 PATH 启动 `ash-app-server`。
`--home` 对应子进程的 `ASH_HOME`，省略时使用服务端正常的 profile 选择规则。
`--workspace` 是显式目录授权；不传时清除子进程继承的 `ASH_WORKSPACE_ROOT`。
这两个参数只用于 stdio。`--timeout` 默认 30 秒，适用于连接、初始化和每次请求，观察通知没有空闲超时。

以下示例省略上述 `run` 前缀和连接参数：

```text
ash-app-server-test-client model-list
ash-app-server-test-client model-list --view built-in
ash-app-server-test-client session-list
ash-app-server-test-client request session/read @params.json
ash-app-server-test-client request session/subscribe @params.json --watch
ash-app-server-test-client watch --session-id SESSION_ID
```

- `request` 的参数为 JSON 对象，默认 `{}`；`@文件路径` 用于避免 shell 转义。
- `model-list` 默认读取已发现模型；`--view built-in` 读取桌面端的固定目录。
- `watch` 不指定会话时观察当前连接收到的通知；指定会话时先调用 `session/subscribe`。
- 每次运行只有一条连接。需要保留订阅时，使用 `watch` 或 `request --watch`，按 Ctrl+C 关闭。
- stdout 每行输出一个 JSON：请求结果、通知或服务端反向请求；错误写入 stderr 并返回非零退出码。
- 收到反向请求时返回 `-32601`；不声明交互处理能力，不自动同意审批。Agent 交互仍由支持交互的产品客户端处理。

## WebSocket

连接由 App Server 启动记录给出的实际 endpoint；启动参数见 [App Server 进程入口](../app-server/README.md#进程入口)。
仅接受 `ws://回环IP:端口`，令牌须与服务端配置的 SHA-256 摘要对应。

```powershell
$env:ASH_APP_SERVER_TOKEN = '<capability-token>'
uv run --frozen --project scripts python -B scripts/cargo.py run -p ash-app-server-test-client -- --url ws://127.0.0.1:4222 model-list
```

`ASH_APP_SERVER_BIN`、`ASH_APP_SERVER_URL` 分别对应 `--server-bin`、`--url`，两种连接方式互斥。
令牌只用于 HTTP Authorization，不打印到帮助或通信输出。
协议方法与参数见 [App Server API](../../docs/ash-app-server-api.md)。

## 验证

```text
just check ash-app-server-test-client
just test ash-app-server-test-client
just rust-warnings ash-app-server-test-client
just dependencies
```

- 子进程测试覆盖初始化、参数文件、通知与响应交错、反向请求拒绝、协议错误、超时和退出回收。
- WebSocket 测试使用正式传输监听器，覆盖带令牌调用、错误令牌拒绝和回环地址约束。
