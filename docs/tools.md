# 工具系统

> 计划物理位置：`ash-rs/tools/`  
> Rust crate：`ash_tools`  
> 当前状态：T1 主链完成，T2 MCP/dynamic 主链完成；MCP host runtime 已提取到 `ext/mcp`。T3 的
> Tool Search、capability-bearing extension、Connector discovery projection、Plugin catalog projection 与
> typed discovery request 已接入共享契约；`ext/web-search` 已提供默认关闭、宿主注入 backend 后才注册的
> `web_search` 工具。Tool Call 已持久化 registry
> generation、definition digest、source chain 与 direct/code-mode caller；Tool Result 已能持久化结构化
> 图片内容。Code Mode 已完成 exec/wait、V8 cell runtime、durable nested-call broker 和可选 stdio Host；
> Plugin local content store 已落地，但安装 authority、activation、grant，以及 dynamic owner 断连后的持久化重启
> 端到端 fixture 仍未完成。
> Canonical value 与 durable Tool Item：[`protocol.md`](protocol.md)  
> Core 调度、approval 与恢复：[`core.md`](core.md)  
> MCP client runtime：[`mcp.md`](mcp.md)  
> Plugin authority：[`plugins.md`](plugins.md)  
> Config 与 runtime snapshot：[`config.md`](config.md)  
> Provider wire adapter：[`ash-api.md`](ash-api.md)

## 快速理解

工具系统把本地工具、MCP 和动态来源转换成统一、可验证的能力目录；它定义和绑定工具，但最终
授权、执行顺序与持久化仍由相邻系统负责。

| 读者首先会问 | 直接答案 | 深入阅读 |
| --- | --- | --- |
| 不同来源的工具为什么能统一调用？ | 每个来源先转换成统一定义、规格、绑定和调用值 | [三层工具契约](#3-三层工具契约) |
| 工具名称就是执行身份吗？ | 不是；稳定身份还包含来源、绑定和快照 generation | [身份、来源与绑定](#5-身份来源与绑定) |
| Agent 当前能看到哪些工具？ | 由不可变注册表快照和暴露范围决定，运行中不会被静默改写 | [注册表与快照](#7-注册表与快照) |
| 谁决定工具能不能执行？ | 权限系统决定授权；Core 调度；工具执行器落实调用 | [当前本地工具来源](#41-当前本地工具来源运行时) |
| 当前完成到哪里？ | 统一 registry/executor/search、durable provenance、结构化图片和 Code Mode 主链已落地；Plugin 安装 authority 尚未完成 | [当前仓库审计](#2-当前仓库审计) |

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
- Plugin 安装、启用、grant、版本、digest、marketplace 或 package store；
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
  和产品连接入口也已落地；完整状态见 [外部服务连接系统](connectors.md)。Plugin activation
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

| 层 | Owner | 典型类型 | 生命周期 |
| --- | --- | --- | --- |
| Canonical product contract | `ash-protocol` | `ToolName`、`ToolCallId`、durable Tool Item、dynamic interaction | 可序列化、可持久化 |
| Host tool contract | `ash-tools` | `ToolDefinition`、`ToolSpec`、binding、invocation、output、executor | process-local 或 snapshot-scoped |
| Execution orchestration | `ash-core` | `ToolScheduler`、`ToolService` port、approval、retry、recovery | Turn/operation-scoped |

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
- `ash-file-system → ash-tools + ash-sandboxing`；
- `ash-tui → ash-file-search`；后者提供只读路径索引，不依赖 `ash-tools`，也不注册为模型
  Tool；
- catalog/runtime manager 可依赖 `ash-file-watcher` 获取 coarse invalidation hint；后者不依赖
  `ash-tools`，不读取文件内容，也不注册为模型 Tool；
- `ash-apply-patch → ash-tools + ash-sandboxing`；
- `ash-action-policy → ash-execpolicy + ash-sandboxing`；
- `ash-execpolicy` 不依赖 sandbox、Core、Tool 或配置 I/O；
- `ash-guardian-reviewer → ash-action-policy + ash-sandboxing`；
- 本地进程执行器只依赖 `ash-sandboxing` 契约；产品组合注入 `mxc-sandbox`，平台细节留在适配器；
- `ash-api → ash-tools + ash-protocol`；
- App Server 组合 Tool registry、source runtime、policy 和 Core port。

Sandbox backend 的内部调度、平台 crate 边界和 fail-closed 规则见
[`sandboxing.md`](sandboxing.md)。这里的 sandbox manager 不是 Core `ToolScheduler`。
Action classifier、exact grant 与最终 execution decision 见
[`auto-review.md`](auto-review.md)。

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

| Crate / tool name | 可做的事 | 明确不做的事 |
| --- | --- | --- |
| `ash-shell-command` / `shell-command` | 在批准的相对 Directory 工作目录执行显式 program/arguments；复用 `ash-tool-executor` 的 approval、timeout 和输出上限 | 不隐式启动 shell，不绕过 process policy |
| App Server `LocalToolSuite` / `read_file`、`write_file`、`edit`、`grep`、`glob` | Thread-scoped 读后写入、conditional atomic 单文件写入和受控搜索 | 不暴露 operation enum；断线恢复后必须重读才能恢复内存中的文件 fingerprint |
| `ash-file-system` / 非 Agent 基础库 | 提供 directory-scoped 条件写入与 host-only filesystem 能力 | 默认 coding profile 不暴露 `file-system` 工具 |
| `ash-apply-patch` / `apply_patch` | 预检后更新、添加或删除普通文件；replacement 按文件原子写入 | 不接受绝对/`..` 路径，不直接提供任意写入 API；多文件提交不承诺事务性 |

这些 owner 均在构造时固定 `ToolEnvironmentId + DirectoryRoot`，要求它与
`ToolExecutionContext.environment_id` 一致，且只接受与自身 `ToolDefinition` digest 相符的冻结
binding。`apply_patch` 在所有 hunk 校验完成前不写入；
若多文件 commit 中途失败，返回 `OutcomeUncertain`，由 Core 决定后续恢复语义。

`ash-file-system` 还提供 host-only 的 `find_nearest_ancestor_with_markers`，用于从一个本地路径
向上发现最近的项目 marker。它不是模型 Tool，不读取 marker 配置，也不施加 `DirectoryRoot`
containment；调用方仍拥有项目根语义和搜索边界。实现与错误策略由
[`ash-rs/file-system/README.md`](../ash-rs/file-system/README.md) 维护。

搜索分成 Agent 内容搜索、编辑器内容搜索和交互式路径搜索：

| Surface | 所有权 | 模型可见 |
| --- | --- | --- |
| App Server `LocalToolSuite::grep` | Agent 内容搜索；由 `agent.grepBackend` 在冻结 `rg` 与 `ash-fast-regex-search` 间选择 | `grep` Tool |
| `ash-content-search` + `rg` | 编辑器工作区内容搜索、分页和取消；不读取 Agent grep 配置 | 否 |
| `ash-file-search` | ignore-aware 路径索引、fuzzy matching、`PathSearchHandle` 和 CLI | 否 |
| `ash-file-watcher` | 多订阅者路径失效提示、missing-path fallback、throttle/debounce 与 overflow rescan hint | 否 |

模型侧注册独立 `grep` 和 `glob` Tool。`grep` 默认执行冻结的 `rg`；选择 `fastRegex` 后只把 `grep` 切换到本地稀疏 n-gram 索引，`glob` 与编辑器 Search 继续执行 `rg`。交互式路径搜索契约由 [`ash-rs/file-search/README.md`](../ash-rs/file-search/README.md) 维护；TUI 直接持有 `PathSearchHandle`，不启动 CLI，Core 也不把路径搜索注册成 Tool。

`fastRegex` 必须先用覆盖 n-gram 和 posting 交集缩小候选，再读取当前文件做精确验证。产品 App Server 通过私有 UDS 调用按 Directory 常驻的 Fast Regex 子进程，lookup 的 mmap、posting 读取和完整查询都留在子进程，主进程只接收有上限的最终结果。短查询、纯字符类和其他没有必需文字的正则仍会扫描全部已索引文件，但它们也进入与 `rg --line-number` 等价输出的性能底线；稀有、无命中和全量扫描用例任一不快于 `rg`，基准就失败。执行方式在 Tool generation 冻结后不会按单次查询暗中切换。基准入口和当前存储契约由 [`ash-fast-regex-search`](../ash-rs/fast-regex-search/README.md) 维护。

普通文件变化直接写 delta；`.gitignore`、`.ignore`、`.git/info/exclude` 变化或 watcher overflow 会重新核对
当前可索引文件集合，只发布实际增删改。只有 delta 需要压缩、格式不兼容、索引损坏或无法可靠计算差异时
才重建 base。手动重建期间旧 generation 继续服务；普通“关闭”切回 `rg` 并保留磁盘数据，“关闭并删除”
在配置提交后释放 worker，再通过跨进程独占锁删除。

`ash-file-watcher` 同样不是搜索或读取接口。它只把 OS mutation/error 转成
`PathsChanged`/`RescanRequired`；consumer 必须重新扫描并校验 own state。其 ref-count、路径匹配、
RAII 与 failure contract 由
[`ash-rs/file-watcher/README.md`](../ash-rs/file-watcher/README.md) 维护。

当前 local App Server 启动时通过 `ash-install-context` 按 `ASH_RG_PATH`、package
`ash-path/`、Ash executable 同目录、host `PATH` 的顺序生成 `rg` candidates，再由
`ash-shell-command` 验证并冻结 canonical executable identity；未找到时启用本地工具的
composition 直接失败。canonical release package 由
[`build/package/build.py`](../build/package/build.py) 按
[`third_party/ripgrep/runtime-lock.json`](../third_party/ripgrep/runtime-lock.json) 下载并校验
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
[`ash-rs/shell-command/README.md`](../ash-rs/shell-command/README.md)。

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

Exposure 不表示 authorization。`Direct` 工具仍可在具体 invocation 时要求 approval。

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

- Turn/model invocation 只读取冻结 snapshot；
- model 产生的 Tool Call 必须在产生它的 invocation snapshot 中解析；
- MCP list-changed、Plugin update、dynamic tool removal 不改变 in-flight binding；
- old snapshot 持有 runtime lease，直到其 model calls 和 Tool invocations drain；
- 新工具默认只在下一个 model safe point 生效；
- policy 的单调收紧可以取消旧 invocation，但不能将旧 binding 静默换成新 executor。

`ToolRegistrySnapshot` 是 process-local 派生值，不进入 Config document 或 Thread event。只有调用
恢复所需的稳定 provenance 进入 durable fact。

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

它不搜索 marketplace 中未安装的 Plugin，也不触发 install、enable、connect 或 credential flow。

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

`ash-rs/tools/src/registry_search_eval_tests.rs` 保存一份跨 coding、GitHub、Slack、Calendar、
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

默认运行时内嵌在进程内；显式选择 Host 时使用 4 字节 little-endian 长度帧 stdio 协议。Host EOF、
运行时 panic 或已开始调用的传输失败会关闭 session 并产生 unknown outcome，不自动重放。Cell 本身
不跨进程恢复；重启后旧 cell 不可继续等待。首版结果支持文本和图片，不扩展音频协议。

### 14.4 结果结构

- structured JSON 保持 JSON，不先 stringify 再 parse；
- text 保持明确 string；
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
[`ash-utils-image`](../ash-rs/utils/image/README.md) 实现；本节拥有跨 Core、Tool、模型与
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

| 能力 | `ash-tools` | `ash-api` |
| --- | --- | --- |
| name/schema validation | canonical 规则 | provider-specific final gate |
| namespace | binding 与 flatten plan | wire encoding |
| strict schema | typed intent/capability requirement | provider bool/field |
| deferred loading | search/loadable spec | native feature encoding 或 host fallback |
| freeform | canonical format | provider grammar/custom tool DTO |
| image detail | effective decision | provider string/field |
| output content | `ToolOutput` | provider request item |

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
ash-rs/tools/src/
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
- ✅ MCP host integration 从 App Server 私有模块提取到 `ash-rs/ext/mcp`；App Server 仅组合和 safe-point replacement；
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

| 路径 | Corpus | Top-1 | Top-3 | 说明 |
| --- | ---: | ---: | ---: | --- |
| BM25 | 20 | 95% | 100% | 默认、离线、零模型成本 |
| BM25 | 160 | 91% | 100% | 验证大 catalog 下的 lexical precision |
| BM25 | 10 个中文/同义 case | 0% | 0% | 明确暴露纯词法边界 |
| controlled semantic + RRF | 同上 | 100% | 100% | 验证 hybrid 编排；不代表任何具体 embedding 模型质量 |

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

新增的 Goal、Agent、历史笔记、图片和等待工具，以及对应扩展职责见 [Agent 扩展](../ash-rs/docs/extensions.md)。
