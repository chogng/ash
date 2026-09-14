# 上下文系统

> 状态：核心纵向切片已实现。`ContextInput`、纯规划器、`ContextPlan`、每个已加载 Thread 的
> `ContextManager`、持久化 checkpoint、预算压缩、供应商溢出恢复和 `ContextAssembler` 已接入
> `TurnExecutor`。Skill 正文通过通用 `TurnInputContributor` 在 invocation safe point 注入；
> 通用预算、精准/估算计量结果和边界判定已拆入 `ash-context-engine`；OpenAI exact，以及
> Anthropic、Google、Kimi、Z.AI estimated remote preflight 已接入，DeepSeek/Hugging Face local
> tokenizer adapter 已接入；provider usage 会按冻结模型和估算 revision 校准未来 Core-managed
> capacity，未知窗口仍为 provider-managed。Hugging Face 公共模型支持按需发现、下载和缓存，其他 provider 的固定
> 资产目录、reference baseline、跨 Thread seed 与自动 Skill 选择仍是扩展点。
>
> Core 总体边界：[`core.md`](core.md)
> Canonical Thread/Turn/Item contract：[`protocol.md`](protocol.md)
> 通用 extension contract：[`ash-rs/ext/extension-api/README.md`](../ash-rs/ext/extension-api/README.md)
> 多 Agent context inheritance：[`core-multi-agent.md`](core-multi-agent.md)
> 共享提示词资产契约：[`ash-prompts`](../ash-rs/prompts/README.md)
> 预算与 token 计量实现：[`ash-context-engine`](../ash-rs/context-engine/README.md)

## 快速理解

上下文系统决定某一次模型调用能看到哪些信息；它从可持久化历史生成模型输入，但不能成为第二份
对话历史。

| 读者首先会问 | 直接答案 | 深入阅读 |
| --- | --- | --- |
| Thread 历史就是模型上下文吗？ | 不是；历史是权威事实，上下文是按预算选择出的派生窗口 | [权威与派生关系](#3-权威与派生关系) |
| 多个 Thread 会共享上下文吗？ | 不会；每个 Thread 有独立的 `ContextManager`、窗口和压缩检查点 | [为什么不放进 Session](#2-为什么不放进-session) |
| 一次模型调用使用什么？ | 使用不可变的 `ContextPlan`，再由 `ContextAssembler` 组装请求 | [数据模型](#4-数据模型) |
| 超出模型预算或供应商实际窗口怎么办？ | 已知预算先规划压缩；供应商仍报溢出时持久化压缩旧历史并只重试一次 | [上下文预算](#7-上下文预算)、[压缩](#8-压缩) |
| 模型或配置变化会污染旧窗口吗？ | 不会静默复用；相关 revision 变化会使派生状态失效并重建 | [供应商变更](#9-上下文窗口与供应商变更) |

## 1. 结论

Ash 长期必须区分四个概念：

```text
Thread history
  durable authority

ContextManager
  per-loaded-Thread 的可重建上下文协调状态

ContextPlan
  一次 model invocation 的不可变选择结果

ContextAssembler
  ContextPlan → provider-neutral ModelRequest 的纯组装
```

上下文不是 Session 级对象。每个 Thread 有独立 history、sequence、context window、compaction
checkpoint 和 ContextManager。父子 Agent、fork Thread 或 side conversation 都不能共享可变
ContextManager。

ContextManager 也不能成为第二份 canonical history。它允许保存 cache、baseline、token estimate
和当前 window revision，但所有影响未来 prompt 的事实必须能够从 durable Thread history、
checkpoint、context seed 与 policy snapshot 重建。

## 2. 为什么不放进 Session

Ash 的 `Session` 是多个 Thread 的产品容器，只拥有 membership、lineage、shared defaults 和
lifecycle。若 Session 持有 context，会产生无法接受的问题：

- 多个 Thread 竞争同一 history/window；
- child Agent 看到 parent 或 sibling 的未授权内容；
- 一个 Thread 的 compaction 改变另一个 Thread；
- provider/model 切换无法按 Thread safe point 生效；
- Session lock 被 model/context I/O 放大；
- Thread 无法独立恢复、并行和回收。

其他代码库中名为 `Session` 的对象可能实际代表一条 conversation/thread 的加载实例。Ash 必须
按领域语义映射，不能按目录或类型名照搬。

## 3. 权威与派生关系

```text
Session event stream
  └─ membership / lineage / defaults

Thread event stream
  ├─ Turns / Items / Tool Calls / Tool Results
  ├─ interactions / Agent deliveries
  ├─ compaction checkpoints
  └─ context seed references
          │
          ▼ reduce
    durable ThreadSnapshot
          │
          ▼ derive
      ContextManager
          │
          ▼ prepare
       ContextPlan
          │
          ▼ assemble
       ModelRequest
```

规则：

- event stream 是 authority；
- `ThreadSnapshot` 是可重建 projection；
- `ContextManager` 是进程内可重建派生状态；
- `ContextPlan` 只属于一次 invocation；
- provider cache 是可丢弃优化；
- compaction summary 是带 provenance 的 durable 派生 artifact，不替代原始事件。

## 4. 数据模型

以下类型表达当前规划语义；`ContextBudget` 由通用 `ash-context-engine` 提供，其余选择模型仍由
Core 内部拥有。live Config、provider client 和 mutable manager 都不会进入不可变规划输入。

### 4.1 ContextInput

```rust
struct ContextInput {
    source_thread_sequence: u64,
    current_turn_id: TurnId,
    instructions: Vec<InstructionFragment>,
    evidence: Vec<ContextEvidence>,
    items: Vec<ThreadItem>,
    checkpoints: Vec<ContextCheckpoint>,
    terminal_turns: BTreeSet<TurnId>,
    item_sequences: BTreeMap<ItemId, u64>,
    tools: Vec<ToolDefinition>,
    budget: ContextBudget,
}
```

`ContextInput` 是一次 prepare 操作看到的完整不可变输入。它不得包含 live config manager、
credential store、provider client 或可变 Session history。

### 4.2 ContextPlan

```rust
struct ContextPlan {
    source_thread_sequence: u64,
    instructions: Vec<InstructionFragment>,
    omitted_instructions: Vec<OmittedInstruction>,
    checkpoint: Option<ContextCheckpoint>,
    selected_items: Vec<ThreadItem>,
    tools: Vec<ToolDefinition>,
    budget: ContextBudgetReport,
}
```

ContextPlan 必须可诊断：

- 从哪个 Thread sequence 派生；
- 选中了什么；
- 省略了什么以及原因；
- token 预算如何分配；
- 使用了哪个 checkpoint。

模型选择冻结在同一次 `ModelInvocationSnapshot`；策略版本和 Skill 激活来源冻结在 durable Turn，
不复制进 `ContextPlan`。

Skill 的发现、启用、模型选择和入口解析不属于上下文系统。外部 runtime 根据 durable activation
解析出 `PromptFragment { source, layer, retention, body }`，也可以贡献 metadata-only catalog
fragment；Core 只校验 fragment provenance，按 Skill layer、`Required / BestEffort` 预算语义
注入。模型随后通过普通 Tool Call/Result 按需读取 Skill 正文。catalog generation、`$` 选择入口和
activation reason 不进入模型可见 Skill 正文。

它不要求成为公共 wire model。测试和诊断可以使用 Core-private readable view。

### 4.3 ContextManager 状态

```rust
struct ContextManager {
    observed_thread_sequence: u64,
}
```

首版 manager 只拒绝倒退的 Thread sequence，然后调用纯规划器；它没有 cache、reference baseline
或 token estimate。未来增加的派生字段仍必须可丢失。若某个字段丢失会改变恢复后的语义，它就
不应只存在 ContextManager 中，而应先成为 durable fact。

## 5. 组件职责

### 5.1 ContextManager

负责：

- 检查 Thread/policy/model revision；
- 选择 context window 与有效 checkpoint；
- 组织 instruction、seed、history、Tool Result 和 Agent result；
- 调用纯 budget/selection planner；
- 决定是否需要 compaction；
- 管理 reference baseline 与 cache invalidation；
- 生成 `ContextPlan` 或明确的 `ContextPreparation` outcome。

不负责：

- 写 Thread store；
- 直接修改 Thread projection；
- 持有 provider client；
- 读取 live Config/MCP/Skill manager；
- 将未经验证的 memory 自动注入；
- 直接执行 summary model；
- 跨 Thread 读取另一个 live ContextManager。

### 5.2 ContextPlanner

选择和预算算法应保持纯函数：

```text
ContextInput + ContextPolicy
  → Ready(ContextPlan)
  | NeedsCompaction(CompactionPlan)
  | ContextError
```

把 planner 保持为纯函数可以独立验证 放置顺序、budget、Tool pairing、checkpoint selection 和
determinism。`ContextManager` 只协调生命周期与缓存。

### 5.3 ContextAssembler

只负责：

- 将 resolved instructions 写入 canonical request；
- 将 selected Item 转成 provider-neutral `InputItem`；
- 保持 Tool Call/Tool Result 配对与顺序；
- 应用已经确定的 tools、tool choice 和 output limit；
- 拒绝损坏 JSON、悬空引用和不支持的 canonical shape。

它不重新选择历史、不决定 compaction，也不读取 ThreadController。

当前 `ContextAssembler` 只接受 `ContextPlan`；Thread snapshot 的读取和选择由
ContextManager/Planner 完成。

### 5.4 通用预算引擎

[`ash-context-engine`](../ash-rs/context-engine/README.md) 只拥有模型无关的预算数学和 token 计量
结果：它区分普通请求的压缩压力线与模型硬窗口，接受精准 preflight/本地 tokenizer 结果或带保守
记账余量的估算，并返回 `Fits`、`NeedsCompaction` 或 `ExceedsContextWindow`。

它不读取 Thread、不选择历史、不执行 provider 请求，也不消费响应 usage。Core planner 使用它解析
预算边界，仍拥有 指令放置顺序、完整语义单元选择和 compaction outcome。provider adapter
只负责产生与所选模型匹配的计量结果，不能拥有另一套预算公式。

### 5.5 提示词所有权与组装

提示词按功能归属：`ash-models-manager` 拥有所选模型的基础 instructions，Goal 提示归 `ext/goal`，动态上下文由对应贡献者提供，`ash-guardian-reviewer` 拥有与动作授权 response schema 绑定的审查提示词，Skill、扩展和工具描述由各能力 crate 拥有。[`ash-prompts`](../ash-rs/prompts/README.md) 提供统一资产和冻结契约，并拥有 context compaction、通用代码 review 这类共享产品提示词。

App Server 在接受普通 Turn 前把 `ash-models-manager` 的基础 instructions 冻结为 durable `TurnInstructions`，review Turn 则冻结共享 review rubric 并标记 `TurnKind::Review`。`$create-instructions` 使用通用 Skill 激活流程创建指令文件。Core 不在 invocation 时重新读取模型配置；它把 Turn 快照连同 User、Directory、Goal、Skill 与扩展 fragment 按 instruction layer、放置顺序、budget 和 provenance 组装成最终 request。User Instructions 位于 Directory 之前，两者作为 user-role 指令进入首条输入消息，不进入 system body。Core 从本 Turn 成功的 `read_file` / `read_instruction` 调用提供路径，App Server 确认目录归属后做 Contextual 匹配，并按准确指令文件读取路径加载 OnDemand 正文。写入工具提交后，由 host 在执行前校验目标路径的规则；缺少规则以工具错误返回模型，不能用同一批调用中新读到的规则直接执行写入。Review Turn 跳过 active Goal 注入与 Goal continuation。历史旧 Turn 可以读取为缺少快照，但不能以临时查询或默认文本继续执行。

当前 assembler 会把同一 Turn 中相邻的 `UserMessage` / `UserImage` 按 durable 顺序合并成一个
provider-neutral user `Message`，分别映射为 `ContentPart::Text` 与
`ContentPart::ImageUrl`。图片内容在 Turn 接受阶段已经由 Core 校验；provider adapter 只负责
转换为各自的 URL/base64 image block。

## 6. 上下文组织

### 6.1 逻辑层次

当前 instruction fragment 使用以下放置顺序；它不代表语义权威或工具权限：

```text
1. System
2. Product
3. User
4. Directory
5. Skill
6. Turn（本次调用上下文）
```

验证过的 checkpoint 随后替代其覆盖的历史前缀，未覆盖 tail、Tool Call/Result 和当前 Turn 输入
保持 durable 顺序。Session defaults、Agent role/seed 和 reference resources 尚未接入；接入时必须
增加明确 layer/retention/provenance，而不能依赖字符串拼接顺序。Provider adapter 只能做 wire
映射，不能改变 Core 已解析的放置顺序与消息角色。

### 6.2 指令优先级

Core 的 `InstructionPlacement` 只决定请求位置；`InstructionRetention` 独立决定预算保留。
用户和目录文件以独立 `HarnessInstruction` 进入 Core，保留来源路径、正文 SHA-256、scope、root
和 activation。上下文计划按文件保留 source identity 与 revision；最终文本带 scope、root、activation
和 revision。相同正文的不同文件不会按正文去重。

产品提示中的 `instruction-priority` 统一规定：

- 系统、产品安全规则与工具权限不受 Markdown、Skill、附件或委托任务覆盖。
- 在上述限制内，当前用户明确要求优先于持久指令；个人规则优先于目录规则。
- 目录规则只适用于声明的 root；子目录规则和 `ASH.md` 可以细化约定，不能默默取消上层明确约束。
- 同级冲突不按文件名字典序决定胜负；阻碍任务时说明冲突并澄清。
- 手动附加、工具读取、Skill 激活、消息位置不提升来源权威或扩大作用范围。
- 当前自动规则快照决定当前激活规则，旧对话副本不重新激活已删除或撤权的规则。

显式附件保存本次选择时的正文与来源标记，仍作为普通 Turn 上下文保存；它不变成系统指令。
Core 不解析自然语言冲突，也不声称通过排序保证模型遵守。权限与文件工具前置条件由执行路径检查。
“已选择”“已注入”“已读取”和“已遵守”是不同结论，读取成功不能作为遵守证明。

每次调用重新选择当前授权范围的文件并计算正文 revision，不冻结旧 catalog 来换取缓存命中。
逐文件来源存在于内部上下文计划与渲染内容中；尚无独立的逐调用指令清单查询 API。

### 6.3 结构不变量

任何 ContextPlan 必须满足：

- 当前用户输入不可被预算算法删除；
- Tool Result 必须引用可见 Tool Call；
- 需要继续执行的 Tool Call/Result group 原子保留；
- Agent result 必须引用可见 delegation/message identity；
- checkpoint 与 tail 不重复覆盖同一 source range；
- omission 不破坏角色和调用边界；
- provider 不支持的内容只能按显式降级策略转换或报错；
- reasoning/plan 是否回灌必须由 canonical contract 明确允许。

### 6.4 模型输入逐项限幅

`ContextPlanner` 先校验 durable `ThreadItem` 形状，再从同一批 Item 生成只属于本次规划的
bounded clone。Thread event、`ThreadSnapshot` 和 attachment object 都不被改写：shell 结果按
30 KiB 保留头尾，`read_file` 按 2000 行和每行 2000 字符限制，`grep`/`glob` 保留 100 条，带
MCP provenance 的结果按 25 KiB 保留头尾。截断诊断记录原始大小、遗漏量和继续读取或缩小查询的
动作。

普通 `ContextPlan`、预算估算、自动压缩和供应商 overflow recovery 共用这份 bounded clone，避免
超大 durable 结果在截断前独占窗口；structured Tool Result 按实际 `ContentPart` 计量，不重复把
fallback text 算作第二份模型内容。图片 admission 只做安全校验和必要的格式 canonicalization，不按
provider 窗口降采样；模型调用和 preflight
在 attachment materialization 边界读取选中 provider/model 的 detail policy，生成临时降采样 data
URL，canonical attachment reference 继续作为 durable authority。

## 7. 上下文预算

### 7.1 预算输入

预算至少包含：

- model context window；
- reserved output tokens；
- system/developer instruction cost；
- Tool definitions cost；
- current Turn minimum；
- Tool/Agent continuation minimum；
- safety margin；
- compaction threshold；
- tokenizer/estimate revision。

预算计量与响应 usage 是两类事实：前者在调用前判断候选请求能否发送，后者在调用完成后记录实际
消耗。精准计量可来自匹配模型的本地 tokenizer 或 provider preflight；provider preflight 本身不
等于精准，准确度必须由 provider 契约独立声明。估算的 measured value 用于诊断，预算边界使用带
策略余量的 accounted value；该余量不冒充 provider 承诺的数学硬上界。

不得使用一个含义不明的 `max_tokens: Option<u32>` 同时表达 context window、output limit 和缺省。
这些值使用独立 newtype/enum。

### 7.2 预算顺序

推荐顺序：

```text
model context window
− reserved output budget
− mandatory instructions/tools/current input
− safety margin
= history budget
```

历史选择按完整语义单元处理，而不是按字符串尾部截断：

- Turn group；
- Tool Call/Result group；
- Agent delegation/result group；
- checkpoint + uncovered tail；
- attachment/artifact reference group。

自动压缩阈值只决定何时产生压力，不是模型硬窗口。普通规划使用 pressure limit；独立压缩请求
可以使用完整 context window，但仍扣除 reserved output 与 safety margin，并且它自身必须通过
预算估算。这样低阈值会更早压缩，却不会错误拒绝仍可装入模型硬窗口的 source prefix。

Core-managed plan 会把同一份 `reserved_output` 写入该次不可变 `ModelRequest`。Provider 配置只在
请求没有显式 limit 时提供缺省，因此 budget 与实际输出上限不会在 invoke 前因配置刷新而漂移。

### 7.3 Overflow 结果

预算不足必须产生明确 outcome：

- `NeedsCompaction`；
- `CurrentInputTooLarge`；
- `MandatoryInstructionsTooLarge`；
- `ToolDefinitionsTooLarge`；
- `CheckpointCapacityTooSmall`；
- `CompactionSourceTooLarge`；
- `UnsupportedContextShape`。

不能静默删除当前输入、权限约束或未完成 Tool/Agent continuation。

已知窗口可以来自内置 `ModelInfo`，也可以由 `ModelProviderConfig.model_context` 按模型 ID 配置；
窗口未知时使用 `ContextBudget::ProviderManaged`，Core 不假装拥有可靠上限。预算解析、精准/估算
计量结果和统一边界判定已由 `ash-context-engine` 提供；生产 planner 首轮仍使用带 revision 的
确定性 byte estimate。最终 canonical request 会按“官方 preflight → 匹配模型的本地整请求计数 →
Core 保守估算”降级：OpenAI Responses 为 exact；Anthropic、Google native `countTokens`、Kimi
estimate 与 Z.AI tokenizer 为 estimated remote；本地 `hf-chat-template + tokenizers` 结果为
estimated。只有 provider definition 明确声明且 model policy 允许的 binding 才会触发远程计量。

有冻结 `ModelRef` 的普通调用和模型驱动 compaction 会把调用前 input estimate、estimator revision
与 calibration revision 附在同一 durable `ModelUsageRecorded` 上。reducer 仍先按原始 provider
usage 维护 Thread/Turn 聚合，再按 Thread 内的模型与 estimator revision 重建低估比例：更大的低估
立即收紧未来容量，较小误差按非对称 EMA 渐进衰减；缺失 provider input usage 时不生成样本。
校准只减少后续 Core-managed budget，不能放大配置容量，不能改变历史 usage 或 checkpoint；
`ProviderManaged` 没有本地可信容量，因此即使存在样本也保持原语义。

## 8. 压缩

### 8.1 持久化压缩摘要

本节的 `ContextCheckpoint` 是模型输入摘要。用户选择消息节点回到过去使用 `MessageCheckpoint`，其历史和文件边界见 [`protocol.md`](protocol.md#6-消息恢复点与共享历史)。共享历史前缀可在一个绑定事件内覆盖多个 Turn；压缩必须按 `referenced_items` 选择完整 Turn，摘要 digest 同时覆盖事件来源和实际 Items。后续摘要不能覆盖倒退或不连续的内容。

恢复分支只读取选定消息边界之前的原记录；在该位置之后产生的摘要不会继承。压缩保留原始消息和文件恢复证据。

Checkpoint 至少记录：

- stable checkpoint ID；
- source Thread；
- covered sequence range；
- referenced Item/Event IDs；
- source digest；
- summary 内容或 artifact reference；
- schema、prompt 与 context policy revision；
- generator/model metadata；
- creation time；
- verification status。

原始 event log 永不因 compaction 删除。

### 8.2 压缩流程

```text
ContextManager detects pressure
→ returns NeedsCompaction(CompactionPlan)
→ Turn/Core orchestration invokes CompactionService
→ validate summary + provenance + digest
→ ThreadController durable commits checkpoint
→ install new ThreadSnapshot
→ ContextManager invalidates old window/cache
→ prepare again from committed snapshot
```

Summary model I/O 不持有 Thread writer。只有 checkpoint durable commit 后，后续 invocation 才能
依赖它。

### 8.3 供应商溢出恢复

当普通请求已经发送、供应商仍返回 `ContextOverflow` 时，Core 不猜测一个新的模型窗口，也不清空对话。`ContextPlanner::prepare_overflow_recovery` 只选择当前 Turn 之前的 terminal 历史前缀；如已有 checkpoint，可连同未覆盖 tail 一起重新压缩。目标摘要最多 1024 个估算 token，并且必须小于被吸收历史的估算大小。

```text
provider ContextOverflow
→ derive overflow CompactionPlan from latest durable ThreadSnapshot
→ generate bounded summary without tools or current-Turn input
→ atomically commit ContextOverflowRecoveryCommitted(checkpoint + turn_id)
→ rebuild ModelInvocationSnapshot from the committed ThreadSnapshot
→ retry the ordinary model request once
→ second ContextOverflow becomes stable contextOverflow
```

`ContextOverflowRecoveryCommitted` 同时是 checkpoint 事实和 Turn 级单次恢复标记。reducer 只允许它绑定一个 Running Turn，验证 covered range 早于当前 Turn 的第一条 durable Item，并拒绝同一 Turn 的第二个恢复 checkpoint。取消发生在摘要生成或提交前时不会产生 checkpoint；取消与提交竞态时最多留下已验证 checkpoint，后续模型重试仍会先看到 cancellation。进程在提交后、重试前退出时，普通 model-only Running Turn 按既有恢复规则转为 Interrupted，不自动重放可能已经发生的模型调用。

若当前 Turn 之前没有可压缩历史，或压缩请求本身溢出，当前 Turn 直接以稳定 `contextOverflow` 失败，不进入递归压缩。

### 8.4 手动压缩

`/compact [保留提示]` 不是普通消息，也不复用正在运行的 Turn。App Server 通过 typed
`SessionRequest::CompactContext` 创建独立的 `ThreadCommand::CompactContext` Turn，并把所选模型和
经过大小校验的可选提示冻结在 command receipt 中。相同 command ID 与相同 payload 在恢复后返回
原 Turn；不同 payload 冲突；Thread 上存在任何非终态 Turn 时拒绝开始，因此手动压缩不可 steering，
也不会与模型或工具副作用竞态。

本地执行器从最新 checkpoint 之后选择最老的完整 terminal durable 前缀。未完成 Turn、未配对的
Tool Call/Result 组和压缩 Turn 自身都不进入 source；选择与普通压缩共用 bounded clone。Core-managed
窗口会把过长 source 分批变成连续 verified checkpoint，每次模型 usage 都先写入 durable ledger，
再提交 checkpoint 并从最新 snapshot 重规划。没有安全候选时 Turn 直接完成；生成、验证或 commit
失败时当前批次不产生 checkpoint，Turn 以 canonical failure 出现在对话。

可选保留提示作为 compaction model request 中独立于 untrusted durable source 的用户要求，不写成
Thread 用户 Item，也不改变 Core compaction prompt revision 或 checkpoint source provenance。
订阅后端对无提示请求调用 upstream `thread/compact/start`，压缩状态由远端 Thread 拥有；上游没有
保留提示字段，因此带提示的订阅请求明确失败，不能静默忽略。

### 8.5 恢复与失效

以下情况会使 checkpoint commit 或 event replay 失败即关闭，损坏的摘要不会进入 projection：

- source range 不存在或重叠错误；
- digest 不匹配；
- schema/policy 不兼容；
- referenced Item 缺失；
- checkpoint 来自另一个 Thread；
- schema/policy revision 缺失；
- checkpoint range 倒退或不是 Thread 前缀。

当前不会在已损坏 event stream 上静默跳过 checkpoint 后继续恢复；原始事件也从不因压缩删除，
因此后续可以增加显式修复/隔离工具，而不用依赖摘要作为唯一副本。

Provider/model 切换不自动使 checkpoint 失效，但必须重新按新 model limits 和 capabilities 规划。

## 9. 上下文窗口与供应商变更

Context window 是模型可见历史的派生窗口，不是新的 history aggregate。

每次 model/provider/context policy 变化：

```text
wait for safe point
→ freeze new revisions
→ invalidate incompatible cached plan/baseline
→ rebuild from durable ThreadSnapshot
→ create new ModelInvocationSnapshot
```

Core 为普通 Turn 请求写入 Session 级 prompt cache key，并在 `ContextPlan` 组装时标出当前 Turn 之前的可复用输入前缀。同一 Session 内的 fork 保留原消息与 key；委托说明追加在前缀之后。模型、工具集、权限指令或模型可见环境变化仍可能改变请求，不能由 AgentId 相同推断缓存命中。

OpenAI 公开 Responses API 对支持模型将 Core 前缀终点映射为显式缓存断点；旧模型保持自动缓存。model-provider 按登录通道选择 `ApiEndpoint::ChatGptResponses`，由 ash-api 省略订阅接口不支持的断点，并将同一缓存 key 写入 `session-id` 请求头。续写、fork、消息恢复和认证重试共用这个协议入口，调用者请求和认证 target 不被改写。结构化工具结果和图片能力与断点支持分别处理。供应商行为见 [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)，跨 provider 的请求头规则与验证见[模型 API 协议](ash-api.md#14-供应商配置档案验证矩阵)。

Provider response ID、缓存命中和连接状态都不是恢复正确性的前提。

## 10. 多 Agent 规则

每个 child Agent 的 ContextManager 只读取：

- child Thread 的 durable history；
- spawn 时固定的 `AgentContextSeed`；
- durable delivered parent/peer messages；
- child 自己的 policy/environment snapshot。

它不能读取 parent/sibling 的 live history 或 ContextManager。

Spawn context mode 必须显式：

```text
Fresh
Selected(item/artifact references)
ForkedPrefix(full | last turns | checkpoint plus tail)
```

Full 模式以 `HistoryPrefixBound` 引用原始事件；Selected、LastTurns 与 CheckpointAndTail 只物化明确选中的有界内容。所有模式都固定 parent Thread sequence 和 provenance。Spawn 后 parent compaction 或继续执行不改变
child 的 seed。Child result 回到 parent 后只是一个有界、可追踪的 durable result Item，由 parent
ContextManager 决定是否选入下一次 ContextPlan。

详细协议见 [`core-multi-agent.md`](core-multi-agent.md)。

## 11. 目录与可见性

```text
ash-rs/
├─ context-engine/
│  └─ src/
│     ├─ budget.rs
│     ├─ measurement.rs
│     ├─ planner.rs
│     └─ *_tests.rs
└─ core/src/
   ├─ context.rs
   ├─ context/
   │  ├─ model.rs
   │  ├─ plan.rs
   │  ├─ assembler.rs
   │  ├─ compaction.rs
   │  ├─ instructions.rs
   │  ├─ invocation.rs
   │  ├─ planner.rs
   │  ├─ skills.rs
   │  └─ *_tests.rs
   ├─ context_manager.rs
   └─ context_manager_tests.rs
```

`context-engine` 保存可跨产品和 provider 复用的预算 value 与纯判定；Core `context` 保存 Thread 内容
选择和组装算法；`context_manager` 保存 per-loaded-Thread 协调逻辑。Core 两个模块默认 private。
`ContextSource` 是 Core 的通用可选 evidence port：host 可在 Turn 第一次 model invocation 前返回带
provenance 的 bounded evidence。Core 对已知窗口最多分配 input budget 的 1/8，并把内容作为 user-level
`trust="untrusted-data"` 数据插在当前用户输入之前，不能提升为 system/directory instructions。
Memory 由 `ext/memories` 通过 `ContextContributor` 注册；`ContextEvidence` 与请求身份由 `extension-api`
定义。Core 先按注册顺序收集扩展材料，再按来源名称收集 host port，两者共用同一预算与低信任入口。
替换或移除 Codebase 不影响 Memory，各条材料保留独立来源、引用和 revision。
来源失败会结束本次 Turn，取消继续传播，不能使用已经收集的
部分内容继续调用模型。压缩或 token 计量导致准备重试时重新读取，避免保留已删除或撤销授权的材料。
Codebase 自动召回由产品设置显式开启；Memory 自动读取由 [Memory API](ash-app-server-api.md#memory)
按作用域独立授权，默认关闭。
只有确有外部消费者时才从 `lib.rs` 导出窄 value/port，不能公开 cache、baseline、window mutable
state 或 ContextManager 自身。

长期 ownership：

```text
ThreadController
└─ LoadedThreadState
   └─ ContextManager

TurnExecutor
└─ asks ContextManager to prepare
   └─ receives immutable ContextPlan
```

## 12. 当前实现与扩展点

| 能力 | 状态 | 边界 |
| --- | --- | --- |
| 不可变输入、纯规划器和调用快照 | ✅ 已实现 | 同一输入产生确定性选择；倒退 sequence 被拒绝 |
| 通用 Skill 指令端口与预算行为 | ✅ 已实现 | 外部返回 `Required / BestEffort`；Core 不拥有 Skill 发现或选择 |
| durable checkpoint、摘要生成、commit 后重规划 | ✅ 已实现 | 原始 event log 永不删除；压缩请求本身也受预算限制 |
| 供应商上下文溢出恢复 | ✅ 已实现 | 只压缩 terminal 旧历史；checkpoint 与 Turn 恢复标记原子提交；最多重试一次 |
| 已知模型窗口的生产启用 | ✅ 已实现 | 可通过 `model_context` 配置；未知模型退回 provider-managed |
| 通用预算与精准/估算计量契约 | ✅ 已实现 | `ash-context-engine` 统一压力线、硬窗口和保守记账判定 |
| provider input-token preflight | 部分具备 | OpenAI exact；Anthropic、Google、Kimi、Z.AI estimated；官方接口失败时降级到本地或 Core 估算 |
| 请求级本地 token 计数 | 部分具备 | HF 公共模型按需发现/下载/缓存；其他 provider 需固定资产清单；多模态 processor 尚未接入 |
| provider usage 校准 | ✅ 已实现 | estimate 与 usage 仍是独立 durable 字段；按 Thread、冻结模型和 estimator revision 重建只影响未来 Core-managed capacity 的非对称 EMA |
| provider prompt cache intent | ✅ 已实现 | Session 级 key + 请求内前缀断点；fork 继承检查点和历史前缀，cache miss 不影响正确性 |
| cache/reference baseline | 推迟 | 只有性能证据证明重复组装是瓶颈后才增加 |
| Agent seed、跨 Thread 选择与 reference resources | 尚未完成 | 不能读取其他 live `ContextManager` |

后续扩展不得先复制 mutable history。cache、baseline 和校准投影必须是可丢弃派生状态；恢复校准
所需的调用前 estimate/revision 与 provider usage 已进入 durable Thread fact。其他会改变恢复语义的
内容也必须先进入 durable fact。

## 13. 验证

必须覆盖：

- 相同 ContextInput 产生字节级等价的 ContextPlan；
- 指令放置顺序、角色与来源；
- budget boundary 与 mandatory overflow；
- Tool Call/Result 原子保留；
- Agent delegation/result 原子保留（阶段 D protocol 类型落地后启用）；
- checkpoint + tail 无遗漏、无重复；
- corrupt checkpoint replay fail closed，且原始 event log 保持完整；
- provider/model/policy revision invalidation；
- ContextManager 丢失后从 durable facts 重建等价结果；
- parent/child/sibling context 隔离（多 Agent 运行时落地后启用）；
- compaction crash before/after durable commit；
- provider overflow 的 commit-before-retry、二次溢出、取消与 restart no-replay；
- current input 永不被静默删除。

手动运行真实缓存验证：

```bash
just test ash-app-server --lib luna_cache_survives_fork_and_message_restore_after_restart -- --ignored --nocapture
```

该测试仅使用 Luna／low 和合成文本，读取已有 Codex 登录状态，不刷新或改写凭据。它经过 SQLite 历史、Core 执行循环和真实模型通道，比较原分支、fork、重新打开数据库后的消息前后恢复，并输出各次调用的输入、缓存读取、缓存写入、输出 token 和耗时。默认测试不发送这些真实模型请求；缓存未命中时保留测量结果并明确失败，不能把本地前缀相等当作服务端命中。

2026-09-10 的 Luna／low 订阅通道实测定位了此前全为 0 的原因：Ash 只发送了 body 中的 `prompt_cache_key`，缺少 Codex 同时发送的 `session-id` 请求头。固定输入的对照显示，仅补 `session-id` 即可命中；单独补 `thread-id`、`x-client-request-id` 或 `client_metadata` 不能替代它。Responses Lite、verbosity 和 turn-state 不属于这次修复的必要条件。原始 SSE 与 Ash 解析后的缓存计数一致。

正式通道补齐请求头后，约 14.3k 输入的原分支续写、fork、重新打开数据库后的消息前后恢复，以及完全相同请求对照都报告 14,080 个缓存读取 token；首轮为 0。历史、身份和请求前缀断言通过，登录凭据未改写。该通道本次仍报告 `cache_write_tokens = 0`，不能据此推断没有写缓存。模型服务的路由和缓存状态仍可能使后续运行出现未命中。

针对路由头的独立对照与原始 SSE 用量核对：

```bash
just test ash-model-provider --lib live_luna_cache_requires_session_routing_header -- --ignored --nocapture
```

## 14. 固定决策

- Context 属于一次 model invocation；
- ContextManager 属于一个 loaded Thread；
- Session 和 Agent tree 不拥有共享 ContextManager；
- Thread event stream 是唯一 history authority；
- ContextManager 可丢失、可重建；
- ContextAssembler 保持纯组装；
- 模型无关预算公式和 token 计量结果属于 `ash-context-engine`；
- 选择、预算和 compaction 决策不进入 provider adapter；
- checkpoint durable，但不删除原始 history；
- 多 Agent 只通过 immutable seed 和 durable message/result 传递 context；
- 跨 Thread memory 在单独 RFC 完成前不进入 ContextManager。

Code Mode 重新绑定工具服务时同步更新工具与权限服务，并保留共享的单元、父调用关系和会话存储。已有单元保留创建时的调用服务与冻结目录；宿主只授权隔离运行器的控制操作，每个嵌套工具仍经过自己的权限检查。
