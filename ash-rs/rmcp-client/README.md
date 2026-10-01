# ash-rmcp-客户端

> 本 README 是外部 MCP client 协议与 transport 实现的 canonical 文档。跨 crate 产品语义、
> catalog/approval/durability 边界及 `ash-mcp` 演进见
> [`../../docs/mcp.md`](../../docs/mcp.md)。

本 crate 直接使用官方 `rmcp` SDK，为一个外部 MCP server 建立一个隔离 client session。它拥有
initialize、原始 tool discovery/call、server notification/elicitation 回调以及 stdio /
Streamable HTTP transport convenience connector；它不拥有 server 配置解析、credential
持久化、tool alias/catalog、approval、Core tool loop 或 durable Thread result。

## 文件与公共契约

| 文件 / symbol | 职责 |
| --- | --- |
| `client.rs` / `RmcpClient` | 一个已经 initialize 的 session；并发发送原始 `tools/list` / `tools/call` |
| `client.rs` / `RmcpClient::connect` | caller-provided RMCP transport 接入点，供 sandbox/remote launcher 或自定义 HTTP stack 使用 |
| `client.rs` / `connect_stdio`、`connect_streamable_http` | direct local child 与 reqwest HTTP convenience connector |
| `client.rs` / `RmcpClientOptions`、`RmcpTimeouts` | client identity、host callback 与 initialize/request/shutdown deadline |
| `handler.rs` / `McpClientHost` | server notification 与 elicitation 的 host-owned delivery contract |
| `handler.rs` / `McpClientEvent` | progress、server cancellation 与 catalog invalidation notification |
| `transport.rs` | `StdioServerCommand`、`StreamableHttpServer`、redacted `BearerToken` |
| `error.rs` / `RmcpClientError` | transport start、handshake、request deadline、service 与 shutdown failure |

公共工具请求/结果直接重新导出 RMCP 模型。这是有意的低层边界；特定协议版本的数据结构
不能从本 crate继续向 Core 或 App Server protocol 泄漏。当前 `ash-mcp` 已把这些类型投影为
provider-neutral catalog、冻结 binding 与 result。

## 内部接口与执行路径

真实调用关系：

```text
RmcpClient::connect_stdio
→ StdioServerCommand::into_command
→ rmcp::transport::TokioChildProcess
→ RmcpClient::connect

RmcpClient::connect_streamable_http
→ StreamableHttpClientTransportConfig
→ ash-http-client::ReqwestHttpClient::sdk_client_builder (OS trust + ring)
→ rmcp::transport::StreamableHttpClientTransport
→ RmcpClient::connect

RmcpClient::connect
→ ClientRuntimeHandler::new
→ ClientServiceExt::serve_with_lifecycle(Initialize)
→ RMCP initialize / notifications/initialized
→ immutable server_info snapshot

RmcpClient::{list_tools,list_tools_after,call_tool}
→ RmcpClient::send_request[_with_cancellation]
→ RunningService::send_request_with_option
→ RmcpClient::await_request
→ response / caller cancellation / deadline 三路竞争
```

`ClientRuntimeHandler` 是关键 private adapter：它把 RMCP progress、cancelled 和 list-changed
notification 转交 `McpClientHost`，把 elicitation response 送回 server。绕过它直接用
`ClientInfo` 启动 service，会静默丢失 host interaction，属于架构漂移。

`RmcpClient::await_request` 统一 caller-visible request deadline。
`call_tool_with_cancellation` 的 caller future 或 deadline 先完成时，client 通过
`RequestHandle::cancel` 发送 protocol cancellation；server 是否遵守取消、或是否已经产生外部
副作用仍不能从取消/timeout 推断。上层 durable tool runtime 必须保留 unknown-outcome 语义。

`shutdown(self)` 消费 session、触发 RMCP cancellation，并在 `shutdown` deadline 内等待 transport
cleanup。stdio transport 的 cleanup 包含 child termination；HTTP transport 会尝试 session
cleanup。只依赖 `Drop` 不保证调用方观察到 cleanup 完成。

## Host 接入与可信边界

- `McpClientHost::on_event` 是同步、非阻塞 callback；实现需要把 UI/RPC delivery 放入有界队列。
- `handle_elicitation` 可以异步等待交互。`NoopMcpClientHost` 会明确 decline，不会自动批准。
- `BearerToken` 由 auth/secret owner 在连接时注入，不持久化、不实现 `Clone`，`Debug` 永远脱敏。
- `StdioServerCommand` convenience connector 继承宿主环境，再叠加显式 env。需要 allowlist、
  sandbox 或 remote execution 的 host 应自行构造 transport，再调用 `RmcpClient::connect`。
- Streamable HTTP 默认 transport 禁止 reqwest redirect（客户端构建时显式设置，同时保留 SDK 的禁用空闲连接池设置），但 OAuth、
  credential refresh 与 credential store 不在本 crate。
- server info、tool schema、notification 与 tool result 都是不可信远端输入；本 crate只保证
  RMCP decode，不替代产品层的 size、policy、schema normalization 或 content safety。

## 测试与修改影响

```text
just test ash-rmcp-client
just rust-warnings ash-rmcp-client
bazel test //ash-rs/rmcp-client:rmcp-client-unit-tests
```

`client_tests.rs` 用 duplex transport 启动真实 RMCP server/client service，覆盖 initialize、
tools/list、tools/call、request timeout → protocol cancellation 与 shutdown；另覆盖 HTTP
scheme、header injection 和 bearer token redaction。修改 RMCP feature、lifecycle mode、
timeout/cancellation、callback 或 transport 时需同步检查本 README 与
[`../../docs/mcp.md`](../../docs/mcp.md)。

## 当前限制与扩展点

- Current：低层 client 已通过 `ash-mcp` 接入 App Server/Core tools vertical slice。
- Current：支持 tools list/call；resources、prompts、roots 与 custom request 尚未暴露。
- Current：HTTP 支持 unauthenticated/bearer；OAuth discovery/refresh、custom header policy 与
  credential persistence 尚未实现。
- Current：没有 session reconnect/recovery；connection generation 与 immutable product catalog
  由上层 `ash-mcp` 管理。
- Extension point：通过 `RmcpClient::connect` 注入 executor-owned stdio transport 或
  Ash-owned async HTTP adapter，不需要把 process/network authority移入本 crate。
