# `ash-editor-extension-host`

> 本 README 记录当前可执行 Editor Extension Host v1 的进程、RPC、授权门禁、取消与故障恢复。
> 作者使用 [`TS SDK`](../../extension-sdk/README.md)，JS 由独立的
> [`独立扩展宿主`](../js-extension-host/README.md)执行：Ash SDK 使用 V8，标准 VS Code 扩展使用真实 Node；本 crate 继续承担共用的进程监管。
> 此前的 [`Rust 作者 SDK`](../extensions/README.md) 不再作为产品作者入口继续建设。
> 共享 wire 定义属于 `ash-editor-extension-protocol`。跨 Marketplace/legacy Plugin、Workspace、App Server 和 Workbench 的产品语义由
> [`docs/editor-extensions.md`](../../docs/editor-extensions.md) 维护；统一远端 package 身份由
> [`crates/core-plugins/README.md`](../core-plugins/README.md) 维护。

`ash-editor-extension-host` 监管一个已经由上层解析和授权的扩展程序。每个
`ExtensionHostSupervisor` 最多拥有一个扩展的一个活动进程 incarnation，通过有界 JSONL Host RPC v1
完成握手、激活、调用、取消、停用和关闭，并在授权仍有效时按有界策略恢复崩溃进程。它不发现或
安装 package，不选择 activation event，不实现 Workbench provider，不实现 VS Code Extension API；该 API 属于产品 JS 宿主。

Rust 后端继续提供授权、GitHub、Git、存储等业务能力。JS 入口和回调在独立 V8 或 Node 进程执行，
作者无需实现传输协议。标准 Node 的激活和后台客户端请求由 `supervisor/client.rs` 的有界并发 pump 处理，
每次请求取得当前授权 lease。App Server 绑定启动窗口，子进程只携带 incarnation/generation；窗口关闭、
撤权、崩溃和 shutdown 取消请求并等待释放，再释放进程 lease。按扩展串行化激活，使激活阶段调用另一
扩展的命令不会持有全局 fleet 锁。状态栏的注册校验和已确认快照更新仍由同一个 SupervisorState 拥有，
回调和后台通道共用处理。新宿主的进程测试已覆盖 SDK 反向编辑器调用、Rust 文件读取、取消、超时和释放；
这些测试不能代替生产平台隔离验收。

标准 Node 的 Host RPC 使用启动前分配、带随机绑定令牌的 loopback socket。私有 `process/node.rs`
只负责该 incarnation 的有界握手，控制 socket 与读写线程仍由现有 ProcessHandle owner 管理；
终止时先关闭 socket，再清理进程组并 join 读取线程。stdout/stderr 合并到已有有界诊断缓冲，
Debug 子进程继承 stdout 或直接写 fd 1 不会进入协议解析器。SDK 与独立协议程序仍使用 stdio。

每个标准 Node incarnation 在加载 package 前通过已有 ClientHost 读取当前窗口 initialization，
恢复时也重新读取。Workbench ConfigurationService 与 WorkspaceContextService 继续拥有事实；
Supervisor 只验证并转交该次快照，不维护另一个配置或工作区更新 owner。`workspaceEvents` 是只读
窗口观察注册，不借用 command、language、Tasks 或 Debug 执行 capability。

## 1. Crate 边界

| 能力                 | 本 crate 的职责                                                                          | 上层或平台职责                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Package binding      | 接收并绑定 `package_id`、digest、entrypoint 与 activation generation                     | source adapter 选择 immutable package/executable 并解析绝对路径                                 |
| Activation authority | 每次激活和调用前获取 `ActivationLease`                                                   | Adapter 同时复核 source artifact/admission lease 与 directory capability                        |
| Process supervision  | 每扩展一个进程、incarnation fencing、停用、关闭和有界重启                                | 平台 launcher 实施选定执行策略并拥有 killable process group                                |
| Host RPC v1          | 版本、请求相关性、严格 shape、注册 ceiling 和 byte limits                                | 扩展程序实现协议；App Server 把注册投影到领域 owner                                             |
| Provider invocation  | 路由到精确 registration、deadline、并发取消和结果校验                                    | Command、Language、Debug、Tasks、Testing、DataChannel、LinkPresentation 定义 payload 与消费结果 |
| Diagnostics / Output | 返回 typed `ExtensionHostError`，保留有界 stderr，并接收受配额约束的扩展命名 Output 事件 | App Server 清洗故障并把 Output 事件投影到 Workbench Output 服务                                 |

出现以下代码表示 ownership 漂移：本 crate 扫描 Marketplace/Plugin 目录、持久化 enable/grant、解释
`package.json`、注册 Workbench provider、决定工作区信任，或自行把一个普通 Node/WASM 脚本当成
entrypoint 加载。

## 2. 文件与公共契约

| 文件                                         | 关键公共契约                                                              | 约束                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `../editor-extension-protocol/src/lib.rs`    | `ExtensionHostRequest`、`ExtensionHostResponse`、`RegistrationDescriptor` | Host 与 SDK 共用的 Host RPC v1 wire shape；严格校验 request/response correlation       |
| `../editor-extension-protocol/src/output.rs` | `ExtensionHostOutputEvent`、`HostOutputOperation`                         | 扩展发起的命名 Output 事件；按 incarnation/generation fencing，不属于静态 registration |
| `authority.rs`                               | `ActivationAuthority`、`ActivationLease`、`ExtensionActivationSpec`       | 授权是 live gate，不是 activation 时的一次布尔判断                                     |
| `limits.rs`                                  | `ExtensionHostLimits`、`ProcessIsolationPolicy`                           | 默认要求平台强制隔离；所有 byte/count/deadline limit 必须非零且一致                    |
| `process.rs`                                 | `ExtensionHostLauncher`、`ExtensionHostProcess`、`ExtensionLaunchCommand` | launcher 在 entrypoint 执行前实施选定策略并应用明确的进程环境                              |
| `supervisor.rs`                              | `ExtensionHostSupervisor`、`ExtensionHostSnapshot`                        | 一扩展一监管器；注册仅在完整 activation 成功后发布                                     |
| `supervisor/invocation.rs`                   | `ExtensionInvocation`、`ExtensionInvocationHandle`                        | wait 与 cancel 可由不同线程并发调用；lease 持续到 terminal handling                    |
| `restart.rs`                                 | `RestartPolicy`、`RestartTracker`                                         | 滑动窗口、指数退避和 terminal `CrashLoop`                                              |
| `error.rs`                                   | `ExtensionHostError`                                                      | 区分拒绝、配额、协议、退出、超时和 unknown outcome                                     |

`ExtensionHostLauncher` 和 `ActivationAuthority` 是 host adapter 必须实现的两个端口。前者拥有物理
隔离，后者拥有“当前是否仍可运行”的 live decision；不能用一个启动时缓存的 `true` 替代后者。

## 3. 内部接口地图

| Private symbol                                 | 精确职责                                                                                                                       | 不能承担                                | 修改时同步检查                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------- |
| `SupervisorState`                              | 保存 status、incarnation、live process、原子 registrations、invocation leases 与 restart tracker                               | Plugin 安装状态或 Workbench registry    | supervisor lifecycle/recovery tests、系统文档           |
| `ExtensionHostSupervisor::launch_and_activate` | 取得 activation lease，spawn，递增 incarnation，完成 handshake + activate 后一次发布 registrations                             | 平台 sandbox、activation-event matching | authority、handshake、capability ceiling、restart tests |
| `ExtensionHostSupervisor::context`             | 分配非零且不复用的 request ID，并绑定 incarnation 与 activation generation                                                     | 跨进程持久 ID                           | exhaustion/correlation tests                            |
| `reserve_pending`                              | 在写 stdin 前预留 waiter，分别约束普通请求和 control request，并拒绝 request ID 重用                                           | provider-level scheduling               | concurrent cancel、quota、duplicate-ID tests            |
| `spawn_stdout_reader`                          | 有界读取 frame，区分 correlated response、client request 与 Output event；前者匹配 pending request，后者严格校验并进入有界队列 | Workbench channel registry 或无限缓冲   | malformed/oversized/correlation/Output quota tests      |
| `extension_protocol::read_frame`               | 在分配增长前校验 frame byte ceiling，并要求换行终止                                                                            | JSON semantic validation                | exact-boundary tests                                    |
| `ExtensionInvocationHandle::wait`              | 轮询 terminal response，观察 caller/deadline cancellation，执行 grace 后 unknown-outcome recovery                              | 把超时当成确认失败                      | cancel/deadline/indeterminate/restart tests             |
| `ExtensionHostSupervisor::recover_locked`      | 清除旧注册和 leases、终止旧进程、消费 restart budget、重新握手和激活                                                           | 无限重启或跨授权恢复                    | crash-window/backoff/authority-revoked tests            |
| `validate_registrations`                       | 检查注册数量、ID 唯一性、字段限制和 manifest capability ceiling                                                                | 实现 provider 业务语义                  | protocol capability/duplicate/size tests                |

真实调用路径为：

```mermaid
flowchart TD
    start["ExtensionHostSupervisor::start"] --> lease["ExtensionActivationSpec::acquire"]
    lease --> spawn["ExtensionHostLauncher::spawn"]
    spawn --> initialize["initialize_and_activate: Initialize"]
    initialize --> activate["Activate + validate_registrations"]
    activate --> publish["SupervisorState atomically publishes Ready + registrations"]
    publish --> invoke["begin_invoke + per-call ActivationLease"]
    invoke --> response["ExtensionInvocationHandle::wait"]
    response -->|success or typed host failure| release["release invocation lease"]
    response -->|exit, invalid protocol, or no terminal result after cancel grace| recover["terminate + recover_failed_incarnation"]
    recover --> spawn
```

## 4. Host RPC v1

传输是一行一个 UTF-8 JSON frame 的双向 stdio 协议。请求与响应携带 `protocolVersion`、`requestId`、
`incarnation` 和 `activationGeneration`；扩展主动发出的 Output event 不带 `requestId`，但必须携带其余
三个 stale-process fence。任一 fence 为零、版本不匹配、response correlation 不完全一致、未知 request
ID、错误 response kind、无效 Output channel identity 或超过 frame/Output ceiling 都使当前进程失败关闭。
请求 ID 空间耗尽时返回 `RequestIdentityExhausted`，不能环回并复用旧 identity。

Output event 是独立的流式协议，不是 `ActivateResult.registrations` 的一种。扩展先发送 `create`，随后可按
stdout 顺序发送 `append`、`replace`、`clear`、`show` 和 `dispose`。监管器为通过 incarnation/generation
复核的事件分配单调 sequence，保留有界历史；App Server fleet generation 因事件变化而更新，Renderer
按 sequence 增量投影。初次连接会重放内容事件以恢复频道，但不会重放旧 `show` 事件抢占焦点。

生命周期顺序固定为 `Initialize → Activate → Invoke* → Deactivate → Shutdown`。`Activate` 一次返回完整
注册集合，只有整批验证通过才成为 `ExtensionHostSnapshot.registrations`。当前注册类型包括命令、
语言供应商、调试适配器、任务供应商、测试配置供应商、数据通道与链接展示供应商；语言 v1 的 operation
ceiling 包含 completion、Parameter Hints、definition、hover、references、rename、formatting、code
action、code lens、document symbols、folding、document links/colors、semantic tokens、Inlay Hints 与
Linked Editing。

`ActivateParams.activation_events` 是上层已经解析的 activation facts，监管器不会自行观察编辑器事件，
也不会据此决定何时启动。`capabilities` 则是强制 registration ceiling：进程不能通过 activation 响应
注册 manifest 未声明的 provider kind。协议支持的 provider kind 不等于 App Server/Workbench 已有对应
业务适配器。

`dataChannel` 注册携带 `channelId`，要求 manifest 声明 `dataChannel` capability，只能调用
`receiveData`，payload 为 `{ "data": <JSON value> }`。它将当前窗口发布的数据按订阅顺序交给扩展，
不是扩展向前端发送任意事件的通道。每个订阅最多保留 32 个待发送事件；超额事件拒绝入队并记录错误，
不会重放断连期间或已退役进程的数据。`editTelemetry` 的数据为 `{ eventName, data }`；编辑器当前发布
补全接受状态和持续时间，不含文档正文。产品遥测采集保持关闭，扩展转发单独由订阅控制。

`linkPresentationProvider` 注册携带 `uriPattern` 与 `presentationKind`，要求同名 capability，只能调用
`provideLinkPresentation`，payload 为 `{ "resource": "<URI>" }`。Frontend 为正在显示的匹配链接发起
查询；返回 `null` 表示使用原文，否则须返回平台 `ILinkPresentation` 的合法 kind、文字、状态与非负
变更计数。首次立即查询，成功后每 30 秒更新；查询失败记录错误并恢复原文。移除链接、注销供应商、
连接关闭或进程替换均取消调用，旧进程的迟到结果不会更新新链接。注册 regex 的语法由 Frontend 校验，
Host 限制 pattern 为 2048 bytes 并验证展示 kind。

默认 `ExtensionHostLimits` 为：

| 限制                                              |                                           默认值 |
| ------------------------------------------------- | -----------------------------------------------: |
| 单 frame                                          |                                            1 MiB |
| invocation payload                                |                                          512 KiB |
| registrations                                     |                                              256 |
| ordinary in-flight requests                       |                                               32 |
| in-flight control requests                        |                                                8 |
| captured stderr                                   |                                          256 KiB |
| queued / retained Output                          |                            4096 events / 512 KiB |
| arguments                                         |                             128 entries / 32 KiB |
| environment                                       |                              64 entries / 32 KiB |
| startup / request / cancellation grace / shutdown |                          10 s / 30 s / 2 s / 5 s |
| restart budget                                    | 60 s 内最多 5 次；100 ms 起步、最高 5 s 指数退避 |
| hard resources                                    |             512 MiB memory、300 s CPU、1 process |

这些值按 bytes 或 entries 计数。硬资源值只是一项 launcher obligation；crate 内没有因为字段存在就
宣称 OS 已经实施限制。

## 5. 授权、隔离与生命周期

`ExtensionActivationSpec` 把可序列化 activation params 与不可序列化 `ActivationAuthority` 绑定。启动、
crash recovery 和每次 `begin_invoke` 都重新取得 lease。disable、update、uninstall 或 directory capability
撤销后，adapter 的 `authorizes/acquire` 必须立即拒绝新工作，并让既有 invocation drain 或被 host
composition 主动取消；进程中自报的 package identity 不是授权依据。

默认 `ProcessIsolationPolicy::RequirePlatformEnforcement` 要求产品提供的 launcher 在 entrypoint 运行前
同时安装 sandbox、memory/CPU/process hard limit、独立 stdio、空继承环境和可整体终止的 process tree。
任何一项无法保证都必须返回 `IsolationUnavailable`。产品 JS 命令单独使用
`RequireJavaScriptEnforcement`：macOS 与 64 位 Windows 的 `ProductJavaScriptLauncher` 只接受产品自带的 V8 宿主，
子进程在执行扩展前安装系统隔离、V8 堆与堆外缓冲区预算，执行仍有截止时间。JS 预算不代表整个进程的系统内存上限。
独立可执行扩展不能选用此策略。
标准 VS Code 命令在现有 exact-package authority gate 之后使用 `AuthorizedNode`：同一 launcher
只启动 composition root 绑定的产品 Node executable 与 bootstrap，直接纳入监督器的进程组。
这项策略允许当前用户的文件、网络和子进程能力，不宣称 V8 隔离或整个进程的硬资源上限；
frame、并发、截止时间、取消和撤销仍由现有监督器执行。Node 的环境额度为 256 项 / 128 KiB，
开发环境在 launcher 创建时冻结，排除产品内部认证变量与继承的 Electron 控制变量；Desktop
仅向确切 Electron 子进程加入 `ELECTRON_RUN_AS_NODE=1`。旧的有限 JS 执行授权必须重新授予。
`TrustedDevelopmentLauncher` 只接受显式 `TrustedDevelopment` policy，
仅用于可信本地开发。所有 stdio 进程的整组清理由共享 sandboxing ProcessHandle 管理。

崩溃后旧 incarnation 的 registrations 立即清除，pending request 和 lease 不得迁移到新进程。恢复会
重新执行 Initialize/Activate，再发布一整批新注册。空闲进程退出由 `reconcile()` 检出，因此 App Server
必须运行 health loop；监管器本身没有常驻 polling thread。超过 restart window 后进入 `CrashLoop`，只
能由上层显式重建或重启失败 runtime，不能无限自旋。

## 6. 取消与失败语义

`begin_invoke` 在发送前取得 invocation lease，并返回可跨线程取消的 handle。绝对 UTC deadline 与
`request_timeout` 取较早者。调用方取消或 deadline 到达时，handle 发送独立 control request；这条
request 不与普通 in-flight quota 竞争。grace 内若仍没有 terminal response，结果为
`OutcomeIndeterminate`：监管器终止该 incarnation 并恢复，而不是声称扩展没有产生副作用。

`Drop` 一个未完成 handle 会尝试取消、终止进程并释放 lease。Host exit、invalid protocol 和 unknown
outcome 都会 fence 当前 incarnation；activation authority 被撤销时恢复失败关闭。`stderr()` 只保留有界
前缀供上层诊断。Output 事件队列在 health loop drain 前若超过配额会使当前进程按协议失败；监管器中的
retained history则丢弃最旧事件以保持固定上界。App Server 对客户端暴露前仍必须清洗主机路径和实现细节。

## 7. 接入义务

App Server 或其他 composition root 必须：

1. 从 source adapter 已规范化的 exact immutable package、digest、executable 与 live authority 构造
   `ExtensionActivationSpec`，并把 directory capability 加入同一 live gate；
2. RPC 程序必须有 exact process permission；JS 入口必须通过 package validation，Ash SDK 交给产品 V8，标准 API 交给产品绑定的 Node executable/bootstrap；
3. 根据入口选择隔离策略：独立可执行扩展要求 `RequirePlatformEnforcement`，macOS 与 64 位 Windows JS 要求 `RequireJavaScriptEnforcement` 并使用 `ProductJavaScriptLauncher`；标准 VS Code 扩展要求 `AuthorizedNode` 与新的确切包执行授权；缺少符合所选策略的 launcher 或 Node 资源时将生产能力标记为不可用；
4. 定期调用 `reconcile()`，把 snapshot 变化原子投影到 provider owners；
5. 使用异步 invocation session 或后台 waiter 暴露调用，使 cancel request 不被一个阻塞 RPC 串行化；
6. connection 断开、authority 撤销和 shutdown 时取消 owned invocations 并调用 `shutdown()`；
7. 只暴露清洗后的 failure code/message，不把 absolute executable、cwd 或原始 stderr 放进 wire DTO。

App 若接入同一执行语义应依赖本 crate，并提供自己的 composition adapter；不得依赖 Desktop 或把
Host runtime 复制进产品 host。

## 8. 测试与修改影响

仓库 workspace 可加载时运行：

```text
just check ash-editor-extension-host
just test ash-editor-extension-protocol
just test ash-editor-extension-host
just test ash-extensions
just rust-warnings ash-editor-extension-host
```

当前仓库还提供不加载根 workspace 其他 crate 的离线入口：

```text
powershell -NoProfile -ExecutionPolicy Bypass -File crates/editor-extension-host/check-standalone.ps1
```

测试分别位于 sibling `*_tests.rs`，覆盖 strict protocol、frame/payload/registration/in-flight limits、
response correlation、request-ID exhaustion、并发 cancel、authority leases、activation atomicity、
deadline/unknown outcome、crash recovery、backoff/crash loop 和 shutdown。修改 registration kind 或 wire
shape 时还必须同步 Plugin manifest ceiling、App Server protocol DTO、Frontend adapter 和跨层文档；修改
launcher obligation 时必须增加各平台 isolation acceptance test，不能只更新 fake launcher 测试。

## 9. 当前限制与扩展点

Current：Host RPC v1、逐扩展进程监管、live activation/invocation lease、原子 registrations、并发取消、
有界 stdio/stderr、扩展命名 Output event stream、incarnation/generation fencing、graceful shutdown 与有界
crash recovery 已实现。

当前限制：

- Ash SDK 的 V8 launcher 支持 macOS 与 64 位 Windows；标准 Node 路径接入支持 Node 的产品平台，独立可执行扩展的生产平台 launcher 尚未开放；
- activation-event matching 和 lazy activation 属于上层 composition，监管器只接收 activation facts；
- 空闲崩溃检测依赖上层 health loop；
- v1 的 extension-originated event 目前只覆盖命名 Output channel；其他事件必须先明确领域 owner 与背压语义；
- 本 crate 不实现 Node/WASM 模块加载、VS Code API 或 Marketplace 兼容解析；产品 Node 宿主与 source adapter 负责这些工作，仍为每扩展一个进程；
- 没有 publisher signature、revocation feed、跨平台 artifact selector 或 binary ABI 检查；这些属于 package
  supply-chain 与平台 launchability 演进，不应加入协议解析器。

潜在演进必须由真实 consumer 驱动：若增加其他 extension-originated event、remote host 或新的 provider
kind，应先固定 App Server/domain owner、背压与权限语义，再版本化协议；不能用 v1 unknown field 或未
声明 capability 静默协商新行为。
