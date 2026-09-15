# Ash Agent 执行架构总体设计

> 状态：Accepted（2026-08-03 整体重审修订，替代此前 Proposed 版本）
> 审查基线：`0df46ca9ff870489b58ebe6a3cbd0b1b8192928a` 加当前工作树改动
> 最后状态核对：2026-08-23
> 适用范围：Session、Thread 执行控制、Agent loop、工具执行、上下文、流式、Provider
> 切换和多 Agent 演进
>
> Cancellation tree 的当前实现与 race semantics 见
> [`ash-async-utils` README](../ash-rs/async-utils/README.md)。

本文是 Agent 执行架构的总入口和跨层演进的权威文档。Core 的 ownership 与 crate 内部分层以
[`core.md`](core.md) 为准；Context 以 [`core-context.md`](core-context.md) 为准；多 Agent 以
[`core-multi-agent.md`](core-multi-agent.md) 为准；canonical 产品契约以
[`protocol.md`](protocol.md) 为准；**harness 产品策略**（提示词组织、工具面选择与注册时机、
上下文裁剪/压缩策略、prompt cache）以
[`agent-harness-design.md`](agent-harness-design.md) 为准；Agent 定义与启动策略以
[`agents.md`](agents.md) 为准；provider 无关的模型目录与候选选择以
[`models-manager.md`](models-manager.md) 为准。本文拥有三件事：**跨层分层与依赖规则、重审后的
关键决策、分阶段实施计划**。

组件状态使用四个显式标记，本文和四篇领域文档共用同一词表：

- `已实现`：有代码与测试证据；
- `部分`：纵向切片存在，声明的完整语义未达成；
- `仅设计`：文档中有设计，代码中零引用；
- `推迟`：明确不做，直到写明的前置条件出现。

## 快速理解

| 审计问题 | 当前结论 | 深入阅读 |
| --- | --- | --- |
| 哪些已经落地，哪些还是纸面设计？ | 单 Agent、durable policy binding、上下文、主力 Provider 流式和多 Agent 纵向切片已实现；完整运行时快照仍为部分设计 | [组件状态总账](#2-组件状态总账) |
| Session 和 Thread 谁是执行边界？ | Session 聚合任务；每个 Thread 独立排序、执行、恢复和持久化 | [分层与执行链](#3-分层与执行链) |
| 执行内核会异步化（tokio）吗？ | 不承诺；保留同步端口 + per-Thread OS 线程，流式经 sink 达成 | [R2](#42-r2同步执行内核流式经-sink) |
| Turn 中途策略会漂移吗？ | 模型选择与 policy revision 都在 `TurnAccepted` 冻结；恢复遇到 revision 变化会 fail closed | [R1](#41-r1策略冻结-durable-化) |
| Agent 请求的模型不可用时怎么办？ | 目标设计是在运行创建前按策略选择同 scope、同 provider 或其他允许 provider 的兼容模型并警告；运行开始后不再换模型 | [`agents.md`](agents.md#41-模型选择与替换)、[`models-manager.md`](models-manager.md#103-模型选择与替换) |
| 上下文溢出怎么办？ | 已由纯 planner 返回显式 overflow/compaction outcome；checkpoint durable commit 后才重规划 | [R3](#43-r3上下文系统裁剪落地) |
| 多 Agent 什么时候做？ | 阶段 D 契约与阶段 E 的上下文模式、委托、消息、等待、取消树、恢复和 UI 投影已落地；会话入口与委托运行共用的 Agent 定义仍按统一契约推进 | [R4](#44-r4多-agent-契约冻结先行)、[`agents.md`](agents.md) |

## 1. 重审结论

### 1.1 经验证保留的决策

以下决策经代码与测试证据验证，不再重开：

- protocol → core → store 分层；App Server 是产品能力唯一外部门禁；Core 不依赖 provider
  wire 类型、storage 实现或 transport；
- Session（membership / lineage / defaults）与 Thread（history / 上下文 / 执行 / 恢复边界）
  的聚合拆分；同 Session 下 Thread 可并行；
- 每 Thread 逻辑单写者 + typed event log + 纯 reducer + command receipt 幂等回放；
- 副作用前 durable（`ToolExecutionStarted`）、unknown outcome 不自动重放、escalation marker
  防止恢复后静默重试；
- explicit incarnation 拒绝迟到/重复/旧实例 completion；空闲回收后从 durable store 重建；
- 模型和工具 I/O 不占用状态提交临界区；通知不早于 durable append；
- 拒绝的抽象继续拒绝：与 rollout 并列的 `CanonicalHistory` store、常驻
  `ProviderLaneRegistry`、把 summary 固化为 `ProviderHandoff` 协议、未定义授权/删除/隔离/
  评测契约的跨 Thread 长期记忆。

### 1.2 修订的决策

本次重审修订四项设计决策，编号 R1–R4；文档形态修订为 R5。详细设计见
[第 4 节](#4-修订决策详细设计)。

| # | 原设计 | 修订立场 | 核心理由 |
| --- | --- | --- | --- |
| R1 | `TurnPolicySnapshot` 为进程内不可变结构 | policy 冻结改为 **durable fact**：Turn 接受时持久化 policy revision，恢复时据此重建 | 进程内快照不能跨 crash-resume 存活；恢复后的 Turn 会从当前配置重建 policy，违反"不得静默放宽"的验收标准。模型选择已经这样做（`TurnAccepted` 携带 model），policy 应对齐 |
| R2 | 端口演进为 async streaming（隐含运行时异步化） | **不承诺 tokio 迁移**：保留同步端口 + per-Thread OS 线程邮箱；真实流式经 wire-level SSE decoder → `ModelStreamSink`；App Server 使用独立 outbound writer 线程 | 桌面级并发上限是几十个 Thread；同步代码对 durability 不变量更易验证；cancellation 已闭环；sink 契约已为流式预留。异步化收益不成比例 |
| R3 | ContextManager 完整形态（cache / baseline / estimate）一步到位 | **裁剪落地**：纯函数 planner + `ContextPlan` 先行；ContextManager 只做薄协调（无 cache）；compaction checkpoint 的 durable schema 提前进 protocol | 纯函数可独立验证 precedence / budget / 配对 / 确定性；cache 失效是最难验对的部分，推迟到有真实性能证据 |
| R4 | 多 Agent 按十步顺序整体落地 | **契约冻结与运行时分离**：先只冻结身份语义进 protocol（阶段 D）；coordinator 运行时 gate 在上下文系统完成之后（阶段 E） | context isolation 与 seed 依赖 `ContextPlan`；先冻结契约避免后续 protocol 破坏性变更 |
| R5 | 文档以现在时描述未实现组件，差异只在"当前状态"小节标注 | 每个组件在其权威文档中挂**显式状态标记**（已实现/部分/仅设计/推迟），本文维护跨层状态总账 | 重审当时 `ContextManager`、`MultiAgentCoordinator`、两级快照在代码中零引用，但组件章节读起来像现状；后续以状态总账消除这一风险 |

### 1.3 明确推迟的决策

| 决策 | 重新评审的触发条件 |
| --- | --- |
| 执行内核 tokio / async 化 | 出现需要数百以上并发 Thread 的真实宿主，或仅支持 async 的必需 transport |
| 提取独立 `ash-agent` crate | 至少两个真实执行宿主，且 Agent loop 不依赖 Thread projection、store、receipt 或 App Server |
| `ProviderHandoff` 协议 | [第 6 节](#6-history上下文与供应商切换)的 continuity 评测持续失败 |
| 跨 Thread 长期记忆 | 单独 RFC 接受 consent、scope、删除、保留期与评测契约 |
| ContextManager cache / reference baseline | 阶段 B 完成后有真实性能证据表明重复组装是瓶颈 |
| 与 Thread 一一对应的 `AgentId` aggregate | 出现一个 Agent 身份跨多个 Thread 延续的真实需求 |

## 2. 组件状态总账

跨层组件的当前状态。各领域文档不再重复此表，只在组件章节挂对应标记。

### 2.1 执行面（已验证部分）

| 组件 | 状态 | 代码证据 |
| --- | --- | --- |
| ThreadController create/fork/rewind、单写者 / receipt / replay / conflict | 已实现 | `core/src/thread_controller.rs` |
| per-Thread loaded projection + FIFO mutation gate + incarnation + idle eviction | 已实现 | `core/src/thread_controller/loaded_thread.rs` |
| 有界执行邮箱（OS 线程 lane，容量 8，30s 空闲回收） | 已实现 | `core/src/thread_controller/mailbox.rs` |
| TurnExecutor 顺序 model → tool → model 循环 | 已实现 | `core/src/turn/executor.rs` |
| same-Turn steering + delivery marker | 已实现 | `core/src/runtime.rs`、`core/src/thread_controller/steering.rs` |
| ToolScheduler：durable one-time approval、sandbox escalation、rejection/repeated-failure circuit breaker | 已实现 | `core/src/turn/tool_scheduler.rs`、`core/src/tool_repetition.rs` |
| Tool unknown-outcome 基线（start marker / escalation marker，不自动重放） | 已实现 | `core/src/turn/tool_scheduler.rs`、`thread_reducer.rs` |
| 模型选择冻结（`TurnAccepted` 携带 model） | 已实现 | `core/src/thread_controller.rs` |
| `ContextAssembler`（`ContextPlan` → `ModelRequest`） | 已实现 | `core/src/context/assembler.rs` |
| `ModelService` / `ModelStreamSink` 契约 | 已实现；声明真实流式的主力 Provider 逐 chunk 产出，显式 unary Provider 使用 final-response bridge | `core-api/src/model.rs`、`model-provider/src/providers/` |
| 取消链路 session/request InterruptTurn → mailbox cancel → token → model/tool | 已实现 | [`core.md`](core.md) §7.3 |
| App Server 可唤醒 outbound 通知源与独立 writer | 已实现 | `app-server/src/server.rs` |

### 2.2 设计面（本计划的工作对象）

| 组件 | 状态 | 归属阶段 | 权威文档 |
| --- | --- | --- | --- |
| policy 冻结（durable policy revision binding） | 已实现 | A | `TurnAccepted.policy_revision`、`ToolScheduler` recovery checks |
| `ModelInvocationSnapshot` | 部分 | B | selected model、`ContextPlan` 与 tools 已冻结；独立 provider/config/catalog revision 集合尚未建模 |
| Agent 运行创建前的模型继承、覆盖与兼容替换 | 仅设计 | E 之后 | [`agents.md`](agents.md#41-模型选择与替换)、[`models-manager.md`](models-manager.md#103-模型选择与替换) |
| `ContextInput` / `ContextPlan` / 纯内容选择 planner | 已实现 | B | [`core-context.md`](core-context.md) |
| 通用 context budget / token measurement 判定 | 已实现 | B | [`ash-context-engine`](../ash-rs/context-engine/README.md)；OpenAI exact，Anthropic/Google/Kimi/Z.AI estimated remote preflight 已接入，local tokenizer 尚未接入 |
| `ContextManager`（薄协调，无 cache） | 已实现 | B | `core/src/context_manager.rs`、`loaded_thread.rs` |
| compaction checkpoint schema + 压缩流程 | 已实现 | B | 预算压缩和供应商溢出单次恢复均复用 durable checkpoint，见 [`core-context.md`](core-context.md) §8 |
| `ContextCompactionService` / `Clock` / `IdGenerator` / `CapabilityBroker` 端口 | 部分 | B / 按需 | model-backed compaction 已实现；其余仍按需设计 |
| provider wire-level SSE streaming | 已实现 | C | OpenAI Responses、OpenAI-compatible Chat、Google 与 Anthropic；其他 Provider 显式 unary |
| App Server 独立 outbound writer 线程 | 已实现 | C | 本文 §4.2 |
| Desktop projection gap/resync | 已实现 | C | stream gap 触发 canonical refresh，新 incarnation 淘汰旧 incarnation |
| `DelegationId` / `AgentMessageId` / `ThreadOrigin::AgentSpawn` / seed schema | 已实现 | D | [`core-multi-agent.md`](core-multi-agent.md) |
| `MultiAgentCoordinator`、Fresh spawn saga、delivery、结构性 tree budget | 已实现 | E | [`core-multi-agent.md`](core-multi-agent.md) |
| Selected/ForkedPrefix inheritance、durable join、cancellation tree、Agent-tree UI projection | 已实现 | E | [`core-multi-agent.md`](core-multi-agent.md) |
| 并行工具计划、通用 deadline、声明式 retry、reconciliation | 仅设计 | E 之后按需 | [`core.md`](core.md) §11 |
| 跨 Thread 长期记忆 | 推迟 | 单独 RFC | 本文 §1.3 |

## 3. 分层与执行链

```text
CLI / Desktop / future daemon
             │
             ▼
Versioned App Server
  connection gate / dispatcher / subscriptions / outbound queue
             │
             ▼
core-api::AgentRuntime → Core Runtime
  retry / execution handoff / interaction resume / failure recording
             │
             ▼
ThreadController (ash-core, one logical writer per loaded Thread)
  session_id grouping / lineage / durable commit / recovery / execution mailbox
             │
             ▼
TurnExecutor (ash-core private module)
  context → model → tool calls → tool results → next model request
       │                              │
       ▼                              ▼
  ModelService                   ToolService + ActionPolicyService
       │                              │
model-provider              shell-command / file-system / apply-patch / MCP adapters

ThreadController  ─── append ──► ThreadStore ──► rollout
      │ committed events and transient deltas
      └─────────────────────────► ThreadUpdateSink ──► subscription hub
```

依赖规则（详见 [`core.md`](core.md#7-依赖边界)）：

- `ash-core` 不依赖 JSON-RPC DTO、provider HTTP wire 类型、concrete adapter、storage 或
  rollout；
- App Server 请求通过 `core-api::AgentRuntime` 调用完整操作；装配代码构造 Core 和 adapter，
  请求层不读取命令日志或单独接续执行；
- `app-server-protocol` 只复用经过审核的 canonical public view；Core-private aggregate、
  loaded state、mailbox、incarnation 永不进入 wire；
- Tool adapter 不直接修改 Thread projection。

Session 的不同语义必须区分（详见 [`protocol.md`](protocol.md)）：产品 `Session` 是按
`session_id` 聚合的 Thread tree 视图；`AppServerConnection` 是一条 RPC 连接的资源 owner；
`BrowserSession` / `TerminalSession` 是具体服务连接。
（capability 生命周期）。三者不得混用命名或状态。

提交顺序与恢复由 [`core.md`](core.md#4-提交与恢复) 维护。工具执行生命周期与授权由
[`tools.md`](tools.md) 维护。

## 4. 修订决策详细设计

### 4.1 R1：策略冻结 durable 化

**原问题。** 原设计的 `TurnPolicySnapshot` 是进程内不可变结构，"整个 Turn 生命周期有效"。但
Turn 可以跨进程重启恢复（waiting approval、resumable tool continuation），进程内快照在恢复
后不存在；当前实现在每次 pending call 审查时从 live `ActionPolicyService` 读取最新策略。结果是：
配置在 Turn 中途放宽后，恢复的 Turn 会在更宽的策略下继续——这违反"安全策略不能在 Turn
中途静默放宽"的固定决策。已有的缓解只覆盖局部：one-time approval 与 escalation 绑定了
`action_digest + policy_revision`，但未绑定 Turn 级策略环境。

**当前实现。** 下列 durable revision binding 已接入 protocol、reducer、projection、scheduler
和 recovery；更宽的 execution limits/agent role snapshot 仍不是当前公共结构。

- `TurnAccepted` 事件增加 `policy_revision` 字段（protocol 变更，进入
  [`protocol.md`](protocol.md) 阶段 P2/P3 的同一批 schema 同步）；
- `ThreadSnapshot` 的 Turn 投影暴露冻结 revision；`ToolScheduler` 构造
  `ActionReviewRequest` 时同时携带冻结 revision 与当前 revision；
- `ActionPolicyService` 端口新增 host obligation（doc comment 契约）：当当前 revision 不等于冻结
  revision 时，实现只允许返回**不宽于**冻结 revision 的决定；无法判定时必须返回 `AskUser`
  或 `Block`，不得静默采用更宽策略；
- 恢复路径（`resume_recovered_tool_continuations` 与 approval resume）从 durable 冻结
  revision 重建策略环境，而不是从当前配置；
- 显式收紧仍然即时生效（当前 revision 更严时按当前执行），与原设计的"单调收紧"一致。

进程内的 `TurnPolicySnapshot` 结构仍可作为实现细节存在，但它是冻结 fact 的派生视图，不是
authority。

### 4.2 R2：同步执行内核，流式经 sink

**立场。** 执行内核保持同步：per-Thread OS 线程邮箱（`ThreadExecutionMailboxes`）、同步
`ModelService` / `ToolService` / `ActionPolicyService` 端口、`CancellationToken` 协作取消。不进行
tokio / async 迁移；重新评审触发条件见 [§1.3](#13-明确推迟的决策)。

**真实流式不需要异步运行时。** `ModelService::stream` 保留 unary 默认桥接；声明
`NativeStreaming` 的 OpenAI Responses、OpenAI-compatible Chat、Google 和 Anthropic adapter 已在
同步读循环中逐 chunk 解码并调用 `sink.emit(...)`。当前实现满足：

- provider adapter 在每个 chunk 边界观察 cancellation；socket 层仍由 `ash-http-client` 的
  bounded transport timeout 收束；
- `InvocationStream`（Core 侧 sink 实现）已具备 stream incarnation + cursor 发布路径，无需
  改动契约；
- transient delta 经有界 channel 发布，饱和时允许合并或丢弃；durable completion 不依赖
  transient stream。

**App Server outbound topology。** `serve_jsonl` 已把 request dispatch 与唯一 outbound writer
分离；response 和 notification 进入同一有界队列，由 writer 串行写出：

```text
per-connection reader thread        per-connection writer thread
  read_message                        wait on ConnectionNotifications
  → dispatch                          → drain
  → enqueue response                  → write_message*
      （response 与 notification 进入同一有界 outbound 队列，
        由唯一 writer 线程串行写出，保序且互不阻塞）
```

需要区分的四种终止语义保持原设计：`$/cancelRequest`（取消一个 RPC handler 等待）、
`session/request` 的 `InterruptTurn`（durable Turn 推向 Interrupted）、connection close（清理 connection-owned
资源并唤醒 writer 退出）、server shutdown（带 deadline 的全局 graceful stop）。

Desktop Renderer 不持有 raw peer；由单一 projection service 消费 notification。相同
incarnation 的 sequence gap 会清空 transient projection 并刷新 canonical Thread；新 incarnation
会淘汰旧 incarnation，迟到的旧 delta 被拒绝。

### 4.3 R3：上下文系统裁剪落地

领域权威是 [`core-context.md`](core-context.md)；本节只固定裁剪范围与顺序。

**阶段 B 核心纵向切片已落地：**

1. `ContextInput` / `ContextPlan` 不可变类型 + 纯 `ContextPlanner`（precedence、完整语义单元选择、
   Tool Call/Result 原子配对、checkpoint selection、显式 overflow outcome），模型无关预算和计量
   判定由 `ash-context-engine` 提供；
2. `ContextAssembler` 从 `ThreadSnapshot → ModelRequest` 过渡 API 改为
   `ContextPlan → ModelRequest` 纯组装；
3. 薄 `ContextManager`：per-loaded-Thread、由 `LoadedThreadState` 持有、只做 sequence 校验
   与 prepare 协调，**无 cache / baseline / token estimate**；
4. compaction checkpoint durable schema 进入 protocol 与 store envelope（与 R1 的 protocol
   变更同批规划，避免两次 schema bump）；
5. compaction 流程：`NeedsCompaction` → `ContextCompactionService` 端口 → 验证 provenance/digest →
   durable commit checkpoint → 失效重建。Summary model I/O 不持有 Thread writer。

**明确未做（推迟）：** `cached_plan`、`reference_baseline`、`TokenEstimate` 缓存。触发条件
见 §1.3。

`ModelInvocationSnapshot` 当前随 `ContextPlan` 一起冻结 selected model、上下文计划与工具；
输出/推理设置和独立 provider/config/catalog revision 集合尚未建模。它是可从 durable fact 与
安全点快照重建的进程内值，无需自身持久化——这与 R1 的 policy 冻结不同。

Agent 级模型策略是另一层尚未实现的创建契约：App Server 在 Agent 运行创建前组合 Session 或
工作流基线、Agent 定义和本次启动参数，再让 `ash-models-manager` 选择一个准确模型。请求模型、
实际模型、替换原因、目录 generation、推理等级和服务等级随运行冻结；后续 Turn 只使用这个已选
模型。目录刷新、上级 Agent 的临时覆盖或一次 provider 调用失败都不能触发运行中换模型或重放。
当前 `TurnAccepted` 携带 model 的行为继续作为 Turn 级事实，不能被误写成上述 Agent 级选择已经
落地。

### 4.4 R4：多 Agent 契约冻结先行

领域权威是 [`core-multi-agent.md`](core-multi-agent.md)；本节只固定门槛。

**阶段 D（契约冻结，已完成）：** `DelegationId`、`AgentMessageId`、
`ThreadOrigin::AgentSpawn`、`AgentContextSeed` schema、delegation requested/started/terminal
facts、`DelegationResult` Item 进入 canonical protocol，同步 Rust types / JSON Schema /
generated TS / fixtures。目的：后续运行时开发不再产生破坏性 protocol 变更。

**阶段 E 的 gate 条件：**

- 阶段 B 完成（seed 的 `Fresh / Selected / ForkedPrefix` 语义依赖 `ContextPlan` 与
  checkpoint）；
- 阶段 D 契约测试通过；
- spawn saga 的 fault injection 框架就绪（复用 Session create/fork saga 的既有测试基建）。

## 5. 工具执行与恢复（保留设计，状态标注）

工具生命周期、取消、unknown outcome 语义由 [`core.md`](core.md) §11 权威定义，均为已实现。
以下仍为仅设计，归属阶段 E 之后按需评审：

- 并行 Tool 计划（policy、Tool definition、resource conflict 三重检查后启用；完成顺序不
  决定 transcript 顺序）；
- 声明式 retry policy（`Never` / `SafeRead` / `IdempotentWrite(operation key)` /
  `ReconcileBeforeRetry`；参数错误、permission denial、unknown outcome 默认不自动 retry）；
- 通用 deadline 与 tool-specific reconciliation。

## 6. History、上下文与供应商切换

Context authority 见 [`core-context.md`](core-context.md)。Provider 切换保持原设计：它是
"未来调用配置变更"，不是新的事实存储层——排入 ThreadController，在 model safe point 从
durable history 重新构造 context 并创建新的 invocation snapshot；运行中的请求默认沿用旧
快照或由用户显式 interrupt。Provider-specific response ID / cache key 可作为 adapter 优化
暂存，不能成为恢复正确性的前提。

只有以下 continuity 评测持续失败时，才重新评审 `ProviderHandoff`：约束保留、已完成工作
识别、决策一致性、Tool Result 引用准确性、切换后继续执行成功率。

供应商配置两层边界（`model-provider-config` 声明层 / `model-provider` 运行时层）保持原
设计，权威见 [`model-provider-config.md`](model-provider-config.md) 与
[`model-provider.md`](model-provider.md)。

## 7. 分阶段实施计划

替代此前的阶段 0–8。原阶段 0–5 中标注"完成 / 基础完成"的内容已并入
[§2.1 状态总账](#21-执行面已验证部分)，不再作为计划项。

### 阶段 A｜地基修整

范围：

- 按 [`core.md`](core.md) §13 目标目录拆分三个越线文件（`thread_controller.rs` 1189 LoC、
  `session_coordinator.rs` 998 LoC、`thread_reducer.rs` 947 LoC）；纯迁移，不改语义，测试
  随实现同步迁移；
- R1：`TurnAccepted` 增加 `policy_revision`，reducer / projection / scheduler / recovery 接
  线，protocol schema + TS + fixtures 同步。

完成条件：

- 拆分后 implementation module 低于 500 LoC，全部现有测试通过；
- 新测试：策略放宽后恢复的 Turn 不以更宽策略执行；冻结 revision 在 replay / recovery 中
  保持；
- schema 哈希与 fixtures 更新完整（`pnpm verify:protocol`）。

### 阶段 B｜上下文系统

范围：[§4.3](#43-r3上下文系统裁剪落地) 的五项 + `ModelInvocationSnapshot`。

完成条件：

- 相同 `ContextInput` 产生字节级等价 `ContextPlan`；
- overflow 产生显式 outcome，当前输入 / 权限约束 / 未完成 Tool continuation 永不被静默
  删除；
- Tool Call/Result 原子保留；delegation group 在阶段 D protocol 类型落地后启用同一规则；
- compaction checkpoint 前后 crash 注入：原始 event log 完整；corrupt checkpoint replay
  fail closed，且不删除可供显式修复的原始 history；
- ContextManager 丢弃后从 durable facts 重建等价 plan。

### 阶段 C｜真实流式（已完成）

范围：[§4.2](#42-r2同步执行内核流式经-sink) 的 provider SSE decoder、App Server
reader/writer 拆分、Desktop gap/resync。OpenAI Responses、OpenAI-compatible Chat、Google 与
Anthropic 已声明真实流式；其余内置 Provider 显式声明 unary。

完成条件：

- 增量 delta 从 provider wire 到客户端全链路可见，不再等待 final response；
- 断连后 snapshot + gap 重建一致；
- 流中取消 race：迟到 delta 丢弃、durable completion 不受 transient channel 饱和阻塞；
- response 与 notification 保序，slow client 不阻塞 durable commit。

阶段 B 与 C 无强依赖，可由不同人并行；合入顺序建议 B 先行，避免流式测试对上下文管线改动
重跑两轮。

### 阶段 D｜多 Agent 契约冻结（已完成）

范围：[§4.4](#44-r4多-agent-契约冻结先行) 的 protocol 变更。

完成条件：Rust / schema / TS / fixtures 四处一致；contract test 覆盖新类型的
serialize / deserialize / 拒绝非法值；不引入任何 Core 运行时依赖。

### 阶段 E｜MultiAgentCoordinator（核心纵向切片已完成）

当前已完成 Fresh/Selected/ForkedPrefix spawn saga、outbox/inbox delivery、durable join、向下
cancellation tree、结构性 Agent tree budget、恢复、Desktop tree projection 与目录 Grant
的模型工具接线，以及目录 Agent definition 的显式/唯一 metadata 自动选择。后续范围是会话入口与委托运行共用的内置/自定义定义身份和启动范围、带作用范围的执行能力上限、跨产品 projection 与更完整的故障注入矩阵；角色定义边界见 [`agents.md`](agents.md)，运行时 gate 条件见 §4.4。

完成条件：[`core-multi-agent.md`](core-multi-agent.md) §17 验证矩阵全量通过，其中 spawn
的每个 durable boundary crash、duplicate delegation 拒绝、parent/child/sibling 隔离为必过
项。

### 贯穿项

- 每个新增 durable boundary 在其落地阶段内补 fault injection，不集中后补；
- 文档随阶段收口更新状态标记（R5），不允许"实现先行、文档滞后超过一个阶段"。

## 8. 验证门

Rust：

```bash
cargo fmt --manifest-path ash-rs/Cargo.toml --all -- --check
cargo clippy --manifest-path ash-rs/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path ash-rs/Cargo.toml --workspace
```

Desktop 与协议：

```bash
pnpm verify:protocol
pnpm --dir ash-ts run build:host
pnpm --dir ash-ts run typecheck:renderer
pnpm --dir ash-ts run test:main
```

跨阶段必须持续覆盖（已实现部分回归 + 新增项）：

- 同 Thread FIFO 与不同 Thread 并发；Session 结构提交不阻塞子 Thread 执行；
- acceptance response 与 notification 顺序；
- provider/tool cancellation race；completion 迟到、重复和旧 incarnation；
- mailbox、stream 和 outbound queue saturation；
- partial durable batch、crash recovery 和 idempotency replay；
- Tool unknown outcome 不自动重放；
- 冻结 policy revision 下的恢复语义（阶段 A 起）；
- Context determinism、overflow、checkpoint crash（阶段 B 起）；
- Renderer gap/resync（阶段 C 起）。

## 9. 验收标准

- rollout 是唯一权威历史，任何投影都能重建；
- Session 是 Thread membership/lineage 的权威边界，Thread 是独立执行与恢复边界；
- 长模型或工具调用期间仍可 interrupt 并服务其他 Thread；
- 同 Thread 只有一个逻辑状态提交者；
- 所有用户可见 final Item 在通知前 durable；
- Turn 级策略环境冻结为 durable fact，恢复不产生静默放宽；
- 上下文溢出只压缩 terminal 旧历史并以 durable 新快照重试一次；无可压缩前缀或再次溢出产生显式 outcome，当前输入与安全约束永不被静默删除；
- provider/tool/execution 失败都有明确 terminal path；断连、取消、超时和 shutdown 不留下
  永久 pending；
- Provider 切换不依赖旧 provider cache；Tool 副作用在 unknown outcome 下不被静默重放；
- connection/capability Session 不得与产品 Session 混用；
- 每个组件的文档状态标记与代码证据一致；
- 长期 Memory 不在没有独立 consent、scope、删除和评测契约时进入核心模型。

## 10. 参考

- [Ash 架构索引](architecture.md)
- [会话与执行系统（Core）](core.md)
- [上下文系统](core-context.md)
- [多 Agent 协作系统](core-multi-agent.md)
- [产品协议](protocol.md)
- [ash-rs 产品内核与统一对外层](ash-rs-architecture.md)
- [Ash App Server API](ash-app-server-api.md)
- [Pi session format snapshot](https://github.com/earendil-works/pi/blob/5bc1c2c0a6f07e00e8c240304182f213ab8d311f/packages/coding-agent/docs/session-format.md)
