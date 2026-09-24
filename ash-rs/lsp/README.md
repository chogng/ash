# `ash-lsp`

> 本 README 是低层 LSP 客户端运行时的 crate-level canonical contract。跨 crate 的产品语义、
> 宿主职责和演进阶段见 [`docs/lsp.md`](../../docs/lsp.md)；Desktop 编辑器展示契约见
> [`ash-editor`](../../app-rs/editor/README.md)，产品级启停与路由见
> [`ash-lsp-manager`](../lsp-manager/README.md)，server 发现与 resolved command 见
> [`ash-lsp-server-provider`](../lsp-server-provider/README.md)。

`ash-lsp` 负责启动或连接一个语言服务器、执行 LSP 生命周期、配对请求、同步打开文档的版本，
并把诊断和服务端消息交给产品宿主。它不选择或安装服务器，不读取文件，不拥有工作区配置、
编辑器状态、诊断展示、自动重启或 App Server API。

## 所有权与公共接口

| API / type | 当前职责 | 明确不做 |
| --- | --- | --- |
| `LanguageServerClient` | initialize 后的单服务器 session、类型化请求、文档同步、transport-close 事实和关闭 | server discovery、共享进程、重启策略 |
| `LanguageServerCommand` / `LanguageServerEnvironmentPolicy` | 保存宿主已经解析的 canonical program、参数、工作目录和环境策略；Unix 可独立保留代理程序依赖的 `argv[0]` 调用名 | 验证可执行文件信任、安装或沙箱策略 |
| `LanguageServerOptions` | client identity、workspace、capability、initialize options、host 和 deadline | 读取产品配置 |
| `LanguageServerInitialization` | 冻结 server info、初始 capability、position encoding 和 document sync policy | 把随后动态注册伪装成 initialize 快照 |
| `LanguageServerHost` | 快速接收事件，并按顺序回答 `workspace/configuration`，消费 progress/message/log 事件 | 直接修改 UI 或阻塞协议 driver |
| `LanguageServerDocumentRouter` | 一个 language ID 到一个 initialized client 的路由、全文 snapshot 同步、replacement replay 与断连 route retirement | server discovery、重启判断或 backoff |
| `LanguageDocumentSnapshot` | 绑定 URI、language ID、EditorHost revision 与完整 authoritative text | 从 filesystem 或 editor 自行取内容 |
| `RoutedDocumentVersion` | 绑定 editor revision、server incarnation 与 LSP document version | 充当磁盘或 durable revision |
| `DocumentChange` / `DocumentSave` | 用 tagged enum 表达完整/增量 change 和 save text | 从编辑器 mutation 自动计算 range |
| `DocumentVersion` | 每个 open document 从 1 开始单调递增 | 表示磁盘 revision 或 durable identity |
| `lsp_types` re-export | 暴露调用类型化请求所需的标准协议类型 | 承诺 LSP 3.18 的全部新增能力 |

`LanguageServerClient::request<R>` 接受实现 `lsp_types::request::Request` 的请求类型。请求 ID 在
同一 session 内单调递增；普通请求使用独立 deadline，超时后发送 `$/cancelRequest`。初始化和
关闭使用各自 deadline。

## 文件与内部接口

| 文件 / private symbol | 精确职责 | 不能承担 |
| --- | --- | --- |
| `client.rs::LanguageServerClient::connect_inner` | 创建 driver，执行 initialize/initialized gate，并冻结 capability | server selection 或 restart loop |
| `raw_client.rs::RawClient` | 分配 request ID、序列化 typed params/result、执行 deadline cancellation | 文档或产品状态 |
| `driver.rs::run_driver` | 单一 writer 顺序、pending response table、服务端 request/notification dispatch，并上报意外 transport close | UI callback scheduling 或 restart policy |
| `protocol.rs::{read_frame,write_frame}` | 有界 `Content-Length` framing | LSP method 语义 |
| `protocol.rs::parse_message` | 区分 request/response/notification；保留合法 `result: null` | typed result decoding |
| `document.rs::DocumentSyncPolicy::from_capability` | 把 server sync capability 冻结为明确策略 | 猜测未声明能力 |
| `client.rs::reap_process` | `exit` 后有界等待，超时则终止 child | 自动拉起 replacement |
| `router.rs::LanguageServerDocumentRouter` | 注册唯一 language route、保存当前全文和精确 revision binding | 选择 executable 或读取 editor |
| `router.rs::replace_server` / `remove_disconnected_server` | 显式 replacement replay；或丢弃断连 route 和旧 document bindings | 检测 crash、退避或静默吞掉 replay failure |

```text
LanguageServerClient::start_stdio / connect
  → driver::spawn_driver
  → RawClient::request<Initialize>
  → validate position encoding
  → DocumentSyncPolicy::from_capability
  → RawClient::notify<Initialized>
  → ready LanguageServerClient

LanguageServerClient::request<R>
  → RawClient::request
  → DriverCommand::Request
  → driver pending table
  → protocol::write_frame
  → protocol::read_frame / parse_message
  → matching typed result

open/change/save/close
  → validate negotiated DocumentSyncPolicy
  → serialize under document table lock
  → assign DocumentVersion
  → driver notification

LanguageServerDocumentRouter::open_document / update_document
  → resolve unique language route
  → send full authoritative snapshot
  → bind EditorDocumentRevision + LanguageServerIncarnation + DocumentVersion

LanguageServerDocumentRouter::replace_server
  → replay sorted current snapshots into replacement
  → any failure: close replayed documents + shutdown replacement + keep old route
  → success: increment incarnation + swap route + shutdown old client

unexpected transport EOF / framing failure
  → LanguageServerEvent::TransportClosed
  → product supervisor decides recovery policy
  → LanguageServerDocumentRouter::remove_disconnected_server
  → abort unusable transport/process without an LSP shutdown handshake
```

若 `client.rs` 开始选择语言服务器、决定 enablement、读取磁盘或保存 UI 状态，表示 crate ownership 已经漂移；
若 `ash-editor` 直接启动进程或解析 LSP JSON，表示运行时边界被绕过。产品宿主应把 LSP range
按 initialize 选定的 position encoding 转换成编辑器 byte range，不能假设所有服务器都使用
UTF-8。

## 协议、失败与宿主义务

Transport 使用 LSP stdio 的 `Content-Length` framing。Header 最多 16 KiB，单条 JSON message
最多 4 MiB；缺少或重复 `Content-Length`、非 JSON-RPC 2.0 envelope、非整数 client response ID
和同时缺少 result/error 的 response 都会关闭当前 driver。服务端 request 目前支持
`workspace/configuration`、`client/registerCapability`、`client/unregisterCapability` 和
`window/workDoneProgress/create`；其他 request 返回 JSON-RPC `Method not found` 并产生
`UnsupportedServerRequest` 事件。

宿主必须：

- 在启动前决定 executable identity、目录 Grant、Environment 与 sandbox；执行包内 JavaScript
  server 时应清空环境后只恢复明确 allowlist，不得继承 `NODE_OPTIONS` 或 `NODE_PATH`；
- 让 `LanguageServerHost::on_event` 快速返回，把 UI 工作排入自己的 event loop；
- 为 `workspace_configuration` 返回与请求项数量和顺序完全一致的结果；
- 为每个文件维持稳定 URI 和 language ID，并只对 open document 发送 change/save/close；
- 按 `position_encoding` 转换位置，按 document version 丢弃过期诊断或请求结果；
- 消费 `TransportClosed` 并在产品层决定是否退避重启；断连 route 必须先退休，再从产品拥有的
  authoritative snapshot 重放，不能复用 router 中的旧文本。

调用 `replace_server` 时，replacement 使用的 `LanguageServerHost` 必须先暂存事件；只有方法成功并
返回新 incarnation 后才能发布这些事件。Replay 期间服务器可能立即发送 diagnostics，router
不会替产品宿主伪造跨 callback 的原子屏障。失败时旧 route 与所有原 document binding 保持不变。

`LanguageServerClient::shutdown` 即使 shutdown request 失败也会尝试发送 `exit`、停止 driver 并回收
child，最后返回原 shutdown error。Client 被直接 drop 时 child 使用 `kill_on_drop`，但这不是规范
关闭路径。`abort_disconnected` 只用于 transport 已关闭的 session：它跳过不可能完成的 LSP handshake，
停止 driver 并终止残留 child；正常关闭不能走这条路径。

## 测试、修改影响与当前限制

```bash
cargo test --manifest-path Cargo.toml -p ash-lsp
cargo clippy --manifest-path Cargo.toml -p ash-lsp --all-targets -- -D warnings
bazel test //ash-rs/lsp:lsp-unit-tests
```

`command_tests.rs` 使用子进程验证 canonical program 与 Unix `argv[0]` 调用名可以独立保留。`client_tests.rs` 使用真实内存双工 transport 覆盖 initialize/initialized、UTF-8 position encoding、`workspace/configuration`、诊断、open/change/save/close、typed hover、timeout cancellation、意外 transport close、shutdown/exit 和 framing validation。`router_tests.rs` 另外覆盖 route validation、stale editor revision、全文更新、replacement replay、incarnation reset、save/close 与多 client shutdown，以及断连 route retirement 后从 authoritative snapshot 重新注册和重放。

修改 framing limit 或 envelope classification 时同步更新 transport tests；修改 capability
advertisement 时同步检查服务端 request handler；修改 document policy 时同步检查版本顺序和
Desktop position conversion；增加 server request 时必须先定义宿主 authority 和 failure behavior。

当前限制：

- Current：兼容常见 LSP 3.17 生命周期、请求、push diagnostics 和 text synchronization；
- Current：仅支持 stdio child 或 caller-provided async transport halves；
- Current：宿主可注册 initialized client，以唯一 language route 同步全文 snapshot，并在显式
  replacement 时重放当前文档和重置 server version/incarnation；
- Current：服务端 request 已实现 `workspace/configuration`、动态 capability register/unregister 与 work-done progress token 创建；
- Current：支持 diagnostic client capability、动态注册、typed document pull 与 typed workspace pull request；
- 当前限制：没有 diagnostic refresh/result-id cache、workspace edit、semantic token delta 或 file-operation registration；
- Current：`ash-lsp-manager` 已作为 product host 使用 router，负责显式启停、resolved definition、
  revision freshness 和 Desktop event-loop 接线；
- Current：Desktop 通过独立 provider 自动解析 PATH 中的 `rust-analyzer`；缺失时不启动 server；
- Current：Desktop 已通过 App Server Config authority 接入持久化 mode/path 和 Settings UI；
- Current：driver 会区分规范关闭和意外 transport close；`ash-lsp-manager` 消费该事实，执行
  有界指数退避、crash-loop gate、断连 route retirement 与 authoritative document replay；
- Current：Desktop 已完成 diagnostics 下划线、hover detail 和 server runtime state 投影；语言请求结果
  UI 仍未完成；
- 当前限制：replacement host event gate 由调用方持有，router 不控制外部 callback queue；
- Potential：更多 transport health facts 可以继续由本 crate 上报，但重启预算、安装路径和用户策略
  必须继续由产品协调层或 catalog 拥有。
