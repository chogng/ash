# Agent Harness 设计

> 状态：Accepted（2026-08-03）；实现状态最后核对于 2026-08-30。
> 定位：回答"Core 的 agent loop 具体怎么搭起来"——一次模型调用长什么样、Turn 内循环与
> 失败弹性、steering、提示词组织、工具选择与注册时机、上下文裁剪压缩、prompt cache、评测。
>
> 分工：执行内核（单写者、durable commit、恢复、取消）由
> [`ash-agent-runtime-architecture.md`](ash-agent-runtime-architecture.md) 负责；上下文生命
> 周期抽象（ContextPlan/Manager/checkpoint）由 [`core-context.md`](core-context.md) 负责；
> 工具三层契约（定义/绑定/执行接口）由 [`tools.md`](tools.md) 负责；**逐工具规格（schema、
> 描述正文、错误文案）由
> [`agent-tools-spec.md`](agent-tools-spec.md) 负责。本文负责 harness 的**行为策略**。

## 快速理解

| 问题 | 结论 | 深入阅读 |
| --- | --- | --- |
| 模型调用失败怎么办？ | 运行时按错误类别重试、压缩或稳定失败；终态错误在对话内提供重试、换模型、新对话或改方案动作 | [§7](#7-turn-内循环与失败策略) |
| Agent 运行中用户发消息怎么办？ | durable 追加到当前 Turn；本地模型输出在安全点与 steer 原子仲裁，再从最新 snapshot 重规划 | [§8](#8-引导与并发输入) |
| 提示词怎么做？ | 分域拥有：模型基础 instructions 归 models-manager，工具描述归工具 owner，Directory/Goal/Skill 各自贡献 fragment，Core 统一组装 | [§4](#4-提示词) |
| 工具选哪些？ | 统一八件套；`apply_patch` 是默认代码变更协议，`edit` 是唯一字符串微编辑和降级工具；逐工具规格见 tools-spec | [§5](#5-工具集) |
| 工具什么时候注册？ | Turn 接受时冻结；内置静态平铺，MCP 超阈值切检索式；不做运行时动态增删 | [§6](#6-工具注册时机) |
| 上下文怎么裁剪/压缩？ | 输入侧逐条限幅；历史语义单元保留；阈值用 `ModelInfo.effective_auto_compact_token_limit` | [§9](#9-上下文裁剪)、[§10](#10-压缩) |
| 缓存怎么搞？ | 前缀字节稳定 + append-only；`cache_control` 由 Anthropic adapter 注入 | [§11](#11-prompt-缓存) |
| 怎么知道 harness 变好了？ | 普通行为用 Rust/TS 回归；多 Agent 安全边界已有版本化模型在环评测；真实任务质量仍需单 Agent 对照 | [§14](#14-评测) |

## 1. 现状差距

一个可用的 coding agent harness 需要的每个环节，对照 Ash 当前实现：

| 环节 | 可用 harness 需要 | Ash 现状 |
| --- | --- | --- |
| Model instructions | 每次调用注入身份、策略和通用工作行为 | ✅ `ash-prompts::AGENT_INSTRUCTIONS` 与所选模型指导在 Turn 创建前冻结，Core 通过 `ContextPlan` 与当前 Role 组合 |
| 环境上下文 | cwd、平台、日期、git 状态、目录指令 | ✅ Local Environment host 在 model safe point 提供环境与 `.ash/instructions` snapshot |
| 工具面 | 读/搜/改/执行闭环 | ✅ `coding-v1` 在 Turn 接受时冻结模型中立的 exact 工具定义；canonical direct 文件工具、`apply_patch`、shell 与 durable `update_plan` 已进入本地闭环 |
| 模型失败弹性 | 429/5xx 退避重试、溢出压缩重试、空响应处理 | ✅ 类型化错误、退避、单次溢出恢复、空响应重试、Refusal 完成语义和对话内错误动作已接通 |
| Steering | 运行中排队注入用户消息 | ✅ typed command、receipt、delivery fact、App Server、Desktop 与本地重规划均已接通 |
| 工具结果限幅 | 模型侧截断 + 保留头尾 | 已实现：ContextPlan 为 shell、read、search、MCP 生成带 continuation 的 bounded clone，durable 原值不改写 |
| 上下文预算 | 窗口估算、溢出显式处理 | ✅ 已知/配置窗口走确定性预算；未知窗口明确退回 provider-managed |
| 压缩 | 阈值触发、durable checkpoint | ✅ `ash-prompts` 共享 compaction 提示词、source digest、原子 commit、恢复校验与 commit 后重规划已接通 |
| Prompt cache | 前缀稳定 + 断点标注 | 已实现：Anthropic tools/system/滚动 user 三断点、cached usage 与 scope 回归已接通 |
| 多 Tool Call/响应 | 模型一次响应多个调用 | 已实现：`parallel_tool_calls: true`，调用先完整持久化再按顺序执行，避免并行写副作用 |
| 计划工具 | 长任务显式计划状态 | ✅ `update_plan` 提交 durable `PlanUpdated`；Turn 与 Desktop 只投影最新 canonical plan，恢复/replay 保持一致 |
| 评测 | 任务集 + 指标回路 | Core、App Server 和 Desktop 覆盖确定性行为；真实任务 baseline 与 production telemetry 尚未接入 |

## 2. 一次模型调用的目标形态

```text
ModelRequest
├─ instructions                          ── Core 按 precedence 组装
│  ├─ 模型基础 instructions                 （models-manager，按冻结模型选择）
│  └─ Product fragments                    （Goal、Agent 与 system/product extension）
├─ input
│  ├─ [0] Directory/Skill fragments        （`.ash/instructions`、Skill 与对应 extension）
│  ├─ [1..] durable history                （append-only，语义单元完整，
│  │                                        可含 checkpoint summary 替代更早历史）
│  ├─ 当前 Turn 输入 / steering 消息        （+ append-only reminder 块）
│  └─ [last] 环境快照                       （字段见 §4.2）
└─ tools                                  ── Turn 接受时冻结的 ToolProfile
```

三条硬规则，所有后续设计都从它们推导：

1. **前缀稳定**：`instructions`、`tools`、已有 history 在 Turn 之间逐字节不变，新内容只
   append（[§11](#11-prompt-缓存) 的前提）。
2. **语义单元完整**：Tool Call/Result 成对；一个 Turn 的内容原子保留或原子被 checkpoint
   吸收（[`core-context.md`](core-context.md) §6.3）。
3. **变化走安全点**：工具面、模型、策略、环境快照只在 Turn 边界或压缩边界变化。

## 3. Turn 内循环

一次 Turn 的执行循环（现有 `TurnExecutor::execute_steps` 的目标形态）：

```text
loop:
  1. 检查取消
  2. 读最新 durable snapshot（steering 消息在此自然进入）
  3. 预算检查：估算占用 ≥ 阈值 → 先压缩（§10），压缩失败且未超硬限 → 继续
  4. ContextManager.prepare → ContextPlan → ContextAssembler → ModelRequest
  5. 调用模型（含 §7 重试策略），流式 delta 经 sink 发布
  6. 响应分类：
     ├─ 有 Tool Call → durable 记录 → ToolScheduler 顺序执行（审批/沙箱/
     │                  升级语义见 core.md §11）→ 回到 1
     ├─ 只有文本   → durable 提交 agent message → Turn Completed
     ├─ Refusal    → 作为最终消息提交 → Turn Completed（不是失败）
     └─ 空响应     → §7 空响应处理
```

无固定迭代次数上限（runtime 文档决策）；失控防护见 [§7.3](#73-失控防护)。

## 4. 提示词

### 4.1 四层结构

| 层 | 内容 | 变化频率 | 存放位置 |
| --- | --- | --- | --- |
| 模型基础 instructions | 身份、指令优先级、注入防护、通用工作行为和输出风格 | 新 Turn 创建时冻结；已开始 Turn 永不变化 | `ash-models-manager` 拥有资产；App Server 冻结到 durable `TurnInstructions` |
| 工具契约 | exact schema、描述、使用边界和错误语义 | 随 tool profile | 各工具 owner；随冻结的 `ToolDefinition` 进入请求，不复制进基础 instructions |
| 环境快照 | 见 §4.2 | 环境连接时采集静态字段；accessible dirs 在每次模型调用时读取 | `ash-agent-environment` 定义值和渲染，App Server 采集，Core 放在请求尾部 |
| 目录与功能指令 | Global `.ash/instructions`、Goal、Skill、extension fragment | model invocation 内冻结；对应状态变化影响后续调用 | 各功能 owner 提供，Core 按 layer 和 provenance 组装 |

`ash-prompts` 只拥有公共设施和共享产品提示词。目前 context compaction 与通用代码 review 在这里；模型基础 instructions 留在 `ash-models-manager`，Goal 提示归 `ext/goal`，Core 负责最终组装，动作授权审查提示词留在 `ash-guardian-reviewer`。

外部产品如何组织目录指令只是参照系；Ash 的 artifact、目录和加载策略由
[`agent-customizations.md`](agent-customizations.md) 定义。共同点是**静态与动态严格分离**——
这决定缓存命中率，比放 system 还是首条消息更重要。

### 4.2 环境快照：精确字段

```text
<environment_context>
  <cwd>/abs/path</cwd>
  <is_git_repo>true</is_git_repo>
  <platform>darwin | linux | windows</platform>
  <os_version>uname/ver 摘要</os_version>
  <shell>zsh</shell>
  <current_date>2026-08-03</current_date>
  <git_branch>main</git_branch>
  <git_main_branch>main</git_main_branch>
  <git_status>porcelain 摘要，最多 40 行，超出标注截断</git_status>
  <git_recent_commits>最近 5 条 oneline</git_recent_commits>
  <filesystem>
    <accessible_dirs>
      <dir>/abs/path</dir>
      <dir>/通过 add-dir 授权的目录</dir>
    </accessible_dirs>
  </filesystem>
</environment_context>
```

冻结纪律：git、platform、shell 等字段在 Environment 连接时采集一次；需要新鲜状态时模型自己调工具。
`accessible_dirs` 来自当前 Session tree 的有效 Grant，每次模型调用读取一次。Core 每次渲染完整
`<environment_context>` 块，与启用时的本次 `<time_context>` 一起作为最后一条 user-role context 放在
durable Thread history 和当前 Turn 输入之后，不进入可复用缓存前缀，也不制造持久用户消息。
环境增量渲染及历史前缀内的环境消息复用尚未实现。

职责边界：`ash-agent-environment` 只拥有不可变值、目录不变量和确定性渲染；App Server 采集平台与 Git 信息，并通过 `DirGrants` 读取 Session tree 的有效 Authorization；Core 的 `HarnessContextProvider` 在每次模型调用边界冻结两者，并由 Context Planner 负责预算与位置。环境 crate 不执行命令、不保存 Session、不签发 Grant，也不参与工具路径判定。

### 4.3 Directory Instruction 发现与注入

- 发现：只读取已授权目录的 `.ash/instructions/*.md` 文件；`AGENTS.md` 和其他生态
  格式必须经 `external-agent-migration`，原生 loader 不兼容扫描；
- 注入：当前只把 `load: global` 条目渲染为 `input[0]` user message，并标注其优先级低于
  system 与安全策略；
- 大小：每个文件最多 32 KiB、直接条目最多 128，非法条目产生隔离 diagnostic；
- `load: contextual` / `on-demand`：catalog 已保留类型化策略，但资源匹配和显式选择尚未实现；
- 目录不存在或没有合法 Global 条目：省略 `input[0]`，不放占位符；
- 文件变化：Directory watcher 触发 catalog refresh；已经组装的 model request 不变，后续
  model invocation 从 `HarnessContextProvider` 读取新 snapshot。

### 4.4 动态注入：append-only reminder

运行时事件（策略变化、文件被外部修改、计划停滞、按需 Instruction、检索到的 MCP
工具定义）以 `<system-reminder>` 文本块附着在**新增**内容上进入历史，永不回改已有消息。
reminder 声明自己是背景信息而非用户指令。这是 Skill 激活、hook 输出、审批结果回填的统一
入口。

## 5. 工具集

### 5.1 设计原则

1. **`apply_patch` 是默认代码变更协议**：一次表达一个完整的逻辑变更，可包含多个 hunk 和多个文件，便于展示 diff、审批、记录、失败诊断和恢复核验，也减少连续微编辑暴露的中间状态。
2. **`edit` 是微编辑与降级原语**：只在修改唯一字符串、单个常量等小范围确定性变更时使用，或在窄 patch 上下文无法匹配时作为降级；它不是与 `apply_patch` 并列竞争的默认入口。
3. **结构化优于 shell 万能**：结构化工具才能给 `ash-action-policy` 精确的审查材料（参数级 capability、路径级沙箱判定），审批 UX 与 diff 展示也依赖结构。
4. **工具描述就是提示词**：进入每次调用的 tools 前缀，与 system prompt 同级打磨。
5. **少而精**：v1 ≤ 10 个。

`apply_patch` 能把多文件变更表达为一个逻辑请求，但这不等于存储层事务。执行器应在第一次写入前完成全部解析、读取和上下文校验；在事务提交或回滚能力落地前，提交阶段若可能已写入部分文件，必须返回 unknown outcome、禁止自动重放，并要求重新检查工作树状态。

外部 harness 的具体工具形式只能作为 schema 和交互设计参考，不能证明某个模型家族必须绑定某种编辑工具。Ash 只有在版本控制的评测或明确启用、去内容化且达到最小样本门槛的用户聚合数据支持时，才考虑新增按模型细分的候选 profile。

### 5.2 工具面与配置档案

```text
ToolProfile = 默认 coding profile + MCP 暴露策略

默认 coding profile：
  shell / read_file / write_file / glob / grep / update_plan / apply_patch / edit
编辑选择：
  跨位置、跨文件、函数重写、接口迁移 → apply_patch（默认）
  唯一字符串微编辑、单个常量、窄 patch 上下文失配 → edit（微编辑/降级）
MCP（按 §6 阈值）：直接平铺 或 search_tools + call_mcp_tool
```

逐工具规格（schema、描述正文、校验、错误文案、限幅、capability 注记）：
[`agent-tools-spec.md`](agent-tools-spec.md)。

Profile 解析发生在 Turn 接受安全点：host 选择声明式 ToolProfile，并把精确工具顺序、schema/description revision 和并行调用设置冻结进本 Turn。默认使用模型中立的 coding profile；切换模型本身不会推断或切换另一套编辑工具。若以后引入有证据支持的候选 profile，显式配置变化也只影响新 Turn；历史中的 Tool Call/Result 继续作为 transcript，只有当前可调用集合必须匹配冻结 profile。

`parallel_tool_calls` 是 profile 属性：默认 coding profile 允许模型一次响应发多个 Tool Call，执行侧仍按现有调度器和 durable 调用顺序串行，避免并行写副作用。

## 6. 工具注册时机

| 方案 | 结论 |
| --- | --- |
| 全量平铺（Codex 式） | ✅ 内置工具 + 小规模 MCP 采用 |
| 检索式（Claude ToolSearch 式） | ✅ MCP 超阈值采用 |
| 运行时动态增删 | ❌ 不采纳：打破 Turn 冻结、每次变化击穿缓存、审批/恢复无法绑定稳定工具面 |

规则：

1. 内置工具静态平铺，Turn 接受时随 profile 冻结；
2. MCP 聚合定义 ≤ 15 个工具且 ≤ 5k tokens 时平铺进冻结集；超阈值整体切检索式——注入
   `search_tools` + `call_mcp_tool` 两个元工具，被发现的定义以 reminder append 进历史
   （不改 tools 数组，保前缀）；
3. 配置/MCP server 变化走 [`tools.md`](tools.md) §7 的 registry snapshot，只在 Turn 边界
   推进。

## 7. Turn 内循环与失败策略

### 7.1 模型调用错误分类与处理

| 错误 | 判定依据 | 处理 |
| --- | --- | --- |
| 限流 | HTTP 429 | 退避重试；优先遵循 `Retry-After`（上限 60s） |
| 过载/服务端错误 | HTTP 5xx、529 | 退避重试 |
| 传输失败 | `ApiError::Transport`（超时/断连） | 退避重试 |
| 上下文溢出 | 供应商错误体解析 | 完整旧历史前缀持久化压缩后，以新快照重试一次；再次溢出以 `contextOverflow` 稳定失败 |
| 认证失败 | HTTP 401/403 | 不重试；Turn fail（stable error `providerAuth`），提示用户检查凭据 |
| 无效请求 | HTTP 400 / `InvalidRequest` | 不重试；Turn fail（stable error `invalidRequest`）；有界原始详情只进入受控日志 |
| 无效响应 | `InvalidResponse` | 重试 1 次（可能是瞬时截断）→ `invalidResponse` |
| 空响应 | 无文本、无 Tool Call、无 Refusal | 重试 1 次（同一请求）→ 仍空则 Turn fail（stable error `model_empty_response`） |
| Refusal | `ResponseItem::Refusal` | **不是错误**：作为最终消息提交，Turn Completed |
| 取消 | token 触发 | 传播；Turn → Interrupted |

退避参数：基数 1s、倍率 2、上限 30s、抖动 ±25%、**最多 4 次尝试**（1 次初始 + 3 次重
试）。退避等待期间以 ≤100ms 粒度轮询 cancellation token（或用带超时的 condvar），interrupt
必须立即生效。重试不跨越安全边界：只重试**未产生任何 durable 副作用**的模型调用本身；流式
场景下已发布的 transient delta 通过新 stream incarnation 作废（runtime 文档 §4.2）。

### 7.2 工具执行失败

工具失败默认是**正常结果**（`is_error: true` 的 Tool Result 回给模型继续处理），不使 Turn
失败——已是现状。政策拒绝的 circuit breaker（连续拒绝中断 Turn）和重复失败工具熔断均已实现。

### 7.3 失控防护

- **重复失败调用（已实现）**：Core 从 durable Tool Call/Result 按同一工具 + canonical 参数 digest 重建连续窗口；第 3 次失败的 Tool Result 附 reminder，第 5 次在下一个 scheduler safe point 使 Turn fail（stable error `toolRepetition`）。成功、工具变化或参数变化清零；重启在模型再次调用前收敛为相同稳定错误。
- **Thread Goal 预算（已实现）**：durable usage 记账（§9.3）之上，每个 Thread 最多有一个可选 Goal；Goal 可设置跨 Turn 累计的 token 上限，仅统计已知的未缓存输入与输出 token，不伪造缺失 usage，也不做 cost/time ceiling。达到预算后将 Goal 标记为 `BudgetLimited`，当前已返回的 final answer 仍可完成，但不再自动启动下一个 Turn；Goal 状态、用量和重放结果都来自同一条 Thread event log。
- 无迭代次数硬上限（与 runtime 文档一致：上限应由可取消的资源策略表达，不用进程内计数器）。

### 7.4 当前接线与剩余恢复

- **已实现**：`ApiError` 分类 `RateLimited { retry_after_ms }`、`Overloaded`、`ContextOverflow`、`AuthFailed`、`InvalidRequest` 和 `InvalidResponse`；HTTP/SSE 适配器从状态码和 OpenAI、Anthropic、Google 错误体映射，`ModelProviderError` 与 `CoreError` 透传类别。
- **已实现**：重试循环位于 `ModelService` 之上的执行器；认证与无效请求不重试，无效响应只重试一次，瞬时错误保留类型化 `Retry-After`。
- **已实现**：`ContextOverflow` 触发一次 durable compaction；`ContextOverflowRecoveryCommitted` 把 checkpoint 与 Turn 级恢复标记原子提交，执行器随后从新 snapshot 重试一次；再次溢出保持 `contextOverflow`。
- **已实现**：Desktop 只读取 canonical Turn 的 `StableTurnErrorCode` 来投影错误卡片。临时失败可显式开始新 Turn，认证错误进入模型选择，上下文或 Goal 预算耗尽创建新对话，无效请求与 `toolRepetition` 聚焦输入以修改方案；刷新和重连不保留第二份错误状态。

## 8. 引导与并发输入

Agent 运行中用户发来新消息：**durable 排队 + 下一个安全点注入当前 Turn**。Steer 不取消模型
或工具 I/O；模型响应回到 Core 时与 steer 原子仲裁，已经过期的响应整体丢弃并用最新 snapshot
重规划；正在执行的工具先按既有 once-only 规则收口，再由下一轮读取 steer。

```text
session/request::SteerTurn { command_id, expected_sequence, thread_id, turn_id, input }
→ 校验 Turn 处于 Running / WaitingForApproval / WaitingForUserInput
→ 原子提交 UserMessage/UserImage Item + TurnSteered + command receipt
→ 本地 execution backend 接受并读取 canonical snapshot
→ durable TurnSteerDelivered
→ RPC 重试只回放 receipt/delivery result，不重复提交 steer
```

- **已实现**：`ThreadCommand::SteerTurn`、`TurnSteered`、`TurnSteerDelivered`、Core reducer、App Server `session/request`、Desktop Send/Stop 双动作与本地 executor 已形成纵向切片；
- 模型调用进行中：消息先落盘；如果 steer 在该 invocation 的 source sequence 之后提交，reasoning、
  文本和 Tool Call 不会部分落盘，整个旧响应被丢弃后立即重规划；不自动 cancel provider 请求；
- 本地执行：`TurnSteered` 先提交，executor 接受最新 snapshot 后再写 delivery fact；进程在两者之间失败时由 command receipt 和 durable marker 恢复，不重复提交同一 steer；
- WaitingForApproval 期间：允许 steer，恢复执行后可见；
- Cancelling/终态：拒绝（稳定错误），客户端引导开新 Turn；
- 多条 steer 按提交顺序进入历史；append-only，缓存友好；
- Turn 处于 Idle（无运行 Turn）时 steer 无意义：返回错误，客户端用 `session/request` StartTurn。

## 9. 上下文裁剪

### 9.1 输入侧逐条限幅

进入模型的每条内容在**选入时**限幅（执行侧上限保护进程与存储，模型侧限幅保护窗口预算，
两者分开；数值是起点参考值，由 §14 评测调）：

| 内容 | 限幅 | 方式 |
| --- | --- | --- |
| shell 结果 | 30 KiB | 头尾各半，中间标注截断字节数 |
| read_file | 2000 行 / 行内 2000 字符 | 尾部提示用 offset 继续 |
| grep / glob | 100 条 | 标注总命中数 |
| MCP 工具结果 | 25 KiB | 同 shell |
| 图片 | durable 附件保持原图；调用前按所选模型与供应商上限生成受控 clone | attachment authority + provider adapter |

### 9.2 历史选择：不做静默滑窗

- 预算内全量保留；接近预算触发压缩（§10），更早历史被 checkpoint 原子吸收；
- 永不静默删除：当前 Turn 输入、安全约束、未完成 Tool Call/Result 组
  （[`core-context.md`](core-context.md) §7.3 的显式 overflow outcome）。

### 9.3 预算来源与 usage 校准

当前实现：

- 窗口与阈值来自 `ModelInfo`，或用户按模型 ID 配置的
  `ModelProviderConfig.model_context`；自动压缩阈值不超过窗口的 90%；
- `ContextWindow::Unknown` 不猜 128k，而是明确使用 `ContextBudget::ProviderManaged`；
- `ash-context-engine` 已统一压力线、模型硬窗口、精准计量与带保守记账余量的估算结果；
- 生产 planner 仍由 `deterministic-bytes-v1` 以 bytes/4 加结构开销做确定性估算，并在诊断中记录
  revision；最终 request 接近压力线或 compaction 后会调用声明式 model binding 对应的 remote
  preflight：OpenAI exact，Anthropic、Google、Kimi、Z.AI estimated；DeepSeek/Hugging Face 可按
  exact model binding 使用带资产 revision 的本地整请求 tokenizer，其结果当前声明为 estimated；
- 模型响应在输出验证、取消仲裁和 steering 仲裁之前写入 durable `ModelUsageRecorded`，因此
  空响应重试和被 steering 丢弃的响应仍分别计账；模型驱动的 compaction 在解析 summary 前通过
  service recorder 回调进入同一账本；reducer 同时维护 Turn 内投影和公开 Thread 聚合；
- 每项聚合由 `reported` 与 `complete` 组成：缺失 usage 只让完整性变为 false，已报告值仍作为可验证
  下限保留；分叉/回退导入历史内容时不重复计入源 Thread 已发生的调用成本；
- 有冻结 `ModelRef` 的普通调用和模型驱动 compaction 会在同一 usage event 旁记录调用前 input
  estimate、estimator revision 与 calibration revision。reducer 只在 provider 报告 input usage 时，
  按 Thread 内的模型与 estimator revision 重建低估比例：更高误差立即收紧，较低误差按非对称 EMA
  渐进衰减，且永不把容量放大到配置值以上；
- 校准投影只减少后续 Core-managed input capacity；`ContextWindow::Unknown` 仍为 provider-managed，
  历史 `ModelUsage` 和已提交 checkpoint provenance 均不改写。legacy configured-default Turn 因没有
  可验证模型身份而不生成校准样本。

调用前估算、preflight 计量与调用后 usage 仍是三类不同事实；EMA 只校准未来的保守规划，不能把
粗估写成精确 tokenizer 保证。

## 10. 压缩

### 10.1 触发

- **自动（已实现）**：估算历史超过 Core-managed input budget → 下一个 model safe point 先压缩、
  durable commit，再从新 snapshot 重规划；
- **手动（已实现）**：`/compact [保留提示]` 创建独立、不可 steering 的压缩 Turn；typed command receipt 冻结所选模型和可选提示，重复 command 只返回原 Turn；
- **溢出恢复（已实现）**：provider `ContextOverflow` 会压缩全部可安全吸收的 terminal 历史前缀；checkpoint durable commit 后重试一次，当前 Turn 与未完成工具组不被吸收。

### 10.2 流程与精确规则

机制（checkpoint schema、digest、失效回退）归 [`core-context.md`](core-context.md) §8。
当前规则：

- **tail 选择**：从最新 Turn 向前按完整 Turn 单元保留；当前 Turn 无条件保留，checkpoint 只
  覆盖 durable 前缀；
- **压缩调用**：独立模型调用使用被吸收前缀、上一个 checkpoint 和 `ash-prompts` 的共享 compaction 提示词；不带
  tools，summary target 在剩余预算内有界；
- **分批处理**：压缩请求本身也必须装入同一模型窗口。过长前缀分批提交 checkpoint；若单个
  新 Turn 连同 compaction envelope 都无法装入，则返回 `CompactionSourceTooLarge`，不循环重试；
- **失败路径**：空 summary、Tool Call、超目标 summary、source digest/Item/range 不一致或 store
  commit 失败都会失败即关闭；未 commit 的 summary 不进入 projection。

手动压缩不会作为普通用户消息发送给模型。Desktop 对 server-owned `/compact` 走
`SessionRequest::CompactContext`；Core 拒绝与任何非终态 Turn 并发，只选择最新 checkpoint 之后由完整
terminal Turn 和完整 Tool Call/Result 组组成的最老前缀。可选保留提示只影响 summary 指令，不成为
对话 Item。订阅模型的无提示压缩委托给 upstream `thread/compact/start`，远端 Thread 拥有其压缩状态；
由于 upstream 方法没有保留提示字段，订阅路径收到带提示请求时明确失败，不静默丢弃提示。

热文件重注入属于 Proposed，当前不会在压缩过程中重新读取 Directory 文件。

### 10.3 窗口重建

```text
instructions（下一个 model safe point 重新冻结）
+ 目录指令（mandatory fragment）
+ checkpoint summary
+ tail 原文
```

## 11. Prompt 缓存

### 11.1 三家机制

| Provider | 机制 | 要求 |
| --- | --- | --- |
| Anthropic | 显式 `cache_control` 断点（≤4），默认 5 分钟 TTL，读 ≈0.1× / 写 ≈1.25× | 前缀逐字节一致；断点前 ≥ 最小 token 数（约 1024） |
| OpenAI | 自动前缀缓存（≥1024 tokens） | 无需标注，前缀逐字节一致 |
| Google | 隐式（2.5+）+ 显式 cache API | 同上 |

### 11.2 组装硬约束

1. 序列化确定性：工具列表顺序固定（内置按 profile 声明序 → MCP 按 server+name 排序）；
2. append-only（§2 规则）；reminder 附着新内容；
3. 前缀不放每次变化的值（时间戳、实时 git status——§4.2 冻结纪律）；
4. 压缩、换 profile、换模型必然击穿缓存——接受为一次性成本。

### 11.3 落点

`cache_control` 不进 canonical `ModelRequest`，由 `ash-api` 的 `anthropic_messages` 构造器
注入：断点 1 = tools 末尾；断点 2 = system 末尾；断点 3 = 最新一条 user 消息末尾。下一 Turn
把断点向前滚动时，Anthropic 在新断点前回看已缓存的稳定前缀。观测：`cached_input_tokens` 已解析；
在 TTL 内且达到供应商最小 token 条件的连续 Turn 应出现 cache read；fixture 用稳定序列化防止组装层引入前缀抖动（§14）。

## 12. Skills 与命令入口

- **slash commands**（`ash-rs/slash-commands` 已有 catalog）：在 `session/request` StartTurn 之前由
  App Server 展开，展开后的正文作为 durable UserMessage 进入 Turn 输入；消息内保留
  `<command-name>` 标注供模型识别来源。不在模型侧解析斜杠语法。
- **Skills**（`ash-rs/skills` 已有 runtime；发现/信任归 [`skills.md`](skills.md)）：
  - 用户入口使用独立 `$name` selector；`/` 只触发产品和服务命令，`@` 留给文件与 Plugin 上下文；
  - v1 已实现：用户提交 exact `SkillRef`，App Server 冻结 digest/generation/reason，Core 在每个
    model safe point 重载 exact `SKILL.md`，以 `ActivatedSkill` instruction layer 注入；raw path
    输入被拒绝；
  - 自动 selector 已实现：host 只用有界 metadata 对 `BuiltInVerified` 候选做唯一高置信匹配，先
    冻结 exact `SkillRef + digest + generation + reason`，再加载正文；歧义、低置信或非可信来源
    不自动激活，catalog 正文不会随数量线性进入 prompt。

## 13. 供应商差异矩阵

canonical 层（`ModelRequest`）保持 provider 中立，差异全部压进 `ash-api` 的 endpoint 请求构造器。
authoring 规则以最严格交集为准：

| 维度 | Anthropic Messages | OpenAI Responses | canonical 规则 |
| --- | --- | --- | --- |
| instructions | `system` 字段 | `instructions` 字段 | 单值 `instructions`，adapter 映射 |
| 角色 | user/assistant | + developer | v1 canonical 只产生 System/User/Assistant；`Developer` 保留给 OpenAI 路径未来用 |
| 工具 schema | `input_schema`，无 strict | strict 模式：`additionalProperties:false` + 全字段 `required` | **按通用子集 authoring**（[`agent-tools-spec.md` §1](agent-tools-spec.md#1-模式约定)）：顶层 object、全 required、可选性用 `["T","null"]`，两边同一份 schema 直接可用 |
| tool_choice | auto/any/tool | auto/required/function/none | 现有 `ToolChoice` 已覆盖 |
| 并行 Tool Call | 支持（`disable_parallel_tool_use`） | 支持（`parallel_tool_calls`） | profile 属性透传 |
| Tool result | user 消息内 `tool_result` block | `function_call_output` item | assembler 已配对，adapter 负责 wire 形态 |
| Tool call id | `tool_use.id` 回传 | `call_id` 回传 | `ToolCallId` 原样往返，adapter 不改写 |
| 图片 | base64/URL source block | data URI / URL | durable `ImageAttachmentRef` 先经 authority 校验和降采样，再以 ephemeral `ContentPart::ImageUrl` 交给 adapter（已实现） |
| 缓存 | 显式断点（§11.3） | 自动 | adapter 差异，canonical 无感 |
| reasoning | thinking content block | `reasoning.effort` | Anthropic 原生 stream 会归一化上游 thinking delta；canonical `ReasoningConfig` 到新旧 Anthropic thinking 配置尚未建立可靠映射，当前显式拒绝而不猜测 budget；历史 assembler 不回灌 reasoning |
| 空响应/拒绝 | `stop_reason` + 空 content | `refusal` item | 统一映射 `ResponseItem::Refusal` / 空响应走 §7.1 |
| 错误分类 | `overloaded_error` 等错误体 | `context_length_exceeded` 等 code | 映射进 §7.4 的 `ApiError` 新分类 |

## 14. 评测

普通 harness 行为正确性由 Core、App Server、Desktop 的单元、集成和 smoke 测试覆盖。真实开发质量和多 Agent 收益必须使用版本化任务与单 Agent 对照，不能由模型自评或合成状态机替代。

### 14.1 真实开发任务集

真实模型行为对比应按下列层次建立独立 benchmark。它们是模型/profile 质量声明和多 Agent 收益声明的前置证据，不是机械执行边界的替代品：

| 层 | 数量 | 内容 | 考察 |
| --- | --- | --- | --- |
| T1 | 10 | 单文件 bug 修复 | 工具基本功、编辑正确率 |
| T2 | 5 | 跨文件小功能 | 搜索/多文件编辑/验证纪律 |
| T3 | 2 | 长会话（>30 次工具调用） | 计划工具、失控防护 |
| T4 | 2 | 强制压缩任务（低阈值配置） | 压缩后连贯性（约束保留、不重做已完成工作） |

### 14.2 指标

每次运行记录：成功与否、input/cached/output tokens、工具调用次数、`apply_patch`/`edit` 选择、prepare/commit 失败、降级次数、验证结果和墙钟时间。运行时聚合只保留去内容化类别，不采集工具参数、diff 或文件正文；按 provider/model × profile 出对比表。

### 14.3 分层运行方式

- **PR smoke（无真模型）**：使用现有 assembler、Core、App Server 和 Desktop 测试，断言请求字节稳定、限幅与结构不变量、重试、steering、循环终止和 stream gap 恢复；
- **多 Agent 对抗回归（无网络）**：运行 `just multi-agent-eval scripted`，每个场景必须实际触发攻击条件，缺少攻击、宿主证据或终态都不能算通过；
- **真实模型安全评测（显式成本）**：只在专用 profile 和明确成本确认下运行相同版本的受支持场景，模型是被测对象，不是裁判；
- **真实开发任务 benchmark**：只有在有受控测试凭据和明确产品目标时，才运行版本化任务集 × 主力 provider/model × 候选 profile，并与单 Agent 结果对照；没有 benchmark 时继续使用统一 profile；
- M0–M6 每个里程碑的验收优先使用对应的确定性测试；模型指标只在 benchmark 启动后作为补充。

默认 PR 不依赖网络或真实模型凭据。真实模型和真实任务 benchmark 只记录明确允许的去内容化指标；目录内容、日志和任务输出不得进入聚合。

### 14.5 运行时观测与发布门

> 状态：尚未完成。

运行时观测应覆盖模型调用、重试、压缩、usage、批准等待、工具终态、编辑工具选择、验证结果和委托恢复。事件只能包含去内容化类别、计数、耗时、稳定错误码和不可逆关联 ID；不得包含 prompt、敏感输入、工具参数、diff、文件路径或文件正文。用户级聚合必须明确启用，Thread/Turn 关联也不能用于恢复用户内容。

发布检查表只在产品发布范围确定后生成，并汇总当前能力矩阵、已知限制、迁移和回滚条件。发布前必须满足：没有 P0 缺口；协议、schema、生成物和文档同步；主力路径通过故障注入；未支持能力在产品中隐藏或明确解释；所有持久化副作用在崩溃恢复测试中保持只发生一次或明确为结果未知，绝不静默重放。

## 15. 实现状态

M0–M6 是本文行为规格的覆盖总账，不再充当阶段性构建计划。ChatGPT 订阅剩余兼容工作由 [`chatgpt-subscription.md`](chatgpt-subscription.md#当前状态与待完成项) 维护；内置与自定义 Agent 的统一定义由 [`agents.md`](agents.md) 维护；运行时观测与发布门由 [§14.5](#145-运行时观测与发布门) 维护。

| 里程碑 | 内容 | 关键改动点 | 前置接线 |
| --- | --- | --- | --- |
| M0（完成）提示词接线 | 模型基础 instructions 在 Turn 创建时持久化，review 使用独立 rubric，环境快照、Global `.ash/instructions`、功能 fragments 与稳定组装已接线；工具契约随各自 definition 注入 | `ash-models-manager`、`ash-prompts`、`TurnInstructions`、`ContextAssembler`、host 环境快照、`DirContributions` | 无 |
| M1（实现完成）工具最小闭环 | canonical 文件工具、`apply_patch`、shell、模型中立的 `coding-v1` ToolProfile、durable `update_plan` 与模型输入逐项限幅已接线；确定性行为由现有测试覆盖 | 本地工具组合、executor contributions、profile 声明层 | 现有行为测试 |
| M2（完成）失败弹性 + steering | Provider 错误分类、退避、空响应、Refusal、overflow 恢复、steering、重复失败工具熔断和对话内错误动作已实现 | executor 重试层、Thread command、App Server protocol | protocol/schema/Desktop 同批同步 |
| M3（实现完成）限幅/预算/压缩 | ContextPlan、逐项输入限幅、配置窗口、preflight、自动/手动 durable compaction、模型调用 usage 账本、跨 Turn 累计的 Thread Goal token 预算已实现；限幅、预算和压缩由现有测试覆盖 | ContextPlan 选入路径、checkpoint、usage 与 Goal 持久化 | 现有行为测试 |
| M4（完成）缓存 | Anthropic tools/system/滚动 user 三断点、字节稳定、cached usage 观测，以及模型/profile/压缩 cache scope 回归已接通 | `anthropic_messages` adapter、conformance fixture | 无 |
| M5（完成）MCP 策略 | registry snapshot、≤15/≤5k 平铺阈值、超阈值整体 `search_tools`/`call_mcp_tool` 与 catalog/definition digest binding 已实现 | MCP registry 之上的冻结暴露策略 | ToolProfile contract |
| M6（完成）Skills/commands | `$name` 显式 SkillRef、slash commands、frozen activation、`skills-read`、Desktop 显式选择与仅限 verified built-in 的 metadata 自动 selector 已接通 | App Server 展开、Skill metadata selector、ActivatedSkill layer | 评测与信任策略 |

当前已经具备“接入已配置模型即可 coding”的最小闭环；真实模型 benchmark 属于有明确产品目标、版本化任务集和受控预算后才启动的产品度量，不阻塞本地闭环。后续实现直接更新上述长期 owner 的状态和完成门，不再维护一份重复的总计划。

## 16. 参考

- [`agent-tools-spec.md`](agent-tools-spec.md) — 逐工具规格与提示词正文
- [`ash-agent-runtime-architecture.md`](ash-agent-runtime-architecture.md) — 执行内核与阶段计划
- [`core-context.md`](core-context.md) — ContextPlan / checkpoint 机制
- [`tools.md`](tools.md) — 工具三层契约与 registry snapshot
- [`skills.md`](skills.md) / [`slash-commands` crate](../ash-rs/slash-commands/) — 扩展来源
- [`ash-prompts` README](../ash-rs/prompts/README.md) — 共享提示词资产契约与分域 ownership
