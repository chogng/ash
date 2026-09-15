# ash-rs 共享后端与统一对外层

> 当前基线：[领域模型](domain-model.md)、[Core](core.md)、[协议](protocol.md)与 [App Server API](ash-app-server-api.md)。
> Agent 自定义对象与外部生态反腐化层见
> [`agent-customizations.md`](agent-customizations.md)。
> 各 crate 的当前 public/private interface、调用图与修改路径以对应 README 为准。

## 快速理解

`ash-rs` 是多个产品共享的 Rust 后端；Core 只是其中的执行控制面。协议、存储、配置、模型、工具和
产品接口各有独立边界，不能都塞回 Core，产品宿主也不应反向放回这里。

| 想知道什么 | 直接答案 | 从哪里继续 |
| --- | --- | --- |
| 哪些状态由 Rust 权威拥有？ | Session、Thread、Turn、工具生命周期、配置与持久化事实 | [核心](#4-核心) |
| Desktop、`ash-code` 和其他 Agent 客户端如何调用？ | 统一经过 App Server API，不链接 Core、Store 或 Provider | [对外接口](#8-app-server) |
| protocol、history、Core 和 storage 有什么区别？ | 分别拥有共享事实、持久化记录形状、状态协调和物理读写 | [Protocol 边界](#3-protocol-边界)、[存储](#5-存储端口与物理存储) |
| 为什么有这么多 crate？ | 按可独立验证的责任拆分，不按功能名称堆成通用 service | [crate 边界](#2-crate-边界) |
| 具体函数和修改路径在哪里？ | 进入对应 crate README，系统文档不复制私有实现 | [文档规范](documentation-guidelines.md) |

## 1. 共享后端职责

`ash-rs/` 是共享 Rust 后端，`ash-rs/core/` 是领域运行时。它负责：

- Session、Thread、Turn、ThreadItem 的 reducer、命令与恢复；
- Agent/model/tool 执行编排；
- persisted Thread history contract、typed SessionStore/ThreadStore 与 SQLite adapter；
- Config、Credential、sandbox 与 resource；
- App Server、client、transport；
- Rust、TypeScript 与 JSON Schema contract tests。

Desktop UI、Electron IPC、`ash-code` 的 TUI 宿主和第三方网页 UI 不属于共享后端。

## 2. crate 边界

```text
ash-rs/
├── protocol/             # canonical shared domain contract
├── external-agent-migration/         # external Agent ecosystem discovery, bounded parsing, and import plan
├── tools/                # target host-side tool types, interfaces and pure adapters
├── shell-command/        # concrete approved-process executor
├── file-system/          # concrete read-only filesystem executor
├── file-search/          # directory path fuzzy search + CLI
├── codebase/             # 目录代码事实、存储接口、检索融合与复核
├── codebase-store/       # Codebase SQLite 表、迁移、查询与记录映射
├── cloud-codebase/       # 可选云端语义增强、授权、同步与删除恢复
├── slash-commands/       # headless catalog, input grammar and interaction state
├── slash-launcher/       # product-selected list composition, slash query and selection state
├── file-watcher/         # shared filesystem invalidation hints
├── state/                # Profile DB、SQLite Thread authority、迁移、目录索引与跨进程锁
├── git/                  # bounded Git repository operations and structured parsing
├── diff/                 # shared bounded line/inline diff mapping for Desktop and TUI
├── syntax/               # bounded incremental tree-sitter analysis；不拥有文件、索引或 presentation
├── terminal-detection/   # host terminal identity/color capability 与 background fallback interpretation
├── theme/                # shared manifest/user-theme resolver 与 device-local bounded loader
├── editor-core/          # 纯 Rust text transaction / selection / history；不拥有 presentation 或 transport
├── text-file/            # UTF-8 文件保存基线、磁盘版本与外部变化冲突；不拥有 editor 或 I/O
├── markdown/             # shared bounded CommonMark/GFM parsing；presentation 位于 app/
├── lsp/                  # LSP stdio lifecycle、request pairing、document sync 与 server events
├── lsp-server-provider/  # 内置 server、可信 executable resolution 与 availability；不启动进程
├── lsp-manager/          # 产品级 LSP 启停、文档路由、请求 facade 与 stale-result gate
├── install-context/      # runtime install method, package layout and resource candidates
├── apply-patch/          # concrete validated write executor
├── history/              # model-history + persisted Thread record domain types
├── thread-store/         # Thread persistence port + append/page validation
├── context-engine/       # provider-neutral context budget、token measurement 与边界判定
├── memories/             # 用户控制的长期 Memory、作用域、读写、引用和存储 port
├── core/                 # reducers, coordinators, execution policy and recovery
├── core-api/             # model, Hooks, policy and host contracts without Core execution
├── rollout/              # local state repository + recovery composition（crate 名待清理）
├── rollout-trace/        # read-only export, diagnostics and evaluation artifact
├── app-server-protocol/  # external RPC wire contract + generators
├── app-server-transport/
├── app-server-client/
├── app-server/
├── queue/                # 持久用户消息队列、租约和交付恢复
├── features/             # 功能身份、阶段、默认值和用户覆盖
├── diagnostics/          # 有界无内容诊断快照
├── analytics/            # 默认关闭的固定使用计数
├── feedback/             # 用户审阅并确认后的诊断上传
├── build-info/           # 版本、commit、target 和 build identity
├── process-hardening/    # 产品入口的 dump、debug attach 和 loader 环境保护
├── config/
├── secrets/              # provider-neutral secret persistence primitives
├── login/                # target interactive account-login control plane
├── chatgpt/              # native ChatGPT subscription OAuth and authenticated target
├── model-provider-config/
├── model-provider/
├── ash-api/
├── http-client/           # shared outbound network policy + unary/streaming HTTP substrate
├── websocket-client/      # provider-neutral WebSocket handshake/message transport
├── ash-client/           # API operation retry 与 SSE framing layer
├── arg0/                  # shared internal helper dispatch
├── exec/                  # target headless Agent runner
├── tool-executor/         # target local process execution boundary
```

产品宿主不属于共享后端：`app` 的 `zui`、`ash-ui-components`、`ash-workbench`、renderer、`wgpu` 和 `winit` 位于
`app/` 的直接子 crate；`ash-code` 的 `ash-cli` 与 `ash-tui` 位于 `ash-code/`。它们仍加入同一个
根 Cargo workspace，但 ownership 由物理目录和依赖方向表达。

当前 `exec/` 仍实现 process `ToolExecutor`。它迁移为 `tool-executor/` 后，`exec/` 名称用于
[`exec.md`](exec.md) 定义的 headless Agent runner；迁移完成前不能把目标目录注释理解为现状。

不建立职责含糊的 `common`、`service` 或总括式执行 crate。Agent loop 先在 Core 内按模块
分层；只有具备第二个真实消费者、独立 typed port 与测试 vertical slice 时才提取 crate。

`ash-git` 当前拥有系统 Git 进程身份、仓库发现、porcelain-v2 快照、分支/远端/ bounded graph 查询、
类型化暂存/取消暂存/丢弃/提交/获取/拉取/推送以及补丁检查与应用；不拥有实时仓库注册表、
监听状态、App Server 线协议或 Desktop SCM。
Git 状态/修改适配器、工作区范围运行时、监听失效/版本通知与 SCM View 已在各自层实现；
它们不改变 `ash-git` 的 crate 所有权。当前 API 和失败语义见
[`git/README.md`](../ash-rs/git/README.md)，跨层状态见 [`git.md`](git.md)。

`ash-diff` 当前拥有 Native 与 TUI 共享的 bounded text diff：精确 line ending、Myers 行映射、
Unicode 字素级内联范围、Git-style hunk、比较策略、取消和资源上限；不读取文件、不调用 Git，
也不拥有 Editor/TUI presentation。当前 API、失败和修改影响见
[`diff/README.md`](../ash-rs/diff/README.md)。

`ash-slash-commands` 当前拥有 App Server、TUI 与 Native 共享的无渲染命令 catalog 校验、
local/server origin、输入 grammar、匹配、选择、dismiss、滚动、补全与 submission parsing；它不执行
命令、不读取 config，也不依赖任何 renderer。Desktop 通过 generated protocol types 与共享
conformance fixture 保持语义一致。跨产品边界见 [`slash-commands.md`](slash-commands.md)，当前 API
和失败语义见 [`slash-commands/README.md`](../ash-rs/slash-commands/README.md)。

`ash-slash-launcher` 当前拥有产品选择列表的无渲染组合、首个 `/query` token、跨列表匹配、选择和
dismiss 状态。它不认识 Slash Command、Skill、业务 target、handler、protocol 或 renderer；产品把
各领域对象投影成列表，并用返回的 `(list_id, item_id)` 解析自己的 typed binding。当前三个产品尚未
迁移到该 crate。跨产品分层见 [`slash-commands.md`](slash-commands.md)，实现契约见
[`slash-launcher/README.md`](../ash-rs/slash-launcher/README.md)。

`ash-syntax` 当前拥有 Rust、JSON、JSONC 与 Shell 文档的有界增量 tree-sitter parse、revision binding，以及
syntax token、folding range、document symbol 和 parse diagnostic snapshot。它不读取文件、
不监听目录、不保存符号索引，也不依赖 legacy editor runtime、`ash-editor` 或 `ash-lsp`。它是
Rust `ash-editor` 内部组合的底层分析 crate，不是 App Server 产品 API。跨编辑器
所有权与演进阶段见 [`syntax-analysis.md`](syntax-analysis.md)，当前 API 和修改路径见
[`syntax/README.md`](../ash-rs/syntax/README.md)。

`ash-codebase` 当前拥有获准 `Dir` 内的 ignore-aware scan、syntax-assisted/fallback
chunking、stable revision/chunk identity、local SQLite generation 与 FTS5 retrieval。它消费
`ash-syntax` declaration facts，但不把 directory lifecycle 下沉给 parser；App Server 拥有 watcher、
profile placement 和 RPC state。跨层隐私与云端边界见 [`codebase.md`](codebase.md)，实现契约见
[`codebase/README.md`](../ash-rs/codebase/README.md)。

`ash-codebase` 当前拥有目录扫描、切分、revision/identity、本地全文与符号数据、可选设备内模型
向量、候选融合、当前源码复核和 byte budget。`ash-cloud-codebase` 只消费它复核后的 exact chunks，
完成可选云端语义索引与查询，并持久化 grant、远端身份、generation 和删除恢复状态。具体 contract 见
[`codebase/README.md`](../ash-rs/codebase/README.md) 与
[`cloud-codebase/README.md`](../ash-rs/cloud-codebase/README.md)。

`ash-theme` 当前嵌入 Desktop registry 生成的语言中立 manifest，严格解析图形界面用户主题 JSON、别名、变换和默认值依赖，并以 Rust GUI 从 `config.toml` 根级 `[gui]` 解释出的选择值与 `themes/*.json` 产生 Rust 桌面端快照。它不依赖 renderer、不拥有组件 geometry；Ash Code TUI 的主题由 `ash-tui` 独立拥有，只解释 `[tui]` 并读取 `ash-code/themes/*.json`，不消费该 manifest。当前 API、失败语义和 conformance contract 见 [`theme/README.md`](../ash-rs/theme/README.md)。

`ash-editor` 当前拥有 `app` 使用的多行编辑、caret/selection、undo/redo、IME、language-aware
syntax lifecycle/projection、普通文档结构折叠、viewport soft wrap 与 source/visual row 映射、代码视口绘制、retained `DiffEditorDocument`、复用两个 CodeEditor pane 的 side-by-side DiffEditor，以及纵向组合
多个文件 section 的 MultiDiffEditor；它依赖
`ash-ui-components`、`ash-diff` 和 `ash-syntax`，但不依赖 `app`，也不拥有文件 Tab、平台事件、EditorHost 或
TUI presentation。当前 API、接入义务和限制见
[`editor/README.md`](../app/editor/README.md)。

`ash-editor-core` 当前拥有不依赖 renderer 或 transport 的纯 Rust document transaction vertical
slice：UTF-16 selection、revision-bound atomic multi-edit、bounded undo/redo 和 snapshot。`app`
的 `CodeEditorDocument` 是当前真实消费者，以 persistent core 持有 committed text/history/revision，app text
projection 仅供行索引、syntax、folding 与绘制使用。Ash Stanza 是独立的 TypeScript Browser editor，拥有自己的
PieceTree、transaction、history、selection 和 tracked ranges；它只异步消费 Rust file/language/workspace service，
不通过 WASM 或 App Server shadow document 调用 `ash-editor-core`。跨运行时边界见
[`editor-core.md`](editor-core.md)。

`ash-text-file` 当前拥有与编辑器实现无关的 UTF-8 文件生命周期：保存文本基线、磁盘版本、
只读状态、dirty/reload/conflict 分类、乐观保存 payload 与待处理外部 snapshot。它不读取或写入
文件、不拥有 mutable editor text、Tab、关闭确认或 presentation。`app` 把 active
`CodeEditorDocument` 的当前文本交给该领域模型，并通过 App Server 的独立文件能力执行 I/O；
Native 拥有关闭确认和 reload/conflict 操作条，而显式覆盖请求仍使用待处理外部 snapshot 的版本
执行乐观 preflight，磁盘再次变化时不会无条件写入；
当前 API、失败语义和接入义务见
[`text-file/README.md`](../ash-rs/text-file/README.md)。

`ash-markdown` 当前拥有有资源上限的 CommonMark/GFM parsing、只读文档 snapshot、富文本与
block layout 和 app presentation，并消费 `ash-ui-components::ScrollState`；它依赖 `ash-ui-components`，但不依赖
`app`，也不拥有消息 identity、网络图片、链接激活、平台输入或持久化。当前 API、
信任边界和限制见 [`markdown/README.md`](../app/markdown/README.md)。

`ash-lsp` 当前拥有单语言服务器的 stdio/async transport、initialize gate、typed request
pairing、deadline cancellation、文档同步版本、push diagnostics 与规范关闭；宿主路由层另外
把一个 language ID 绑定到一个 initialized client，保存 editor revision / server incarnation /
document version，并在显式 replacement 时重放当前全文。它不依赖 `ash-editor` 或 app host，也不拥有
server discovery、安装、directory 配置、restart policy 或 UI projection。
它会上报规范关闭之外的 transport-close 事实；`ash-lsp-manager` 用 generation/server epoch
隔离旧实例，拥有断连 route retirement、有限指数退避、crash-loop gate 和 authoritative snapshot
重放。跨层所有权与当前阶段见 [`lsp.md`](lsp.md)，当前 API 和修改路径见
[`lsp/README.md`](../ash-rs/lsp/README.md)。

`ash-lsp-manager` 把 fresh diagnostics 转换为 product-neutral UTF-8 document ranges；app
adapter 只负责转换到 `CodeEditorDiagnostic` 并按精确 editor revision 选择缓存，CodeEditor 自己
完成跨行、soft-wrap 波浪线与命中，Desktop 在命中后绘制 hover detail。任何 LSP 类型进入 editor
crate，或 app 重新计算波浪线 geometry，都表示该边界发生漂移。

`ash-lsp-server-provider` 当前拥有内置 Rust、JSON/JSONC、Shell server identity、
Automatic/Enabled/Disabled preference、execution policy gate、冻结 PATH candidate 校验、canonical
executable 和 availability；App Server Config authority 分别持久化 mode/path，Desktop Settings UI 为三个
server 保留独立 draft，并只提交 revision-safe typed command，
再把权威 snapshot 映射进 resolver，并将 definition 交给 `ash-lsp-manager`。它不启动进程、不决定目录 capability，也不
读取编辑器文档。crate contract 见
[`lsp-server-provider/README.md`](../ash-rs/lsp-server-provider/README.md)。

`ash-plugin` 拥有 Plugin identity、manifest、path 与 package observation；`ash-core-plugins` 统一拥有
来源聚合、本地 staging、整包 digest 复核、immutable artifact、安装/update/uninstall、authority、lease
与 opaque resource。Language 不再拥有第二套 distribution
storage；App Server 的本地 Language adapter 只把 Manager-verified capability handle 组合进 Extension
catalog 和 `LspServerProviders` provider collection，下载、安装与激活所有权仍然分离。

`ash-lsp-manager` 当前位于产品宿主与 `ash-lsp` 之间，拥有显式 enablement、resolved
definition 消费、非阻塞文档/request API、editor revision / LSP version freshness、位置编码转换、
server generation 和 supervisor thread 生命周期。`app` 已把文件 open/change/save/close、directory
change、hover/completion/definition 和事件循环接到该层；PATH 中存在有效内置 server 时启用
对应 route；config generation 变化时 app 重建服务并重放全部打开文档。它不读取文件、不依赖
`ash-editor`、不发现 executable，也不绘制 UI。crate contract 见
[`lsp-manager/README.md`](../ash-rs/lsp-manager/README.md)。

`ash-ui-components::ScrollState`、`ScrollMetrics`、`ScrollView` 与 `ScrollbarController` 提供
domain-agnostic logical-pixel offset、clamp、viewport clip、内容坐标、同源 scrollbar
paint/hit/track-page/thumb-drag geometry，以及 hover/active/fade deadline。MultiDiffEditor
复用这套基座；平台 wheel normalization、pointer capture，以及 Terminal scrollback 的距底部
行偏移、输出增长锚定和 alternate-screen 分流仍由 `app` 拥有，不能迁入通用 ScrollView。

组件到 GPU 的依赖方向固定为 `ash-ui-components Component → zui::UiScene → Renderer → concrete backend`；
`UiScene` 通过 `SceneBatch` 保留跨 primitive 的真实绘制顺序。`zui` 不依赖组件 crate、窗口系统或
wgpu，`ash-ui-components` 只向下依赖 `zui`；`app` 只保存
`dyn Renderer`，当前具体类型只在 composition-root adapter 中选择。Native 的 interaction 与
accessibility frame 不进入 renderer。完整所有权、后端替换路径和架构约束见
[`app/docs/rendering-architecture.md`](../app/docs/rendering-architecture.md)。

Direct-provider credential ownership 由 [`model-provider.md`](model-provider.md) 维护；通用 secret
persistence 由 [`secrets.md`](secrets.md) 维护；interactive login control plane 由
[`login.md`](login.md) 维护。目录模型不创建统一 credential/OAuth crate，也不让 Core、API 或
network client 读取 secret store。

ChatGPT 订阅通过 [`chatgpt-subscription.md`](chatgpt-subscription.md) 接入：`ash-chatgpt` 在本机执行 device OAuth、refresh 与 SecretStore persistence，并向 `ash-model-provider` 提供 fresh authenticated target。完整 Agent loop 继续由 Ash Core `TurnExecutor` 持有。产品 composition 使用 exact ModelRef 对应静态 row 的 `runtime = chatgpt_subscription` 选择 target，不会由“已登录”隐式切换模型。

## 3. Protocol 边界

Canonical 产品模型、command/event/update/request 的分类、ID/cursor 语义、当前缺口和后续迁移
统一由 [`protocol.md`](protocol.md) 维护。本文件只规定 crate 依赖关系：
`ash-protocol` 是纯共享值层，Core、store、provider adapter 与 App Server wire 可以依赖它，
它不能反向依赖这些执行或 I/O crate。

工具 host contract、registry/binding、executor interface、MCP/dynamic conversion、tool search、
Plugin discovery、code mode 与图片精度由 [`tools.md`](tools.md) 维护。`ash-tools` 复用 protocol
identity/content，不拥有 Core 调度、MCP session、Plugin authority 或 provider wire。

## 4. 核心

Core 的完整 ownership、执行组件、ports、并发与恢复规则统一由
[`core.md`](core.md) 维护。本节只保留共享运行时约束。

ThreadController 通过纯 reducer 维护可重建 Thread 状态：

```text
stored event + previous snapshot → next snapshot
```

live commit 与 recovery 必须调用同一 reducer。副作用顺序固定为：

```text
validate command
→ build typed events
→ append atomic batch
→ update in-memory projection
→ publish update
```

append 失败时不能暴露未提交状态。

ThreadController 只序列化一个 Thread 的执行历史。membership、lineage 与 lifecycle 都由 Thread
事实表达；不同 Thread 可并行，不存在 Session sequence。

## 5. 存储端口与物理存储

`ash-history` 拥有模型历史中已经落地的 persisted Thread record：`StoredEvent`、exact
`ThreadCommandReceipt`、event ID、时间戳和 schema version。它是纯数据 contract，不提供 Store，
也不建立第二份 history authority。具体契约见
[`history/README.md`](../ash-rs/history/README.md)。

`ash-thread-store` 拥有 storage-neutral Thread Store trait、完整恢复/追加请求、atomic batch
validator 与错误。Core 依赖 history 类型和该 port，不依赖本地文件实现。Store 细节见
[`thread-store/README.md`](../ash-rs/thread-store/README.md)。

`ash-state` 提供 `SqliteThreadStore`，打开 `state.sqlite3` 并负责：

- `BEGIN IMMEDIATE` 下的 sequence compare-and-set；
- batch/event identity 唯一性；
- typed envelope JSON 与可查询 identity/sequence 列的原子提交；
- foreign key、WAL、`synchronous=FULL` 和 bounded busy timeout；
- component-scoped schema version gate。

SQLite 中的 Thread stream 是物理 authority。旧 JSONL stream、
tail-recovery 和 rollout adapter 已退出执行路径；开发期不保留双写或自动 import。

`ash-rollout` 中公开的 `LocalStateRepository` 组合 SQLite Thread store 与 writer lease，负责从
一个 profile root 恢复可运行的 `ThreadController`。crate 名仍是历史命名，不能据此重新引入
rollout 文件格式。App Server 的本地 composition root 只依赖该 repository，不重复恢复流程。
具体打开与恢复顺序见 [`rollout/README.md`](../ash-rs/rollout/README.md)。

`ash-rollout-trace` 枚举 Thread store 并按 `session_id` 生成只读、可序列化的 Session tree
trace。它适合诊断、导出和评测，但不是 authority，也不能成为执行输入。它保留各 Thread 的
sequence，不制造 Session 全局顺序。trace 可能携带用户输入、工具参数和结果，因此
crate 不提供默认文件写入；持久化或上传必须由调用方显式施加脱敏、访问控制和保留期策略。
实现与 privacy obligation 见
[`rollout-trace/README.md`](../ash-rs/rollout-trace/README.md)。

当前开发期只读当前 Thread SQLite schema。旧 JSONL、独立 Session event、kind/payload
upcast 和 sidecar ledger 不进入执行路径。旧 Config DB 正文只在 component v1→v2 时一次性迁出
为 TOML，迁移后不再读取。

Config transaction metadata 也在同一 profile 数据库中，通过独立 component migration 与表维护
revision/generation/receipt contract；desired document 的唯一 authority 是 profile
`config.toml`，SQLite 只保存 digest 与事务元数据。目录中的 `.ash/config.toml` 是严格、
只读的 scoped intent，不是用户级数据库的替代 writer。

## 6. Sequence 与并发

Sequence、cursor、ID 和 optimistic concurrency 的领域语义统一见
[`protocol.md`](protocol.md#5-sequencecursor-与-id)。存储实现必须为每个 aggregate
提供独立 writer lease，使不同 Thread 可以并发且不会占用 Session revision。

Fork 在 Session lineage 中保存 `parentThreadId + parentSequence`。该 parent sequence 是一个
不可变历史锚点，不是另一套物理日志计数。

创建/fork Thread 使用可恢复 saga：

```text
Session plan(creating)
→ Thread create
→ Session attach(active)
```

## 7. 类型化命令重放

Command identity、receipt 和 replay 规则统一见
[`protocol.md`](protocol.md#41-command请求改变状态)。store adapter 负责把
typed receipt 与首个业务 event 原子提交，reducer recovery 恢复稳定结果；Config authority
沿用相同模式。Config、Plugin、MCP 与 Skill 的 authority 分布、snapshot reconcile 和 safe-point
组合由 [`config.md`](config.md) 统一规定。

## 8. App Server

`ash-app-server-protocol` 直接引用语义完全一致的 canonical Session/Thread/Turn/ThreadItem、
events 和 updates，只为真正 wire-specific 的 params/result/error 定义 DTO。
Registry/generator 实现见
[`app-server-protocol/README.md`](../ash-rs/app-server-protocol/README.md)。

`ash-app-server` 负责：

- initialize、protocol version 与版本化 capability advertisement；
- method dispatch；registry 解析 global/Session/connection-resource serialization scope，App Server
  通过跨 connection FIFO/shared-read scheduler 执行；
- connection subscription cursor；
- `session/changed` / `session/thread/update`；前者只提示重新读取派生树，不携带 durable sequence；
- Resource ownership；
- Core error 到 stable RPC error 的映射。

它不重建旧事件、不运行 reducer、不推断领域状态，也不拥有持久化模型。
当前 dispatch、broker、resource 与 local composition 见
[`app-server/README.md`](../ash-rs/app-server/README.md)。

## 9. 客户端与传输

```text
ash-exec / TUI
  → app-server-client::AppServerSession
  → request handle + event stream
  → App Server dispatcher

Desktop
  → generated TypeScript contract
  → JSONL / stdio
  → App Server dispatcher
```

Rust `app-server-client` 是本地 App Server 的共享宿主层：负责启动、initialize、请求/事件
channel wiring 和显式 shutdown，详细边界见
[`app-server-client.md`](app-server-client.md)。进程内 typed channel 是性能优化，不是语义
捷径；Rust 本地路径与 Desktop JSONL 路径都必须经过 typed request/response、initialize、
dispatcher 和 notification contract。对于 `Session`、`Thread`、`Turn`、`ThreadItem` 产品能力，
App Server 是唯一外部进入/输出边界；外部程序与远程 Ash 使用同一份 App Server 契约，
不再提供 MCP Agent-as-tool 接口。

`app` 当前的 Rust 进程内直接组合只覆盖终端/PTY 宿主。它不能把该宿主路径扩展成 Agent
产品的 Core 旁路；Native Agent 能力必须复用同一个 App Server 契约和分发器。

产品 Session、App Server connection session 与 terminal session 是三种不同生命周期，命名
时必须带领域限定。

## 10. 无界面 exec 与远程执行

`ash-exec` 是无交互 Agent runner，负责 run-once、机器输出、terminal outcome 和未来 scheduler
worker adapter。它只通过 App Server Client 工作，不依赖 Core、store、provider、sandbox 或
process executor。完整架构见 [`exec.md`](exec.md)。

底层 process execution 已从原同名 crate 迁移为 `ash-tool-executor`。未来
`ash-exec-server` 只负责远程 process/PTY/filesystem execution，不能接收 Agent
`session/request`。Remote Agent scheduling 与 remote process execution 使用不同 protocol、
identity、lease 和 disconnect 语义。

## 11. 验证

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
corepack pnpm --dir ash-ts test:main
corepack pnpm --dir ash-ts typecheck:renderer
```

协议变更还必须重新生成并提交 JSON Schema、TypeScript 与 Desktop 同步产物。
