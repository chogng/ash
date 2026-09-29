# MCP extension

> 本 README 是 `ash-mcp-extension` 的实现契约；跨 crate 的产品语义、能力状态和演进由
> [`docs/mcp.md`](../../../docs/mcp.md) 维护。

`ash-mcp-extension` 拥有宿主侧 MCP 集成：它把 Config、Connector 和 Plugin authority 投影为
持续运行的 MCP session，把冻结的 MCP 工具适配为 `ash-core::ToolService`，并提供审批策略、
生命周期状态、独立 MCP OAuth 编排和表单交互转换。

它不拥有 MCP wire/session 语义（属于 `ash-mcp` 与 `ash-rmcp-client`）、SecretStore 实现、
Plugin 安装 authority、Connector 账号 authority、Core durable Thread 状态或 App Server RPC。

## Crate 边界与模块

| 模块 | 当前职责 | 不得承担 |
| --- | --- | --- |
| `composition.rs` | declaration materialization、运行时构造、Core 工具/策略适配、调用 authority fence | OAuth provider wire、Plugin 安装、Core durable event |
| `runtime.rs` | 在专用 Tokio worker 上拥有 `ash-mcp` runtime，并桥接同步工具调用 | 产品配置或审批决策 |
| `connector.rs` | Connector/Plugin server publication 与运行时 invocation fence 契约 | Connector 登录状态机 |
| `plugin.rs` | 从 exact active package 构造 package-rooted MCP/Connector server | package 下载、grant 或 enablement mutation |
| `auth.rs`、`auth/*` | 独立 Config MCP 的 PKCE/state、一次性 callback、凭据 envelope、refresh/revoke 编排 | provider discovery、client registration、scope 或 token wire parsing |
| `elicitation.rs` | MCP form schema 与 Core `RequestUserInput` 的有界双向转换 | UI、durable interaction ownership 或 URL elicitation |
| `updates.rs` | `tools/list_changed` reconcile hint 与当前工具调用的 task-local interaction binding | 全局 interaction registry |
| `status.rs` | redacted runtime snapshot 与 process-local connect/disconnect intent | durable desired config |

依赖方向保持为：

```text
App Server composition
  → ash-mcp-extension
      → ash-mcp
          → ash-rmcp-client
      → ash-core ports
      → Config / Connector / Plugin / SecretStore contracts
```

`ash-mcp` 和 `ash-rmcp-client` 不得反向依赖本 crate、Core 或 App Server。

## 公共契约

| API | 调用者 | 契约 |
| --- | --- | --- |
| `compose_mcp_tools*` | App Server composition | 完整构造一个不可变 generation；失败时不发布半成品 runtime |
| `McpToolComposition` | App Server tool composition | 同时返回 Tool service、policy、status 和保持 session 存活的 owner |
| `ConnectorMcpRuntimeProvider` | Connector/Plugin host adapter | 只发布当前 authority 允许的 server definition 与 invocation fence |
| `PluginConnectorMcpRuntimeProvider` | local Plugin composition | 从 exact activation 和 manifest permission 解析 package-rooted contribution |
| `McpOAuthProvider` | 具体产品/provider adapter | 拥有 discovery、endpoint allowlist、client identity、scope、token parsing、audience、refresh 与 remote revoke |
| `McpOAuthService` | App Server OAuth RPC | 只编排 PKCE/state、exact target binding、SecretStore persistence 和 lifecycle operation |
| `McpRuntimeStatusSnapshot` | App Server status projection | 仅暴露 redacted state、generation、tool count 和安全诊断 |

`McpOAuthProvider` 的实现必须返回不含凭据的稳定错误。把 provider-specific discovery、HTTP token
response 或 client secret 放入 `McpOAuthService`，意味着 provider ownership 已发生漂移。

## 工具组合与调用路径

`compose_mcp_tools` 只处理 enabled user Config declaration；
`compose_mcp_tools_with_connectors*` 还读取 exact ready Connector snapshot，并把 Plugin-specific
transport construction 委托给 `ConnectorMcpRuntimeProvider`。Config、Connector 和 Plugin 的
server ID 冲突会失败关闭。

一次调用按以下顺序执行：

1. `McpRuntimeOwner::prepare_call` 把 exact `McpToolBinding` 与 JSON-object arguments 冻结为
   `McpPreparedCall`。
2. `McpToolService::review_request` 复核 catalog generation、Connector authority 和 Plugin
   runtime fence，并生成包含完整来源与参数的动作摘要。
3. Core 持久化批准或自动审查结果后，`McpToolService::execute_with_optional_interactions` 再次检查
   authority，并在 dispatch 前获取 `RuntimeInvocationLease`。
4. `ConnectorAuthority::with_authorized_invocation` 把 exact connector ID、connection generation
   和 definition digest 线性化到远端调用周围。
5. worker 用自己持有的不可变 catalog 再校验 binding，随后才进入远端 session。

已经 dispatch 的调用可以在 disconnect 提交后排空；disconnect 必须阻止旧 generation 的新调用。
删除这两个 fence 中任意一个，或按 live tool name 重新查找 executor，都会破坏 generation binding。

`McpCatalogUpdates` 把 `tools/list_changed` 转为 reconcile hint。App Server 构造完整的新 generation
后，只在后续 model safe point 原子替换；已经 prepared 的调用继续持有旧 service generation。

## 独立 MCP OAuth

OAuth 只适用于带 credential reference 的、无 URL userinfo/fragment 的 HTTPS Streamable HTTP
Config server。`McpOAuthTarget` 绑定 server ID、endpoint 和 SecretKey 的摘要，不读取 secret bytes。

流程如下：

1. `McpOAuthService::start` 校验 HTTPS 或本地 loopback redirect，生成 256-bit state、verifier 和
   S256 challenge，并要求 provider 返回的 authorization URL 精确包含 state、challenge、redirect
   和 resource。
2. `PendingOAuthAttempt` 只保存在进程内，最多 64 个、十分钟过期，drop 时清零 state/verifier。
3. `complete` 先移除 flow，使 callback 一次性；随后常量时间比较 state，并复核当前 Config target
   digest，防止浏览器流程期间 server 被换绑。
4. provider exchange 成功后，`encode_oauth_credential` 把 runtime bearer 与 lifecycle secret 写入
   私有 versioned envelope；连接 materialization 通过 `project_runtime_credential` 只能取得 bearer。
5. `refresh` 原子替换 envelope 的两个部分；`revoke` 先完成 provider remote revoke，再删除本地
   secret。App Server 在调用 revoke 前等待 active Tool generation 移除该 server，因此 provider
   失败时仍保持失败关闭。

旧的 raw bearer SecretStore value 仍可直接 materialize，以保持既有配置兼容。OAuth envelope 的
格式是本 crate 私有存储格式，不得进入 Config、protocol DTO 或日志。

`McpOAuthService` 本身不是通用 OAuth discovery client。没有 host 注入的 exact
`McpOAuthProvider` 时，server 明确返回 unavailable。

## MCP 表单交互

只有在 App Server 为当前 Tool call 提供 `ToolInteractionService` 时，RMCP client 才声明 form
elicitation。`McpCatalogUpdates` 使用 task-local binding 把并发 MCP call 隔离到各自的
Thread/Turn/ToolCall；不得改成进程级“当前请求”槽位。
同一绑定把 Turn 身份交给 `Elicitation` 与 `ElicitationResult` Hook。Hook 进程在阻塞线程运行，
不占用驱动 MCP 连接的 Tokio 线程；前置拒绝会取消该次表单请求。

`handle_elicitation` 当前接受 string、number、integer、boolean 和单选 enum/oneOf，并保留 exact
field ID、required、长度/数值范围。它最多接受 32 个字段、100 个选项和每段 4096 个字符；数组、
多选、未知 shape，以及名称或说明中含 password/secret/token/credential/API key 标记的字段都会
被拒绝。`schemaValidation=false` 是刻意的：当前实现不承诺完整 JSON Schema format 校验。

表单被转换为 Core durable `AgentRequest::UserInput`。用户响应唤醒同一个 live Tool execution；
取消映射为 MCP `Cancel`。同步 durable wait 在 `spawn_blocking` 上运行，不能阻塞 RMCP current-thread
runtime。没有 active interaction context 或收到 URL elicitation 时，host 返回 `Decline`。

进程重启后 remote MCP request 不可恢复。Core 仍保留 durable interaction，但已 started 且没有
terminal result 的 MCP Tool call 按未知结果处理，不能在新 connection 上重放旧 request。

## 失败、取消与安全边界

- 调用前取消返回 `CoreError::Cancelled`；已经发出的远端 mutation 若丢失响应则返回 unknown outcome。
- `NotStarted` 和 invalid result 可以成为普通 tool failure；transport-lost 或无法证明未执行的错误
  必须保持 unknown outcome。
- SecretStore 只接收 opaque bytes；OAuth code、state、verifier、bearer 和 refresh material 不进入
  Debug、status、Config 或 protocol response。
- Plugin disable/update 先退休 exact package generation，再拒绝新 lease，并等待已获取 lease 的调用
  排空。
- Connector disconnect 以 authority lock 线性化；把它弱化为一次 best-effort state read 会产生
  disconnect 后仍可 dispatch 的竞态。

## 宿主集成

Local App Server 必须：

- 共享 Connector runtime 使用的同一个 `SecretStore`；
- 在 runtime 构造前注入 exact OAuth provider registry；
- 把 `McpRuntimeStatusSnapshot` 和 reconcile subscription 接到 App Server；
- 只把 process-local connect/disconnect intent 作为 desired config 的 overlay；
- 在 Plugin/Connector/Config generation 变化时构造完整替代 runtime；
- 通过 Core interaction port 处理 elicitation，而不是从 MCP worker 直接调用 UI。

## 测试与修改检查

```text
cargo test -p ash-mcp-extension --lib
cargo test -p ash-mcp --lib
cargo test -p ash-rmcp-client --lib
cargo test -p ash-app-server --lib
```

测试覆盖 OAuth PKCE/envelope/target revalidation/refresh/revoke、旧 bearer 兼容、Config/Connector/
Plugin authority、runtime generation、并发 elicitation task-local 隔离和 App Server durable live wake。

修改时同步检查：

- public RPC 或 error mapping：更新 `ash-app-server-protocol` registry、schema fixture 与 App Server test；
- credential envelope：保留旧 bearer 读取兼容，并增加 secret projection/revoke test；
- form 支持范围：同步更新 capability declaration、local validation 和并发/cancellation test；
- binding 或 generation：同时检查 review、dispatch fence、prepared-call retention 与 disconnect test；
- status state：同步更新 App Server DTO projection，不能加入 endpoint、credential 或 provider raw error。

## 当前限制与扩展点

- 当前没有 resources、prompts、roots、sampling 或 tasks 的产品 adapter。
- 当前没有自动 reconnect/backoff、完整 health state machine 或 runtime log RPC。
- 当前不拥有通用 MCP OAuth metadata discovery 或 concrete provider；必须由 host 注入 provider adapter。
- URL elicitation、数组/多选和完整 JSON Schema format validation 尚未支持。
- stdio 仍需要更完整的 sandbox/process-tree supervisor。
- progress 可以在低层接收，但尚未投影为产品级 durable/transient update。

- Marketplace Connector/MCP 绑定与 invocation lease 由本 crate 的 `marketplace` 模块持有；声明读取委托 `connectors`。
- 启动、目录变化和关闭会进入扩展 MCP 生命周期接口。
