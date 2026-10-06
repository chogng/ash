# `ash-lsp-manager`

> 本 README 是产品级语言服务协调层的 crate-level canonical contract。底层协议运行时见
> [`ash-lsp`](../lsp/README.md)，跨 crate 的能力、产品语义和演进阶段见
> [`docs/lsp.md`](../../docs/lsp.md)。

`ash-lsp-manager` 位于产品宿主与 `ash-lsp` 之间。它拥有语言服务启停、调用方已经解析并
验证过的 server definitions、文档快照路由、editor revision freshness、LSP position 到 UTF-8 byte range
的转换，以及 supervisor thread 生命周期。它不读取文件、不拥有 mutable editor text、不发现或
安装 executable，也不绘制诊断、补全或 hover UI。

## 所有权与公共接口

| API / type                                                      | 当前职责                                                                                                                  | 明确不做                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `LspManager`                                                    | 提供非阻塞文档 API并拥有 supervisor thread、Tokio runtime、router 与 clients                                              | 保存编辑器文本或直接修改 UI                    |
| `LspManagerConfiguration`                                       | 固定 directory root、启用状态和 resolved server definitions                                                               | 读取设置、PATH 或安装目录                      |
| `LanguageServerRestartPolicy`                                   | 定义 Never 或有限指数退避、重启预算和 healthy-window reset                                                                | 发现 executable 或绘制错误 UI                  |
| `LanguageServerState`                                           | 向产品发布 Starting、Ready、BackingOff、CrashLoop、Failed、Stopped                                                        | 保存设置或作为协议状态                         |
| `ash-lsp-server-provider::LanguageServerDefinition`             | resolver/provider 委托的唯一 route、canonical command 与 initialize options                                               | 在 runtime 内重新查询 PATH                     |
| `LspDocumentSnapshot`                                           | 传递绝对路径、language ID、精确 editor revision 和 authoritative full text                                                | 充当磁盘 revision 或文件缓存                   |
| `LanguageDiagnostics`                                           | 绑定路径、精确 editor revision 和 product-neutral UTF-8 ranges                                                            | 保存 LSP URI、version 或 paint style           |
| `LanguageRequestId` / `LanguageDocumentPosition`                | 非阻塞请求 identity 与 editor-owned UTF-8 source position；本地 service 或 Remote product adapter 在请求边界分配 identity | 暴露 LSP position encoding                     |
| `LanguageHover` / `LanguageCompletions` / `LanguageDefinitions` | capability-gated、revision-fresh 的产品结果                                                                               | 绘制 popup、读取定义文件或持有 editor text     |
| `LspManagerEventSink`                                           | 快速接收分开的通知与请求结果                                                                                              | 在 callback 中阻塞或反向调用 manager           |
| `LspRequestMetricsSink`                                         | 接收不含源码、路径、query 或 position 的请求结果指标                                                                      | 做 telemetry transport、保存用户内容或控制请求 |

`LspManagerEnablement::Disabled` 会保留最新文档快照但不启动 server。调用方必须显式提供
`Enabled` 和非歧义 resolver/provider 结果，manager 才会把 resolved command 委托给 `ash-lsp` 启动。

manager 的事件流已经把两种语义分开：`LspManagerEvent::Notification` 只承载 server 状态、diagnostics、
message、progress 和 capability 变化；`LspManagerEvent::RequestResult` 只承载带 request identity 的
语言查询结果或失败。新代码统一使用 `Lsp*` API；`LanguageService*` 类型和旧的扁平事件 sink 只保留为
App 迁移兼容层。

## 内部执行路径

```text
Desktop / another product host
  → LspManager::synchronize_document(full snapshot)
  → SupervisorCommand::Synchronize
  → Supervisor
      ├─ validate monotonic LanguageDocumentRevision
      ├─ retain authoritative snapshot + file URI
      └─ LanguageServerDocumentRouter::synchronize
          → LanguageServerClient → LSP stdio process

LanguageServerEvent::PublishDiagnostics
  → ProtocolEventBridge
  → reject stale supervisor generation / LSP document version
  → projection::project_diagnostic(position encoding → UTF-8 byte range)
  → LspManagerEvent::Notification(Diagnostics(editor revision))
  → product event loop

LanguageServerEvent::TransportClosed
  → reject stale generation / server epoch
  → clear diagnostics + mark matching documents unrouted
  → retire disconnected router route
  → bounded exponential backoff or CrashLoop
  → launch fresh client + replay authoritative retained snapshots

request_hover / request_completions / request_definition
  → validate current routed revision + advertised capability
  → convert editor UTF-8 position with negotiated encoding
  → async typed LSP request
  → reject stale generation / server epoch / editor revision
  → project product-neutral result event
  → emit cold/warm latency + result count + terminal outcome
```

关键私有符号：

- `Supervisor` 拥有所有可变 server、route、document 和 URI binding；UI thread 不接触这些状态。
- `SupervisorCommand` 是调用线程进入 supervisor 的唯一 mutation boundary。
- `ProtocolEventBridge` 给每个 server event 标记 server identity、service generation 和 server epoch，
  用于拒绝已停用、已替换或已重启实例的迟到事件。
- `ServerRestartTracker` 只计算连续失败、healthy-window reset 和 bounded backoff；`Supervisor` 拥有
  timer、route retirement、fresh launch 与 crash-loop 状态转换。
- `validate_definitions` 在创建 thread 前拒绝重复 server name 和重复 language route。
- `router_snapshot` 把产品文档转换为 `ash-lsp` snapshot；协议类型不会泄漏到 Desktop adapter。
- `projection::project_diagnostic` 根据 initialize 协商的位置编码生成 editor byte range。
- `request_runtime` 拥有 capability gate、异步 request task 和三重 freshness gate；`requests` 只定义
  product-neutral input/result 与 UTF-8/UTF-16 projection。
- `metrics` 定义 content-free `LanguageRequestMetric`；`Supervisor` 按 `(server, epoch, request kind)`
  区分 cold/warm，并拥有 in-flight task cancellation。

如果宿主开始直接持有 `LanguageServerClient`，或者本 crate 开始读取 editor/file system，表示协调
边界已经被绕过。若 `ash-lsp` 开始决定用户是否启用某个 server 或从哪里安装它，则协议层发生了
ownership 漂移。

## 校验、失败与宿主义务

- directory root 必须能转换为绝对 file URI；文档必须有非空绝对路径和 language ID。
- 同一路径只接受递增 editor revision；相同 revision 是无操作，旧 revision 产生异步文档错误。
- 一个 language ID 只能路由到一个 server。resolver 歧义在 thread 启动前同步返回错误。
- 启用后异步启动 resolved command；单个 server 启动或 transport 失败按配置发布 `Failed`、
  `BackingOff` 或 `CrashLoop`，不会使 supervisor panic。
- 默认策略最多重启五次，延迟从 250 ms 指数增长并封顶 4 s；连续 Ready 60 s 后下一次失败从新预算开始。
- 禁用、重配或 shutdown 会递增 generation、失效 server epoch、取消 launch，并让旧 timer 和旧实例
  的迟到事件无法触发重启或发布结果；所有 in-flight requests 同时被取消。
- `cancel_request` 会中止对应 task，并记录 `Cancelled`；freshness gate 丢弃的完成记录为
  `StaleDiscarded`，capability/route 拒绝记录为 `Rejected`。
- 意外断连会先清空该 server 文档的 diagnostics、退休 route 和旧 bindings；新实例 Ready 后只从
  本 crate 保留的 authoritative product snapshots 重放。
- diagnostics 只有在 LSP version 仍绑定到当前 editor revision 时才会发布；非法 range 被丢弃。
- `shutdown` 是有界的显式关闭路径；直接 drop 只排队 best-effort shutdown，不能用于等待完成。

产品宿主必须保存 authoritative editor document，并在每次文本 mutation 后发送 full snapshot；保存和
关闭通过独立方法通知。宿主还必须提供经过配置、授权和 executable resolution 的 definitions，并把
事件快速投递到自己的 event loop。诊断是否画下划线、hover/completion 的触发时机和 UI 状态不属于
本 crate。

## 测试、修改影响与当前限制

```bash
cargo test --manifest-path Cargo.toml -p ash-lsp-manager
cargo clippy --manifest-path Cargo.toml -p ash-lsp-manager --all-targets -- -D warnings
```

测试覆盖禁用模式的文档生命周期、启动失败隔离、resolver 歧义校验、精确重启预算、backoff 期间
禁用、真实 stdio server 初始化后崩溃、UTF-8/UTF-16/emoji/CRLF position conversion，以及拒绝、
取消和 content-free metrics。
修改 enable/disable、generation 或 epoch 规则时必须补充迟到 timer/event 测试；修改文档 binding
时必须同时检查 editor revision 与 LSP version；修改 projection 时必须覆盖 Unicode scalar 边界和
server 选定的位置编码。

当前实现：

- ✅ 产品级 supervisor、resolved definition 消费、显式启停、文档路由和规范 shutdown；
- ✅ diagnostics freshness 与 product-neutral byte-range projection；
- ✅ Desktop 已通过独立 adapter 接入 editor open/change/save/close 和 directory change；
- ✅ Desktop 通过独立 resolver 自动解析 PATH 中的 Rust、JSON/JSONC 与 Shell server，不可用时保持 Disabled；
- ✅ Desktop 消费 App Server Config snapshot，三个内置 server 均支持独立持久化 mode/path、Settings UI、
  热重配和打开文档重放；
- ✅ Desktop host 已把 neutral diagnostics 接入 CodeEditor decoration 与 hover detail；本 crate 仍不拥有 UI；
- ✅ 意外 transport close、断连 route retirement、有限指数退避、healthy-window reset、crash-loop gate
  和 authoritative document replay；
- ✅ Desktop Settings 显示 Starting、Ready、BackingOff、CrashLoop、Failed 和 Stopped，运行态不进入配置 authority；
- ✅ hover/completion/resolve/command/navigation/hierarchy/rename/code-action/formatting/signature-help/inlay-hints/linked-editing 非阻塞 facade、capability gate、request identity 和 stale-result rejection；
- ✅ Semantic Tokens、Document Symbols、CodeLens、Document Links、Document Colors 与 Folding 的 product-neutral projection 和 revision freshness；
- ✅ 静态/动态 capability gate、dynamic registration 与 work-done progress 事件；
- ✅ document pull diagnostics 的 full/unchanged report projection；full report 复用现有 diagnostics 事件和 freshness 规则；
- ✅ workspace diagnostics 的 capability gate 与跨文件 raw-coordinate projection；文件读取和 UTF-16 转换仍由 App Server directory-access authority 完成；
- ✅ message severity、show/log 区分与 work-done progress 的 product-neutral 事件；
- ✅ request kind/server incarnation/configuration + service generation/cold-warm/latency/result-count 与
  delivered/empty/failed/cancelled/stale-discarded/rejected 指标；不记录路径、文本、query 或 position；
- ✅ 显式 `cancel_request`、disable/reconfigure/shutdown 的 in-flight task cancellation；
- ✅ Desktop pointer hover、latest-request gate、可滚动 completion window/安全 textEdit 接受，以及 F12
  definition navigation；
- ✅ Desktop 已把 completion resolve/commands、additional edits、semantic tokens 和文档特性接入现有 Editor contract；多 definition target 复用 Peek 列表；
- 尚未完成：diagnostic result-id/partial-result/refresh；
- 尚未完成：server-specific distribution provider 与产品级 message/install UI；
- 尚未安装：references/navigation session cache；先由现有指标证明重复成本，再设计 incarnation/revision
  完整绑定的 key 与失效规则；
- Potential：远程 directory authority 出现后再评估是否把 execution 放到 App Server。
