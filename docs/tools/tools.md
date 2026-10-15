# 工具系统

> 计划物理位置：`crates/tools/`
> Rust crate：`ash_tools`
> 当前状态：T1 主链完成，T2 MCP/dynamic 主链完成；MCP host runtime 已提取到 `ext/mcp`。T3 的
> Tool Search、capability-bearing extension、Connector discovery projection、Plugin catalog projection 与
> typed discovery request 已接入共享契约；`ext/web-search` 已提供默认关闭、宿主注入 backend 后才注册的
> `web_search` 工具。Tool Call 已持久化 registry
> generation、definition digest、source chain 与 direct/code-mode caller；Tool Result 已能持久化结构化
> 图片内容。Code Mode 已完成 exec/wait、V8 cell runtime、durable nested-call broker 和可选 stdio Host；
> Plugin local content store 已落地，但安装 authority、activation、grant，以及 dynamic owner 断连后的持久化重启
> 端到端 fixture 仍未完成。
> Canonical value 与 durable Tool Item：[`protocol.md`](../protocol.md)
> Core 调度、approval 与恢复：[`core.md`](../core.md)
> MCP client runtime：[`mcp.md`](../mcp.md)
> Plugin authority：[`plugins.md`](../plugins.md)
> Config 与 runtime snapshot：[`config.md`](../config.md)
> Provider wire adapter：[`ash-api.md`](../ash-api.md)

## 快速理解

工具系统把本地工具、MCP 和动态来源转换成统一、可验证的能力目录；它定义和绑定工具，但最终
授权、执行顺序与持久化仍由相邻系统负责。

本文统一维护架构、业务能力工具集、产品组合、范围和执行契约，并分别标明当前实现与待实现规则。
逐项名称、用途、执行归属与可用条件只维护在[完整工具目录](tool-catalog.md)。

| 读者首先会问                     | 直接答案                                                                                                             | 深入阅读                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 不同来源的工具为什么能统一调用？ | 每个来源先转换成统一定义、规格、绑定和调用值                                                                         | [三层工具契约](#3-三层工具契约)                |
| 工具名称就是执行身份吗？         | 不是；稳定身份还包含来源、绑定和快照 generation                                                                      | [身份、来源与绑定](#5-身份来源与绑定)          |
| 工具如何按业务能力分组？ | ToolSet 声明可复用的工具成员，产品组合选择集合，Scope 冻结本轮名单 | [业务分组原则](#65-业务能力工具集与产品组合)、[目标集合](#66-业务能力工具集目标) |
| Agent 当前能看到和调用哪些工具？ | 冻结范围限制目录与调用，暴露方式决定何时加载；实时授权仍可拒绝操作 | [Scope 计算](#74-scope-计算与调用约束)、[生命周期](#73-安全点与排空) |
| 哪些集合默认启用，哪些按需选择？ | 当前 Profile 仅有单一 sets；Tasks 拆分、默认／可选分离及待补集合属于目标规则 | [产品组合](#75-产品组合与接纳规则)、[默认与可选](#默认启用与可选组合) |
| 如何检查实例实际注册的工具？ | 命令面板打开只读目录快照；它不等于某个 Turn 的实时权限 | [查看工具目录](#174-查看工具目录与范围诊断) |
| 谁决定工具能不能执行？           | 权限系统决定授权；Core 调度；工具执行器落实调用                                                                      | [当前本地工具来源](#41-当前本地工具来源运行时) |
| 当前完成到哪里？                 | 统一 registry/executor/search、durable provenance、结构化图片和 Code Mode 主链已落地；Plugin 安装 authority 尚未完成 | [当前仓库审计](#2-当前仓库审计)                |

## 1. 结论

`ash-tools` 是 Ash 工具子系统的共享类型与纯适配层。它定义一个工具如何被描述、暴露、搜索、
绑定、调用和返回结果，并提供 MCP、dynamic tool、code mode 与图片精度等跨模块转换能力。

它解决的是：

```text
不同工具来源
  local / MCP / dynamic / connector / future extension
            │
            ▼
统一 host-side ToolDefinition / ToolSpec / ToolBinding
            │
      registry + search + adaptation
            │
            ▼
ToolInvocation ──► ToolExecutor ──► ToolExecutionOutcome
            │
            ▼
Core durable Tool Call / Tool Result lifecycle
```

长期职责固定为：

- provider-neutral 的 `ToolDefinition`、`ToolSpec`、schema 和 exposure 类型；
- model-emitted `ToolCall` 到 host-materialized `ToolInvocation` 之间的共享值；
- executable tool 的 `ToolExecutor` / `ToolOutput` 接口；
- immutable `ToolRegistrySnapshot`、binding、definition digest 与来源信息；
- MCP descriptor/result 到 Ash 工具值的纯转换；
- dynamic tool definition/result 的校验与转换；
- deferred tool loading、tool search 索引和值类型；
- Plugin/Connector 发现结果和 install/enable/connect 请求的纯展示值；
- code mode 的工具定义投影、命名、nested-call/result 适配；
- tool output image 的 detail capability 检查、标准化和降级；
- schema、输出、日志预览和 provider capability 的共享校验规则。

`ash-tools` 不拥有：

- model → tool → model loop、approval、并行计划、retry 或 `UnknownOutcome` 决策；
- Thread/Turn reducer、durable append、Tool Call/Result commit 或 recovery；
- MCP transport、JSON-RPC session、process supervision、OAuth 或 reconnect；
- Plugin 安装、启用、grant、版本、digest、Extensions 或 package store；
- local tool、MCP server、browser、terminal 或 code-mode runtime 的具体 I/O；
- sandbox、filesystem/network enforcement、credential materialization；
- provider HTTP DTO、Responses API/Anthropic wire encoding；
- App Server connection owner、interaction delivery 或客户端 UI。

一句话边界：

> `ash-tools` 统一“工具在 host 中是什么以及如何跨表示转换”；Core 决定“何时、按什么策略调用”；
> source runtime 决定“如何完成具体 I/O”。

## 2. 当前仓库审计

当前已有可复用地基：

- `ash-protocol` 已定义 `ToolName`、`ToolCallId`、`ToolDefinition`、`ToolCall`、`ToolResult`、
  `ContentPart`、`ImageDetail` 和 durable `ThreadItem::ToolCall/ToolResult`；
- `ash-protocol` 已定义 `DynamicToolSpec`、`DynamicToolCall`、`DynamicToolResponse` 和对应
  Agent interaction；
- `ash-core` 已定义 `ToolService::prepare/execute` port，并完成 policy-gated、可恢复的顺序
  model → tool → model vertical slice；
- `ash-core::ContextAssembler` 已能重建 Tool Call/Result pairing；
- `ash-api` 已分别把 canonical function tool 和图片 detail 转成 OpenAI Responses、
  Chat Completions 与 Anthropic Messages wire payload；
- `ash-shell-command` 与 `ash-apply-patch` 各自提供独立 executor；App Server 的 direct
  `LocalToolSuite` 唯一提供 Agent 可见的 `read_file`、`write_file`、`edit`、`grep` 与 `glob`，三者
  共同接入 durable facts、policy authority、streaming output 与统一 registry；legacy
  operation-enum `file-system` 只留给明确的非 Agent consumer；
- `ash-mcp` 的 tools-only catalog/binding runtime 与 `ash-mcp-extension` 的 host/Core adapter 已进入共享
  registry/search projection；client-hosted dynamic tool 已进入同一 approval、durable interaction、
  exact owner 与 unknown-outcome 链；
- `ash-extension-api::ReadOnlyToolContributor` 和显式声明 network/credential scope 的
  `CapabilityToolContributor` 已进入同一 registry/policy/runtime；当前 `skills-read` 走前者，
  `web_search` 走后者并要求 exact one-time approval。`ash-core-plugins` 已把验证后的本地 catalog 投影为不可执行的 discovery
  snapshot，`ash-tools` 已定义 generation-bound install/enable/connect request；`ash-core-plugins` 已能把
  local package stage、复验并原子 promote 到 content-addressed store，安装 authority 位于同一 crate；
- App Server 以 frozen `ToolBinding` 的 runtime key 执行，不再在执行阶段按 live tool name 猜 source
  service；model invocation 会同时冻结 definitions 与 generation-bound binder，hot reload 只影响后续
  model safe point，已绑定调用保留原 generation 和 policy 直到排空。
- Core 在 durable Tool Call 中保存 registry generation、definition digest、source chain 和 caller；恢复
  时 exact binding 不匹配会失败关闭，不会按同名新工具重放。Shell Turn 和 Code Mode nested call 也走
  同一绑定入口；
- Tool Executor、MCP 和 dynamic output 已转换为结构化 `ContentPart`，durable Tool Result 保留可选
  content，旧纯文本记录继续兼容读取；模型调用边界会再次按 provider capability 清理 `Original`。

当前剩余问题集中在尚未收口的跨边界能力，而不是再增加一套 registry：

- dynamic owner 断连已经 fail closed，但还缺“持久化后重启恢复”的完整 App Server fixture；
- Plugin/Connector 已有 typed discovery，Plugin manifest 可声明一个 Connector 到其 MCP contribution
  的绑定；`ash-connectors-extension` 统一拥有连接状态、Plugin 目录转换、SQLite authority 与认证编排，
  ready binding 已接入 MCP/App Server hot composition。local package store、OAuth/refresh/远端 revoke
  和产品连接入口也已落地；完整状态见 [外部服务连接系统](../connectors.md)。Plugin activation
  由 package authority 提供，不能用 executable registry 反向代替；
- `ash-web-search-extension` 已有 bounded request、executor、JSON HTTP backend 与 App Server opt-in 安装口；
  当前没有默认生产 Search provider 或 credential UI，宿主未注入 backend 时工具完全不可用；
- provider adapter 可能分别决定 namespace flattening、strict schema 和 image detail fallback；
- tool search、Plugin discovery 和 install request 容易被混成一个有隐式副作用的“发现服务”；
- Code Mode 已有确定性投影、exec/wait、V8 cell lifecycle、异步 broker 和可选 stdio Host。嵌套调用
  使用冻结 binding 并重新进入普通 ToolScheduler；Host/运行时异常不会重放可能已有副作用的调用。

后续扩展必须继续经过现有 `ash-tools` 窄共享契约和 App Server composition root，不能在 Plugin、
Connector、code mode 或 provider adapter 内另建可执行 registry。

本方案参考本地 `../codex/codex-rs/tools/` 已验证的提取方向：共享 definition/spec、MCP/dynamic
adapter、tool search/discovery、code-mode bridge、image-detail normalization 与 executor
contract 可以离开 Core。Ash 不直接照搬其中的 Responses API DTO 或 Core runtime context：
provider wire 继续属于 `ash-api`，durable scheduling/recovery 继续属于 `ash-core`。

## 3. 三层工具契约

工具系统固定分为三层：

| 层                         | Owner          | 典型类型                                                            | 生命周期                         |
| -------------------------- | -------------- | ------------------------------------------------------------------- | -------------------------------- |
| Canonical product contract | `ash-protocol` | `ToolName`、`ToolCallId`、durable Tool Item、dynamic interaction    | 可序列化、可持久化               |
| Host tool contract         | `ash-tools`    | `ToolDefinition`、`ToolSpec`、binding、invocation、output、executor | process-local 或 snapshot-scoped |
| Execution orchestration    | `ash-core`     | `ToolScheduler`、`ToolService` port、approval、retry、recovery      | Turn/operation-scoped            |

### 3.1 `ash-protocol` 继续拥有

- 所有跨进程和 durable identity；
- model output 中 canonical `ToolCall` 的语义；
- Thread transcript 中 Tool Call/Result 事实；
- dynamic tool 的 Agent request/response envelope；
- provider-independent message content 和图片 detail 枚举；
- App Server 客户端确实需要读取的稳定工具值。

`ash-tools` 不重新定义 `ToolName`、`ToolCallId` 或另一套 durable Tool Item。

### 3.2 `ash-tools` 拥有

- 比 model request DTO 更完整的 host-side definition/spec；
- schema normalization、definition digest 和 name/binding 规则；
- executor authoring contract；
- source-neutral registry、search、code mode 和 output adapter；
- 从 source-specific projection 到 host tool contract 的纯函数。

当前 `ash-protocol::ToolDefinition` 在迁移期保留为 model invocation 的最小 canonical value。
`ash-tools::ToolDefinition` 通过显式、可失败的 adapter 转成它。两者不能依赖同名 re-export
长期共存；迁移完成后应根据真实消费者选择以下一个方向：

1. protocol 类型明确命名为 `ModelToolDefinition`，host 类型保留 `ToolDefinition`；或
2. 如果完整 host definition 也确实需要跨进程共享，再将纯子集提升到 protocol。

不能用 `pub use` 假装两个不同生命周期的类型语义相同。

### 3.3 `ash-core` 继续拥有

- 当前 invocation 使用哪个 registry snapshot；
- model call 后的 schema/availability 校验时机；
- sequential/parallel plan；
- approval、deadline、cancellation 与 resource conflict；
- Tool Call intent 的 durable commit；
- result ordering、retry 和 uncertain outcome 的最终映射；
- completion 的 operation/incarnation 校验；
- next model invocation 与 Turn terminal decision。

Core 的 `ToolService` 是 consumer-owned port；它可以由外层 `ToolRegistryAdapter` 实现，但不能
被 `ToolExecutor` 取代。前者是 Core 的编排入口，后者是工具作者的执行接口。

## 4. 依赖方向与组合

目标依赖：

```text
                         ash-protocol
                               ▲
                               │ canonical IDs/content
                         ash-tools
                   shared types / pure adapters
                    ▲       ▲        ▲
                    │       │        │
          local tool owners  ash-mcp  code-mode adapter
      shell-command / App Server direct files / apply_patch
                    \       |        /
                     \      |       /
                      App Server composition
                     /       |        \
                    ▼        ▼         ▼
             Core ToolService  Plugin catalog  ash-api
                adapter        projection      provider wire
                    │
                    ▼
                 ash-core
```

允许：

- `ash-tools → ash-protocol`；
- `ash-core → ash-tools + ash-protocol`；
- `ash-mcp → ash-tools`；
- `ash-shell-command → ash-tools + ash-tool-executor + ash-sandboxing`；
- local App Server composition → `ash-install-context + ash-shell-command`；
- `ash-file-system → ash-file-access + ash-file-identity`；
- `ash-tui → ash-file-search`；后者提供只读路径索引，不依赖 `ash-tools`，也不注册为模型
  Tool；
- catalog/runtime manager 可依赖 `ash-file-watcher` 获取 coarse invalidation hint；后者不依赖
  `ash-tools`，不读取文件内容，也不注册为模型 Tool；
- `ash-apply-patch → ash-tools + ash-file-access + ash-file-system`；
- `ash-action-policy → ash-execpolicy + ash-sandboxing`；
- `ash-execpolicy` 不依赖 sandbox、Core、Tool 或配置 I/O；
- `ash-guardian-reviewer → ash-action-policy + ash-sandboxing`；
- 本地进程执行器只依赖 `ash-sandboxing` 契约；产品组合注入 `mxc-sandbox`，平台细节留在适配器；
- `ash-api → ash-tools + ash-protocol`；
- App Server 组合 Tool registry、source runtime、policy 和 Core port。

Sandbox backend 的内部调度、平台 crate 边界和 fail-closed 规则见
[`sandboxing.md`](../sandboxing.md)。这里的 sandbox manager 不是 Core `ToolScheduler`。
Action classifier、exact grant 与最终 execution decision 见
[`guardian.md`](../guardian.md)。

禁止：

```text
ash-tools → ash-core
ash-tools → ash-mcp live runtime
ash-tools → ash-core-plugins authority
ash-tools → ash-app-server
ash-tools → provider HTTP client
ash-tools → credential or secret store
ash-tools → ThreadStore / SessionStore
```

MCP adapter 的公开输入使用 `ash-tools` 自己的纯 `McpToolProjection`，不在 public API 暴露
某个 MCP SDK 的 wire DTO。`ash-mcp` 负责从当前 protocol revision 的 wire model 产生 projection；
`ash-tools` 负责从 projection 产生 host definition。这样 MCP SDK 升级不会迫使所有工具消费者
一起升级。

### 4.1 当前本地工具来源运行时

本地 Directory 的 Agent 工具由 App Server composition root 统一注册；模型侧只看到 canonical
direct 工具名，不看到基础库或 legacy operation enum：

| Crate / tool name                                                               | 可做的事                                                                                                            | 明确不做的事                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ash-shell-command` / `shell-command`                                           | 在批准的相对 Directory 工作目录执行显式 program/arguments；复用 `ash-tool-executor` 的 approval、timeout 和输出上限 | 不隐式启动 shell，不绕过 process policy                                                   |
| App Server `LocalToolSuite` / `shell-session`                                   | 启动长任务；读取输出、写入 stdin、等待退出、调整 PTY 和终止已有进程                                                 | 不允许其他 Session 或 Thread 操作该进程                                                   |
| App Server `LocalToolSuite` / `read_file`、`write_file`、`edit`、`grep`、`glob` | Thread-scoped 读后写入、conditional atomic 单文件写入和受控搜索                                                     | 不暴露 operation enum；断线恢复后必须重读才能恢复内存中的文件 fingerprint                 |
| `ash-file-system` / 非 Agent 基础库                                             | 提供 directory-scoped 条件写入与 host-only filesystem 能力                                                          | 默认 coding profile 不暴露 `file-system` 工具                                             |
| `ash-apply-patch` / `apply_patch`                                               | 预检后更新、添加、移动或删除普通文件；提交复用文件系统层的版本检查与单文件原子写入                                  | executor 不接受绝对/`..` 路径；移动目标必须不存在，父目录必须存在；多文件提交不承诺事务性 |

Agent 通过这两个命令工具执行 Git、测试和构建；Workbench 的 Git UI 通过 Git RPC 调用 Rust
Git 服务。通用命令工具不按 Git 子命令逐个注册，也不需要先打开可见终端。

执行器的 Environment 在构造时固定，要求它与 `ToolExecutionContext.environment_id` 一致；
工具注册表只接受与自身 `ToolDefinition` digest 相符的冻结 binding。host 根据当前 Session
和 Thread 的目录授权选定工作目录。短命令和长任务共用同一目录校验，免沙箱权限只改变执行
权限，不改变工作目录；显式 sandbox scope 必须与 host 选定的目录一致。
`apply_patch` 的 `parser.rs` 解析补丁，`file_update.rs` 根据上下文生成修改内容。
`@@ 上下文行` 从指定位置继续查找，`*** End of File` 限定片段匹配文件末尾，只有新增行的
更新片段追加到文件末尾。移动操作的源路径和目标路径都进入 host 的授权与策略检查。
文件系统层拥有三个编辑工具共享的换行、文件末尾和 EditorConfig 规则。

`apply_patch` 在所有 hunk、源文件版本与临时写入准备完成前不修改目标文件；
版本检查和提交使用与普通条件写入相同的目录锁。其他进程仍可修改文件，提交前再次检查版本。
若多文件 commit 中途失败，返回包含已完成路径的 `OutcomeUncertain`，由 Core 决定后续恢复语义。

`ash-file-system` 还提供 host-only 的 `find_nearest_ancestor_with_markers`，用于从一个本地路径
向上发现最近的项目 marker。它不是模型 Tool，不读取 marker 配置，也不施加 `DirectoryRoot`
containment；调用方仍拥有项目根语义和搜索边界。实现与错误策略由
[`crates/file-system/README.md`](../../crates/file-system/README.md) 维护。

搜索分成 Agent 内容搜索、编辑器内容搜索和交互式路径搜索：

| Surface                           | 所有权                                                                                    | 模型可见    |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| App Server `LocalToolSuite::grep` | Agent 内容搜索；调用公共 grep，由 `grep.backend` 在包内 `tgrep`（默认）与冻结 `rg` 间选择 | `grep` Tool |
| `ash-grep`                        | 共用结构化搜索；Current 用 rg，Indexed 默认用 tgrep；编辑器通过分页任务使用               | 否          |
| `ash-file-search`                 | ignore-aware 路径索引、fuzzy matching、`PathSearchHandle` 和 CLI                          | 否          |
| `ash-file-watcher`                | 多订阅者路径失效提示、missing-path fallback、throttle/debounce 与 overflow rescan hint    | 否          |

模型侧注册独立 `grep` 和 `glob` Tool。`grep` 默认请求 Indexed，由包内 tgrep 执行；公共配置 `grep.backend = "ripgrep"` 显式关闭索引，改为 rg 扫描并返回 Current。编辑器与 Codebase 使用同一 grep 服务：编辑器 Current 内容搜索始终用 rg，Codebase Indexed 文字候选默认用 tgrep。`glob` 由 file-search 的 Rust ignore-aware walker 枚举当前文件。选择理由和成本见[引擎分工](../search.md#rg-与-tgrep-的场景分工)；路径搜索契约由 [`crates/file-search/README.md`](../../crates/file-search/README.md) 维护。

[`ash-grep`](../../crates/grep/README.md) 通过内部 tgrep 适配器按仓库启动并持有上游 `tgrep serve --shared` 子进程，为各 Directory 注册独立 worktree 租约，通过其本机 TCP JSON-RPC 查询。普通目录与未提交的新仓库使用单目录服务。tgrep 自己维护 trigram 索引和文件监听。公共结果按路径排序，Agent 调用限定 100 个匹配行；Ash 文件工具写入后先由对应 worktree 的刷新接口确认处理，避免监听延迟；单目录服务使用 reload 确认。删除 worktree 前先等待已开始的搜索并释放目录租约。外部编辑仍遵循 tgrep 异步索引语义；正向 glob 直接筛选索引候选。Current、单文件和含未保存文档的内容查询由公共 grep 交给 rg，不创建 tgrep 会话。公共结果与 RPC 分页携带本次索引查询的计划和候选统计，具体过滤约定见 [`ash-tgrep`](../../crates/tgrep/README.md)。

运行时版本、源码和补丁校验值由 [`third_party/tgrep/runtime-lock.json`](../../third_party/tgrep/runtime-lock.json) 固定。开发准备与发布构建编译校验后的固定源码与补丁，统一放入 `ash-resources/tgrep/`；搜索期间不下载。普通关闭切回 `rg` 并保留磁盘索引；关闭并删除在配置提交后释放服务，再通过 State Runtime 的独占租约删除。旧 `fastRegex` 配置迁移为 `tgrep`，旧索引不读取，新索引使用版本目录。

`ash-file-watcher` 同样不是搜索或读取接口。它只把 OS mutation/error 转成
`PathsChanged`/`RescanRequired`；consumer 必须重新扫描并校验 own state。其 ref-count、路径匹配、
RAII 与 failure contract 由
[`crates/file-watcher/README.md`](../../crates/file-watcher/README.md) 维护。

当前 local App Server 启动时通过 `ash-install-context` 按 `ASH_RG_PATH`、package
`ash-path/`、Ash executable 同目录、host `PATH` 的顺序生成 `rg` candidates，再由
`ash-shell-command` 验证并冻结 canonical executable identity；未找到时启用本地工具的
composition 直接失败。canonical release package 由
[`build/app_server.py`](../../build/app_server.py) 按
[`third_party/ripgrep/runtime-lock.json`](../../third_party/ripgrep/runtime-lock.json) 下载并校验
target-specific ripgrep archive，把 executable 放到 `ash-path/rg[.exe]`；源码开发启动仍可使用
`ASH_RG_PATH` 或 host `PATH`。
filesystem 与 shell Tool 复用同一个启动时 canonicalized `DirectoryRoot`，CLI 优先采用
`ASH_WORKSPACE_ROOT`，否则采用当前目录。模型只看到 `program = "rg"`，host 强制加入
`--no-config`，拒绝 preprocessor、hostname command、archive search、symlink follow 和外部
pattern/ignore file 参数，包括 `-f/path`、`-LH` 等紧凑短参数形式，并用只读、断网 sandbox
执行。进程输出采用总 byte budget 截断并返回显式 truncation marker，Turn cancellation 会终止
已启动的子进程。

当前限制：package metadata 记录锁定的 ripgrep version、archive digest 与 binary digest，但
App Server 尚未执行 `rg --version` capability probe；本地 override/PATH candidate 也不保证与
package 锁定版本相同。该 runtime prerequisite 属于命令执行与安装诊断，不应通过重新增加一套
内容搜索 Tool 解决。crate 内实现契约见
[`crates/shell-command/README.md`](../../crates/shell-command/README.md)。

### 4.2 宿主、产品与能力归属

| 边界                           | 拥有的职责                                           | 与工具的关系                                                            |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Ash Workbench                  | 编辑器、文档模型、终端及工作台交互                   | 提供需要客户端完成的操作；编辑器和文件状态沿用原有 owner。              |
| Agent Window                   | 会话界面、导航、侧栏与用户交互                       | 复用共享工具目录；会话持久状态仍由共享服务维护。                        |
| App Server                     | 注册能力、解析产品范围、连接共享服务与客户端         | 在 composition root 汇总工具，按已有绑定路由到能力 owner 或指定客户端。 |
| Agent runtime / Core           | Turn 生命周期、冻结快照、调度、Code Mode、Agent 委派 | 对发现与调用使用相同范围约束，动作执行继续经过权限与审批。              |
| 能力 owner                     | 文件、进程、浏览器、记忆、应用操作等具体领域         | 拥有工具定义与具体操作；集合成员由可信组合声明，不复制业务状态。                        |
| Code / Cowork / Design Profile | 产品可组合的工具集                                   | 不拥有新注册表，不决定执行进程，也不替代动作授权。                      |

因此，`sessions` 表示“会话管理能力”，不表示“只能在 Agent Window 进程执行”。
其中有共享后端操作，也有需要 Agents 窗口完成的界面操作。
实际调用仍取决于既有客户端绑定；连接不可用时不能静默改投另一个窗口。

“共用注册体系”不要求跨所有环境维持一个全局可变实例。目录是执行上下文中的派生快照，
业务状态仍由各领域服务或 Provider 唯一持有。共享业务不因跨窗口运行就必须搬入核心，
具体扩展边界遵循[扩展架构](../editor-extensions.md#00-共享核心与两类扩展)。

| 目标身份 | 决定什么 | 当前例子 |
| --- | --- | --- |
| Environment／授权目录 | 文件与进程实际执行的位置和资源边界 | `read_file`、`shell-command`、`environment` |
| 本轮选定 IDE | 编辑器展示及文档交互目标 | `open_in_ash` 的文件、review 分支 |
| 发起窗口与连接 | 本次用户交互和窗口状态归属 | 导航、侧栏、Tasks；未选择 IDE 时的展示操作 |

这些目标不能由一个模糊的 `host` 字段代替。当前 App Tools 的客户端声明主要是 `agents/desktop`，
细化实际能力并让发现阶段反映不可用原因仍是后续工作；调用时的精确绑定检查继续保留。

## 5. 身份、来源与绑定

### 5.1 Name 不是执行身份

`ToolName` 是模型可见、在一次 invocation tool set 中唯一的路由名。它不是：

- MCP remote tool 的永久 identity；
- Plugin contribution ID；
- Connector account ID；
- executor instance ID；
- `ToolCallId`；
- registry generation。

同名工具可以在不同 source 中存在，但进入一个 model invocation 前必须解析为唯一 alias 或产生
明确 collision diagnostic。

### 5.2 绑定

目标共享值：

```rust
pub struct ToolBinding {
    pub registry_generation: ToolRegistryGeneration,
    pub id: ToolBindingId,
    pub exposed_name: ToolName,
    pub definition_digest: ToolDefinitionDigest,
    pub source: ToolSourceProvenance,
    pub runtime_key: ToolRuntimeKey,
}
```

语义：

- `ToolBindingId` 在一个 `ToolRegistrySnapshot` 中稳定且唯一；
- `ToolRuntimeKey` 是 host router 的 opaque key，不进入 model request 或 Thread transcript；
- `ToolDefinitionDigest` 覆盖 model-visible name、description、schema、loading 与 invocation kind；
- `ToolSourceProvenance` 保存稳定、可审计的 source chain，但不保存 credential、PID、session ID
  或 mutable package path。

一个 Plugin 贡献的 MCP tool 同时保留：

```text
distribution provenance = PluginId + version + package digest + contribution ID
execution provenance    = McpServerId + exact remote tool name + catalog generation
```

二者不能互相替代。

### 5.3 Durable 来源

process-local `ToolBindingId` 不能单独用于 crash recovery。当前 Tool Call durable fact 保存：

```text
exposed ToolName
+ stable source reference
+ definition digest
+ registry/catalog generation provenance
```

`ToolCallBinding` 已进入 protocol，history schema revision 已同步提升。Core 在记录 model、Shell 或
Code Mode nested call 前先冻结该值，App Server reloadable service 同时保留对应 registry/policy
generation。恢复时若 exact source generation 已不存在：

- 未开始执行的调用变成稳定 `Unavailable`；
- 已开始且副作用 outcome 不确定的调用进入 Core `UnknownOutcome`；
- 不能仅按旧 `ToolName` 在新 registry 中重新查找并执行。

## 6. 工具定义、模式与规格

### 6.1 叶级定义

`ToolDefinition` 描述一个可调用 leaf tool：

```rust
pub struct ToolDefinition {
    pub name: ToolName,
    pub description: String,
    pub invocation: ToolInvocationKind,
    pub output_schema: ToolOutputSchema,
    pub schema_mode: ToolSchemaMode,
    pub loading: ToolLoading,
}

pub enum ToolInvocationKind {
    Function { input_schema: ToolInputSchema },
    Freeform { format: FreeformFormat },
}

pub enum ToolSchemaMode {
    ProviderDefault,
    Strict,
}

pub enum ToolLoading {
    Eager,
    Deferred,
}

pub enum ToolOutputSchema {
    Unspecified,
    Schema(ToolSchema),
}
```

不使用 `strict: bool` 或 `defer_loading: bool` 作为 host API。Provider wire 需要的 bool 只在
`ash-api` adapter 最后一层产生。

Description 是 untrusted model context：

- 有 byte/token 上限；
- 保留 source provenance；
- 不能含有改变 approval、sandbox 或 instruction precedence 的权威语义；
- source runtime 不能通过 description 宣称自己是 `SafeRead` 并获得自动 retry。

### 6.2 工具模式

工具 schema 是受约束的 JSON Schema，不是任意 unchecked `serde_json::Value`：

```rust
pub struct ToolSchema {
    canonical: serde_json::Value,
    digest: ToolSchemaDigest,
}

pub struct ToolInputSchema(ToolSchema);
```

`ToolInputSchema` 额外要求根节点满足 Ash function-argument contract。公开构造只能经过
parser/validator。至少限制：

- 总 bytes、nesting depth、node/property/enum 数；
- string length、property name 和 description length；
- `$ref`、recursive schema 和 remote reference；
- unsupported keyword 与 dialect；
- `required` 必须引用已存在 property；
- object 的 `properties` / `additionalProperties` 语义；
- provider 严格模式所需的完整 required set；
- schema canonicalization 与稳定 digest。

Canonical dialect 以 Ash 支持的 JSON Schema 子集表达。MCP 2020-12 schema、dynamic schema 和
provider function schema 都先进入同一 parser。不能为通过某个 provider 校验而静默删除有语义的
constraint；只能：

```text
exactly supported → preserve
explicitly approximated → diagnostic + capability snapshot records approximation
unsafe/ambiguous → reject definition
```

### 6.3 聚合规格

`ToolSpec` 是 model-facing aggregate：

```rust
pub enum ToolSpec {
    Callable(ToolDefinition),
    Namespace(ToolNamespaceSpec),
    Search(ToolSearchSpec),
    ProviderHosted(ProviderHostedToolSpec),
}
```

规则：

- `Callable` 的 function/freeform 形态由 `ToolDefinition::invocation` 唯一决定，并且必须有
  host binding；
- `Namespace` 是展示和 provider capability 层的组合，不改变 leaf binding；
- `Search` 只搜索冻结 registry 中的 deferred definitions；
- `ProviderHosted` 由 provider 执行，必须有独立 outcome/capability contract，不能伪装成
  `ToolExecutor`；
- provider 不支持 namespace 时，由 `ash-api` 根据 frozen alias table flatten，不能自由拼接
  字符串；
- provider 不支持 freeform 或 hosted kind 时，在 model invocation 前返回 capability error。

### 6.4 暴露范围

工具是否初始暴露使用自描述 enum：

```rust
pub enum ToolExposure {
    Direct,
    Deferred,
    DirectModelOnly,
    Hidden,
}
```

- `Direct`：进入初始 model tool set，也可成为 code-mode nested tool；
- `Deferred`：只进入 search index，被搜索选中后才进入后续 model invocation；
- `DirectModelOnly`：直接暴露给模型，但不进入 code mode；
- `Hidden`：只注册 dispatch，不向模型或 tool search 暴露。

| 维度                        | 描述什么                                                            | 不应据此推导什么                                                |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `source` / `sourceChain`    | 工具由 local、MCP、dynamic、extension、environment、host 等来源提供 | 不决定业务集合成员或产品授权。                                      |
| `sourceGroups`              | 同一目录快照内按来源汇总的成员                                      | 不作为产品能力工具集使用。                                      |
| `toolSets`                  | 明确声明的能力成员集合                                              | 不表示工具位于同一个进程或 provider。                           |
| `exposure`                  | direct、deferred、modelOnly、hidden 等暴露方式                      | deferred 不代表范围外；发现后加载也不能扩大范围。               |
| `authority`、动作审批、沙箱 | 某次具体操作可以访问哪些资源、能否执行                              | 已进入 Scope 仍可能因为路径、参数、用户授权或沙箱条件而被拒绝。 |

外部工具可以按已注册的精确名称选择；提供者自报的标签或集合 ID 不授予产品集合成员资格。
底层执行身份还包含来源、绑定和 generation；Scope 中的允许名称列表不替代这些身份校验。

Code 包含浏览器、图片或自动化并不自动意味着模型初始上下文包含其全部定义；
减少噪声应先评估暴露方式和搜索相关性，不能仅凭工具不属于编程类别就缩小允许范围。
复合工具的操作差异见[目录中的操作表](tool-catalog.md#复合工具的操作边界)；工具名白名单不能表达操作级权限。

### 6.5 业务能力工具集与产品组合

目标采用新版 Agent Host 客户端工具的业务能力分组方式：围绕 Tasks、浏览器、远程任务、自动化等完整工作流程，
把需要独立选择或复用的工具组成具名 ToolSet。目标不再维护 Category 层，也不通过 `read/edit/execute` 标签推导集合。

上游客户端分组只覆盖客户端贡献的工具；Ash 的共享目录还包含执行环境、Core 与 Provider 提供的能力。
所有固定工具均归入 ToolSet，包括发现、转调和运行控制入口；注册或执行位置不同不构成不归组的理由。
统一分组不要求所有集合默认启用或使用同一个执行服务，成员仍依赖实际注册、授权、模式和连接条件。

| 概念 | 职责 | 对范围的影响 |
| --- | --- | --- |
| Tool | 定义、来源、绑定、调用与结果 | 注册一次，按冻结的精确身份执行 |
| ToolSet | 明确成员构成的可复用业务能力组 | 作为产品默认或按需选择的组合单元 |
| Product Profile | 产品的默认集合、可选集合与可信上限 | 当前只有单一 `sets`，目标需分开表达这些决定 |
| Effective Scope | 本轮解析后冻结的精确工具名单 | 统一约束发现、直接调用、转调、Code Mode 与委派 |

分组按能否作为一项业务能力独立启用来判断。文件读取与编辑可以组成“文件”，
Tasks 的运行与输出读取组成“工作台 Tasks”；操作的读取、写入和执行差异继续由动作策略裁决。
`request_permissions` 和远程任务分别有独立的交互、默认选择与启用要求，因此保持独立集合。

集合成员与实现归属分开维护。同一工具可以由可信组合显式复用到多个集合，组合后按精确工具名称去重，
不重复注册定义或执行器。取消选择某个集合，只移除该集合带入的成员；通过其他已选集合带入的同一工具仍可保留，
精确工具禁用项始终优先。集合不能让新来源、同名定义或执行目标替换既有绑定。

所有 ToolSet ID 统一采用不带层级前缀的业务名称，使用小写字母和下划线，例如 `files`、`tasks`、`permissions`、`remote_tasks`。
全部集合遵循同一规则，不按通用程度、Agent 角色或产品归属增加前缀。工具函数名是独立标识，本次集合改名不改变函数名。

Workbench、Agent Window、TUI 是宿主，Code、Cowork、Design 是产品组合。来源、执行位置、Provider 和客户端条件分别维护为元数据，
不编码到业务集合 ID 中，也不因分组把可选业务移入核心。

`ToolProductProfile` 是产品组合声明；`ToolProfileSnapshot` 是已有的 Turn 工具快照。
产品组合先解析，最终范围存入快照的 `allowed_tools`。

### 6.6 业务能力工具集（目标）

目标为 **26 个 ToolSet、86 个不同固定工具**，完整成员定义统一维护在
[ToolSet 总表](tool-catalog.md#toolset-总表)，格式为“ToolSet、数量、完整工具成员”。
总表覆盖全部固定入口，不另设未归组的机制工具；详细用途、执行归属和条件紧随总表维护。
基础清单每个工具列一次，有实际消费者时仍可由可信组合复用成员并去重。

分组按以下独立选择需求收敛：

- `memory`、`history`、`notes` 分别管理长期记忆、当前会话历史和任务笔记，不共享宽泛的读写同意。
- `modes`、`consultation`、`waiting` 分别管理模式切换、顾问咨询和当前执行等待，替代原先含义宽泛的工作方式分组。
- `tasks` 管理工作台任务，`execution` 管理命令、进程与执行环境；二者独立选择。
- `tool_discovery` 完成工具发现与 MCP 转调，`code_mode` 管理 JavaScript cell；执行条件不同，集合成员同样显式声明。

全部集合统一使用无前缀业务 ID，具体实现仍归各领域 owner。来源分组不冒充业务集合，分组不复制现有业务状态。
默认与按需选择统一见[默认启用与可选组合](#默认启用与可选组合)。Profile 引用集合不会安装、启用或连接对应能力。

### 6.7 当前实现与迁移边界

**本节记录代码现状，目标分组和命名尚未落地。** 当前实现有 17 个集合、76 个成员，仍使用带前缀的旧 ID。
例如旧 `core.files` 对应 `files`，旧 `app.sessions` 对应 `sessions`；发生职责拆分的集合按精确成员迁移：
旧 `core.memory` 拆为 `memory`、`history`、`notes`，旧 `agent.control` 拆为 `modes`、`consultation`、`waiting`，
旧 `core.execution` 的 8 个成员拆为 `execution` 的 3 个命令／环境工具和 `tasks` 的 5 个工作台任务工具。
其他已有集合统一去掉前缀。
这些旧 ID 只用于解释迁移，不是目标命名的例外。

当前代码没有独立的 Tasks、权限请求、远程任务集合；`request_permissions` 和四个 `remote_task_*` 已有产品接入，但缺少集合元数据。
本文全部 26 个无前缀 ID 都属于待实现的目标命名，当前协议不会把它们识别为旧 ID 的别名，提交时会返回未知集合错误。
迁移需要同步修改成员声明、产品组合与范围解析，并处理保存的旧选择；不能同时保留两套不同成员定义或绕过原有范围限制。
已冻结的精确工具名单与执行绑定继续按既有生命周期处理。固定工具及控制入口仍为 86 个，不新增工具实现。

当前 `ToolService::tool_set()`／`ToolExecutor::tool_set()` 每个工具至多返回一个集合，
后续成员复用应由可信组合显式声明，不能将该接口现状固化为业务工具必须唯一归组的要求。
来源分组 `sourceGroups` 仍单独维护；外部提供者不能凭自报集合 ID 加入受保护集合。
集合变动只参与后续范围解析，不追改已冻结名单。

代码还保留 `ToolCategory`、`scope.categories` 和开发者目录的分类字段，具体迁移与输入兼容要求见
[当前协议与迁移要求](#当前协议与迁移要求)。文档移除目标分类体系，不表示已删除这些运行行为。

#### 统一归组与当前入口装配

当前 App Server 会在非空范围下补入 `tool_search` 及必要的 MCP 桥接入口，Core 按 Tool Mode 注入 `exec/wait`，
后者尚未作为普通 App Server 成员出现在开发者目录。这些是代码现状，不能用来推断已经实现目标集合。

目标将前面三个入口纳入 `tool_discovery`，后两个纳入 `code_mode`，目录与范围解析需识别所有成员及其精确绑定。
组合默认值、显式选择和禁用项统一约束入口名单，不得在冻结后绕过选择补回工具；具体启用条件见
[默认启用与可选组合](#默认启用与可选组合)。执行、审批、取消和资源释放继续由原 owner 处理，
不为分组增加空壳普通工具执行器，也不建立第二套注册表。

## 7. 注册表与快照

### 7.1 注册表输入

App Server composition root 收集：

```text
built-in registrations
+ ready MCP catalog projections
+ active connector adapters
+ accepted dynamic tool specs
+ host capability tools
+ code-mode bridge tools
constrained by policy/grants/model capability
= ToolRegistrySnapshot
```

`ash-tools` 提供 builder 和 immutable snapshot value，但不读取任何 live manager。

### 7.2 快照

```rust
pub struct ToolRegistrySnapshot {
    pub generation: ToolRegistryGeneration,
    pub entries: Vec<RegisteredTool>,
    pub diagnostics: Vec<ToolRegistryDiagnostic>,
}

pub struct RegisteredTool {
    pub definition: ToolDefinition,
    pub binding: ToolBinding,
    pub exposure: ToolExposure,
    pub search: ToolSearchMetadata,
    pub execution: ToolExecutionMetadata,
}
```

Builder 必须确定性执行：

1. validate definitions；
2. resolve reserved names；
3. assign exposed aliases；
4. collision check；
5. compute definition digests；
6. bind source runtime keys；
7. build deferred search entries；
8. project code-mode-eligible definitions；
9. sort entries and diagnostics；
10. publish new generation。

同一输入 generation 集合必须产生同一 snapshot。新 snapshot 只有在 consumer-visible tool set、
binding、definition 或 diagnostic gate 变化时递增 generation。

### 7.3 安全点与排空

| 对象 | 生效边界 | 约束 |
| --- | --- | --- |
| Turn 正向范围 | 接受 Turn 时解析 `allowed_tools` | 当前不能通过 steering 扩大；换 Profile 或添加名称需要新 Turn |
| 模型请求的定义与绑定 | 模型调用安全点捕获同一 generation 的定义和 binder | 已产生的调用只在原 invocation snapshot 中解析 |
| 实际权限与连接状态 | 执行边界复核；撤权、停用、断连由其 owner 处理 | 冻结绑定不保证旧权限持续有效；已开始的副作用可能只能报告结果不确定 |

MCP list-changed、Plugin update 和 dynamic tool removal 不会把 in-flight binding 静默换成新 executor。
旧 snapshot 持有 runtime lease，直到其 model calls 和 Tool invocations 排空；权限单调收紧仍可取消旧调用，
精确 owner 断连后的处置遵循[动态工具执行](#112-执行)。

目录刷新在后续模型安全点生效，但不能扩大已冻结的 Turn 正向名单。新 MCP 工具即使进入下一份目录，
也不会自动加入该 Turn。若以后需要 Turn 内受控扩展，应另行定义可信授权和范围版本更新契约，当前尚未实现。

`ToolRegistrySnapshot` 是 process-local 派生值，不进入 Config document 或 Thread event。只有调用
恢复所需的稳定 provenance 进入 durable fact。

### 7.4 Scope 计算与调用约束

**目标规则，涉及默认／可选组合及可信上限的部分待实现。** 业务集合最终展开为精确工具名称，不再增加分类筛选层。

```text
集合成员 = 所选 ToolSet 中实际已注册的成员，展开后去重

未提供显式工具选择 → 使用可信产品配置中的默认集合成员
提供显式选择       → 所选集合成员 ∪ 显式工具名称
显式空 Scope       → 空名单，不补默认集合

本轮允许范围 = 选择结果 ∩ 可信产品上限 − 精确工具禁用项
当前 Agent 可调用范围 = 本轮允许范围 ∩ Agent 自身能力上限
当前 Agent 可委派范围 = 本轮允许范围 ∩ Agent 委派能力上限
```

输入的 Profile 是组合选择，不是可信产品身份；省略或改填 Profile 都不能扩大可信执行上下文的上限。
来源授权、实际能力、Tool Mode 与连接条件继续限制可用成员。发现与运行控制入口也来自已选集合，
不能作为名单外例外被自动补入。只选 `tool_discovery` 或 `code_mode` 不授予其他目标工具；显式空 Scope 仍无工具。
根 Agent 没有额外 Agent 上限时使用本轮范围。自身能力与委派能力是两份不同上限，不能机械地将委派范围缩成亲自调用范围。

`remote_task_send` 创建使用目标机器自身权限的独立任务，并非当前 Agent 树的子 Agent；
其显式委派要求和传输边界见[远程任务目录](tool-catalog.md#24-远程独立任务4)，目标任务不自动继承本轮所有权限限制。

| 检查点 | 范围贯彻要求 |
| --- | --- |
| Turn 接收 | App Server 解析选择，Core 冻结 `allowed_tools`；精确工具禁用项继续保存 |
| 模型工具目录 | 直接工具和后续加载的工具都按冻结范围过滤 |
| Tool Search | BM25、正则、语义搜索先过滤候选；范围外文档不参与本次嵌入与排名 |
| 直接调用 | 调度准备与执行前检查范围，猜到名称不能绕过 |
| MCP 转调 | 搜索与目标调用分别检查范围，桥接入口不授予额外目标 |
| Code Mode | 嵌套目录和嵌套调用沿用同一范围；`exec/wait` 准备与执行也检查范围 |
| 子 Agent | 工具选择与协调器创建入口受父 Turn 范围约束，继续委派不能放大 |
| Steering | 不能改变已接受 Turn 的选择；改变范围需要新 Turn |

冻结绑定与实时权限的生命周期见[安全点与排空](#73-安全点与排空)。目标输入字段形式由后续协议设计确定。

#### 当前协议与迁移要求

下表及示例描述当前可调用协议，避免将目标规则当成已经实现的配置。

| 当前输入或实现 | 现有行为与迁移要求 |
| --- | --- |
| 指定 Profile，省略集合和工具 | 使用该 Profile 的已注册成员；当前 Code 引用 17 个集合 |
| 指定 Profile，同时选择集合／精确工具 | 与 Profile 成员取交集；已注册但在 Profile 外的工具仍不可用 |
| 完全省略 `scope` | 兼容原有宿主目录，不新增正向名单；不是默认选择 Code；后续需接入可信产品默认与上限 |
| `scope: {}` | 生成空名单；目标仍保留此行为 |
| 遗留 `scope.categories` | 当前仍对已选工具作分类交集，单独填写不能授予工具；后续需转换为精确成员并保留既有限制，或在移除支持后明确拒绝旧字段，不能静默忽略而扩大范围 |
| 未知工具、集合或 Profile | 返回输入错误；目标沿用精确校验 |
| `cowork` 或 `design` | 当前为 planned，选择报错，不回退到 Code |
| 无前缀业务集合 ID | 本文 26 个目标 ID 当前均不支持，也没有隐式旧 ID 别名；当前调用可使用精确工具名称，集合 ID 需等待统一迁移 |
| 发现与 Code Mode 入口 | 当前仍按宿主条件补入或注入；目标需通过 `tool_discovery`／`code_mode` 进入统一选择与范围解析，不得绕过显式排除 |

当前完整字段、序列化及校验由[共享类型](../../crates/protocol/src/turn/tool_profile.rs)和
[Turn 输入协议](../../crates/app-server-protocol/src/protocol/turn.rs)维护。没有新增普通设置项或产品 Profile 选择器。

#### 使用示例

**文件读取与文件搜索。** 使用精确工具保留读取和搜索，避免选择包含修改能力的完整文件集合。
以下写法当前已支持，不依赖分类筛选：

```json
{
  "type": "toolSelection",
  "disabled": [],
  "scope": {
    "profile": "code",
    "tools": ["read_file", "grep", "glob"]
  }
}
```

需要代码索引检索时，可从实际目录取得已注册的 `search_code` 并显式选择。当前实现仍可按现有规则补入搜索入口；目标方案需明确选择 `tool_discovery`，或在未显式选择时由产品默认组合提供。
这只限制工具名单，文件资源授权与沙箱仍单独检查。

**使用当前 Code 的完整已注册组合。** 此例仍采用当前单一 `sets` 的行为，不代表已实现目标默认／可选分离。

```json
{ "type": "toolSelection", "disabled": [], "scope": { "profile": "code" } }
```

**明确不给工具。**

```json
{ "type": "toolSelection", "disabled": [], "scope": {} }
```

**当前单独选择任务工具。** 在 `tasks` 落地前可以使用精确名称，无需同时选择 Shell：

```json
{ "type": "toolSelection", "disabled": [], "scope": { "profile": "code", "tools": ["tasks_list", "tasks_status", "tasks_output"] } }
```

当前不指定 Profile 时也能组合已注册集合或精确名称；这不是绕过未来可信产品上限的方式。

#### 范围实现入口

| 内容                               | 代码入口                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 集合、产品声明及冻结范围类型       | [共享工具范围契约](../../crates/protocol/src/turn/tool_profile.rs)                                                                                                                              |
| 产品组合、集合汇总与 Scope 解析    | [App Server composition](../../crates/app-server/src/tool_composition.rs)                                                                                                                       |
| Turn 输入转换与目录 RPC            | [App Server operations](../../crates/app-server/src/server/operations.rs)                                                                                                                       |
| 当前调用与委派能力判断             | [ToolExecutionFacts](../../crates/core/src/services.rs)                                                                                                                                         |
| 准备与执行前检查                   | [ToolScheduler](../../crates/core/src/turn/tool_scheduler.rs)、[ToolExecution](../../crates/core/src/turn/tool_execution.rs)                                                                    |
| 子 Agent 创建边界                  | [MultiAgentCoordinator](../../crates/core/src/multi_agent/coordinator.rs)                                                                                                                       |
| 搜索候选过滤                       | [BM25 / 正则](../../crates/tools/src/registry/search.rs)、[语义搜索](../../crates/app-server/src/tool_search_embedding.rs)、[MCP](../../crates/app-server/src/tool_composition/mcp_exposure.rs) |
| Code Mode 控制与嵌套目录           | [控制目录](../../crates/core/src/turn/code_mode/catalog.rs)、[Broker](../../crates/core/src/turn/code_mode/broker.rs)                                                                           |

### 7.5 产品组合与接纳规则

当前 Profile 是输入选择预设。若产品要求强制隔离，服务端必须从可信 Session／Agent 执行上下文取得上限，
再与输入选择取交集；省略 `scope` 或提交另一个 `profile` 都不能扩大该上限。这是待实现要求，
现有可选 `scope.profile` 尚未完成产品隔离。具体操作仍由来源授权、动作策略、审批与执行边界裁决，
不因引入产品组合就另建授权系统。

| Profile  | 状态      | 当前组合         | 使用行为                                       |
| -------- | --------- | ---------------- | ---------------------------------------------- |
| `code`   | `ready`   | [当前代码的 17 个工具集](#67-当前实现与迁移边界) | 仅纳入其中实际已注册的成员，之后仍可缩小范围。 |
| `cowork` | `planned` | 空               | 有声明、无可用能力，选择会报错。               |
| `design` | `planned` | 空               | 有声明、无可用能力，选择会报错。               |

Cowork、Design 当前只有产品声明占位，尚未实现它们的专属工具、工具集或默认组合。
已有 Cowork / Design 界面不代表这些 Profile 已投入使用。

#### 默认启用与可选组合

以下为已确定规则，待代码实现。

此处“默认启用”指产品在没有显式工具选择时，将集合纳入本轮候选范围；它不等于初始模型请求加载全部定义，
也不代表任何具体操作已获批准。Direct／Deferred 暴露仍独立配置。

| 集合 | Code 默认选择 | 可选组合与运行条件 |
| --- | --- | --- |
| `tasks` | 从当前 Code 的 Tasks 成员迁移为独立默认集合 | 仅在存在有效客户端 Tasks 能力、工作区与发起连接时提供；显式选择可独立排除 |
| `permissions` | 交互式 Code 的默认组合明确引用 | 只有权限请求策略允许，且存在可处理权限交互的宿主通道时才可用；显式范围或禁用项可排除它 |
| `remote_tasks` | 默认不纳入 | 由用户选择或可信任务配置明确启用；需要 task-delivery runtime，远端操作还需有效目的地、连接和对应授权 |
| `memory`、`history`、`notes`、`modes`、`consultation`、`waiting` | 随当前 Code 既有成员迁移为分别声明的默认集合 | 仍按用户同意、授权 Thread、模式交互、顾问配置／成本限制及取消条件分别检查；可独立选择或排除 |
| `tool_discovery` | Code 默认组合明确引用 | 仅提供实际可用的通用发现／MCP 桥接成员；候选和调用目标均受本轮精确名单约束 |
| `code_mode` | Code Mode 启用时由默认组合明确引用 | 还需本组被选中、Tool Mode 匹配及运行时可用；选择本组不授予其他嵌套工具 |

“交互式”按真实交互通道判断，包括支持权限响应的 Desktop、TUI 或其他宿主；不能只按是否存在桌面窗口判断。
无人值守且没有权限响应通道的任务不提供 `permissions`，也不把无法询问解释为自动同意。
该集合是 Code、Cowork、Design 可共享的组合单元；Cowork／Design 仍为 planned，接入时必须明确决定其默认选择，
不会因为共用 Runtime 就自动继承 Code 的任何集合。

目标组合规则如下，字段形式由后续协议设计确定，本文不把这些概念写成已经支持的配置字段：

1. 可信产品配置分别声明默认集合和允许按需选择的集合，两者都受可信产品上限约束。
2. 未提供显式选择时采用默认集合；显式选择时采用所选集合／工具，再与上限取交集，不重新并入遗漏的默认集合。
3. Agent 自身／委派上限及精确工具禁用项继续生效；默认集合不能覆盖显式选择。空 Scope 仍为空，不再应用分类筛选。
4. 根据实际注册、来源授权、策略和宿主条件计算可用成员；批准新的资源访问不扩大冻结的工具名单。
5. 本轮选择冻结后，普通默认／可选组合调整在新 Turn 生效；实时撤权和连接失效仍按[安全点与排空](#73-安全点与排空)处理。

`permissions` 遵循普通集合选择，不因文件工具被选择或范围非空而自动补入。
例如只选 `files/search` 时，仍需明确选择 `permissions` 才提供权限请求；
即使随后获准访问新目录，也不会让被排除的 `shell-command` 或远程投递工具变得可用。
`tool_discovery` 在目标方案中也遵循默认／显式选择规则，不能用当前宿主的自动补入行为绕过显式排除。

`remote_tasks` 不随 `collaboration`、`sessions`、SSH 连接配置或目的地发现自动启用。
需要完整投递流程时选择该集合；只需查询时可以显式选择 `remote_task_targets`、`remote_task_list`、
`remote_task_read`，排除 `remote_task_send`。启用投递入口仍不代替一次具体跨机器委派的用户指示和动作授权。

`tasks` 的默认迁移保留当前 Code 已包含 Tasks 的组合意图；集合可用性仍取决于实际客户端。
显式选择 `execution` 不带入 Tasks，显式选择 `tasks` 不带入 Shell；关闭一组不隐式关闭另一组。
目标默认组合需分别引用二者，不能靠命名或调用位置自动补入。

当前 `ToolProductProfile` 只有单一 `sets`：它既提供缺省成员，又限制显式选择；缺省 Scope 仍沿用旧行为。
后续需统一迁移集合 ID 与拆分成员，落实权限请求、远程任务、发现与 Code Mode 集合，不能仅追加 ID 就宣称已实现上述规则。
实现必须同时支持默认／可选组合的区别及可信上限；在实现前，Code 仍沿用[当前协议行为](#当前协议与迁移要求)。

#### 发现与 Code Mode 的启用条件

`tool_discovery` 将通用发现和 MCP 发现／转调作为一组配套能力。只有实际已注册的入口才可提供，
搜索候选先按冻结的目标名单与来源授权筛选，`call_mcp_tool` 继续校验精确定义、digest、绑定和目标调用权限。
只选择发现集合不会安装、连接或授予整个 MCP Server，也不会使范围外目标进入搜索结果。

`code_mode` 的两个成员共同管理 cell，但实际暴露还受 Tool Mode 和运行时条件约束。
嵌套目录及每次调用继续使用本轮目标名单、原绑定与普通审批；JavaScript 不因集合被选中就获得直接文件、网络或进程接口。
精确工具禁用项优先；若 `CodeModeOnly` 等所选执行模式依赖的入口不可用、未选中或被禁用，应明确报告配置冲突，
不能静默恢复入口或扩大工具范围。已开始 cell 的取消与清理仍由运行时负责，按现有生命周期收口。
这些是后续统一选择的目标要求，当前入口注入和范围特例尚未迁移。

#### 外部工具如何进入产品范围

当前 Profile 只引用固定集合。未进入这些集合的 MCP／Extension 工具，即使注册成功且已按来源获准使用，
也会在指定 `profile: "code"` 时被集合交集排除；显式填写工具名不能越过该交集。
`request_permissions` 和 `remote_task_*` 也有相同的成员缺口。省略 Profile 后可以按实际注册名称选择，
但这只是当前协议行为，不能作为绕开未来可信产品上限的办法。

后续产品组合需要同时表达以下输入，并由统一范围解析入口处理：

| 输入 | 成员来源 | 状态 |
| --- | --- | --- |
| 产品自有集合 | 产品明确维护的工具成员 | 已实现固定集合组合 |
| 获准的外部贡献 | 精确 Provider／MCP 连接身份及其有效来源授权，再受产品扩展规则限制 | 尚无完整的 Profile 接纳规则 |
| 用户／Agent 选择 | 在可信上限内选择集合或精确工具 | 已有输入选择；与可信产品身份的分离待实现 |

外部贡献可通过产品扩展规则进入范围，无需先加入某个内置业务集合。是否接纳某服务器未来新增工具，应是明确的来源信任规则；
连接成功、自报标签和 Tool Search 结果均不能替代该规则。来源授权与单次动作批准的边界沿用
[Plugin 两层授权](../plugins.md#101-两层授权)，不在工具组合中另建授权 authority。

Cowork／Design 接入真实能力后再声明组合和扩展规则，不先注册假集合。复用 Shell、文件修改或应用管理
是产品的显式选择。普通工具适配已有定义、调用与结果契约后，应无需修改搜索和调度核心；新的交互方式、
执行模式或结果类型仍可能需要扩展公共契约，不能保证任意新功能都只改一条注册。

## 8. 工具 Call、调用与执行接口

### 8.1 三种调用值

必须区分：

```text
Model ToolCall
  模型输出：call id + exposed name + raw payload

Materialized ToolInvocation
  host 已解析 binding、校验 schema、固定环境和 operation identity

Durable Tool Call Item
  Core 已提交的调用事实
```

不能让 executor 接收一个只有 name/JSON 的值后自行从 live registry、Config 或 Thread 查找环境。

### 8.2 载荷

```rust
pub enum ToolPayload {
    FunctionArguments(serde_json::Value),
    FreeformInput(String),
    SearchQuery(ToolSearchQuery),
}
```

Function arguments 在 materialization 前完成 JSON parse 和 schema validation。原始 provider
arguments 可以留在 invocation trace 供诊断，但 executor 只接收 canonical payload。若 source
确实需要 exact raw bytes，应由具名 `RawPayloadRequirement` capability 明确声明，不能成为默认。

### 8.3 具体化调用

```rust
pub struct ToolInvocation {
    pub operation_id: ToolOperationId,
    pub call_id: ToolCallId,
    pub turn_id: TurnId,
    pub binding: ToolBinding,
    pub payload: ToolPayload,
    pub context: ToolExecutionContext,
}
```

`ToolExecutionContext` 只包含 executor 被允许看到的 environment identity 与 cancellation token。
Core/App Server 接入时会将它扩展为具名、受限的 capability handle，例如：

- effective working directory reference；
- approved filesystem capability；
- approved network capability；
- resource writer；
- redacted locale/timezone；
- explicitly selected credential capability。

它不默认包含完整 conversation history、Config、secret store、Thread controller 或 App Server handle。
需要额外上下文的工具必须在 registration 时声明具名 capability，并经过 policy/materialize。

### 8.4 执行器接口

`ash-tools` 定义工具作者接口：

```rust
/// Executes one fully materialized tool invocation.
///
/// Implementations must execute only the supplied binding and payload, observe
/// cancellation and limits, never read or mutate Thread state, and report
/// whether an externally visible operation may have started when a trustworthy
/// result cannot be produced.
pub trait ToolExecutor: Send + Sync {
    fn definition(&self) -> ToolDefinition;

    fn exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn search_metadata(&self) -> ToolSearchMetadata;

    fn concurrency(&self) -> ToolConcurrency;

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_>;
}
```

新 trait 必须保留上述角色和实现约束的 doc comment。接口不接受含糊的 `bool` / `Option` 参数。
`definition`、`exposure`、`search_metadata` 和 `concurrency` 必须确定、无 I/O；composition root
只在构造新 registry snapshot 时读取它们。

`ToolConcurrency` 使用 typed policy hint：

```rust
pub enum ToolConcurrency {
    Exclusive,
    ParallelSafe,
    ConflictClass(ToolConflictClass),
}
```

它只是 executor 声明；Core 仍将它与 Turn policy、approval 和 resource conflict 一起计算最终
schedule。

### 8.5 核心消费方端口

Core port 接收 materialized request 并返回 source-neutral outcome：

```rust
/// Routes a Core-approved invocation to the executor bound by the frozen
/// registry snapshot.
///
/// Implementations must preserve operation and call identity, reject stale
/// bindings, enforce host capabilities, and never commit Thread state.
pub trait ToolService: Send + Sync {
    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_>;
}
```

长期不再通过 `definitions()` 在执行时读取 live list。Definitions 由独立 snapshot 输入
`ContextManager`；execution 只解析 invocation 中冻结的 binding。

### 当前 Turn 的模式切换

内置工具 `switch_mode` 接收 `{ "mode": "plan", "reason": "先确认实现方案" }`，支持
`agent`、`plan`、`debug`、`multitask`、`ask`。`reason` 必须是 1–1000 字符的非空说明。

App Server 注册工具并处理用户选择；Core 的 `ThreadController.change_turn_mode` 拥有状态变更，
写入 `turnModeChanged` 事件及新的模式指令。下一次模型调用读取更新后的 Turn，历史调用保留原有
指令。事件包含 `fromMode`，用于识别过期切换和同步输入框。桌面与 TUI 跟随切换，但保留用户为下一条
消息选择的不同模式。

| 切换情况                                            | 行为                                               |
| --------------------------------------------------- | -------------------------------------------------- |
| Agent / Debug / Multitask 之间，或进入 Plan / Ask   | 直接切换                                           |
| Plan 与 Ask 之间                                    | 直接切换                                           |
| Plan / Ask → Agent / Debug / Multitask              | 通过现有用户输入交互等待明确选择；拒绝后保留原模式 |
| 已在目标模式                                        | 返回 `changed: false`，不重复写事件                |
| Turn 已结束、不是 coding Turn，或确认期间原模式改变 | 拒绝变更                                           |

成功输出为 `{ "changed": true, "from_mode": "agent", "mode": "plan", "sequence": 8 }`；
拒绝确认输出为 `{ "changed": false, "mode": "plan", "rejected": true }`。
模式仅决定工作方式和模式提示词。权限、角色、模型选择、共享指令与工具快照保持不变；
`bypassPermissions` 也不会跳过离开 Plan / Ask 所需的用户选择。

## 9. 输出与结果

### 9.1 面向模型的输出

```rust
pub struct ToolOutput {
    pub status: ToolOutputStatus,
    pub content: Vec<ToolContent>,
    pub structured: ToolStructuredOutput,
    pub provenance: ToolOutputProvenance,
}

pub enum ToolOutputStatus {
    Success,
    Error,
}

pub enum ToolContent {
    Text(String),
    Image(ToolImage),
    Resource(ToolResourceRef),
}

pub enum ToolStructuredOutput {
    Absent,
    Json(serde_json::Value),
}
```

Tool-level API failure、业务校验失败和 command exit non-zero 通常是
`ToolOutputStatus::Error`，作为 Tool Result 返回模型。它们不是自动终止 Turn 的 infrastructure
error。

所有 output 施加：

- 总 bytes、content part 数和每 part 上限；
- UTF-8 与 JSON/schema validation；
- MIME、URI scheme 和 resource ownership 校验；
- binary/image 的 resource indirection；
- deterministic truncation 与明确 truncation marker；
- 日志预览与 model-facing full output 分离；
- external context provenance。

统一截断算法由 `ash-utils-output-truncation` 持有；`ash-tools::ToolOutput::truncate_text` 只负责
把 `ToolContent` 的多个 text part 交给这个 utility，并保留非文本 part。算法只在文本超过明确预算
时从中间截断，保留 UTF-8 边界和头尾，并写入原始 token 数与行数；当前的 image 不会被切坏。
`Bytes` 是硬字节预算，`ApproximateTokens` 只用于确定性近似，不能替代 Context/Model Provider
层的精确 token measurement。MCP 使用自己的配置预算调用同一 utility，可执行工具 adapter 使用
`DEFAULT_TOOL_OUTPUT_MAX_BYTES`，因此不同来源不会各自维护一套截断算法。

### 9.2 执行结果

```rust
pub enum ToolExecutionOutcome {
    Returned(ToolOutput),
    NotStarted(ToolStartFailure),
    OutcomeUncertain(ToolUncertainOutcome),
}
```

边界：

- `Returned`：executor 对工具业务结果有可信终态；
- `NotStarted`：能够证明外部动作尚未开始，例如 binding stale、local validation failed；
- `OutcomeUncertain`：请求可能已到达外部系统，但断线/崩溃使终态未知。

`ash-tools` 定义准确值，Core 决定：

- 是否将 `NotStarted` retry；
- 是否把 `OutcomeUncertain` durable 映射为 `UnknownOutcome`；
- Tool Result 是否继续 model loop；
- Turn 是否失败。

取消只是一种执行信号，不自动等于 `NotStarted`。Executor 必须根据外部动作是否可能开始返回准确
outcome。

当前 Core 的 sandbox escalation 已采用更窄的恢复规则：只有 executor 明确返回
`SafeToRetry` denial 才进入二次 policy review；需要用户决定时先 durable 保存 denial 和 exact
approval binding。批准后在非 sandbox 重试前提交 escalation marker；若 marker 已存在而结果缺失，
恢复只产生 unknown-outcome failure，不重复调用工具。`MayHaveSideEffects` denial 永不自动重放。

### 9.3 输出适配器

共享 adapter 负责：

```text
ToolOutput
  ├─► canonical ash-protocol::ToolResult content
  ├─► code-mode nested result
  ├─► bounded telemetry preview
  └─► provider-neutral next ModelRequest input
```

Provider wire encoding 仍由 `ash-api` 完成。不能让每个 executor 自己生成 OpenAI/Anthropic
JSON。

## 10. MCP 工具转换

### 10.1 两段式适配器

MCP 转换固定为：

```text
MCP wire Tool
  → ash-mcp: revision-specific parse + exact remote identity
  → McpToolProjection
  → ash-tools: schema normalization + host definition + output adapter
  → RegisteredTool + MCP executor binding
```

纯 projection：

```rust
pub struct McpToolProjection {
    pub remote_name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub output_schema: McpOutputSchemaProjection,
    pub annotations: McpToolAnnotationClaims,
}
```

它不包含 transport、request ID、credential、connection handle 或 SDK-specific type。

### 10.2 定义转换

`mcp_tool_definition` 必须：

- 接收已经 collision-checked 的 exposed `ToolName`；
- 保留 exact remote name 到 MCP executor binding；
- 对缺失/null object `properties` 按明确兼容规则补为空 object；
- 用统一 `ToolSchema` parser 处理 input/output；
- 将 MCP annotations 标记为 `UntrustedSourceClaim`；
- 计算 definition/schema digest；
- 根据 host policy 选择 exposure，不能听任 server 自己扩大暴露面；当前 App Server 对聚合 MCP
  catalog 使用 §12.2 的整端口阈值投影；
- 拒绝 schema bomb、invalid name、超长 description 和不支持 content contract。

MCP `outputSchema` 只约束 `structuredContent`。MCP call result 外层 `content`、`isError` 和 `_meta`
有独立 envelope；不能把 remote output schema 错当成整个 Tool Result schema。

### 10.3 结果转换

转换规则保留：

- text → `ToolContent::Text`；
- image/blob → 经过 size/MIME/resource policy 的 `ToolContent::Image/Resource`；
- resource link/embedded resource → 保留 MCP source provenance；
- `structuredContent` → 校验 output schema 后进入 `ToolStructuredOutput::Json`；
- `isError: true` → `ToolOutputStatus::Error`；
- MCP protocol error → `NotStarted` 或 infrastructure error，取决于请求是否发送；
- transport lost after send → `OutcomeUncertain`，不能伪造普通 error output。

MCP adapter 不决定 approval、retry 或 durable state，也不能根据 server `readOnlyHint` 单独把调用
标为可自动重试。

## 11. 动态工具

“Dynamic tool”必须区分两个概念：

```text
Dynamic definition
  Turn/client/extension 在运行时提供一个新的 ToolSpec

Dynamic execution
  一次调用通过 Agent interaction 交给外部 owner 返回结果
```

二者通常一起出现，但不能让“动态”成为绕过 registry 和 policy 的通用后门。

### 11.1 定义适配器

`DynamicToolSpec → ToolDefinition` 经过与 MCP/built-in 相同的：

- `ToolName` validation；
- schema parser 和 complexity limit；
- description/output limit；
- exposure/policy resolution；
- alias collision check；
- definition digest；
- registry generation。

Dynamic source 不能提交 unchecked provider wire schema，也不能选择 reserved tool name。

### 11.2 执行

client-owned dynamic tool 使用：

```text
model emits Tool Call
→ Core resolves frozen dynamic binding
→ validate + approval
→ durable Tool Call
→ durable InteractionRequested { DynamicToolCall }
→ App Server delivers to exact owner
→ client returns DynamicToolResponse
→ output adapter validates call id、content 与 image/resource policy，并分配有效 detail
→ durable InteractionResolved + Tool Result
```

`RequestId`、`ToolCallId` 和 App Server JSON-RPC request ID 始终分开。

Dynamic tool owner disconnect 时：

- 尚未投递：等待能够精确承载该 tool name 的 owner；
- 已投递且 side effect 可能开始：持久化 `OwnerDisconnected` cancellation，按 unknown outcome
  收口；
- 不能将请求转交给同名的新 owner，也不能自动重试；
- 原 interaction 取消后，重连客户端的迟到 response 会被拒绝。

### 11.3 运行时注册

进程内 extension 也可以动态注册 `Arc<dyn ToolExecutor>`，但必须由 composition root 生成新的
registry snapshot。不能从正在执行的 executor 内部直接修改当前 snapshot。

## 12. 工具搜索

### 12.1 搜索对象

`tool_search` 只搜索：

- 已安装；
- 已启用；
- 已完成 grant/credential gate；
- 当前 registry snapshot 中可用；
- exposure 为 `Deferred`；
- 对当前 model/Turn policy 兼容；
- 尚未直接暴露给当前 invocation 的工具。

它不搜索 Extensions 中未安装的 Plugin，也不触发 install、enable、connect 或 credential flow。

### 12.2 搜索值

```rust
pub struct ToolSearchMetadata {
    pub text: String,
    pub source: ToolSearchSourceInfo,
    pub tags: Vec<ToolSearchTag>,
}

pub struct ToolSearchQuery {
    pub text: String,
    pub limit: ToolSearchLimit,
}

pub struct ToolSearchResult {
    pub registry_generation: ToolRegistryGeneration,
    pub matches: Vec<ToolSearchMatch>,
}

pub struct ToolSearchMatch {
    pub binding_id: ToolBindingId,
    pub score: ToolSearchScore,
    pub loadable_spec: LoadableToolSpec,
}
```

`LoadableToolSpec` 带 definition digest 与 binding correlation。模型不能修改 search result 中的
name/schema 后要求 host 执行。

第一版 `ToolSearchLimit` 默认值为 8，并受 host-configured hard cap 限制。超出 hard cap 返回
typed validation error，不以无限结果或静默全量 catalog 作为 fallback。

当前 App Server 的 exposure policy 是：built-in Directory 与 client-hosted dynamic port 直接暴露，
extension executor 使用自身声明的 exposure；聚合 MCP port 先对排序后的 canonical definitions 做
稳定估算。工具数 ≤15 且 `ceil(canonical JSON bytes / 4)` ≤5000 时全部直接暴露；任一阈值超限时，
整个 MCP port 不向 registry 添加实际定义，只直接暴露固定的 `search_tools` 与 `call_mcp_tool`。
边界不会出现一部分平铺、一部分 deferred 的混合状态。

超阈值投影冻结 catalog digest；`search_tools` 最多返回 5 个按确定性分数/名称排序的 definition，
并携带 catalog digest 与各 definition digest。`call_mcp_tool` 必须回传两者，catalog 刷新或同名 tool
schema/description 变化都会 fail closed，要求重新 search。该 MCP 专用元工具不替代通用 registry
`tool_search`：后者仍只在其他 contribution 确实声明 `Deferred` 时出现。Plugin、Connector 和
dynamic contribution 继续经过同一 composition/collision contract，不能各自创建旁路。

### 12.3 索引与排序

第一版使用 snapshot-local、可重建的 deterministic index：

- name 与拆词后的 alias；
- description；
- schema property name/description；
- namespace；
- source display name 与受控 tags。

限制 query bytes、result limit、index size 和单 entry text。相同输入 snapshot/query 必须产生
稳定 ordering，以 score、source priority、exposed name、binding ID 做 tie-break。

向量或远端搜索只有在独立隐私、缓存和 failure contract 完成后加入。search index 不包含 secret、
tool output、conversation history 或未经允许的 Plugin package content。

当前默认模式是 `Lexical`：自然语言 query 使用 exact/substring name 优先和 snapshot-local BM25；
调用方明确选择 `regex` strategy 时，使用有 query byte 上限的线性时间 Regex 匹配完整 search
document。默认返回 8 个、硬上限 32 个。这条路径不调用模型，也不发送工具元数据到进程外。

User Config 可把 `toolSearch.mode` 设为 `hybridEmbedding`，并用独立的
`toolSearch.embeddingModel` 选择 exact `ModelRef`。App Server 通过 `SemanticModelProvider` 把该选择
和对应 provider config 解析成 `EmbeddingInvoker`；它不借用 Codebase 的模型选择或启用状态。
`toolSearch/configure` 在提交配置前先发送一条不包含工具元数据的固定 readiness probe；缺少模型、
provider/credential/runtime、请求失败、响应数量错误或零向量都会返回 `ToolSearchUnavailable`，配置
不提交。若 hybrid 配置来自外部 TOML 或进程启动恢复，但运行时不可达，App Server 把
`config/read.toolSearch.embeddingStatus` 投影为 `unavailable`；自然语言搜索明确失败，不静默改用
BM25。用户显式切回 `lexical` 后才恢复纯词法自然语言搜索。

门禁通过后，自然语言搜索为 query 和当前 deferred tool documents 生成 embedding，再用
reciprocal-rank fusion 与 BM25 排名合并；Regex 始终保持本地词法路径。向量只缓存在当前 registry
generation 的内存中。后续真实 embedding 调用失败、返回数量/维度错误或向量无有效模长时，当前
`tool_search` 直接返回明确错误，不静默回落到 BM25。模型调用继续属于 `model-provider`；
snapshot-local 目录、输入准备、召回融合、generation 校验、过滤与截断仍属于 Tool Search owner。

获得读取能力的本地目录还会注册 direct built-in `search_code`。它不属于 deferred Tool Search：Agent
可以显式传入自然语言 query 与最多 20 条结果，App Server 使用 canonical CodebaseRetrieval 编排本地 FTS、
已授权 semantic 和可选 cloud candidates，再返回 bounded、current-source-verified excerpts。Policy 只
只接受绑定当前目录、授权版本和读取 Permission 的 Authorization；伪造或复用其他 Authorization 会被拒绝。

`crates/tools/src/registry_search_eval_tests.rs` 保存一份跨 coding、GitHub、Slack、Calendar、
Browser 和 Database 的离线查询集，比较当前 BM25 排序与 uniform token-overlap baseline，并以
Top-1、Top-3 和 MRR 设置回归门槛。该 synthetic fixture 只防止明显退化，不替代基于匿名真实调用
构建的长期评测集；纯语义同义词和跨语言查询单独计分，不冒充词法方案已经解决的能力。

### 12.4 加载流程

Host-executed flow：

```text
model calls tool_search
→ Core durably records search call/result
→ validate result binding against same registry generation
→ next model invocation includes selected definitions
```

如果 provider 原生支持 deferred tool loading，`ash-api` 可以把同一 `LoadableToolSpec` 编码成
provider feature，但 provider 返回的 loaded tool 仍必须关联 frozen binding。Provider 不能加载
host registry 中不存在的 tool。

## 13. Plugin 与 Connector 发现

### 13.1 与工具搜索分离

Plugin discovery 面向“当前不可执行、可能需要安装或启用的扩展能力”：

```text
tool_search
  = 在当前已授权 registry 内找 callable tool

plugin discovery
  = 在 Plugin/Connector catalog 中找候选扩展
```

Plugin discovery result 永远不是 `ToolDefinition`，不能直接进入 model tool set。

### 13.2 共享发现值

`ash-tools` 只定义跨 Plugin manager、App Server 和 Agent-facing helper 共享的纯值：

```rust
pub enum DiscoverableCapability {
    Plugin(DiscoverablePluginInfo),
    Connector(DiscoverableConnectorInfo),
}

pub enum DiscoveryAction {
    Install,
    Enable,
    Connect,
}

pub struct DiscoverablePluginInfo {
    pub id: PluginDiscoveryId,
    pub display_name: String,
    pub description: String,
    pub has_skills: CapabilityPresence,
    pub mcp_servers: Vec<DiscoveryContributionName>,
    pub connectors: Vec<ConnectorDiscoveryId>,
    pub action: DiscoveryAction,
}
```

这些值是 catalog projection，不是 Plugin authority record。Exact version、digest、origin、
permissions 和 credential slots 必须在真正 install/enable command 前由 Plugin manager 再读取并
展示。

### 13.3 面向 Agent 的辅助程序工具

当前已实现的是 generation-bound discovery snapshot、client capability filtering 和 typed request；
这些值本身不能成为 `ToolDefinition`。以下两个 Agent helper 仍是下一阶段接线：

```text
list_available_plugins_to_install
request_plugin_install
```

但其语义必须是：

- list 读取 App Server 提供的 immutable discovery snapshot；
- request 产生 typed interaction/Plugin command intent；
- install/enable 需要用户确认和 exact candidate；
- helper 不下载 package、不写 Config、不授予 permission；
- Plugin manager 返回成功后，Tool registry 仍等到新的 activation/MCP generation 在 safe point
  发布；
- 安装完成不等于相关 MCP server 已 Ready。

客户端差异通过 typed `ClientCapabilities` 过滤，不通过 `"tui"` 等 client-name 字符串硬编码。

## 14. 代码模式

### 14.1 定位

Code mode 是普通工具集合的另一种模型调用表示：模型通过一个 code execution surface，在代码中
调用多个 nested tools。它不是第二套 tool runtime，也不是 approval/sandbox 旁路。

`ash-tools` 拥有：

- `ToolSpec → CodeModeToolDefinition` 的纯投影；
- namespace/name normalization 和 collision table；
- description 中 code-mode 调用示例的确定性增强；
- eligible nested tool 收集和排序；
- nested payload/result 与普通 `ToolPayload` / `ToolOutput` 的转换；
- tool output image detail 的统一 sanitize。

它不拥有：

- code cell/session lifecycle；
- JavaScript/Python/Wasm runtime；
- execute/yield/wait/cancel；
- remote code-mode host transport；
- nested tool dispatch、approval 或 durable commit；
- cell recovery 和 resource accounting。

这些由独立 code-mode runtime 和 Core adapter 拥有。

### 14.2 投影

```rust
pub struct CodeModeToolBinding {
    pub code_name: CodeModeToolName,
    pub binding_id: ToolBindingId,
    pub definition_digest: ToolDefinitionDigest,
    pub definition: CodeModeToolDefinition,
}
```

映射必须：

- 基于 frozen registry snapshot；
- 对 namespace 和 leaf name 做规范化；
- collision check 后保存显式 mapping table；
- 不依赖运行时把 `namespace__name` 反向猜回 `ToolName`；
- 排除 `Hidden`、`DirectModelOnly`、provider-hosted 和不能安全嵌套的 tool；
- 保留 input/output schema；
- 对相同 snapshot 产生稳定排序。

### 14.3 嵌套调用路径

```text
model emits code-mode execute call
→ Core durably records outer call
→ code runtime parses/starts cell
→ nested call references CodeModeToolBinding
→ adapter materializes ordinary ToolInvocation
→ normal approval / durable nested Tool Call / ToolService dispatch
→ ToolOutput converted to code-mode result
→ cell continues/yields/terminates
→ outer Tool Result durable commit
```

每个 nested call 必须拥有独立 `ToolCallId` / `ToolOperationId` 和可审计 lifecycle。Code runtime
不能拿到裸 executor map 后直接执行副作用。

outer call 与 nested calls 的 transcript 展示可以由客户端折叠，但 durable facts 不能只保留一段
opaque code output，使内部副作用不可恢复。

当前实现提供 `Direct`、`CodeMode` 和 `CodeModeOnly` 三种持久化模式。模型侧的 `exec`/`wait` 控制
工具驱动 V8 cell；JavaScript 只得到 `text/image/store/load/notify/yield/exit` 和冻结后的 `tools`
投影，不得到文件、网络或进程接口。每个 nested call 写入普通 durable Tool Call，caller 记录 parent
call、cell ID 和 runtime call ID，再由同一个 `ToolScheduler` 处理审批、执行、取消和结果提交。

默认运行时内嵌在进程内；显式选择 Host 时使用版本 2 的 4 字节 little-endian 长度帧 stdio 协议。
Host 通过 `CancelCellTools` 立即取消父进程中的工具回调，不等待下一次 wait。Host EOF、
运行时 panic 或已开始调用的传输失败会关闭 session 并产生 unknown outcome，不自动重放。Cell 本身
不跨进程恢复；重启后旧 cell 不可继续等待。首版结果支持文本和图片，不扩展音频协议。

### 14.4 模型上下文与资源

- nested Tool Call/Result 完整持久化，但不进入模型上下文、输入计量或历史压缩；模型只接收外层
  `exec`/`wait` 的显式输出。
- 每个 cell 冻结自己的可嵌套工具目录与绑定；同一 Turn 中后续 cell 可以使用搜索后激活的工具。
- 模型通过 `ALL_TOOLS` 的 name、description 和 inputSchema 发现工具；只向模型打印所需条目。
- `maxOutputTokens` 限制单次观察返回的文本，默认 10000；无 provider tokenizer 时用 UTF-8
  字节保守估算；图片保持完整并受运行时输出字节上限约束。它不改变 cell 的执行限额。终态输出消费后关闭 cell，重复 wait 返回不可用。
- 正常完成、异常、exit、超时与显式终止都会取消未完成的嵌套调用；取消不能撤销已经发生的副作用。
- 每个 Thread 的共享 JSON store 上限为 16 MiB；`store(key, undefined)` 删除键。Session 停止、
  归档或删除时释放其运行时与存储。Host 快照替换包含删除结果，不能合并回已删除的键。

### 14.5 结果结构

- 普通文本结果始终保持 string，包括看起来像 JSON 的文本；需要解析时由脚本显式 JSON.parse。
- 结构化内容返回 `{text, content, isError}`，保留内容与错误状态；纯文本工具失败拒绝 Promise。
- image/resource 使用统一 `ToolContent`；
- MCP result 保留 content、structured content、is-error 和 provenance；
- output truncation 在 code-mode budget 与普通 tool output budget 两层都可解释；
- cell yield 不是 Tool Result terminal outcome；
- code runtime crash 后，已开始的 nested side effect 仍按普通 uncertain-outcome 规则处理。

## 15. 图片精度

### 15.1 为什么属于共享工具层

图片可以来自 built-in tool、MCP、dynamic owner、code mode 或 future connector。它们最终进入同一
provider-neutral model context。若每个 source/provider 分别降级 `Original`，同一图片会得到不一致
行为，因此 capability normalization 放在 `ash-tools`。

### 15.2 请求与决策

保留 canonical：

```text
Auto / Low / High / Original
```

“未指定”使用具名选择，而不是把 `None` 的语义散落在调用方：

```rust
pub enum ImageDetailSelection {
    ProviderDefault,
    Explicit(ImageDetail),
}

pub struct ImageDetailDecision {
    pub requested: ImageDetailSelection,
    pub effective: ImageDetailSelection,
    pub reason: ImageDetailDecisionReason,
}
```

`ImageDetailDecisionReason` 至少区分：

- `Supported`；
- `ProviderDefaultSelected`；
- `OriginalUnsupportedDowngraded`；
- `SourcePolicyDowngraded`。

### 15.3 规范化

输入：

```text
requested detail
+ resolved model capability snapshot
+ source/content policy
= effective detail + diagnostic
```

规则：

- model 支持 `Original` 时保留；
- model 不支持时默认降级为 `ProviderDefault`；未来若引入其他 fallback，必须使用全局具名
  policy，不能由各 adapter 自由选择；
- `Low` / `High` 不因 provider default 改写；
- `Auto` 与 `ProviderDefault` 保持不同语义；
- provider wire adapter 只编码 `effective` value；
- model invocation 前再次 sanitize 所有 tool output image，防止 MCP/dynamic/code-mode path 漏检；
- downgrade 是可观察 diagnostic，不伪装成原精度已发送。

`Original` 只控制模型读取精度，不授予读取本地文件、绕过 Resource ownership 或发送无限原始
bytes 的权限。

### 15.4 图像安全

共享图片字节的解码、资源限制、缩放、重编码、metadata policy 与 bounded cache 由
[`ash-utils-image`](../../crates/utils/image/README.md) 实现；本节拥有跨 Core、Tool、模型与
provider 的安全和策略边界，crate README 拥有具体实现契约。

- data URL、remote URL 和 durable attachment reference 使用不同 typed source；
- 限制 decoded bytes、pixel count、dimensions、frame count 和 MIME；
- SVG、animated image 和 metadata 使用明确 policy；
- remote URL fetch 属于 host-owned `ash-attachments` admission，不在 `ash-tools`；它使用 direct
  transport、DNS-time public-address enforcement、逐跳 redirect 复核和 bounded body；
- 接受后的图片以 content digest + 验证后的媒体元数据进入 Thread；只有 model invocation adapter
  才把 verified bytes 临时 materialize 为 provider data URL；
- telemetry 不记录完整 data URL 或图片 bytes；
- dynamic/MCP adapter 若携带 image detail，它也只是请求；未携带时使用
  `ImageDetailSelection::ProviderDefault`，最终均由 model capability normalization 决定。

## 16. 供应商适配器

`ash-tools` 保持 provider-neutral；`ash-api` 负责：

```text
ToolSpec + ModelCapabilitySnapshot
  → OpenAI Responses / Chat Completions / Anthropic wire tools

provider tool call/result
  → canonical ToolCall / provider-neutral content
```

共享层负责提供确定性输入，provider 层负责 wire 差异：

| 能力                   | `ash-tools`                         | `ash-api`                                |
| ---------------------- | ----------------------------------- | ---------------------------------------- |
| name/schema validation | canonical 规则                      | provider-specific final gate             |
| namespace              | binding 与 flatten plan             | wire encoding                            |
| strict schema          | typed intent/capability requirement | provider bool/field                      |
| deferred loading       | search/loadable spec                | native feature encoding 或 host fallback |
| freeform               | canonical format                    | provider grammar/custom tool DTO         |
| image detail           | effective decision                  | provider string/field                    |
| output content         | `ToolOutput`                        | provider request item                    |

Provider adapter 不能：

- 重新选择 tool alias；
- 从 live registry 加载 definition；
- 将 unsupported schema 静默变宽；
- 把 provider call ID 当 canonical `ToolCallId` 而不经过 validation；
- 对同一个 Tool Result 产生与其他 provider 不同的业务 success/error 语义。

## 17. 安全、策略与可观察性

### 17.1 信任

以下全部默认不可信：

- Tool description 和 schema；
- MCP annotation/result；
- dynamic tool definition/result；
- Plugin discovery metadata；
- code-mode source 和 nested arguments；
- remote image/resource URL；
- provider 返回的 tool arguments。

Definition validation 不等于 invocation approval，Plugin signature 不等于 tool 安全，MCP
`readOnlyHint` 不等于 host `SafeRead`。

### 17.2 Secret 与日志

共享 output/log helper 必须：

- 默认只生成 bounded preview；
- 区分 model-visible output、audit metadata 和 telemetry preview；
- 对 credential、authorization header、cookie、data URL 和 filesystem path 执行 redaction；
- 不把完整 arguments/output 放进普通 error display；
- 允许 source adapter 提供 typed sensitive-field markers；
- 不因 serialization error fallback 输出整个 raw payload。

### 17.3 策略输入

`ToolExecutionMetadata` 可以携带 source claim 和 host-derived classification：

```text
source claim
  read-only / destructive / idempotent / open-world

host classification
  effect class / approval requirement / retry eligibility / resource conflicts
```

Core/host policy 只信任后者。Source claim 只用于 diagnostic 和保守收紧。

### 17.4 查看工具目录与范围诊断

普通 Workbench 与 Agent Window 设置页暂不显示完整工具清单。
用户仍通过已有权限、沙箱、连接与扩展入口管理对应行为；本次文档不增加配置入口。

开发者在**命令面板**运行：

- 中文：**开发者：查看 Agent 工具目录**
- 英文：**Developer: Show Agent Tool Catalog**
- 命令 ID：`workbench.action.chat.showToolCatalog`

该入口在正式版本也可用，不要求开发构建。每次运行读取新注册目录并打开独立只读 JSON 快照，
包括 `profiles`、`toolSets`、来源、exposure、authority 和说明字段；`kind: source` 表示来源分组，
`kind: capability` 表示能力集合。现有输出仍含遗留的 `categories`／`unclassified`，后续随分类字段迁移，
不能将当前快照解读为已经使用本文的目标业务分组。

目标目录围绕业务 ToolSet 展示成员，并单独保留来源、绑定、暴露方式和宿主可用条件；
Tasks、发现与 Code Mode 均按各自 ToolSet 展示；Code Mode 的 Core 目录也需纳入完整视图，来源汇总不能冒充业务集合。
真实 Turn 的允许名单、加载状态与拒绝原因需从该 Turn 的快照诊断，不能从注册目录推断“当前可调用”。
现有命令不允许编辑配置，也不提供完整的实时 Turn 权限诊断。
实现入口：[开发者目录命令](../../src/ash/workbench/contrib/preferences/browser/preferencesActions.ts)。

## 18. 错误契约

至少区分：

```text
ToolDefinitionInvalid
ToolSchemaTooComplex
ToolSchemaUnsupported
ToolNameReserved
ToolNameCollision
ToolBindingStale
ToolUnavailable
ToolArgumentsInvalid
ToolOutputInvalid
ToolOutputTooLarge
ToolExecutionNotStarted
ToolExecutionFailed
ToolOutcomeUncertain
ToolSearchQueryInvalid
ToolSearchOverloaded
PluginDiscoveryUnavailable
DynamicToolOwnerUnavailable
CodeModeUnsupportedTool
CodeModeBindingCollision
ImageDetailDowngraded
InternalToolInvariant
```

职责：

- `ash-tools` 产生 definition/schema/adapter/binding 错误；
- source runtime 产生 transport/executor detail；
- Core 映射 approval/retry/recovery/Turn outcome；
- App Server 映射 stable RPC error；
- provider adapter 产生 provider capability/wire error。

内部错误可以保留 source chain，但 public error 不泄露 secret、raw MCP frame、Plugin writable path、
完整 arguments 或 output。

## 19. 目标目录与公开 API

第一版保持一个 crate，模块默认 private，`lib.rs` 只做精确导出：

```text
crates/tools/src/
├── lib.rs
├── error.rs
├── identity.rs
├── definition/
│   ├── mod.rs
│   ├── model.rs
│   ├── schema.rs
│   ├── spec.rs
│   └── validation.rs
├── registry/
│   ├── mod.rs
│   ├── binding.rs
│   ├── builder.rs
│   ├── snapshot.rs
│   └── provenance.rs
├── execution/
│   ├── mod.rs
│   ├── invocation.rs
│   ├── executor.rs
│   ├── output.rs
│   └── outcome.rs
├── adapters/
│   ├── mod.rs
│   ├── protocol.rs
│   ├── mcp.rs
│   └── dynamic.rs
├── search/
│   ├── mod.rs
│   ├── index.rs
│   ├── query.rs
│   └── loadable.rs
├── discovery/
│   ├── mod.rs
│   ├── model.rs
│   └── install_request.rs
├── code_mode/
│   ├── mod.rs
│   ├── definition.rs
│   ├── naming.rs
│   └── output.rs
├── image_detail.rs
└── *_tests.rs
```

目录只随 vertical slice 创建，不预建空模块。每个 implementation 的测试放在 sibling
`*_tests.rs`，并使用：

```rust
#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
```

目标 public API 只包含：

- validated definition/schema/spec；
- registry snapshot/binding/provenance；
- invocation/payload/output/outcome；
- `ToolExecutor` 和必要 future 类型；
- MCP/dynamic/protocol pure adapters；
- search/discovery values；
- code-mode/image-detail pure helpers。

不公开：

- mutable global registry；
- executor concrete map；
- MCP SDK wire DTO；
- Plugin manager record；
- provider Responses/Anthropic DTO；
- Core TurnContext/ThreadController；
- secret/resource concrete handle；
- unchecked schema constructor。

若 code-mode runtime、MCP adapter 或 search engine 后续形成独立重量级依赖，应提取独立 crate，
但 `ash-tools` 仍只保留窄 bridge contract。第一版不创建 `tools-common`、`tools-types`、
`tool-runtime` 等无独立消费者的小 crate。

## 20. 迁移顺序

### 阶段 T0：固定共享边界（完成）

- ✅ 创建 `ash-tools`；
- ✅ 复用 protocol `ToolName` / `ToolCallId`，不复制 identity；
- ✅ 建立受限 schema parser、`ToolDefinition`、function/freeform invocation 与基础 output content；
- ✅ 为当前 protocol `ToolDefinition/ToolResult` 提供 adapter；
- ✅ 为 dynamic tool 与 wire-neutral MCP projection 提供 definition adapter；
- ✅ 加入 schema/name/output fixture。

完成条件：OpenAI/Anthropic 当前 function tool request round-trip 不回归，且新 crate 不依赖 Core。

### 阶段 T1：执行器与注册表（主执行链已接入）

- ✅ 定义 `ToolBinding`、`ToolExecutor`、materialized invocation、cancellation context 与 outcome；
- ✅ built-in process、direct filesystem suite 与 `apply_patch` tool 实现 executor contract；
- ✅ App Server 构造 immutable registry snapshot，并在 Directory replacement 时单调递增 generation；
- ✅ Core `ToolService` adapter 按 frozen binding/runtime key 路由，并把 durable Turn facts 投影为 `ToolInvocation`；
- ✅ prepared call 在 hot reload 后继续使用原 Tool/Policy generation，sandbox retry 不切换 generation；
- ✅ definitions 与 execution route 由同一个 immutable registry snapshot 产生，不按 live name 直接猜 service。

完成条件：registry 更新不能劫持 in-flight call，stale binding 被明确拒绝。

### 阶段 T2：MCP 与动态适配器（MCP/动态与 durable 来源主链完成）

- ✅ `ash-mcp` 输出 `McpToolProjection` 并建立 immutable catalog/binding；
- ✅ 接通 MCP schema/name/result conversion 与调用取消；
- ✅ MCP App Server/Core adapter 接入逐次 approval、durable commit 和 unknown outcome；
- ✅ MCP host integration 从 App Server 私有模块提取到 `crates/ext/mcp`；App Server 仅组合和 safe-point replacement；
- ✅ dynamic definition 进入共享 registry，execution 经过 approval、durable interaction 与 Tool Result commit；
- ✅ dynamic request 固定 definition digest、call id、name 与 arguments；同名新定义不能认领旧 response；
- ✅ 多连接 delivery 还按 initialize capability 的 exact dynamic tool name 选 owner；
- ✅ 已投递 dynamic owner 断连/退订后不重新分配，按 unknown outcome 且不重试收口；
- ✅ Tool Call durable provenance 保存 registry generation、definition digest、source chain 与 caller；
- 部分具备：MCP transport-lost 已覆盖；dynamic owner-disconnect 已覆盖 broker/Core continuation，
  仍需补持久化重启的完整端到端 fixture。

完成条件：MCP/dynamic 工具都不能绕过普通 approval、commit 和 recovery。

### 阶段 T3：工具搜索与 Plugin 发现

- ✅ deferred exposure 和 deterministic search index；
- ✅ host tool-search vertical slice；
- ✅ Core 根据 successful durable search result 在下一 model step 增量暴露定义；
- ✅ `ReadOnlyToolContributor` 产出的 host extension executor 进入共享 registry/policy/runtime（当前包括统一的 `skills-read`）；
- ✅ `CapabilityToolContributor` 冻结 exact network/credential scope，并通过普通一次性 approval 执行；
- ✅ `ext/web-search` 提供 eager `web_search`、可注入 backend 和默认关闭门禁；
- ✅ `ext/connectors` 统一管理 Connector 账号连接、目录发现与就绪 MCP 绑定；
- ✅ enabled connector/MCP catalog 与 local/dynamic/extension port 做统一 collision check；
- ✅ Plugin/Connector catalog-only discovery value、generation-bound snapshot 与 local Plugin projection；
- ✅ typed install/enable/connect request 和通用 client capability filtering；
- ✅ local Plugin package store 已完成 staging、copy-time identity check、digest 复验和 content-addressed
  atomic promotion；
- 尚未完成：Connector OAuth/connect/revoke、默认生产 Web Search provider、Agent helper、用户确认
  interaction 与 Plugin 安装/启用 authority；dynamic owner 的 exact
  tool-name filtering 已完成。

完成条件：search 只返回当前 registry 工具，Plugin discovery 不产生可执行 binding，install 无隐式
grant。

当前受控检索回归包含 20 个代表工具、140 个 collision/distractor 工具和中英文 semantic cases：

| 路径                      |              Corpus | Top-1 | Top-3 | 说明                                                |
| ------------------------- | ------------------: | ----: | ----: | --------------------------------------------------- |
| BM25                      |                  20 |   95% |  100% | 默认、离线、零模型成本                              |
| BM25                      |                 160 |   91% |  100% | 验证大 catalog 下的 lexical precision               |
| BM25                      | 10 个中文/同义 case |    0% |    0% | 明确暴露纯词法边界                                  |
| controlled semantic + RRF |                同上 |  100% |  100% | 验证 hybrid 编排；不代表任何具体 embedding 模型质量 |

真实 embedding 的模型质量必须按具体 provider/model 另做可重复 eval；CI 中的 controlled semantic
ranking 只证明 gate、document embedding、cosine ranking 和 hybrid merge 接线不会退化成伪 fallback。

### 阶段 T4：代码模式

- ✅ code-mode definition projection、naming/collision table；
- ✅ nested call 写入 durable binding 并重新进入普通 ToolScheduler path；
- ✅ structured/MCP/image result adapter；
- ✅ exec/wait、V8 cell lifecycle、yield/terminate、并发 nested calls 和 uncertain outcome；
- ✅ 内嵌运行时与可选 stdio Host、帧大小/版本/EOF 校验；
- ✅ Cargo/Bazel 的 sandbox-enabled V8 输入锁定，以及 Desktop/发布 Host 打包；
- 明确推迟：音频结果、gRPC Host 和崩溃后 cell 重放。

完成条件：code mode 的任意 nested side effect 都可审批、可审计、可取消，并具有准确恢复语义。

### 阶段 T5：图片精度与供应商能力收敛

- ✅ 统一 `ImageDetailSelection/Decision`；
- ✅ model invocation 最终 capability gate；
- ✅ provider adapter 只接收 effective detail；
- ✅ Tool Executor/MCP/dynamic output 统一转为 durable structured content 并 sanitize；
- 部分具备：downgrade decision fixture 已有；data URL byte/pixel/MIME 限制和跨 provider 端到端
  wire fixture 尚未完成。

完成条件：unsupported `Original` 不会到达 provider wire，且调用方能解释实际使用的 detail。

## 21. 验证门

除 directory 常规检查外，必须覆盖：

- invalid/reserved/colliding ToolName；
- schema depth/size/property/enum/ref bomb；
- schema canonicalization 和 digest stability；
- required/additionalProperties/provider strict conversion；
- registry deterministic build、generation、old-snapshot drain；
- stale binding 与同名新 executor 不会互换；
- model ToolCall → materialized invocation → durable item identity；
- tool-level error、not-started 和 uncertain outcome 分类；
- output bytes/content/schema/MIME/resource limit；
- MCP missing properties、outputSchema、isError、protocol error 和 transport loss；
- dynamic owner disconnect、late response 和 RequestId/ToolCallId mismatch；
- deferred search ranking、limit、generation 和 forged result；
- Plugin discovery 与 tool search 隔离；
- install/enable/connect 无隐式 grant；
- code-mode namespace/name collision、nested approval 和 result shape；
- structured JSON 不被意外 stringify；
- image Auto/Low/High/Original capability matrix；
- unsupported Original 的稳定降级；
- telemetry 不泄露 secret、data URL、raw MCP frame 或完整敏感 payload；
- 所有新 test module 使用 sibling `*_tests.rs`。

协议或 provider contract 变化还必须重新生成并提交 JSON Schema、TypeScript 和对应 fixtures。

### 21.1 能力组合与范围的待实现事项

以下事项尚待实现或补齐；验收场景不代表已经完成对应验证。

| 优先事项 | 需要完成的行为 | 验收场景 |
| --- | --- | --- |
| 可信产品范围 | 将可信上下文上限与可选输入 Profile 分开 | 缺省 Scope、改填其他 Profile、桌面／TUI／无窗口入口都不能扩大上限 |
| 外部贡献接纳 | 明确产品对精确来源及未来新增工具的接纳规则 | 新 MCP、同名不同来源、连接更换、未授权集合声明 |
| 生命周期 | 联合验证 Turn 名单、请求绑定及实时撤权 | 新增工具、热更新、停用、断连、迟到结果及不确定写入 |
| 集合与客户端条件 | 落实 26 个无前缀集合及拆分成员，统一发现／Code Mode 入口目录，保留实际客户端条件 | 86 个工具都有集合归属；两份文档成员一致；旧选择不扩大范围；Tasks 与 Shell 独立；无窗口与指定 IDE 场景 |
| 遗留分类迁移 | 移除分类模型、Scope 分类筛选及目录分类展示，保留或明确拒绝旧输入的既有限制 | 旧读取筛选不会带入修改工具；分类字段未迁移前不声称已删除；目录按业务组展示 |
| 默认与可选组合 | 实现[默认与可选规则](#默认启用与可选组合)，发现与 Code Mode 也服从显式范围和禁用项 | 交互式／无人值守 Code；远程任务默认关闭；空 Scope；只选发现不获目标；CodeModeOnly 缺入口报冲突；资源批准不扩名单 |
| 操作级限制 | 需要限制复合工具某些动作时接入真实动作策略 | 自动化只读范围不能保存／运行；环境读取范围不能写入／执行 |
| 诊断 | 从真实 Turn 解释排除原因与绑定目标 | 区分未安装、未启用、范围外、未加载、断连与权限拒绝 |

跨集合成员复用按真实组合需求实现；搜索增量索引按性能测量安排。不为满足固定集合数量注册空组或复制工具实现。

## 22. 固定决策

- `ash-tools` 是共享类型与纯适配层，不是第二个 Core；
- `ToolName` 是 model-facing alias，不是 source/executor identity；
- `ToolCall` 与 materialized `ToolInvocation` 是不同生命周期；
- Core 的 `ToolService` port 与工具作者的 `ToolExecutor` interface 分开；
- definition、binding、registry snapshot 在 model safe point 冻结；
- in-flight call 永远按原 binding 执行，不按 name 重查 live registry；
- MCP wire/lifecycle 属于 `ash-mcp`，MCP-to-tool pure conversion 属于 `ash-tools`；
- Plugin authority/install/grant 属于 `ash-core-plugins`，discovery DTO 不拥有 mutation；
- tool search 只搜索已安装、已授权、当前可用的 deferred tools；
- Plugin discovery 不能直接产生 executable ToolDefinition；
- dynamic tool 不绕过 schema、registry、approval 或 durable interaction；
- code mode 是普通工具调用的另一种表示，不是执行旁路；
- nested code-mode tools 继续使用普通 binding、approval、commit 和 recovery；
- tool output 使用 typed content/structured value，不让各 provider/executor 自定义 wire JSON；
- `Original` 图片精度只在 model capability 支持时保留；
- provider adapter 只编码 effective tool/image value，不重新做 host policy；
- 所有 schema、description、arguments、outputs 和 discovery metadata 默认不可信；
- `ash-tools` 不读取 Config、Plugin/MCP live manager、credential、ThreadStore 或 provider client；
- 新 public trait 必须带角色和实现约束 doc comment；
- 新 API 不使用让调用方写出 `foo(false)` / `bar(None)` 的含糊参数；
- 模块默认 private，`lib.rs` 精确导出，implementation tests 放 sibling 文件。

新增的 Goal、Agent、历史笔记、图片和等待工具，以及对应扩展职责见 [Agent 扩展](../../crates/docs/extensions.md)。
