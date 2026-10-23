# `ash-lsp-manager`

> 本 README 是产品级语言服务协调层的 crate-level canonical contract。底层协议运行时见
> [`ash-lsp`](../lsp/README.md)，跨 crate 的能力、产品语义和演进阶段见
> [`docs/lsp.md`](../../docs/lsp.md)。

`ash-lsp-manager` 位于产品宿主与 `ash-lsp` 之间。它拥有语言服务启停、调用方已经解析并
验证过的 server definitions、文档快照路由、editor revision freshness、LSP position 到 UTF-8 byte range
的转换，以及 supervisor thread 生命周期。它不读取文件、不作为编辑器文本 authority、不发现或
安装 executable，也不绘制诊断、补全或 hover UI。

## 所有权与公共接口

| API / type                                                      | 当前职责                                                                                                                  | 明确不做                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `LspManager`                                                    | 提供非阻塞文档 API并拥有 supervisor thread、Tokio runtime、router 与 clients                                              | 拥有编辑器文本 authority 或直接修改 UI         |
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

`LanguageServerControl::Suspend` 只释放没有匹配打开文档、没有在途请求的 Ready server；
进程退出完成后才发布 `LanguageServerState::Idle`。它保留 definition，区别于显式用户 Stop，
后者不会因语言请求自动恢复。Desktop 的本地用户设置 `languageServers.autoSuspend` 和
`languageServers.idleTimeoutMinutes` 决定何时请求回收：默认关闭自动回收，让已启动的服务
保留进程内分析结果。显式启用后，最后一个匹配编辑器关闭再等待 10 分钟；打开文件、
语言请求和服务器 progress 会延后回收。已有显式设置不被默认值变更覆盖。关闭的缓存 TextModel 不算
打开的编辑器。再次打开文件或执行语言功能时恢复 server；基础 Tree-sitter 语法服务不参与启停。
恢复会重新建立进程内分析缓存，因此基础高亮、滚动和折叠不应触发 LSP 唤醒。
Rust 默认关闭全项目缓存预热，以按需分析降低启动内存；其缓存容量按条目计数，线程数控制
并发，均不是总内存字节上限。Cargo 磁盘产物不能恢复 RA 分析数据库，当前也没有磁盘检查点
或对应的容量／过期清理设置。策略依据及用户设置见 [Rust 语言支持](../../extensions/rust/README.md#analysis-cache-and-memory)。

manager 的事件流已经把两种语义分开：`LspManagerEvent::Notification` 只承载 server 状态、diagnostics、
message、progress 和 capability 变化；`LspManagerEvent::RequestResult` 只承载带 request identity 的
语言查询结果或失败。新代码统一使用 `Lsp*` API；`LanguageService*` 类型和旧的扁平事件 sink 只保留为
App 迁移兼容层。

## 内部执行路径

```text
App Server / another product host
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
just test ash-lsp-manager
just rust-warnings ash-lsp-manager
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
- ✅ Rust 由内置扩展声明默认启用并按需获取；JSON/JSONC、Shell、JS/TS 的 PATH resolver 默认关闭；
- ✅ Desktop 消费 App Server Config snapshot，每个 server 均支持独立持久化 mode/path、Settings UI、
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
- ✅ App Server 消费已验证的 Node/direct 语言包；Workbench 通过 Extensions 安装服务器，日志、消息与进度接入 Output、通知中心和状态栏；
- 尚未安装：references/navigation session cache；先由现有指标证明重复成本，再设计 incarnation/revision
  完整绑定的 key 与失效规则；
- ✅ server execution 已由 App Server 承载，目录授权与客户端连接生命周期由产品宿主检查；跨系统远程体验仍需各平台验收。

## 配置与保存

宿主把规范化的 profile 参数、初始化选项和 settings 放进 `LanguageServerDefinition`。
`ProtocolEventBridge` 按请求顺序解析 settings 的 section，缺失 section 返回 null。
Desktop 的配置 service 保留由语言服务器解释、尚无 Workbench schema 的 JSON 设置，按用户、工作区和目录层合并。
窗口等待配置初始化后，通过 `language/servers.settings` 发送每个目录的 `rust-analyzer` section；
该快照只属于当前 connection 的目录 session，不写回 App Server profile。Rust section 同时进入
initialize options 和 `workspace/configuration`；外部修改或移除设置后，退役该目录受影响的实例，
等待新实例就绪并重放打开的文档。`window/showMessage` 使用对应严重性的非模态通知，附带“显示输出”操作。
本仓库的 Rust 检查命令通过 Just 调用 `scripts/cargo.py`，复用校验过的 grammar、V8 与 Sherpa 原生依赖；
保存检查使用 rust-analyzer 的 `{label}` 包标识，避免把目录设置改成全工作区检查。
每个目录 session 在 initialize 中发布自己的 workspace folder。静态与动态 capability 的触发字符
随 incarnation 的 capability snapshot 发布，客户端按实际声明注册补全和签名帮助。
`save_document(path, saved_text)` 在同一 supervisor 队列发送 didSave，不覆盖更新的 dirty snapshot。
连接隔离和断连回收归 App Server 的运行期 owner；manager 本身不解释客户端连接身份。

## 精确替换与请求结果

`replace_servers` 接受完整的 resolved definition 集合，保留启动契约不变的实例、文档绑定和在途请求。
`retire_servers` 立即撤销指定 source 的 route、重启任务和请求，其他服务器继续服务。
宿主在同 ID 的包更新、停用或撤权时先 retire，再提交新定义；不能仅比较服务器名称。
每次启动分配新的 server epoch，移除后重新添加同名服务器也不会复用旧 epoch。
退役实例的 graceful shutdown 在独立 task 中完成，原 definition 保留 lease 到进程回收。

`LspManagerEventSink::on_request_queued` 在请求发往 supervisor 前注册结果目的地，随后由
`RequestResult` 按 request ID 交付。App Server 在等待结果前释放连接 mutex，不持有目录／包目录的共享锁；
取消、超时、连接关闭或 source version 变化均撤下该请求的结果目的地并取消协议请求。
