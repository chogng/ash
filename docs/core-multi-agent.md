# Agent 委托与运行树

> 状态：同一 Session 内的 Agent 树核心纵向切片已实现（2026-08-12）。`DelegationId`、`AgentMessageId`、`AgentJoinId`、`AgentContextSeed`、
> `ThreadOrigin::AgentSpawn`、durable delegation/message/result events、Fresh child Thread spawn、
> exact-once delivery、结构性 tree budget，以及 App Server 的 `spawn_agent`、
> `send_agent_message`、`wait_agent` 工具已落地。`Selected` 和有界 `ForkedPrefix` 在 spawn 时物化进入 immutable seed；Full 通过不可变历史前缀保留原消息；All/Any/Quorum join、向下 cancellation tree 与 canonical Agent-tree projection
> 均使用 durable Thread/Session facts。Agent role 按 Default 或精确 source/name 选择，会
> 冻结 generation、digest、reason、自身 Tool、下放 Tool 与 Skill 上限；每一代委托只能从祖先下放
> 上限继续收窄。Desktop 只消费 canonical tree 并可精确
> 中断单个节点。S6 的 child failure、parent cancel、join timeout、any/quorum、恢复、预算耗尽与
> mailbox isolation 矩阵已覆盖；late-result/UnknownOutcome 等更广故障注入仍按后续需求演进。原落地顺序分为契约冻结
> （[阶段 D](ash-agent-runtime-architecture.md#阶段-d多-agent-契约冻结已完成)）与运行时
> （[阶段 E](ash-agent-runtime-architecture.md#阶段-emultiagentcoordinator核心纵向切片已完成)）；理由见
> [`ash-agent-runtime-architecture.md` R4](ash-agent-runtime-architecture.md#44-r4多-agent-契约冻结先行)。
>
> Core 总体边界：[`core.md`](core.md)
> Context 与 ContextManager：[`core-context.md`](core-context.md)
> Canonical Session/Thread/Turn contract：[`protocol.md`](protocol.md)
> 外部客户端与 Remote Ash 接入：[`ash-app-server-api.md`](ash-app-server-api.md)
> 内置与自定义 Agent 的统一定义、专化职责、启动范围、模型和工具边界：[`agents.md`](agents.md)

## 快速理解

本文只处理 Agent 运行之间的委托关系，不定义“主 Agent”与“子 Agent”两种类型。每个运行实例都由独立 Thread 表达；会话入口位于树根，被委托运行由 `ThreadOrigin::AgentSpawn + DelegationId` 关联到调用方。界面可以把后者简称为“子 Agent”，但同一份 `AgentRole` 可以在其启动策略允许时用于任一位置。

多个独立 Session 的根 Thread 之间不存在父子关系，不属于本文协调器，也不建立另一套跨 Session 工作图。需要共同完成一个目标时，由一个 Session 的根 Agent 创建同一 Agent tree 内的子 Thread。

| 读者首先会问 | 直接答案 | 深入阅读 |
| --- | --- | --- |
| “主 Agent”和“子 Agent”是不同类型吗？ | 不是；它们只是会话入口运行和委托运行在树中的相对位置 | [`agents.md`](agents.md) |
| 被委托 Agent 在系统中是什么？ | 一个拥有独立 `ThreadId`、Turn、上下文和取消域的 Thread | [身份与聚合边界](#2-身份与聚合边界) |
| 调用方与被委托方共享历史或模型状态吗？ | 不共享可变状态；只通过明确的种子、消息和结果传递信息 | [上下文隔离](#11-上下文隔离) |
| 创建、分叉和生成有什么区别？ | 创建建立新 Thread，分叉固定已有序列点，生成额外记录委托关系 | [创建、分叉与生成](#4-创建create分叉fork与生成spawn) |
| 被委托 Agent 如何回传结果？ | 结果通过可持久化消息和委托终态回到调用方，不靠进程内引用 | [结果与汇合](#8-结果与汇合) |
| 取消父 Agent 会发生什么？ | App Server 的 Turn interrupt/Session stop 会向所有 live descendants 传播；child 取消不反向影响 parent/sibling | [取消与终态语义](#9-取消与终态语义) |
| 多个 Agent 的代码结果如何避免互相破坏？ | 根 Agent 通过明确任务范围和依赖安排子 Agent；每个 Thread 使用自己的受管目录与 Turn ChangeSet，最终验证和提交仍走 Git/Turn Changes | [`chat-session-inspector.md`](chat-session-inspector.md) |
| 专化职责的提示词、模型、工具和启动范围在哪里定义？ | 内置定义由产品资源维护，自定义定义来自 `.ash/agents`；会话、委托和工作流共用一种契约 | [`agents.md`](agents.md) |
| Team 模式属于哪一种？ | Team 是同一 Session Agent 树的产品形态，根 Thread 协调多个子 Thread | [Agent 树协调器](#3-agent-树协调器) |
| 多个独立 Session 如何协作？ | 不建立隐式协作；需要共同目标时回到一个 Session 的 Agent tree | [系统边界](#2-系统边界) |

## 1. 结论

Ash 当前实现的 Agent 树使用同一 Session 下的独立 Thread：

```text
Session
└─ entry Thread / Agent
   ├─ delegated Thread / Agent A
   └─ delegated Thread / Agent B
```

每个 Thread 独立拥有：

- durable sequence、Turn 和 Item；
- ThreadController 的逻辑提交序列；
- ContextManager、context window 与 compaction；
- model/tool/policy snapshot；
- cancellation domain；
- 恢复和 terminal outcome。

产品上一个独立 Agent 任务通常显示为一个 Session，但真正执行它的是该 Session 的根 Thread。另一个 Session 的根 Thread 是独立执行分支，可以复用同一个 AgentId；它不是当前根 Thread 的 child，也不能通过本文的委托关系假装成 child。

多 Agent 不是多个执行 task 共享一份 `SessionHistory`。父子和 sibling 不共享 mutable context、
projection、provider conversation ID 或 Tool state。

同进程 Agent 委托运行由本架构定义的 `MultiAgentCoordinator` 创建，不通过外部 App Server
连接自调用。跨 runtime Ash 使用 App Server transport；调用方仍必须在本地拥有 delegation、
budget、cancellation 和 result delivery，远端连接只承担执行通信。

长期必须把定义和三种运行关系分开：

1. **Agent definition**：职责、提示词、模型策略、工具、能力和允许的启动来源；
2. **Thread lineage**：产品里的 root/fork/spawn 拓扑；
3. **Agent delegation**：谁委派了什么工作以及结果状态；
4. **Context inheritance**：被委托运行首次调用能看到调用方的哪些内容。

只记录 `parentThreadId` 不能表达 Agent 定义、委托任务与上下文交付。

## 2. 身份与聚合边界

### 2.1 SessionId

标识一个产品任务及其 Thread 拓扑。Session 只串行 membership、lineage、shared defaults 和
lifecycle，不串行 child Thread 执行。

### 2.2 AgentId 与 ThreadId

`AgentId` 标识长期 Agent 身份，`ThreadId` 标识独立执行分支。一个 Agent 可以同时拥有多个 Thread，也可以参与不同 Session 的任务。各 Thread 独立冻结角色、工具和 Skill 配置，不共享可变上下文、执行状态或取消域。

- 新建根或委托运行分配 AgentId；显式指定已有 AgentId 可在另一任务中复用身份。
- 普通 fork、rewind 和 replacement 保留源 AgentId。
- replacement 要求源 Thread 已归档，新分支从空历史开始；旧历史、委托和结果留在原 Thread。
- Agent 与 Thread 绑定、Thread 来源均不可重新分配；替换通过创建新绑定表达。
- Agent 记录与首次 Thread 创建同事务提交，删除所有任务后仍保留身份。
- `agent-graph-store` 定义读取契约，`ash-state` 实现索引；云端认证不进入该模型。

身份跨 Session 复用不建立跨 Session 委托、消息、共同预算或取消关系。

### 2.3 DelegationId

`DelegationId` 是必需的独立身份，标识一次 parent → child 工作委派。它不能由数组位置、child
Thread ID 或 Tool call completion 顺序隐式表达。

一个 delegation 至少关联：

- parent Thread/Turn；
- parent sequence anchor；
- child Thread；
- delegated task；
- context seed；
- lifecycle；
- result/delivery identity。

Agent spawn 可能由模型 Tool Call、用户操作或系统策略触发，因此 `DelegationId` 不直接等同
`ToolCallId`。

### 2.4 AgentMessageId

跨 Thread message/result 需要稳定 `AgentMessageId`，用于：

- sender retry；
- receiver deduplication；
- crash recovery；
- delivery receipt；
- provenance。

## 3. Agent 树协调器

当前 Rust 类型名为 `MultiAgentCoordinator`，实际职责是同一 Session 的 Agent 树协调。长期公开责任和命名应收窄为 Agent tree，不能给它增加 Project 或全局参与者分支。单 Agent 执行不经过它；
ThreadController、TurnExecutor、ContextManager 和 ToolScheduler 已经构成完整的单 Agent 路径。

负责：

- spawn、send、join、cancel、close；
- delegation lifecycle；
- context seed 物化；
- parent/child cancellation tree；
- max depth、max children、并发和总资源预算；
- 通过 ThreadController 创建 child Thread 并保留 `session_id`；
- 协调 ThreadController 提交 parent/child durable facts；
- 跨 Thread message/result 的 outbox/inbox delivery；
- crash reconciliation。

不负责：

- 持有 Thread transcript；
- 读取 live ContextManager；
- 直接执行 child Turn；
- model/Tool I/O；
- Session membership reducer；
- provider connection 或远端 Agent transport；
- UI projection。
- 工作契约、跨 Agent 修改冲突、验证结论或目标分支集成。
- 跨 Session 观察、等待、另开方向、移交、共同预算或共同取消。

MultiAgentCoordinator 可以协调多个 Thread，但不能建立跨所有 Thread 的大锁。长 I/O、等待
child 和等待 delivery receipt 都在 Thread writer 之外。

### 3.1 团队共享讨论

同一 Agent 树已可通过 `board_read` 和 `board_write` 共享频道、话题、回复与订阅。消息由 `ash-rs/ext/agent-message-board` 保存，成员身份、运行状态与工具授权由 Ash 既有运行时提供。接口与通知规则见 [Agent 共享讨论板](../ash-rs/docs/extensions.md#agent-共享讨论板)。

- 根 Agent 可为工作建立频道，成员在话题中发布发现、阻塞、接口决定和验证证据。
- 消息按 Session 与根 Thread 隔离；成员可主动读取历史，提醒只送达其当前活动 Turn。
- 分工、启动、等待和取消继续使用 Agent 树；讨论内容不能代替委托结果、授权或验收事实。
- `/team <任务>` 已通过服务端命令启动 `team-coordinator`，由其委托 `team-implementer` 与 `team-reviewer`；这些角色使用同一讨论板。
- `/team status` 查看结果，`/team resume` 恢复当前执行或重试失败尝试，`/team cancel` 取消协调者及其后代。命令状态由 `ash-rs/ext/workflows` 保存，执行仍归 Core。

## 4. 创建（Create）、分叉（Fork）与生成（Spawn）

三种操作语义不同：

| 操作 | 目的 | parent 关系 | context |
| --- | --- | --- | --- |
| Create | 新建独立 Thread | 无 | fresh |
| Fork | 创建产品历史分支 | immutable lineage anchor | 明确 fork selection |
| Spawn | 创建一次 Agent 委托运行 | delegation + parent anchor | 明确 AgentContextSeed |

Fork 不自动产生委托关系。用户可以 fork side conversation；Agent 也可以在 fresh context 下
创建委托运行。

目标 `ThreadOrigin` 至少能区分：

```rust
enum ThreadOrigin {
    Root,
    Fork {
        parent_thread_id: ThreadId,
        parent_sequence: u64,
    },
    AgentSpawn {
        parent_thread_id: ThreadId,
        parent_sequence: u64,
        delegation_id: DelegationId,
    },
}
```

`ThreadOrigin` 只描述来源和不可变 anchor。具体 context inheritance 放在独立
`AgentContextSeed` 中，避免把拓扑与 prompt policy 混成一个 enum。

普通 `Fork` 保留 AgentId、来源锚点、已提交历史和检查点；委托的 `ForkedPrefix` 仍通过物化种子继承上下文。不可变历史共享与模型缓存验证尚未完成，由后续改动处理。

## 5. AgentContextSeed

Spawn 时必须创建不可变、可验证的 seed：

```rust
struct AgentContextSeed {
    delegation_id: DelegationId,
    parent_thread_id: ThreadId,
    parent_turn_id: TurnId,
    parent_sequence: u64,
    task: DelegatedTask,
    agent: AgentConfiguration,
    inheritance: AgentContextMode,
    materialized_context: Vec<AgentMaterializedContext>,
    policy_ceiling: DelegatedPolicyCeiling,
    digest: ContextSeedDigest,
}
```

`AgentConfiguration` 同时保存可选角色、能力上限与共享/模型指令。Default 的角色为空；共享指令仍然生效。角色定义更新不会改写已有配置。三种历史继承方式都使用子 Agent 自己的共享指令，不继承父 Agent 的 Review 等任务指令。

### 5.1 继承模式

使用自描述 enum：

```rust
enum AgentContextMode {
    Fresh,
    Selected { sources: Vec<AgentContextSource> },
    ForkedPrefix { selection: ForkedAgentContext },
}

enum ForkedAgentContext {
    Full,
    LastTurns { count: u32 },
    CheckpointAndTail,
}
```

不使用 `inherit_context: bool` 或 `last_turns: Option<u32>`。

语义：

- `Fresh`：只注入 shared constraints、Agent role 和 delegated task；
- `Selected`：注入显式 Item/artifact references；
- `ForkedPrefix`：从固定 parent sequence 选择完整或裁剪历史。

所有模式都必须固定 source sequence 和 provenance。Spawn 后 parent 继续执行、compaction、
provider change 或 policy refresh 都不能偷偷改变 child seed。

### 5.2 策略继承

Child policy 必须满足：

```text
effective child policy
  = session/system ceiling
  ∩ parent delegated ceiling
  ∩ child role restrictions
  ∩ current host safety policy
```

Child 可以被进一步收紧，不能静默获得 parent 没有的 capability 或放宽 approval。

`AgentCapabilityScope.tools` 是 child 自己可以调用的准确 Tool 集合；
`AgentCapabilityScope.delegation_tools` 是 child 可以继续向下一代下放的准确上限。两者从
parent 的 `delegation_tools` 独立收窄，互不隐含。根 Thread 的角色配置保存在 `ThreadCreated.agent`，子 Thread 的配置保存在 `AgentContextSeed.agent`；Core 通过同一个配置访问入口限制工具与 Skill。Default 根 Thread 使用当前环境工具，明确选择角色的根 Thread 使用创建时冻结的上限；历史 seed 缺少 `delegation_tools` 时按空集合读取。

**当前限制。** `AgentCapabilityScope` 目前冻结两组工具名与 Skill，尚未携带带作用范围的 `Capability` 集合。因此“只读审查”“只允许构建目录写入”等角色限制目前不能只靠该结构强制执行；工具名允许列表可以执行约束，文件路径等细粒度限制仍由 action policy 负责，不能把角色文本当作授权机制。详见 [`agents.md`](agents.md#8-当前实现与缺口)。

### 5.3 种子持久化

Seed 可以作为 child creation fact 或 stable artifact reference 持久化，但必须在 child 首次执行
前 durable。若 seed 引用 parent Item：

- source Thread/sequence 必须固定；
- original event log 必须仍可解析；
- digest 必须可验证；
- visibility/sensitivity policy 必须允许；
- materialization 失败时 child 不得在不完整上下文下静默启动。

## 6. Spawn 事务

Spawn 跨 parent Thread、Session 和 child Thread，必须使用可恢复 saga：

```text
1. parent commits DelegationRequested
2. Session commits ChildThreadCreationPlanned
3. child Thread is created with AgentSpawn origin + ContextSeed
4. Session commits ChildThreadAttached
5. parent commits DelegationStarted(child ThreadId)
6. child Turn is accepted and scheduled
```

每一步都使用同一个 `DelegationId`。Crash recovery：

- 只有 step 1：继续计划 child，或按明确 policy 取消；
- 已计划但未创建：创建确定身份的 child；
- child 已创建但未 attach：完成 attach；
- attach 后 parent 未记录 started：补交 started；
- child 已运行：不得创建第二个 child；
- saga 失败：提交可解释的 terminal delegation outcome。

如果 storage 将来提供 multi-stream transaction，可以优化提交次数，但不能改变可观察语义。

## 7. 通信

### 7.1 显式消息

同一 Session 的 parent、child 和 sibling 只能通过显式 Agent message 交流：

当前 Agent message 明确拒绝跨 Session 路由。跨 Session 协作只能交换工作协调域中有来源的观察、等待条件、决定和封存结果，不能放宽本文消息路由后复用父子语义。

```rust
struct AgentMessage {
    message_id: AgentMessageId,
    delegation_id: Option<DelegationId>,
    sender_thread_id: ThreadId,
    receiver_thread_id: ThreadId,
    sender_sequence: u64,
    content: AgentMessageContent,
    provenance: AgentMessageProvenance,
}
```

不能通过：

- 读取另一个 ContextManager；
- 共享 mutable `Vec<Message>`；
- 复用 provider conversation ID；
- 直接修改 receiver projection；
- 把跨 Agent message 冒充普通 user input。

### 7.2 Durable 投递

跨 Thread delivery 使用 outbox/inbox 语义：

```text
sender commits AgentMessageSent
→ delivery worker/coordinator attempts receiver append
→ receiver deduplicates AgentMessageId
→ receiver commits AgentMessageReceived
→ sender records receipt when required
```

目标是 at-least-once transport + exactly-once durable application，而不是假设一次函数调用天然
exactly once。

Receiver terminal/archived、policy rejection 和 delivery timeout 都需要明确 outcome。消息不能
无声丢失。

### 7.3 引导

发送给正在执行 child 的新 instruction 是 steering，不等于修改它已经冻结的 invocation：

- 先 durable delivery；
- 当前 invocation 是否 interrupt 由明确 policy 决定；
- 默认在下一个 model safe point 生效；
- safety tightening 可以立即传播；
- 普通 steering 不回写历史快照。

## 8. 结果与汇合

Child 完成时生成有界结果：

```rust
struct DelegationResult {
    delegation_id: DelegationId,
    child_thread_id: ThreadId,
    status: DelegationResultStatus,
    summary: String,
    artifacts: Vec<ArtifactRef>,
    source_range: ThreadSequenceRange,
    digest: DelegationResultDigest,
}
```

结果 flow：

```text
child commits terminal result
→ result delivery uses stable AgentMessageId
→ parent commits DelegationResultReceived
→ waiting join condition is re-evaluated
→ parent resumes at safe point
→ parent ContextManager may select the bounded result
```

Parent 不自动继承 child transcript。需要更多细节时，parent 可以通过显式 message 请求，或在
授权范围内引用 child artifact。

Join policy 使用 enum：

```text
All
Any
Quorum(NonZeroU32)
Explicit(Vec<DelegationId>)
```

Join 等待必须 durable；它不能靠一个进程内 `join_all` future 表达。

## 9. 取消与终态语义

Cancellation tree：

```text
caller Agent source
├─ delegated A source
│  └─ delegated A operations
└─ delegated B source
   └─ delegated B operations
```

规则：

- parent cancellation 传播到所有 live descendants；
- child cancellation 不影响 parent 或 sibling；
- Session shutdown 可以取消所有 roots；
- 一个 Session 的 stop 或 root cancellation 不传播到协作中的其他独立 Session；
- cancel signal 是 best effort；
- child 已执行的 Tool 副作用仍按 UnknownOutcome/reconciliation 处理；
- parent 取消后迟到的 child result 可以 durable 记录为 late，但不能恢复已 terminal parent Turn；
- terminal delegation 状态必须 durable，不能只看 task handle 是否结束。

可区分的 terminal outcome 至少包括：

- completed；
- failed；
- cancelled；
- policy denied；
- capacity rejected；
- context seed invalid；
- delivery failed；
- unknown outcome。

## 10. 资源预算与调度

必须区分：

```text
Per-invocation context budget
  ContextManager 负责

Per-Turn execution limits
  TurnExecutor 负责 token / cost / deadline 等 durable policy；不使用固定模型调用次数

Per-Agent-tree resource budget
  MultiAgentCoordinator 负责
```

Agent tree budget 至少包含：

- max depth；
- max live children；
- max total descendants；
- model concurrency；
- Tool concurrency；
- cumulative token/cost budget；
- deadline；
- optional per-role quota。

当前 spawn 使用共享 ThreadController 的 Session 门锁串行检查和提交 admission，避免并发请求同时占用最后一个名额；多个环境协调器共享同一个 Session 门锁，不同 Session 不共享门锁。名额预留写入后即释放门锁，工作树创建不阻塞其他预留。live children 包括尚未创建完的预留和未终结的 child，已经终结的 child 释放 live 名额，但仍计入 total descendants。重试从已保存的 seed 恢复，不重新选择角色或读取角色文件。

Reservation 必须在 spawn 前完成。并发 slot 是进程内资源，可以在 crash 后重建；已经消耗的
usage 和 durable delegation 状态不能只存在内存。

Capacity saturation 返回稳定 retryable/terminal outcome，不能无限排队。不同 Session 之间还需要
宿主级 fairness，但其全局 scheduler 实现不必进入 Core aggregate。

## 11. 上下文隔离

每个 child ContextManager 只读取：

- child Thread history；
- child creation 时的 AgentContextSeed；
- durable delivered message/result；
- child 自己的 TurnPolicySnapshot；
- composition root 提供的 child environment/capability snapshot。

不能读取：

- parent/sibling live ContextManager；
- parent 在 anchor sequence 之后的 history；
- Session 中其他 Thread 的 transcript；
- 未授权的 cross-thread memory；
- parent provider cache。

Parent result injection 规则：

- result 是独立 canonical Item；
- 必须携带 delegation/child/provenance；
- 由 parent ContextManager 参与预算和选择；
- 不能跳过 instruction precedence；
- child 的不可信文本不能升级为 system fact。

## 12. 批准与能力

Child 的 approval request 仍属于 child Thread/Turn。Interaction 必须携带 child identity 和
delegation provenance。

默认规则：

- 调用方 Agent 不是安全 authority；
- parent 不能替用户批准超出 delegated ceiling 的 action；
- UI 可以聚合显示同一 Agent tree 的 requests；
- resolve 必须命中精确 RequestId；
- parent cancel 可取消 child pending approval；
- disconnect 与 owner selection 仍由 App Server 负责。

Capability handle 不能跨 Agent 隐式共享。若 child 需要 browser/terminal/resource：

- spawn seed 声明 capability scope；
- host 在 child Turn safe point 解析 handle；
- handle lifecycle 仍由宿主拥有；
- child completion/cancel 触发明确 release policy。

## 13. 恢复

恢复顺序：

1. replay Session topology；
2. replay parent/child Thread；
3. reconcile incomplete spawn saga；
4. rebuild delegation projection；
5. redeliver unacknowledged messages/results；
6. rebuild cancellation and capacity state；
7. rebuild each child ContextManager；
8. schedule eligible non-terminal Turns。

必须拒绝：

- 重复 spawn 相同 delegation 的第二个 child；
- 重复应用相同 AgentMessageId；
- 旧 incarnation 的 completion；
- source digest 不一致的 context seed；
- terminal parent/child 上的非法恢复；
- policy scope 已失效但仍尝试继续的 operation。

## 14. Protocol 影响

目标 canonical contract 需要逐步增加：

- `DelegationId`、`AgentMessageId`；
- `ThreadOrigin::AgentSpawn` 或等价来源模型；
- `AgentContextSeed` / stable seed reference；
- delegation requested/started/terminal facts；
- Agent message sent/received/delivery outcome；
- `DelegationResult` Item；
- durable join/wait state；
- readable Agent tree/delegation projection；
- stable error/outcome code。

不要把 Core-private mailbox、task handle、ContextManager 或 cancellation node 暴露到 protocol。

Protocol 变更必须同步更新：

- Rust canonical types；
- JSON Schema；
- generated TypeScript；
- App Server method/update contract；
- store envelope/schema version；
- Desktop/CLI/TUI projection；
- contract fixtures 和 recovery tests。

## 15. 当前目录与扩展方向

```text
core/src/
├─ multi_agent.rs
└─ multi_agent/
   ├─ coordinator.rs
   ├─ budget.rs
   ├─ context.rs
   └─ coordinator_tests.rs
```

当前纵向切片把 spawn、delivery 与 recovery 放在 `coordinator.rs`，避免先按想象拆出空模块。
只有 cancellation、join 或 projection 形成独立 owner 且实现增长时，才拆为对应的 named child
module。

相关 ownership：

```text
MultiAgentCoordinator
├─ uses ThreadController for topology and durable mutations
├─ creates immutable AgentContextSeed
├─ owns delegation/delivery/resource policy
└─ never owns ContextManager
```

模块默认 private。若 App Server 需要操作多 Agent，只公开 typed command/result 和 read-only
projection，不公开 coordinator 内部状态机。

## 16. 落地顺序

落地分两段执行；跨层阶段定义与完成条件由
[`ash-agent-runtime-architecture.md` §7](ash-agent-runtime-architecture.md#7-分阶段实施计划)
权威维护。

**阶段 D｜契约冻结（已完成当前切片）：**

1. 冻结 `DelegationId`、Agent spawn 与 message/result 语义；
2. 区分 `ThreadOrigin::Fork` 与 Agent spawn；
3. 定义 ContextSeed 及 `Fresh/Selected/ForkedPrefix`；
4. delegation requested/started/terminal facts、`DelegationResult` Item 进入 canonical
   protocol，同步 Rust types / JSON Schema / generated TS / fixtures。

**阶段 E｜运行时（核心纵向切片已完成）：**

5. ✅ parent delegation durable facts 的 Core 接线；
6. ✅ 用可恢复 saga 创建 Fresh/Selected/ForkedPrefix child Thread；
7. ✅ child execution、durable All/Any/Quorum join 与显式 `wait_agent` result；
8. ✅ outbox/inbox exact-once delivery 与 steering；
9. ✅ 结构性 Agent tree budget 与 parent-to-descendant cancellation tree；
10. ✅ Core 从一致的 Session/Thread read set 生成 canonical nested Agent tree；App Server 随
    `session/subscribe` 返回，Desktop 在 Thread durable update 后重新读取该投影，直接显示
    status/wait/budget/usage/role/join/result 并精确中断；
11. ✅ S6 fault matrix：terminal reconciliation、spawn/join/cancellation recovery、join timeout、
    Any/Quorum、Turn/结构预算、duplicate/cross-delegation delivery、digest corruption 与 context/tool
    isolation 已测试；更完整的 late-result/unknown-outcome 故障注入继续补充。

第一阶段不需要：

- 独立 `ash-agent` crate；
- 与 Thread 一一对应的 Agent aggregate；
- 任意 Agent graph workflow engine；
- 跨机器 Agent transport；
- 自动共享长期 memory；
- parent/child provider cache 共享。

## 17. 验证

本节验证 Agent 生命周期、上下文隔离、消息投递和恢复。代码修改是否可以发布仍由实际 Turn ChangeSet、项目测试和 Git 提交结果证明，不能由 Agent 自报完成替代。

必须覆盖：

- spawn 的每个 durable boundary crash；
- 相同 DelegationId 幂等恢复；
- fork 与 spawn 语义不混淆；
- Fresh/Selected/ForkedPrefix 的可见内容；
- 调用方 anchor 后新增内容对被委托 Agent 不可见；
- parent/child/sibling ContextManager 隔离；
- message at-least-once transport + exactly-once apply；
- duplicate/late/out-of-order result；
- join All/Any/Quorum；
- parent cancel、child cancel 和 sibling independence；
- max depth/children/concurrency/budget；
- child Tool UnknownOutcome；
- invalid seed digest；
- parent terminal 后的迟到 result；
- restart 后 delegation、delivery、join 与 context 等价恢复。

## 18. 固定决策

- 一个 Agent 可绑定多个独立 Thread；
- Agent 定义不区分主或子；会话入口和委托只是运行关系；
- AgentId 表达长期身份，ThreadId 表达执行分支；
- DelegationId 与 AgentMessageId 是独立稳定身份；
- fork lineage、Agent delegation 与 context inheritance 分离；
- 被委托 Agent 不共享调用方或同级 Agent 的 mutable context；
- context seed 在 spawn 时固定 parent sequence；
- MultiAgentCoordinator 协调拓扑和 delivery，但不拥有 context；
- parent/child 只通过 durable message/result 通信；
- parent 不自动继承 child transcript；
- per-Thread context budget 与 Agent tree resource budget 分离；
- cancellation 向下传播，不向 parent/sibling 反向传播；
- 多 Agent 恢复只依赖 durable facts；
- MultiAgentCoordinator 不拥有工作范围、验证或集成决定；
- 同 Session Agent 树与跨 Session 独立 Agent 协作保持不同的身份、消息、取消、预算和恢复语义；
- Team 只组合 Agent 树、工作协调和验证视图，不成为新的运行时事实源；
- 在出现真实多 Thread Agent identity 需求前不增加 Agent aggregate。

## 完整历史继承

- 新 Full 委托把父 Thread 原事件冻结成共享前缀，子 Thread 只保存绑定和自身事件；不把完整对话改写成一段指令文本。
- Selected、LastTurns、CheckpointAndTail 仍只接收所选内容，不能为了共享存储扩大可见历史。
- 委托说明放在可复用前缀之后；角色与权限仍按子 Agent 独立冻结，因此不同权限不保证相同缓存请求。
- 未完成的父执行在继承处中断；已有工具调用保留并附中断结果，子 Thread 不继承原执行资格。
- 消息恢复属于同一 Agent 的新执行分支，委托才创建独立 Agent 身份。文件和历史生命周期见 [`protocol.md`](protocol.md#6-消息恢复点与共享历史)。
