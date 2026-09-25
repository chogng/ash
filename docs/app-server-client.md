# App Server 客户端架构与演进方案

> 物理位置：`ash-rs/app-server-client/`  
> 主要消费者：`ash-exec` 非交互执行宿主、`ash-tui`、`app`
> Wire contract：[`ash-app-server-api.md`](ash-app-server-api.md)  
> Canonical 产品模型：[`protocol.md`](protocol.md)  
> Headless 与远程调度：[`exec.md`](exec.md)
> 当前 crate contract：[`ash-rs/app-server-client/README.md`](../ash-rs/app-server-client/README.md)

## 快速理解

App Server 客户端把“连接后端进程、初始化连接、配对请求、转发事件和正确关闭”封装成一个
就绪会话，使 CLI、TUI 和无交互宿主不必各自实现一遍。产品端通过 stdio 连接单独打包的
`ash-app-server`；进程内连接只供本 crate 测试及显式启用 `in-process` 特性的契约测试使用。

| 调用方动作 | 客户端保证 | 调用方仍负责 |
| --- | --- | --- |
| 启动本地 App Server | 只有进程和双向通道都建立后才开始初始化 | 提供启动配置和产品参数 |
| 取得 ready client | 已完成能力、版本和模式校验 | 决定接下来调用哪个产品方法 |
| 发出多个并发请求 | 按请求 ID 配对结果并结束等待者 | 处理领域结果和用户交互 |
| 接收通知 | 独立转发服务端事件，不阻塞请求结果 | 更新自己的呈现状态 |
| 关闭宿主 | 拒绝新请求、结束等待者并等待后台任务退出 | 决定产品级退出或重连策略 |
| 连接远程 App Server | `start_stdio` 复用同一 ready session、typed request 与 event contract | SSH transport、安装和产品重连策略由 host layer 拥有 |

## 1. 结论

`ash-app-server-client` 除 typed RPC method 外，还统一 `ash-exec`、`ash-tui` 与 Rust App 的
连接流程：

1. 启动产品选定的 App Server 程序；
2. 建立到 App Server 的请求通道；
3. 建立返回结果与事件的通道；
4. 通过请求通道完成 `initialize` 与 schema/capability 校验；
5. 只在初始化成功后向调用方交付 ready client；
6. 运行期间正确配对请求结果，并持续转发 server notification；
7. 退出时关闭 connection、结束 pending 请求并等待后台任务停止。

这套启动、连接和关闭逻辑不能在 `ash-exec` 与 `ash-tui` 中各写一份，因此抽成共享 crate。

```text
ash-exec / ash-tui / app
          │
          ▼
ash-app-server-client ── JSONL/stdio ──► ash-app-server 程序
```

普通客户端依赖图不包含 App Server 实现。`AppServerSession::start_stdio` 连接产品选定的子进程，
`app` 也用它承载 SSH Remote App Server；客户端只负责 App Server contract，不负责 scheduler
或远程进程执行。Desktop 的 JSONL/stdio client 仍不要求复用这个 Rust crate。

`ash-exec` 是无交互界面的 Agent 执行宿主。它与交互式 TUI 均通过 stdio 连接独立 App Server，
并把初始 `cwd` 作为执行位置交给服务端。
后续远程调度系统以它作为 headless execution entry。Job/Attempt/lease/event cursor 属于
[`exec.md`](exec.md) 定义的 scheduler adapter，不进入 App Server Client。

当前 `ash-cli` 的交互式和无界面提示词路径已经使用自有
`AppServerSession`、可克隆请求句柄、独立 `AppServerEvents` 与显式关闭。
## 2. 抽象单位：一个运行中的 App Server Session

共享层的顶层抽象应是一个有明确所有权的运行会话，而不是裸 transport：

```rust
pub struct AppServerSession {
    client: AppServerRequestHandle,
    events: Option<AppServerEvents>,
    // private shutdown state and joined driver tasks
}
```

`AppServerSession` 拥有：

- 产品选择的 child-process JSONL connection；契约测试可使用进程内 runner；
- 唯一 App Server connection；
- request channel 的 server 端；
- server message/event channel 的 client 端；
- connection driver 与 server runner 的后台任务；
- initialize/ready/closing/closed 生命周期；
- 显式 shutdown 与 task join。

Windows stdio 输出通过 `ash-utils-pty::CancellablePipeReader` 读取，连接关闭标记可以停止等待；即使后台服务仍持有管道写端，也不能阻塞客户端 shutdown。系统调用只保留在 PTY/管道工具 crate，客户端继续保持安全 Rust 边界。

它向宿主提供两个运行时端点：

```rust
impl AppServerSession {
    pub fn client(&self) -> AppServerRequestHandle;
    pub fn take_events(&mut self) -> Result<AppServerEvents, TakeEventsError>;
    pub fn shutdown(self) -> Result<(), ShutdownError>;
}
```

- `AppServerRequestHandle` 是共享 request ID allocator 的可克隆 typed request handle，供
  feature/task 发送 request；
- `AppServerEvents` 是单消费者事件流，供 app event loop 持续接收 notification 与 connection
  lifecycle event；
- `AppServerSession` 保持所有权直到显式 shutdown，避免最后一个 client clone 的偶然 drop
  决定 server 生命周期。

结果与事件必须区分：

- request result 通过该 request 自己的 completion/oneshot 返回；
- server notification 通过独立 `AppServerEvents` 流返回；
- connection closed、protocol failure 等连接事件也通过 `AppServerEvents` 告知宿主；
- notification 不得依附某次 request，不能通过 `drain_notifications()` 拉取。

## 3. 为什么由这个 crate 统一连接 App Server

`ash-exec`、`ash-tui` 和 Rust App 都需要相同的连接语义：

- initialize 参数、schema hash 与 capabilities；
- 请求结果配对与通知转发；
- connection-scoped subscription 与 Resource ownership 的关闭；
- shutdown 与错误回收。

如果这些步骤留在各自 consumer，会形成两套不同的启动语义：一个可能忘记 schema gate，另一个
可能没有事件 pump，第三个关闭时遗留后台任务。共享 crate 必须保证它们拿到的是同一种 ready
connection。

依赖方向应是：

```text
ash-exec / ash-tui / app
          │
          ▼
ash-app-server-client
   ├─► ash-app-server-protocol
   └─► channel/task runtime

in-process 契约测试特性 ─► ash-app-server 实现
```

产品 consumer 不直接创建 `AppServer`、`ConnectionState`、dispatcher 或 notification broker。
服务端组合归 `ash-app-server` 程序所有；客户端的进程内测试特性复用这套组合。

当前 `ash-exec` 已是非交互 Agent 宿主，并通过本 crate 连接独立 App Server；底层 process
execution 已迁移到独立 `ash-tool-executor`。后续 remote scheduler 仍位于 `ash-exec` 上层，不能让
“执行一个 tool process”和“宿主化完整 App Server”重新共享同一个模块或协议。

backend 选择应由产品宿主显式建模，但不应把 Remote 再做成
`ash-app-server-client` 的上层入口。客户端只负责统一的 session contract；例如 `app`
在自己的 `AppServerHost` 中选择 Local 或 Remote backend，然后把两者都转换为
`AppServerSession`：

```rust
pub(crate) enum AppServerBackend {
    Local { cwd: PathBuf },
    Remote {
        connection: SshAppServerConnectionOptions,
        cwd: PathBuf,
    },
}
```

- Local backend 通过 `StdioAppServerCommand` 连接 profile-scoped local App Server，并传入初始 `cwd`；
- Remote backend 由 `ash-remote-connections` 建立 SSH/stdio 连接，再交给相同的
  `AppServerSession`；
- 两者暴露相同 typed request handle、event stream 与 shutdown contract；
- `AppServerHost` 是 `app` 的产品级横向协调层，不是 `ash-rs` 的通用 App Server API；
- remote scheduler 仍位于 `ash-exec` 上层，不属于 App Server backend。

在 app 中，这个产品边界位于 `app-rs/workbench/app_server/`。Agent、Language 和 Terminal 通过
Workbench 的 App Server host 使用它导出的 session/event contract；`zui`、`ash-ui-components`、Agent Sidebar
等 UI crate 不依赖 App Server client。这样 `ash-rs` 提供核心协议和通用 client，app 提供
产品启动、本地/Remote backend 与重连协调，两边不会再各自复制一套 client。

## 4. 启动流程

产品宿主选择 App Server 程序及其参数，客户端负责启动并初始化：

```rust
let mut session = AppServerSession::start_stdio(command, client_info, capabilities)?;
let client = session.client();
let events = session.take_events()?;
```

`start_embedded` 只在客户端自身测试或显式启用 `in-process` 特性的契约测试中提供。

Remote 不需要额外的 `connect_remote` client API：它通过产品宿主构造
`StdioAppServerCommand`，或由 Remote connection adapter 直接创建同一个
`AppServerSession`。因此 App Server 是横向核心 contract，Remote 只是其中一种可替换 backend。

进程内契约测试的启动顺序如下；产品 stdio 路径遵守相同的 initialize 与 ready 边界：

```text
validate options
  → build App Server composition
  → create one server connection
  → create bounded request/result-event channels
  → start server runner and connection driver
  → send initialize through the normal request path
  → validate protocol major and required capability versions
  → return Ready AppServerSession
```

必须保持的 invariant：

- `initialize` 是 connection 的首个 request；
- initialize 也经过正式 request channel、dispatcher 和 result pairing，不能直接调用内部
  server method；
- protocol major 不一致、required capability 缺失或版本不兼容时，`start` 失败；schema hash 不一致只进入诊断；
- `start` 失败必须关闭已创建的 connection/channel 并 join 已启动的 task；
- 调用方永远拿不到半初始化的 `AppServerClient`；
- start options 完整描述 composition，不依赖 consumer 在启动前偷偷修改全局状态。

Remote connect 必须：

```text
validate endpoint/auth
  → connect bounded transport
  → send initialize as first request
  → validate schema/capabilities
  → start request/event driver
  → return Ready AppServerSession
```

Remote connection failure 必须结束 pending request 并发出 connection event；自动 reconnect 只有
在能重新建立 subscription、Resource ownership 和 transient cursor 时才能增加，不能隐藏状态
丢失。

启动配置应使用自解释类型，而不是 bool：

```rust
pub struct AppServerStartOptions {
    pub profile_root: PathBuf,
    pub client_info: ClientInfo,
    pub required_capabilities: RequiredCapabilities,
}
```

若 `ash-exec` 与 TUI 的 capability 不同，可以分别构造 typed
`RequiredCapabilities`，不能用 `start(..., true, false)` 表达。

## 5. 请求通道与结果配对

`AppServerClient` 的 typed method 将请求送入后台 connection driver：

```text
typed params
  → allocate connection-local request ID
  → build typed ClientRequest
  → request channel
  → App Server dispatcher
  → response channel
  → match pending request ID
  → typed result / typed server error
```

进程内测试路径使用 protocol-owned typed request enum：

```rust
enum ClientRequest {
    Initialize(InitializeParams),
    SessionCreate(SessionCreateParams),
    SessionRequest(SessionRequestParams),
    SessionThreadSubscribe(SessionThreadSubscribeParams),
    // generated/registered remaining methods
}
```

Client worker 在 request 外附加 connection-local request ID 与 oneshot completion。In-process
channel 不需要先序列化为 JSON string，但仍必须经过相同 initialize gate、method dispatcher、
result/error envelope 和 notification contract。JSON/JSONL/WebSocket backend 在 transport
边界执行 wire encoding。

公共接口仍然是类型化方法：

```rust
let result = client.request_session(SessionRequestParams { /* ... */ })?;
```

调用方不拼 method string、不处理 JSON-RPC request ID，也不直接操作 request channel。
当前 typed method 同步等待自己的 completion，但 request 在独立 driver 上执行；需要在 UI
主循环中避免等待异常缓慢 request 时，由 consumer 把 completion 重新投递成 app event。

请求 driver 负责：

- 分配只在当前 connection 内有效的 request ID；
- 保存 `requestId → completion` pending table；
- 校验 response ID、envelope 与 typed result；
- 允许多个调用方持有 `AppServerClient` clone；
- connection 关闭时一次性结束全部 pending request；
- 将 server stable error 保留为 typed `AppServerError`，包括 code、name 和 data；
- 对 unknown、duplicate、retired request ID 做明确 protocol error 处理。

JSON-RPC request ID 不能代替产品 `CommandId`。修改操作的 `CommandId`、
`expectedSequence` 和 exact typed payload 由调用方创建并传入，client 只负责无损发送。超时或
response 丢失后的业务重试策略不属于 connection driver。

## 6. 事件通道

App Server notification 与 request result 是两条独立交付路径：

```text
                         ┌─ matching response ─► request completion
App Server outbound ─────┤
                         └─ notification ──────► AppServerEvents
```

当前公共事件契约是：

```rust
pub enum AppServerEvent {
    Notification(ServerNotification),
    ConnectionClosed(ConnectionCloseReason),
}
```

当前 App Server API 包含非持久的 `session/changed` 树刷新提示、`session/thread/update`、owner-directed
`agent/request`、`connector/changed`、`skills/changed`、Git 与 filesystem notification，均由 `ServerNotification`
typed enum 表达。approval/user-input 通过 `agent/request` + canonical
`SessionRequest::ResolveInteraction` 完成，不在 client crate 建第二套 server-request envelope。
显式 `Lagged`/`Desynced` lifecycle event 尚未提供；当前 transient overflow 通过 cursor gap 触发
consumer snapshot resync，control-only overflow 关闭 connection。

`ServerNotification`、method registry 与 payload decoder 由 protocol crate 的同一个
`server_notifications!` 定义生成。该总枚举跨 crate 标记为非穷尽：client boundary 必须严格解码
每一个已注册 method，而 consumer 只能在自己的 projection 中选择所拥有的 capability，并为其余
通知保留 fallback。新增 Document 或其他领域通知因此不会要求无关产品同步增加 ignore
arm。

事件 driver 负责：

- 在没有新 request 时仍持续接收 notification；
- 解码 `session/changed` 与 `session/thread/update`；
- 保留 durable sequence 与 transient stream cursor；
- 保证同一 request 的 response 先于它产生的 causal notification 交付；
- 已知 notification 在 remote decode 或 typed validation 失败时关闭 connection 并报告
  protocol failure；
- server request 无 consumer/handler 时及时返回 stable rejection，不能让 approval 永久等待；
- event receiver 被 consumer drop 时执行明确 policy，而不是无限积压；
- bounded channel 满时不静默丢弃 durable update。

Event channel 不负责：

- 把 update 应用到 Session/Thread projection；
- 判断 durable sequence gap 后如何 resubscribe；
- 推导 Turn 或 Item 的权威终态；
- 将 notification 变成日志文本；
- 合并不同 aggregate 的 sequence。

这些属于 `ash-exec` 的输出/终态协调或 TUI 展示状态。

各消费端的数据流向是：

```text
protocol registry（method + payload + decoder）
                    │
                    ▼
AppServerEvents::Notification(ServerNotification)
                    │
                    ├─► TUI 通知状态 ─► ClientEvent
                    ├─► 应用层 Agent/Session 视图 ─► AgentSessionEvent
                    └─► 无界面运行的完成状态
```

产品消费端不得穷尽列出未拥有的 notification。TUI 当前拥有 Connector picker，因此由
Connector capability 消费 `ConnectorsChanged` 并触发 canonical list refresh；其他产品若不拥有
Connector UI，则无需增加对应分支。Connector 状态不能塞进通用 connection lifecycle event。

## 7. Driver 与 App Server 的连接方式

共享层需要同时驱动请求与事件，不能保留“调用一次、顺便 drain 一次”的模型：

```text
AppServerClient clones
        │
        ▼
bounded request channel
        │
        ▼
connection driver
  ├─ dispatch request ─────────► App Server
  ├─ pair response ────────────► request completion
  ├─ receive notification ─────► AppServerEvents
  └─ observe shutdown ─────────► close + join
```

进程内测试连接仍应经过同一个 App Server protocol dispatcher。Typed channel 可以避免 JSON 编解码、
stdio 与子进程开销，但不能直接调用 Core、Store 或私有 App Server operation。它复用相同
request/result/error/notification 语义，而不是复制第二份 in-process response contract。

App Server 当前通过 connection-scoped `ConnectionNotifications` 提供条件变量唤醒的 outbound
source；client event pump 与 request driver 独立，因此空闲连接和长 Turn 的 update 都无需
新 request 即可到达。runner 同时处理：

- 新 client request；
- 新 server notification；
- shutdown signal。

这属于 client session 与 App Server runner 共同遵守的 channel contract。

## 8. 正确关闭

显式 `AppServerSession::shutdown()` 是正常退出路径。它必须：

1. 原子地把 session 状态从 `Ready` 改为 `Closing`；
2. 拒绝新 request；
3. 结束或明确失败所有尚未完成的 request completion；
4. 关闭 App Server connection，使 subscription 与 Resource ownership 失效；
5. 停止 server runner 和 connection driver；
6. 关闭 event stream，并给 consumer 一个最终 `ConnectionClosed` 原因；
7. join 所有由 session 启动的后台 task；
8. 返回 shutdown 期间发生的错误。

关闭 connection 不等于 `session/request` 的 `InterruptTurn`。若产品要求退出前中断某个 Turn，
`ash-exec` 或 TUI 必须先发送 typed `session/request` 并等待所需终态，再调用 session shutdown。Client session
不能猜测要中断哪个 Thread/Turn。

`Drop` 只能做 best-effort cancellation，不能替代显式 shutdown，因为 `Drop` 无法可靠等待
后台任务结束。测试和正常 consumer 路径必须调用并等待 `shutdown()`。

需要定义以下边界情况：

- event receiver 先于 session 被 drop；
- 所有 client handle 被 drop，但 session owner 仍存在；
- session shutdown 时仍有 client clone；
- initialize 期间 consumer 取消启动；
- App Server runner panic；
- request completion receiver 被调用方取消；
- shutdown 被重复触发。

## 9. 消费方使用方式

### 9.1 `ash-exec`

非交互宿主：

1. 启动 `AppServerSession`；
2. 从 client handle 发送 Session/Thread/Turn typed request；
3. 同时消费 request result 与 `AppServerEvents`；
4. 根据 canonical Turn terminal update 产生 human/JSON/JSONL 输出和退出码；
5. Ctrl-C 时按产品策略发送 `session/request` 的 `InterruptTurn`；
6. 最后显式 shutdown session。

它不自行创建 App Server、初始化 connection 或实现 notification pump。

后续 scheduler-facing protocol、worker registration、lease、heartbeat、Job/Attempt mapping 和
event ack 属于 [`exec.md`](exec.md)。App Server Client 只提供 stdio App Server
connection，不理解 scheduler Job。

### 9.2 `ash-tui`

TUI：

1. 启动同一种 `AppServerSession`；
2. 把 client handle 交给 command dispatcher；
3. 把 `AppServerEvents` 接入 terminal/app event loop；
4. request 执行期间继续处理键盘、重绘和 server update；
5. 退出前恢复 terminal，并显式 shutdown session。

TUI 不再接收一个同步 `&mut AppServerClient<T>`，也不调用 `drain_notifications()`。

## 10. 当前实现审计

当前已经落地：

- 产品端 `AppServerSession::start_stdio` 只在 initialize 与 schema gate 成功后返回 ready session；
- `start_embedded` 与进程内 transport 由客户端测试或 `in-process` 特性启用；
- `AppServerRequestHandle` 可克隆，clone 共享 connection-local atomic request ID allocator；
- bounded request channel、per-request completion 与独立 connection driver；
- 进程内测试的 `ConnectionNotifications` 在 server publish 时主动唤醒独立 event pump；
- response completion 在同一 request 产生的 causal notification 交付前发送；
- `AppServerEvents` 是单消费者 typed notification/connection lifecycle stream；
- `AppServerEvents` channel 限 1024 项，背压到 App Server 4096 项 connection queue；transient
  backlog 可清除，durable/control 不静默丢弃；
- `shutdown` 拒绝后续请求、关闭 connection、唤醒 event pump 并 join 两个 background task；
- CLI interactive 与 headless 路径都使用 `AppServerSession::start_stdio` 连接 local authority；
- `start_in_process_client` 供契约测试复用正式请求协议；
- `open_in_process_app_server` 返回可克隆的 `InProcessAppServer` host；
- `InProcessAppServer::connect` 为同一个 `Arc<AppServer>` 建立各自 initialize 完成的 typed
  connection，供 embedded host 和 contract tests 共享一个 composition；
- `InProcessTransport::from_shared_server` 明确表达共享 host，不要求每个 transport 重建
  SQLite repository/config/model composition；
- typed client methods，包括 app Remote 编辑器消费的文档同步、关闭、Hover、Completion 与位置请求；
- protocol method registry；
- external JSON-RPC request/response 编解码；
- response ID 校验；
- protocol major、版本化 required capability 校验，以及非致命 schema hash 诊断；
- successful `InitializeResult` 保存在 `AppServerClient::initialization` snapshot 中，consumer
  可读取 server capabilities 与动态 slash catalog，而无需重复 handshake；
- typed `list_skills` / `set_skill_enablement` method；
- protocol registry 同源生成 known notification typed decode，包括 `agent/request`、
  `connector/changed`、`skills/changed` 与 Git status；
- TUI notification adapter 只投影自己拥有的 Agent、Connector、Skill、Git 与 Thread capability，
  未拥有领域不进入 `ClientEvent`。

同步适配面与剩余工作：

| 边界 | 状态 |
| --- | --- |
| `start_in_process_client` / generic `AppServerClient<T>` | 前者仅供契约测试，后者是 typed request 的通用接口；TUI/CLI 不再依赖 drain |
| typed method 同步等待 completion | shared handle 保持同步 typed API；TUI 已用 `RequestTask` 把等待移出单写者 loop |
| bounded event/data plane | Current：1024 event + 4096 server queue；显式 `Lagged` event 尚未提供 |
| stdio child backend | 已实现；`AppServerSession::start_stdio` 完成 initialize 的协议和必需能力校验，并使用同一 request/event contract；本地与 Remote `ash code` 的 30 秒有界重连和 snapshot 恢复由 CLI 宿主负责 |
| initialize gate 只存在于一个 helper | 裸 `AppServerClient::new` 可以在未初始化时发送业务请求 |
| server error 被压成 code/string | 丢失 typed error name/data |

因此 stdio session 的 request/event/shutdown 与有界交付主路径已经完成；下一阶段集中在 typed error、显式 lag lifecycle，以及其他产品宿主需要的连接恢复。不要把这些策略回退到 notification drain，也不要把 durable subscription restoration 偷塞进低层 stdio transport。

## 11. 目标模块

建议按所有权拆分，而不是按 RPC domain 复制 protocol：

```text
app-server-client/src/
├── lib.rs
├── session.rs
├── start.rs
├── client.rs
├── events.rs
├── driver.rs
├── embedded.rs
├── remote.rs
├── pending.rs
├── shutdown.rs
├── error.rs
├── session_tests.rs
└── driver_tests.rs
```

- `session.rs`：顶层 owner 与 ready/closing/closed lifecycle；
- `start.rs`：App Server composition、channel 创建和 initialize；
- `client.rs`：cloneable typed request handle；
- `events.rs`：单消费者 event stream；
- `driver.rs`：request/result/notification/shutdown multiplexing；
- `embedded.rs`：仅供契约测试的 typed in-process channel 与 local App Server runner；
- `remote.rs`：相同 contract 的 remote App Server transport；
- `pending.rs`：request ID 与 completion pairing；
- `shutdown.rs`：关闭顺序与 task join；
- `error.rs`：startup/client/protocol/server/shutdown error。

不创建第二套 Session/Thread/Turn DTO，也不按 method 建大量重复 wrapper 模块。Wire Params、
Result、Notification 与 error 的 source of truth 仍是 `ash-app-server-protocol`。
新增 test module 使用显式 `#[path = "..._tests.rs"]` 引入相邻测试文件。

## 12. 验证要求

共享层的测试重点是完整 session 生命周期：

- `start` 连接 App Server 并只在 initialize 的协议和必需能力校验成功后返回；
- initialize 是 dispatcher 收到的首个 request；
- startup 任一步失败都会关闭 channel 并 join 已启动 task；
- `ash-exec` 与 TUI 使用相同 start path；
- embedded 与 remote backend 通过相同 request/event contract suite；
- 多个 client clone 可以并发发送 request，result 按 request ID 正确配对；
- request 执行期间 event stream 可以持续收到 notification；
- 空闲时由其他 runtime activity 产生的 notification 无需 polling request 即可到达；
- response 先于其 causal notification 交付；
- event channel 满不会静默丢失 durable update；
- connection failure 会结束全部 pending request；
- shutdown 后新 request 明确失败；
- shutdown 会关闭 subscription/Resource ownership 并 join 全部 task；
- event receiver、client handle 和 session owner 以不同顺序 drop 时都不会泄漏；
- in-process typed channel 仍经过 protocol dispatcher，不存在 Core 私有旁路；
- remote backend reconnect 不会偷偷复用旧 subscription、Resource ownership 或 transient
  cursor。

验证入口：

```bash
cargo test --manifest-path Cargo.toml -p ash-app-server-client
```

修改 wire contract 时，还必须按
[`ash-app-server-api.md`](ash-app-server-api.md#11-source-of-truth) 重新生成 schema 与
TypeScript，并验证所有 consumer。
