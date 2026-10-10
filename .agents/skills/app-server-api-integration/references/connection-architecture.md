# 连接与所有权

本文件规定 TypeScript 编辑器平台与 Rust 产品业务后端的最终边界，以及领域 service、adapter、renderer/Main、process、connection 和后端对象的所有权。这里描述目标设计，不表示当前源码已经实现全部能力。Sessions 只在 Thread 进入 Agents Window 时适用。路径表达最终职责，不认可目标仓库的现有错误目录；迁移选择不明确时执行主 skill 的冲突门禁。

## 快速理解

产品保留 TypeScript 编辑器前端和桌面平台，经 Rust app-server 接入共享核心机制与可选 Provider。先判断核心、扩展和客户端的职责，再决定后台执行与状态 scope；跨 renderer 存活、稳定持久状态或 Rust 实现不自动要求能力进入核心。目标 TS/JS 与独立 Rust 扩展的完整边界见 [扩展架构](../../extension-architecture/SKILL.md)。

| 能力 | 最终 owner | 决策 |
| --- | --- | --- |
| Agent、Thread、Turn、Item、审批、权限和工具执行 | 对应 Rust 领域 crate | 迁入 Rust |
| Project、Environment、模型调用契约与状态 | 对应共享 Rust 领域 crate | 接入共享后端 |
| 服务商认证、账户会话、托管平台 API 与可选业务 | 选定的 TS/JS 或 Rust Provider | 扩展拥有状态，App/TUI 按需消费 |
| SecretStore、消费者账号/scope 授权 | 共享秘密与权限服务 | 核心机制，不复制 Provider 会话 |
| command/process/resource、Agent 发起的 Git/repository/worktree 操作 | 对应 Rust 领域 crate | 迁入 Rust |
| 跨窗口搜索、索引、监听、远程连接和恢复 | 核心领域服务或可选 Provider，按真实职责决定 | 状态放后台，具体适配不默认进入核心 |
| text model、working copy、dirty buffer、undo、diff | 前端 editor/file owner | 保留前端 |
| Workbench UI、contribution、设置、主题、布局、快捷键和可访问性 | 前端 Workbench owner | 保留前端 |
| 扩展 API 的编辑器对象、兼容桥与 UI 注册 | 前端 extension owner | 保留客户端，扩展在所选独立宿主或程序执行 |
| Electron 与操作系统窗口能力 | Main | 保留并压薄 |
| 通用文件服务、交互式 Terminal 执行层、SCM 执行层、语言服务 | 由完整 contract 与真实收益决定 | 条件迁移，不能默认并入 app-server |

Rust 后端不能成为编辑器对象的远程镜像。`../app-server/` 提供连接、typed dispatch、授权路由与跨领域 orchestration；核心服务或扩展 Provider 唯一拥有其状态与资源，broker 不复制业务。前端领域 service 保持调用方 contract，adapter 只做机械转换。

### 迁移判定

先把可选服务商业务归到 Provider；再用以下条件判断能力是否适合后台接入，不能据此将 Provider 实现并入核心：

- 状态需要跨 renderer、窗口关闭或后台任务长期存活；
- contract 可以由稳定 ID、request、notification、server request 或显式 resource 完整表达；
- 实现不依赖 text model、dirty buffer、DOM、Electron 对象或扩展进程中的对象身份；
- Rust 能带来明确的持久化、并发、IO、安全、恢复或多产品复用收益。

高频同步 UI 状态、编辑器事务、扩展贡献的客户端对象和系统窗口对象保留前端。扩展业务代码可独立执行，共享状态由 Provider 的明确 scope 持有。一个能力同时命中两边且无法确定唯一 owner 时，按主 skill 的冲突门禁处理；不能建立双写状态或通用远程对象层。

## 端到端结构

```mermaid
flowchart LR
    Caller[renderer 调用方] --> Service[前端领域 service]
    Service --> Adapter[领域 app-server adapter]
    Adapter --> Client[renderer protocol client]
    Client --> Port[per-renderer transport]
    Port --> Relay[Main transparent relay]
    Relay --> Process[shared app-server process]
    Process --> Dispatch[typed dispatch]
    Dispatch --> Domain[共享核心领域服务]
    Dispatch --> Provider[有效的 TS/JS 或 Rust Provider]
```

账户调用方依赖账户 service，文件调用方依赖文件 service，配置调用方依赖配置 service；它们不依赖 Sessions。每个领域 adapter 消费同一个 renderer protocol client，但只暴露该领域的前端契约。

每个 renderer 独立完成 connection initialize、request pairing、notification 订阅和 server request 回复。Main 只启动共享进程、为窗口取得独立 backend connection 并透明转发 frame；Main 不解析 method、不改 request ID，也不保存领域状态。

## 所有权表

| 对象 | 唯一 owner | 禁止承担 |
| --- | --- | --- |
| 前端领域接口、状态、事件和可见错误 | `src/platform/<domain>/common/` 或 `src/workbench/services/<domain>/common/` | transport、JSON-RPC、Rust DTO |
| 领域 app-server adapter | 对应领域的 `browser/` 或 `electron-browser/` | process、通用 pending、其他领域状态 |
| 生成协议、protocol client contract | `src/platform/agentHost/common/appServerProtocol/` | 具体领域 API、UI 状态 |
| protocol client 与 connection 状态机 | `src/platform/agentHost/browser/` | 领域 facade、业务决定 |
| renderer transport acquisition | `src/platform/agentHost/electron-browser/` | process spawn、领域状态 |
| 进程与 renderer connection relay | `src/platform/agentHost/electron-main/` | initialize、request pairing、method routing |
| Agents Window 的 Session/Chat contract | `src/sessions/services/sessions/common/`，仅 Thread UI 使用 | 通用 app-server API |
| Thread 的 Sessions Provider adapter | `src/sessions/contrib/providers/agentHost/browser/`，仅 Thread UI 使用 | 文件、账户、配置等领域入口 |
| 产品装配 | `src/code/electron-main/app.ts` 与对应 renderer main entry | protocol parser、DTO 转换、领域状态 |
| 线上协议与生成物 | `../app-server-protocol/` | runtime、renderer 类型 |
| backend connection 与 typed dispatch | `../app-server/` | renderer/window 状态 |
| 多 connection transport | `../app-server-transport/` | 领域业务规则 |
| 共享 Rust 领域行为 | 对应核心领域 crate | IPC、前端类型、具体可选 Provider 实现 |
| 可选业务、认证会话与后台任务 | 选定扩展 Provider | 核心最终授权、UI 或第二份会话副本 |

前端依赖方向是 `base → platform → editor → workbench`。`src/platform/agentHost/` 的 protocol client、transport 和 starter 不得依赖具体领域或 `src/sessions/`；领域 adapter 依赖 protocol client contract。Sessions 位于 Workbench 之上，只能作为其中一个领域消费者。

## 目标目录

前端参考源码根以下统一写作 `src/`：

```text
src/
├── platform/agentHost/
│   ├── common/
│   │   └── appServerProtocol/
│   │       └── appServerProtocol.ts
│   ├── browser/
│   │   └── appServerProtocolClient.ts
│   ├── electron-browser/
│   │   ├── appServerMessagePortTransport.ts
│   │   └── localAgentHostService.ts
│   └── electron-main/
│       ├── electronAgentHostStarter.ts
│       └── appServerConnectionRelay.ts
├── platform/<domain>/
│   ├── common/<domain>.ts
│   └── browser/<domain>AppServerAdapter.ts
├── workbench/services/<domain>/
│   ├── common/<domain>.ts
│   └── electron-browser/<domain>AppServerAdapter.ts
├── sessions/contrib/providers/agentHost/browser/
│   ├── appServerSessionsProvider.ts
│   └── appServerSessionAdapter.ts
└── code/electron-main/app.ts

build/protocol/generate.ts
build/protocol/generate.py
```

`.build/protocol/typescript/` 由 Rust 导出器写入，构建入口在临时目录生成完整契约后发布，禁止手改或提交生成物；`schema_hash` 集成测试在 `export` feature 下逐字节验证源码与产物一致。生成物供所有宿主共用，保留在构建目录，由 Rust protocol crate 负责；前端 protocol client contract 留在 `common/`，不能把产物复制进旧 TypeScript Host 的 `node/` 子树。领域属于 platform 还是 workbench 由前端调用方和依赖方向决定。只属于 Agents Window 的 Thread facade 才放进 Sessions Provider。只创建有真实调用方的文件；小型 adapter 可以与领域 service implementation 同文件，没有独立 relay 逻辑时可与 starter 合并，不能为了目录对称创建占位文件。

后端参考源码使用并列 crate 路径：

```text
../app-server-protocol/
├── src/listen_info.rs
├── src/protocol/common.rs
├── src/protocol/v2/<domain>.rs
├── src/export.rs
└── src/typescript_decoder.template.ts

../app-server/
├── src/main.rs
├── src/message_processor.rs
├── src/request_serialization.rs
├── src/outgoing_message.rs
├── src/request_processors/<domain>_processor.rs
└── src/<domain>_resource.rs

../app-server-transport/
├── src/lib.rs
└── src/transport/
    ├── auth.rs
    └── websocket.rs
```

`<domain>_resource.rs` 只用于跨 request 存活的 watch、process、stream 等资源。普通 request 不创建 resource manager。

新增能力先固定核心机制或扩展 Provider 的公开 contract，再由 `../app-server-protocol/` 暴露产品协议，由 `../app-server/` typed processor 授权并路由。可选业务实现留在独立 Provider，不链接进核心。不能因为调用经过同一个 app-server，就把账号、GitHub、文件、执行、SCM、Terminal 或搜索实现堆进 app-server crate。

## 旧 Host 退出边界

最终架构保留前端 Host service 的名称和调用者契约，但替换它下面的线上协议与运行时。迁移完成后生产调用链必须满足：

- `localAgentHostService.ts` 创建或取得 renderer 的 app-server protocol client，不再创建旧 Host protocol client；
- 旧 Host 的 action/state/command 线上 envelope、pending、reconnect 和 protocol negotiation 不再参与 renderer 与 Rust 之间的通信；
- `node/agentHostMain` 及 TypeScript Host runtime 不再由 desktop starter 启动；仍有真实前端调用方需要的纯前端 contract 必须迁回其领域 owner，不能为了保留文件而继续运行旧 Host；
- Main starter 直接启动 app-server executable，或启动只负责建立正式 backend connection 的最小进程；不能启动一个继续承担领域行为的 TypeScript 中间层；
- 每个旧 Host API 必须选择“由现有前端领域 service 通过 app-server adapter 实现”或“从产品能力中移除”。协议缺失或行为冲突时停下来问用户，不能加入 AHP-to-app-server compatibility adapter。

只有所有生产调用方、注册点、启动入口和测试 fixture 都已转移后才能删除旧文件。迁移期间也不能让两个实现同时注册同一 service。

## Process 与 connection 拓扑

最终拓扑是：

```text
一个 host process
  ├── renderer A → connection A → protocol client A → 多个领域 adapter
  ├── renderer B → connection B → protocol client B → 多个领域 adapter
  └── renderer C → connection C → protocol client C → 多个领域 adapter
```

Main starter 在首次请求时启动一个进程。每个 renderer 通过带 nonce 的 acquisition 请求取得专属 MessagePort；Main relay 为该 MessagePort 打开一条独立 backend connection。relay 只进行 frame 转发、背压和关闭传播，不解码 JSON、不执行 initialize、不分配或重写 request ID。

同一 renderer 的领域 adapter 复用同一个 protocol client，不能各自创建 connection、pending map、reader 或 reconnect loop。renderer 关闭时只关闭自己的 MessagePort、backend connection、pending、订阅和资源。应用关闭、明确 restart 或 host 致命失败才停止共享进程；进程停止会关闭全部 renderer connection。

领域、Project、Workspace 和 renderer window 都不能启动额外 app-server 进程。扩展由既定 supervisor 按有效包授权启动独立进程，其状态 scope 与关闭见扩展契约；它们不改变共享 app-server 的拓扑。只有额外 app-server 隔离无法在既定契约表达且用户未决定取舍时，才执行冲突门禁。

### 多 connection transport 门禁

正式桌面 transport 必须同时满足：

- 一个进程接受多个独立 connection；
- 每条 connection 单独 initialize、拥有独立 capabilities 和 request ID 空间；
- macOS、Linux 和 Windows 都有正式支持的本地 endpoint；
- Main relay 能为每个 renderer 打开独立 connection，且不理解线上 method；
- transport 有有界队列、背压、身份校验和确定关闭语义。

单路 stdio 不能满足该 app-server 拓扑。Main protocol multiplex、每窗口一个 app-server 进程或自动 transport 切换都不能成为正式路径；扩展进程可使用其公开契约规定的独立传输。当前后端不满足这些条件时停止前端实现，先按 [前置能力补全](prerequisite-completion.md) 将 token-authenticated loopback WebSocket、机器可读启动记录和三平台测试补进 `../app-server-transport/` 与 `../app-server/`；后端不在授权范围或源码前提冲突时再询问用户。

## renderer protocol client

`src/platform/agentHost/browser/appServerProtocolClient.ts` 每个 renderer 创建一个实例，负责：

- connection 状态与代次；
- request ID、client pending 与 server request pending；
- `initialize` response、`initialized` notification 和 ready gate；
- 生成 decoder、message 分类、typed notification listener 与 server request handler；
- connection 关闭时拒绝 pending、结束资源并忽略旧代次结果。

client 不启动进程、不读取 active editor/Session、不保存领域 catalog，也不包含按领域扩张的 method switch。每项线上 method 只能通过生成 method map 调用。

`src/platform/agentHost/electron-browser/appServerMessagePortTransport.ts` 只把 MessagePort frame 变成 client message transport，拥有有界发送队列、drain/close 和有限诊断。它不执行 initialize、不拥有 pending，也不恢复领域对象。

## 领域 adapter

每个 adapter 从前端领域 contract 出发，只消费它需要的 typed request、notification 和 server request。adapter 可以转换 URI/path、时间、枚举、结构化错误和 resource ID，不能：

- 暴露线上 method、envelope、request ID 或生成 DTO 给普通调用方；
- 保存 Rust 领域的第二份 durable state；
- 调用不属于本领域的后端 method；
- 依据英文错误、active window 或其他领域缓存决定行为；
- 启动 process、创建第二个 protocol client 或实现自己的 reconnect。

后端 catalog/state 的前端 facade 可以按 snapshot 与 notification 保持最新，但后端仍是唯一持久化 owner。只有多个真实前端消费者需要同一领域时才抽出共享 service；不能因为多个线上 method 就建立万能 app-server domain。

## 后端对象 identity

Project 是后端持久 catalog object；Workspace 是前端工作目录概念；Environment 是 Thread/Turn 执行目标；Thread 是 durable conversation；process/resource 使用自己的稳定 ID。它们可以关联，但身份不得互换。

Project adapter 处理 Project catalog 与 assignment；Workspace/file service 处理目录和文件状态；Environment adapter 处理执行目标；Thread adapter 处理 conversation。一个 adapter 可以在机械转换时读取关联对象，但不能夺取另一领域的 owner。

Project 或 Environment API 仍为实验协议时，生产 adapter 不开启实验 capability。先按 [前置能力补全](prerequisite-completion.md) 稳定真实产品调用方需要的 method、field 和 notification 闭包；稳定范围包含尚未决定的产品行为时执行冲突门禁。

## Thread 进入 Agents Window 时

仅此场景实现 `src/sessions/contrib/providers/agentHost/browser/` 下的 app-server adapter。

Provider instance 使用稳定 `providerId` 和 resource scheme。committed Thread `threadId` 被编码进 provider-owned resource，canonical Session ID 统一由：

```text
providerId + ":" + resourceUri
```

生成。消费者比较 resource identity，不解析 scheme 或 Thread ID。Provider adapter 内部可以从 resource 路由到 Thread API，但普通 UI 不能解析。

新 Session 在发送首个请求前是 Provider-owned draft。`thread/start` 成功后发布 committed facade，并通过独立 replacement lifecycle 用 committed Session 替换 draft。不要持久化临时 resource，也不要在 Project、process service 或 UI storage 保存 draft → Thread 映射。

resume/read/catalog discovery 直接从 backend Thread 建立 committed resource。fork 返回新 Thread 时建立新 Session；rollback/revert 更新原 Thread facade，除非协议返回新 Thread。

默认 Chat resource 等于 Session resource，表示 Thread 的主 Chat。只有后端同时提供稳定 Chat catalog、Chat ID、create/fork/side-chat/delete/restore、每条 Chat 状态和 catalog notification 时，Provider 才能声明 multi-chat。不能为了复刻多 Chat UI 把多个独立 Thread 拼成一个 Session。

`ISession.workspace` 可以投影 Thread cwd、runtime workspace roots 和关联 Project roots，但 Project roots 变化不自动改写运行中 Thread cwd；协议没有明确行为时不能在前端推断同步。

## Server request 路由

后端 server request 在产生它的 backend connection 上发送，因此 renderer protocol client 天然确定窗口 owner。renderer 可完成的 request 由对应领域 adapter 调用明确前端 service；Main 才能完成的系统、进程或凭据能力通过独立 named host channel 请求 Main，不能把整个线上 server request union 转发给 Main。

必须处理未知 method、handler 未注册、窗口关闭、用户取消、超时和 connection close。每个 server request 恰好回复一次成功或稳定错误，并从该 renderer client 的 server pending 表移除。

如果后端可能把交互 request 发送到错误 connection，或者 request 缺少 connection/领域 identity 无法确定 owner，属于协议冲突；不能广播给所有窗口。

## Connection 状态

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Acquiring
    Acquiring --> Initializing
    Initializing --> Ready: initialize 成功并发送 initialized
    Acquiring --> Failed: acquisition 或 transport 失败
    Initializing --> Failed: handshake 或 capability 失败
    Ready --> Closing: renderer dispose、transport 丢失或 process exit
    Closing --> Closed
    Failed --> Closed
    Closed --> Acquiring: 明确创建新 connection
```

`Ready` 前的调用等待同一个 ready promise。初始化期间到达的已知 notification/server request 按协议读取和暂存；reader 不能被 ready gate 阻塞。close 先拒绝新 request，再停止 transport、拒绝 pending、结束资源并清空 handler。restart 创建新代次，旧 pending、resource ID 和消息不能进入新 connection；修改 request 不自动重放。

## 文件与编辑状态

app-server 不取代前端 file service、text model 或 working copy。后端拥有落盘修改；前端继续拥有打开文件、dirty buffer、保存、reload 和外部变更冲突。

- 后端写盘后由文件监听进入前端 file service，再更新未 dirty 的 model。
- dirty model 遇到后端磁盘变化时进入明确的外部变更或保存冲突状态。
- approval request 可以展示计划修改，但不能成为唯一冲突检测。
- 如果现有 file service 无法保证 dirty 冲突，或后端要求直接修改前端内存 model，立即停止并询问用户；adapter 不建立双写同步层。

## 产品装配

`src/code/electron-main/app.ts` 只创建 starter/relay、绑定应用生命周期并注册 connection acquisition channel。renderer main entry 注册 `localAgentHostService`、唯一 protocol client 和各真实领域 adapter；Thread 进入 Agents Window 时再由 Sessions entry 注册 Provider。装配文件不解析 JSON、不转换 DTO、不实现领域 switch，也不保存领域状态。
