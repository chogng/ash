# Agent 指令组合、模型专化与评测

本文维护 Agent 共同规则、Role 指令和模型适配的组合设计，以及性能评测、外部参考和后续修改的证据要求。推荐采用共同规则与当前 Role 组合，并为模型专化提供明确入口；尚不能据此声称运行更快、成本更低或任务完成率更高。

> 状态：通用启动、指令组合和准确模型专化入口已实现；已加入离线 benchmark 与行为回归测试。复核日期：2026-09-09。
> 本地测量使用仓库的优化测试构建，不是 release 或真实模型质量成绩；没有调用收费模型进行任务集评测。
> Role 的完整产品契约见 [Agent 定义](../../docs/agents.md)，委托生命周期见 [Core 多 Agent](../../docs/core-multi-agent.md)，用量与成本语义见 [模型记账](model-accounting.md)。本文不复制这三份文档的完整接口。

## 已确定的方向与待验证的问题

| 项目 | 设计决定 | 证据状态 |
| --- | --- | --- |
| 指令组合 | 共同规则常驻，每个 Thread 只应用当前 Role | 已接入根、子 Thread 和审查 Turn |
| 默认 Agent | `Default` 使用正常执行配置，不读取专用 Role | `general.toml` 已删除 |
| Issue 入口 | 页面通过通用 Session 创建契约选择 `issue` | TUI 已接入，旧执行工作流已移除 |
| 默认 worker | 选择 `Default`，不继承父 Role 的协调职责 | 关键词匹配已删除，完整历史继承也保留角色隔离 |
| 模型专化 | Generic 或准确模型指导，收益经评测后确认 | 已默认登记 17 个准确模型的初版指导；效果未评测，见下文 |
| 本地性能 | 分别测选择、组装、持久化和并发 | 已测选择与组合，见 [本轮数据](benchmarks/agent-instructions-2026-09-09.md)；内存和磁盘启动仍待测 |
| 模型行为 | 同模型、同 Role、同工具下比较模板 | 尚无任务成功率和成本实测 |
| 文档维护 | 设计、当前实现、实验结果分别标注 | 本文建立初始记录 |

## 组合契约

组合发生在共同规则、模型指导与角色职责之间；更换 Role 时只保留所选角色的职责。一个 Role 不能撤掉共同约束，也不能通过正文授予工具、目录或外部服务权限。

| 内容 | 表达什么 | 目标 owner |
| --- | --- | --- |
| 共同规则 | 保留无关修改、核验交付、如实报告、遵守宿主授权 | Prompts |
| 模型指导 | 针对确定模型有效的指令表达与工具使用指导 | Models Manager 的模型指令资产 |
| Role | 协调、实现、审查等当前职责和交付要求 | Agent Roles |
| 工具与运行信息 | 实际可调用工具、环境、父子关系和取消状态 | 各执行领域；Core 组装 |
| 目录规则、Skill、任务材料 | 已授权规则与任务上下文，保留各自来源和层级 | 既有 Instructions、Skill 与任务 owner |

- 共同规则不写“必须亲自编码”或“必须委托”。这些是职责选择，会与 `issue` 等角色冲突。
- `Default` 不加载专用 Role 正文。正常执行能力来自共同规则、任务和实际工具，不依赖额外的通用 worker 文件。
- 创建 worker 时重新组装指令，只传递允许的任务上下文。父 Role 不因完整历史复制而成为子 Agent 的有效角色指令。
- Issue 内容作为任务材料输入。Issue Manager 不拥有计划执行、assignment 或调度状态机；GitHub 操作由 Plugin 提供，委托由通用多 Agent 能力执行。
- Markdown frontmatter 的 `model`、工具列表和 Skill 引用由程序解析；只有正文是提示词。格式并不决定指令优先级。
- 根 Role 所需 Skill 从已授权 catalog 解析并激活，不能要求尚不存在的父 Turn 已经激活它；调用方的 Skill 上限与正文加载仍是两个步骤。
- Core 保留来源、层级与顺序，由供应商 adapter 映射到对应请求格式。不能把模型、Role、用户输入混成无法追溯的单个字符串。
- 角色选择、模板选择和实际授权分开保存。恢复角色快照不能恢复已撤销权限，缓存也不能代替授权检查。

## 共享模板与 Codex 的对应关系

本次按本地 Codex 提交 `73a1148c9c775c2a4616ce5096291740a00ed68a` 的 `codex-rs/prompts` 逐项核对，并按 Ash 已有执行入口补齐。下表维护采用范围，不以目录或文件数相同作为完成标准。

| Codex 资产/模块 | Ash 对应入口 | 当前差异与接线 |
| --- | --- | --- |
| `permissions_instructions` 与 `templates/permissions` | [`permissions_instructions`](../prompts/src/permissions.rs) | 共同动作授权说明 + AskPermissions/AutoReview/BypassPermissions；Core 每次组装根据已保存的 Turn 模式选择 |
| 沙箱 read-only/workspace-write/full-access | `templates/permissions/actions.md` | Ash 按 Tool Call 解析文件、网络和沙箱授权；不从可访问目录推断写权限，不描述不存在的全局沙箱状态 |
| approval never/on-request/unless-trusted、扩展权限工具 | `templates/permissions/approval/*` | 使用 Ash 的三种真实批准模式；不引入 Codex 专用参数和工具 |
| compact prompt / summary prefix | [`compact.rs`](../prompts/src/compact.rs) | 原生成模板继续使用；补上 `checkpoint_prompt`，保留 ID/来源摘要并转义摘要内容 |
| review rubric / review request | [角色正文](../agent-roles/assets/reviewer.md)、[目标渲染](../prompts/src/review.rs) | App Server 从角色目录冻结审查职责；Git 比较仍经授权工具执行，prompt crate 只渲染目标 |
| review exit success / interrupted | `review_exit_prompt` | 按已保存的结果选择 completed/interrupted/failed，结果正文保留在原 Assistant 消息，不重复复制 |
| 普通 Turn 中断说明 | `TURN_INTERRUPTED_PROMPT` | 将 Core 中的共享文案收归 prompts，不假定中断一定由用户主动发起 |
| realtime start / end / backend | 尚未接入 | Ash 没有实时语音会话、转写来源与转发执行链路；不放入声称这些能力已存在的模板 |

参考源码：[模块与导出](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/prompts/src/lib.rs)、[权限组装](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/prompts/src/permissions_instructions.rs)、[审查结束](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/prompts/src/review_exit.rs)、[实时语音资产入口](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/prompts/src/realtime.rs)。

### 运行状态、持久化与预算

- 共同规则、模型指导与 Role 继续按既有方式冻结。权限说明属于运行上下文：从当前 Turn 已保存的 `approval_mode` 选择当前程序版本的资产，id/revision 进入 ContextPlan，作为必需指令参与预算。它不改写历史 TurnInstructions，也不代替执行时的 action policy 检查。
- 审查结束说明由 Thread 中的 kind/status 派生，只为仍在上下文中的终结 Review Turn 插入一次，位于后续任务之前。正在审查时不注入结束说明；已被 checkpoint 覆盖的审查不再重复插入。普通编码完成不会得到 review 说明。
- checkpoint 续接文本明确是派生任务材料，不能恢复权限或把结果未知描述为成功。转义可防止摘要中的关闭标签破坏来源边界；完整输出的字节数参与预算。
- 自动压缩先为续接说明与固定格式的新 checkpoint 身份留出空间，再决定正文目标及保留哪些旧 Turn。压缩结果按模型可见编码检查大小，避免正文满足目标但包装后超预算。Core 测试使用达到目标上限的摘要验证无需再次压缩。
- 共享模板目录在 `.gitattributes` 中固定 LF 行尾，跨平台嵌入时保持相同正文，避免在每次模型调用时再规范化文本。
- 估算器版本为 `deterministic-bytes-v2`，新压缩结果的 context policy revision 为 `context-policy-v2`；存储 schema 不变。摘要生成模板正文没有变化，因此保留其已有 prompt revision。
- 新请求会增加权限说明；历史中有审查或 checkpoint 时才增加对应续接文本。前次性能报告保留原始源码摘要，不能当作新增模板后的请求大小或耗时。

权限模板修改必须同时核对 `ApprovalMode` 与 `ActionPolicyService` 的实际行为；审查结束模板修改必须覆盖三种终态、恢复和压缩覆盖；checkpoint 渲染修改必须同步检查规划预留、结果大小与最终输入估算。只修改 Markdown 而遗漏这些调用方，不算完成。

## 模型专化入口

模型专化值得支持，但不应建立按“模型 × Role × 工具组合”复制整篇提示词的维护方式。

### 选择与组装分开

`models-manager/src/instructions.rs` 的 `ModelInstructionCatalog` 已提供准确模型选择；Core 使用现有 context pipeline 组装结果。下面概括当前流程，字段详细定义以协议与源码为准：

```text
启动阶段选定的 provider/model 身份
    → ModelInstructionCatalog::resolve
    → Generic { model } 或 Specialized { model, instructions, digest }

Core 接收：共同规则 + 选择结果 + 当前 Role + 实际工具/环境 + 任务
    → 有来源的 ContextPlan
    → ModelRequest
```

| 边界 | 要求 |
| --- | --- |
| 输入 | 使用启动阶段选定的 provider/model；不读取 UI 模型标签或任务关键词 |
| 匹配 | 当前只按准确 provider/model 匹配，重复登记时报错；未实现模型族或名称前缀匹配 |
| 通用路径 | 没有登记专化规则时显式返回 `Generic`；它不代表模型被替换 |
| 错误 | 已选专化资产损坏、摘要不符或不兼容时返回错误；不能悄悄改用其他模板 |
| 输出 | 持久化准确模型、资产 ID/revision/正文及摘要；与 Turn 模型不一致时拒绝 |
| 权限 | 适配内容不能增加工具、Skill、目录、凭据或委托权限 |
| 依赖 | 模型选择不依赖 Core、Role catalog、Thread 或实时工具执行对象 |
| 热路径 | 同一输入解析结果可复用；不在每次模型调用前扫描目录或查询外网 |

模型族必须来自可核实的目录事实或代码内明确登记的映射，不能因为名称相似就认定兼容。模型别名指向变化时记录供应商实际返回的模型；无法确定具体版本的结果单独标注，不与固定版本混算。

适配指导若依赖某类工具，需要声明可检查的工具能力要求，由 Core 对实际工具集合验证并决定是否包含对应段落。实际工具参数与协议由工具 schema 和供应商 adapter 拥有，提示词不建立第二份工具协议。

### 允许的专化范围

| 候选 | 评价 | 采用条件 |
| --- | --- | --- |
| 所有模型共享同一模板 | 最少维护成本，作为实验对照 | 每个支持模型完成能力与行为验证 |
| 共同规则加有界模型指导 | 推荐；Role 仍独立，差异容易定位 | 固定任务集证明质量或效率收益 |
| 每个模型维护完整 Agent 提示词 | 容易复制共同规则与角色职责 | 本方案不采用 |
| 任意 section 覆盖或运行脚本改写提示词 | 扩大验证面、增加组合歧义 | 不作为普通 Role 或 Plugin 能力 |

当前专化贡献一个有界的模型指导块，上限 64 KiB；空白资产、重复登记或不一致的已保存摘要会失败。没有引入通用模板语言、动态注册中心、模型族匹配或工具条件模板。增加这些能力必须有具体消费者、兼容规则和对应评测，不能用未经验证的隐式规则代替。

每个专化记录适用模型、正文 revision、设计假设和证据状态。本轮按“先补上、后续再修改”的要求默认启用初版；真实失败案例和对照结果仍标为未完成，不能因为已经启用就声称更优。后续优化须以同模型对照评测判断收益，保留空目录作为 Generic 对照。

角色快照与模型指导选择分别记录。正在进行的调用使用已经保存的内容；若运行契约允许用户明确更换模型，在下一个允许的边界重新选择适配并记录新版本。本文不新增自动换模型或跨供应商重放策略。

## 内置模型指导初版

当前提供四份可直接修改的 Markdown，准确登记仓库已有的 17 个模型。默认启用的状态是**初版、未做真实模型效果评测**；这是本轮补齐模板的产品决定，不是质量或成本提升的证明。没有增加或替换模型型号，也没有改动推理等级、服务等级、能力 metadata、凭据或 API 参数。

| 资产 | 准确模型登记 | 设计假设与来源 |
| --- | --- | --- |
| `model/gpt` / `gpt-guidance-v1` | `openai/` 下的 `gpt-6-astra`、`gpt-5.6`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4` | 目标驱动、减少无意义停顿与重复验证，保留简短回答中的必要证据；参考 [GPT-5.6 指导](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6) 与 [GPT-6 Astra 指导](https://developers.openai.com/api/docs/guides/latest-model) |
| `model/claude` / `claude-guidance-v1` | `anthropic/claude-sonnet-4-20250514` | 明确所需产物并限制额外工程化；参考 [Claude 提示词指导](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) 的通用原则，不将较新型号的行为描述冒充 Sonnet 4 的实测结论 |
| `model/gemini` / `gemini-guidance-v1` | `google/gemini-3.6-flash` | 简洁指令、明确当前任务、证据与目标格式；参考 [Gemini 3 指导](https://ai.google.dev/gemini-api/docs/gemini-3)，这属于对当前登记型号的初版应用 |
| `model/function-calling` / `function-calling-guidance-v1` | `xai/grok-4.5`、`qwen/qwen-plus`、`kimi/kimi-k2.6`、`kimi/kimi-k2.7-code`、`deepseek/deepseek-v4-pro`、`zai/glm-5.1`、`minimax/MiniMax-M3`、`mimo/mimo-v2.5-pro` | 共同的工具调用接口适配：执行参数与回答分离，等待实际结果后继续；参考 Ash 已接的工具通道，以及 [Qwen Function Calling](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling)、[Z.AI Function Calling](https://docs.z.ai/guides/capabilities/function-calling) |

来源复核日期为 2026-09-09。上述具体登记来自 [`STATIC_MODEL_CATALOG`](../model-provider-config/src/model_catalog.rs)，不代表本轮验证了每个远端型号的在线可用性。多型号共用正文是明确的代码登记，不是按名称前缀猜测兼容性；未知型号、自定义 provider 和不同大小写不会自动套用。

四份正文没有复制整套通用规则、权限策略或 Role，也没有要求生成内部推理过程、伪造工具执行记录或通过文字调整 API 设置。诸如 DeepSeek 的 `reasoning_content` 或 Gemini 的思考签名，其保存和重放要求属于供应商 adapter，提示词无法代替实现。[DeepSeek 文档](https://api-docs.deepseek.com/guides/thinking_mode/)、[Gemini 文档](https://ai.google.dev/gemini-api/docs/gemini-3)

### 修改、生效与检查

- 正文位于 [`models-manager/templates/instructions`](../models-manager/templates/instructions)，模型分组、资产 ID 与 revision 位于 [`instructions.rs`](../models-manager/src/instructions.rs) 的 `BUILT_INS`；具体操作见 [crate README](../models-manager/README.md#初版模板与修改入口)。
- 内置 catalog 经一次校验、冻结和摘要计算后，由进程共享；选择时执行准确 HashMap 查找，不扫描目录，不调用模型。
- `ModelInstructionCatalog::default()` 保持空目录语义。嵌入方使用 `with_model_instructions` 替换整个目录，不隐式叠加旧内置条目；这也提供同模型 Generic 对照入口。
- 模板通过 `include_str!` 编译嵌入；编辑后需重编译、重启。普通 Default 根会话的新 Turn 重新解析指导，已有角色与子 Agent 的冻结内容不被覆盖。
- 当前假设尚无任务集结果。后续优先比较完成率、工具调用正确性、额外检查/停顿和最终回答完整度，再比较延迟、token 与成本。若要单独调优共用正文中的某个型号，把准确条目移入独立资产组即可。
- 本轮仅运行本地契约、调用链与构建验证；前两份离线报告保留其原始源码摘要，不据此推断新增模型指导后的请求规模和性能。

### 初版指导验证记录（2026-09-09）

- `just test ash-models-manager`：16 项通过，检查 17 个静态模型的覆盖、准确身份、共享正文、空目录对照和无效条目拒绝。
- `just test ash-app-server agent_`：37 项通过，1 项离线 benchmark 按默认忽略。新增测试让四类模板分别经过 RPC 根会话 → 实际 `spawn_agent` Tool Call → 默认 worker → 模型请求，检查指导、共同规则和权限说明各保留一份。
- `just test ash-app-server review_turn_freezes`：1 项通过；已有自定义目录与根 Role 组合测试随 Agent 回归通过。
- `just check ash-models-manager`、`just check ash-app-server`：正常构建检查通过，无新增 warning。
- 四份资产含末尾换行分别为 GPT 714、Claude 646、Gemini 626、Function Calling 745 字节；每次只选其中一份，字节数不能换算为实测 token 或费用。
- Markdown 本地链接、Rust 格式、编译资源引用和 LF 行尾已核对。本轮没有访问真实模型或改写既有性能原始样本。

## 性能评估

### 先区分三种成本

| 范围 | 要测什么 | 不能据此推出什么 |
| --- | --- | --- |
| 本地处理 | catalog 解析、选择、集合过滤、正文渲染、请求序列化、日志提交 | 字符串组装快不代表模型任务更快 |
| 模型调用 | 输入/输出用量、首个有效输出、调用时长、缓存读取和写入 | 首 token 快不代表工作更早完成 |
| 整项任务 | 成功率、完成时间、全部调用、工具与协调开销 | 子 Agent 的耗时不能直接相加当作墙钟时间 |

对一次任务，墙钟耗时按实际执行时间线和依赖的最长路径计算；总用量按根 Thread 与全部后代的调用求和。重试、失败、压缩、协调和验证调用都计入，不能只统计最终 worker。

现阶段可提出的性能假设是：正文大小、重复上下文、调用轮数和缓存稳定性可能比少量字符串组合更影响端到端结果。这是待验证假设，不是已有测量结论。

### 本地与供应商缓存

- catalog 使用现有不可变 snapshot；发现与解析发生在来源变更或启动解析阶段，Core 不在组装中扫描目录。
- 可缓存共同规则、选中模板和已解析 Role 的不可变渲染片段，不缓存实时授权结论。
- 本地组合缓存 key 至少覆盖共同规则 revision、模板 ID/revision/digest、Role 来源与摘要、工具 schema 摘要、渲染器版本，以及片段实际依赖的环境作用域。
- 缓存必须有容量与内存边界，分别观察命中、未命中、失效和淘汰。不能把每个 Thread 永久存成一个缓存项。
- 稳定前缀不包含无关时间戳、随机 ID、计数或目录枚举顺序。需要让模型看到的动态身份与状态保留在明确的运行上下文中。
- 只加载当前 Role 与实际需要的 Skill；不为提高缓存命中而暴露所有角色、工具或来源内容。
- 本地渲染复用与供应商 prompt cache 是两个指标。前者命中不能证明后者命中。

[agent_context_fragments](../core/src/multi_agent/context.rs) 现在使 Role 标签只包含稳定名称，正文摘要用作诊断来源；父 Thread 等动态信息放在独立的委托上下文。此改动减少无关前缀变化，但供应商缓存命中收益尚未实测。

OpenAI 的官方指导强调稳定前缀与显式变量；Anthropic 的缓存包含工具、系统内容和消息的前缀，具体匹配和缓存门槛还受模型、平台与配置影响。评测要记录真实请求和供应商返回的缓存用量，不能用“文本大致相同”判断命中。[OpenAI 指导](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object#what-changes)、[Anthropic 缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## Benchmark 与行为评测方法

### 分开比较四个问题

| 实验 | 固定条件 | 唯一主要变量 |
| --- | --- | --- |
| 组合器开销 | 完全相同的最终消息与工具 schema | 预组装输入与真实分段组装路径 |
| 模型专化收益 | 同一模型、Role、任务、工具、权限、推理/服务配置 | 通用指导与候选模型指导 |
| Role 收益 | 同一模型、任务和可授权能力 | 是否应用专用职责；单独报告工具集合变化 |
| 委托拓扑收益 | 同一任务、验收与总资源上限 | 单 Agent、协调加一个 worker、协调加多个 worker |

不同模型之间的成绩用于判断覆盖范围，不能直接归因为模板收益。不同拓扑之间的成绩用于评估协调成本，不能与纯提示词对照混成一个分数。

根 Thread 已支持 Role。仍不能把普通单 Agent 与 Issue 协调加 worker 混为等价性能回归；先在完全相同模型输入下测组合开销，再分开评估职责与委托拓扑。

### 离线 benchmark

复用当前 Rust owner 的测试设施，不新增另一套 Agent runtime。现有离线入口可在优化测试构建下快速复核；正式发布性能验证另用明确记录的 release 构建，不能混用结果。现有 [planner tests](../core/src/context/planner_tests.rs) 与 [Role 集成测试](../app-server/src/server/agent_selection_tests.rs) 是行为设施，不能把它们的通过时间当成 benchmark 结果。

| 场景 | 首轮输入规模 | 测量边界 |
| --- | --- | --- |
| Role 与模板选择 | 1、16、128 个 Role；Generic 与准确专化 | 预加载 catalog 到选中配置 |
| 工具与 Skill | 16、128、512 个工具；0、8、32 个 Skill | 校验、集合收窄与片段生成 |
| 上下文组装 | 0、32、256 KiB 历史正文；短/长 Role | 计划、预算估计与请求序列化 |
| 生命周期 | 新建、复用、恢复、压缩后继续 | 指令恢复与持久化分别计时 |
| 并发和缓存 | 1、4、16 个并发；命中、失效、淘汰 | 延迟、分配与进程内存增长 |

这些数字是建议的评测矩阵，不是产品限制，也不表示本轮已执行全部场景。本轮入口已覆盖 Role 数量、工具数量、短/长 Role 和模型指导准确查找；Skill 数量、历史规模、磁盘与内存仍需单独测量。

- 记录 CPU、内存、OS、Rust 版本、构建模式、代码 revision 与工作树差异摘要。
- 编译不计入样本；区分进程首次使用、进程内首次解析、渲染缓存命中。OS 文件缓存不能仅靠重启进程宣称已清空。
- 使用单调时钟。公开预热策略、样本数和采样方法；报告 p50、p95、p99、分配字节和峰值内存，样本不足不报告稳定尾延迟。
- 短函数批量计时并控制空循环开销；检查结果被实际消费，避免优化器删除工作。
- 比较最终请求的内容、顺序与语义。只测一次字符串连接不能代表包含权限过滤、Skill 激活或持久化的启动路径。

### 端到端任务集

任务集应来自真实失败与产品使用，固定仓库提交、输入、验收和允许副作用；开发集用于调提示词，保留集用于判断是否接受变化。先规定验收，再运行模型。[评测方法参考](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)

| 任务类别 | 必须覆盖的行为 |
| --- | --- |
| 普通编码 | 小修复、跨模块修改、测试失败定位、保留无关工作 |
| Issue 协调 | 单 Issue、独立多 Issue、共同根因、有依赖的任务 |
| 角色边界 | 默认 worker 不携带父角色、reviewer 只审查、失败不能冒充完成 |
| 能力变化 | 缺 Skill、工具未连接、权限撤销、动态工具发现 |
| 上下文 | 中文/英文、长历史、压缩、恢复、角色文件更新后的旧 Thread |
| 外部数据 | Issue 中包含角色替换或扩大权限的文字；内容仍作为任务材料 |

外部 Issue/PR 的主要评测使用固定 fixture 与受控工具服务，以免内容更新、网络与真实外部写入干扰对照。真实连接测试另设受控仓库，并单独报告。不能为跑评测向用户的实际 Issue 发布评论。

每组比较固定模型身份、provider/account scope、服务等级、推理配置、输出上限、工具 schema、Skill revision、权限、目录、总预算、并发和超时。供应商不支持 seed 时记录不支持，不能假装可确定复现。

同一任务多次运行，对照顺序随机交错，避免所有 A 在早晨、所有 B 在晚间。每次代码任务恢复相同初始状态；不能让 B 使用 A 留下的修改或测试缓存而不披露。

供应商缓存分别设冷态与热态实验，并用实际缓存用量确认。不能靠往稳定前缀塞随机字符串制造“冷态”，那会同时改变被测输入；不能控制缓存时把状态记为未知。

### 必须报告的指标

| 指标 | 口径 |
| --- | --- |
| 任务通过率 | 全部已启动运行中满足预先定义验收的比例；超时和失败保留，未启动或跳过的任务另列 |
| 角色/权限违规 | 分开记录模型尝试越权与执行层实际放行；通过样本不等于证明永无违规 |
| 完成时间 | 从接受任务到验收结束；另列模型、工具、排队、人工等待和协调时间 |
| 首个有效输出 | 请求发出到首次文本或工具调用事件；不得把心跳当首 token |
| 调用与工具次数 | 根和全部后代、重试、压缩、验证均计入 |
| 用量 | 输入、输出、推理、缓存读取/写入；供应商缺失字段保持未知 |
| 参考成本 | 全部尝试的参考成本；完整度与未计价原因同时报告 |
| 每个成功任务成本 | 全部尝试参考成本总和 / 成功数；失败成本也进入分子，零成功时不定义 |
| 工程开销 | 本地组装 p50/p95/p99、内存和请求大小 |

用量字段的包含关系与参考成本归一化直接遵循 [模型记账](model-accounting.md)，不在评测脚本复制计价规则。订阅用量不能套 API 单价冒充实际账单。

当前 [ModelInvocationRecord](../protocol/src/model/accounting.rs) 有起止时间、模型和用量，但首次有效输出时间不在该结构中；[当前记账范围](model-accounting.md#当前状态) 也未完整覆盖失败调用及跨 Thread 查询。评测采集必须补齐这些缺口，不能把缺失失败记录当作免费或瞬间结束。

主评分优先使用测试、构建、diff 范围与结构化工具事件；模型裁判只辅助评价难以自动判定的解释质量，需固定裁判配置、盲化候选名称并人工抽查。被测 Agent 不能通过修改验收脚本获得通过。

裁判模型的费用计入评测预算，单列为评测成本，不混入产品 Agent 的任务执行成本。预算中止、基础设施故障和模型失败分别记录；排除样本的规则必须提前确定，不能在看到候选成绩后选择性剔除。

### 实验规模与接受规则

1. 先做不调用模型的契约与本地 benchmark，排除错误实现。
2. 小规模试验可从 12 个开发任务、每任务 3 次、2 个模板、1 个模型开始，共 72 次任务运行。这个规模用于找失败类型和估算费用，不足以证明小幅提升。
3. 根据初次方差、任务分布和需要识别的差异，预先确定正式样本量、预算与停止条件，再跑未用于调参的保留集。其他模型逐个做同模型内对照，不一次展开所有组合。
4. 每次批量模型运行前明确模型清单、总用量或金额上限、最大调用次数、并发和超时；本设计文档不代表已经执行或消耗该预算。
5. 报告每个任务类型和模型的配对差值、区间与原始样本数；按任务聚类，不能把同一任务的重复采样当作独立任务。
6. 接受标准先写再运行：正确性与实际权限执行不得退化；质量允许差异和延迟/成本目标由产品预算确定。举例，质量非劣于基线且每个成功任务成本下降 10% 可以是一个预登记目标，但它不是已测结果或统一上线门槛。
7. 置信区间跨过目标、成本不完整、缓存状态未知或保留集不足时，结论写“尚不能判断”。不能只保留成功样本、临时改变评分或反复查看结果直到出现显著差异。

## 外部产品参考与采用范围

下面记录的是源码或公开文档可确认的行为；“采用/不采用”是 Ash 的设计判断，不是外部产品之间的性能排名。复核日期均为 2026-09-09。

| 产品与路径 | 已确认的做法 | Ash 采用 | 不直接复制 |
| --- | --- | --- | --- |
| Codex 子代理 Role | 基础指令与 Role 配置分开；Role 应用受限配置覆盖；内置 default 无独立配置文件 | 默认执行与专用角色分开，复用执行系统 | 整个会话配置格式作为 Role、同名覆盖语义 |
| Claude Code 专用 Agent | `--agent` 可选择主代理；专用提示词替换默认产品提示词；普通专用子代理另装环境上下文 | 同一定义可用于根或委托，职责清楚 | 把整篇基础指导的维护责任交给每个 Role |
| VS Code 本地 Copilot | 按模型选择基础提示词，再加入 `modeInstructions` | 模型与 Role 是独立维度 | 未指定子代理时继承当前 Role、只靠文字声明覆盖上文 |
| VS Code Copilot Agent Host | Session 的 `agent` 与 `systemMessage` 分开；支持分段定制和模型贡献 | 创建时选择角色、有限组合、独立运行信息 | 普通 Role 任意覆盖全部段落、实验设置的宽泛改写能力 |

证据固定到可复核版本：

- Codex：本地检出 `73a1148c9c775c2a4616ce5096291740a00ed68a`，所引文件无工作树修改。[默认角色与配置应用](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/core/src/agent/role.rs)、[模型指令模板](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/protocol/src/openai_models.rs)、[官方自定义 Agent 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)。文档与检出实现不完全同步时，以明确标注的路径说明具体结论。
- Claude Code：依据公开文档，未检查其内部执行源码。[主代理选择](https://code.claude.com/docs/en/sub-agents#invoke-subagents-explicitly)、[子代理启动内容](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)、[追加与替换](https://code.claude.com/docs/en/cli-reference#system-prompt-flags)。替换提示词不等于撤销执行系统的权限检查。
- VS Code：微软仓库 `322d4efe0fefe31adff4c7deddda06035ba2d8d1`。[本地组合器](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx)、[模型模板注册](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/extensions/copilot/src/extension/prompts/node/agent/promptRegistry.ts)、[子代理继承](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/src/vs/workbench/contrib/chat/common/tools/builtinTools/runSubagentTool.ts)。
- VS Code Agent Host：同一提交的 [系统指令配置](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/src/vs/platform/agentHost/node/copilot/prompts/systemMessage.ts)、[组合注册器](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/src/vs/platform/agentHost/node/copilot/prompts/promptRegistry.ts)、[Session 启动](https://github.com/microsoft/vscode/blob/322d4efe0fefe31adff4c7deddda06035ba2d8d1/src/vs/platform/agentHost/node/copilot/copilotSessionLauncher.ts)。这些结论限于 Copilot 路径，不能代替 VS Code 内其他执行后端的行为。

在 Ash 中模拟上述组合方式，只能称为“参考设计的对照实验”，不能称为 Codex、Claude Code 或 VS Code 产品 benchmark。直接比较三个应用还涉及工具实现、隐藏配置、模型路由与权限差异，必须单独报告，不能归因于提示词布局。

## 实施前静态记录

以下是实施前的历史统计，其中旧路径已退场，不代表当前目录。工作区基线为 `eb9885c445fdd7192c41d757bb2f5e5d7ce954bd` 加已有未提交修改，因此以下记录使用文件内容摘要，不能仅凭提交号复现。统计读取 UTF-8 文件；Role 只统计去除首尾空白后的 `developer_instructions` 正文，与当前 Role 正文归一化一致。

| 资产 | 文件字节 | 指令正文字节 | Unicode 字符 |
| --- | ---: | ---: | ---: |
| `models-manager/templates/instructions/base.md` | 1933 | 1933 | 1933 |
| `agent-roles/assets/builtins/issue.toml` | 2170 | 1701 | 1701 |
| `agent-roles/assets/builtins/general.toml` | 371 | 192 | 192 |

```text
base.md sha256:b17c0ad39ee04614337b613f40699c963d016b331ee59827817f8a099b059952
issue.toml sha256:280ea896bba4b7b31d5361d2dcb97ad9a3ad87a04cb17355db4296dcac39f9b3
general.toml sha256:98bed24189700a9d836b2217f32e85f9d3cb3d5da234782d549cdcc00e91597d
```

这三段历史正文均为 ASCII，所以 UTF-8 字节数与字符数相同。数字不包含角色标签、工具 schema、目录规则、Skill、历史或供应商消息包装，不能当作完整请求大小，更不能按固定字节/token 比例换算成实测用量。

| 验证 | 本次状态 |
| --- | --- |
| 外部源码与公开文档核对 | 已完成，参考版本见上节 |
| 静态正文规模 | 已统计，内容摘要见上表 |
| 当前本地选择与组装耗时 | 已完成优化测试构建测量，见 [报告及原始样本](benchmarks/agent-instructions-2026-09-09.md) |
| 分配、峰值内存和磁盘启动 benchmark | 未执行 |
| 模型任务集、缓存命中、参考成本比较 | 未执行 |
| 组合方案已提升质量或性能 | 尚无实验证据 |

## 文档与实验的维护

### 资料分工

| 资料 | 维护内容 |
| --- | --- |
| 本文 | 组合和适配设计、外部取舍、评测方法、已接受决定与证据入口 |
| `docs/agents.md` | Role 选择、定义及启动契约；当前实现单独标注 |
| 所属 crate README | 当前职责、真实入口和已实现状态；不提前写成已迁移 |
| 模板源码 | 唯一可执行正文、revision 与对应测试；文档不复制整篇正文 |
| 实验记录 | 固定输入、运行配置、原始结果、评分规则、统计和接受决定 |

评测的可审阅摘要放在 `ash-rs/docs/benchmarks/`，仅在产生结果时创建。大体积 trace 与原始数据放在仓库既有或明确配置的实验产物位置，摘要必须记录可访问地址、内容摘要和保存期限；临时目录不能成为长期证据入口。

每次实验至少保存以下字段，格式可用 Markdown 配合 JSONL，不先引入专用平台：

```text
experiment_id / status / date / hypothesis / acceptance_criteria
code_revision / worktree_diff_digest / runtime / hardware
dataset_revision / split / task_ids / graders_revision
model_requested / model_resolved / provider_scope / effort / service_tier
base_revision / role_source_and_digest / model_guidance_revision
tools_schema_digest / skill_digests / renderer_revision
cache_configuration / observed_cache_state / concurrency / limits
per_attempt_outcomes / timings / usage_completeness / reference_cost
aggregate_and_intervals / failure_examples / artifacts_and_digests / decision
```

记录可复现材料时遵循来源访问范围；摘要不含凭据，私有 Issue、代码与完整提示词不自动写入公共产物。只保存摘要而没有可授权访问的正文，也不能声称完整可复现。

### 修改时同步什么

1. 改共同规则：在 prompts 提升资产 revision，检查所有已上线 Role，运行最终上下文契约测试与代表性跨角色评测。
2. 改模型专化：更新适用模型、失败假设、对照结果及兼容范围；重跑受影响模型和角色的保留集。
3. 改 Role：同步正文版本、工具/Skill 声明、根与子 Thread 的启动测试及对应任务评测。
4. 改组合顺序、来源标签或缓存边界：核对最终请求、层级、泄漏、缓存冷/热态以及恢复行为。
5. 改供应商序列化或工具 schema：重查模板是否引用不存在的行为，重跑对应请求与工具契约测试。
6. 接入根 Role、删除 `general` 或清理 Issue Workflow：同批同步调用方、协议生成物、资源打包、状态说明与现有测试；不能只改本文。
7. 更新外部参考：记录新提交或文档复核日期、行为差异、采用决定与受影响实验；保留旧证据的固定版本。
8. 结论不成立时追加原因和替代决定，旧实验原始结果不覆盖。模型版本、工具契约、核心模板或 renderer 变更后重新核定既有成绩的适用范围。

普通维护直接更新上述长期文档，不自动生成 `/develop` 阶段产物。代码验证执行所属 package 的最小检查；纯文档修改只做本地链接、锚点、Markdown 结构与差异检查，不能据此声称产品或模型评测通过。

## 实现入口与兼容性

| 位置 | 当前职责 |
| --- | --- |
| `prompts/src/agent.rs`、`prompts/templates/agent/common.md` | 所有 Agent 共用规则的唯一资产与 revision |
| `protocol/src/agent.rs` | Default/Exact 选择、共享 AgentConfiguration 与工具/Skill 上限 |
| `protocol/src/turn/instructions.rs` | 扁平共享资产、模型指导与持久化校验 |
| `app-server/src/server/agent_selection.rs` | 根、子 Thread 共用的准确来源解析和根 Skill 依赖准备 |
| `models-manager/src/instructions.rs` | 准确模型指导登记、查找与无效资产拒绝 |
| `core/src/thread_controller.rs` | 根配置与创建事实同批写入、幂等重放 |
| `core/src/multi_agent` | 角色隔离、委托恢复、上下文、并发和能力上限 |
| `ash-code/tui/src/issues` | Issue 浏览与通用 Session 创建、稳定首 Turn 请求 |

协议主版本为 2，Session/Thread/Turn capability version 为 4；旧后端必须在握手时拒绝，不能忽略角色字段后执行默认 Agent。新历史记录使用 schema 15，保留读取 12–14 的支持；旧执行器不能读取新记录并丢弃根角色约束。旧种子的冻结指令仍用于恢复，不根据已删除的 general 文件重新生成。

TUI 的自动 Issue 标签注入和仅服务旧流程的编辑器绑定已退场；首 Turn 直接携带完整 URL。`/pr` 也通过普通 Agent 提交路径执行。浏览刷新编辑类型集中在 `ash-code/tui/src/config.rs`。

配置文件 schemaVersion 2 移除 Issue 执行偏好，保留浏览刷新设置；SQLite 配置文档版本 10 的支持下界为 7。旧 Issue 数据表不再由生产路径打开，也不在后台删除用户已有数据。

App Server 默认使用 `ModelInstructionCatalog::built_in()`。`AppServer::with_model_instructions(ModelInstructionCatalog)` 可在创建环境宿主前整体替换目录；传入空目录建立 Generic 对照。catalog 由准确 `ModelRef` 与带 owner/id/revision 的 `PromptArtifact` 构建；重复模型、空白正文与超过 64 KiB 的资产会被拒绝。当前初版已启用，现有运行仍保留已冻结的指令，新内容只影响后续解析。

共享库归属按本次明确选择固定为 prompts。Codex 的 [prompts 共享库](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/prompts/src/lib.rs) 是参考，其模型基础模板仍有不同归属；Ash 没有宣称逐目录复制外部产品。

## 本轮实现验证记录

本轮主要行为包括：根角色原子创建与重试、Default 不按关键词选角色、子 Agent 不继承父 Role/审查指令、权限上限与 Code Mode 内层过滤、并发预留及完成后释放名额、Skill 缺失拒绝、旧配置迁移、Issue 浏览与普通 Session 启动。测试均使用固定模型响应或本地 fixture，未向真实 Issue/PR 写入内容。

| 验证入口 | 本轮结果 |
| --- | --- |
| `just test ash-core` | 204 项通过；离线 benchmark 默认忽略，另行运行 |
| `just test ash-app-server agent_`、`review_turn_freezes` | 36 项 Agent 回归和 1 项审查组合测试通过 |
| `just test ash-app-server` | 340 项通过、1 项失败、1 项 benchmark 忽略；失败说明见下文 |
| `just test ash-app-server-protocol` | 42 项库测试和 3 项生成器测试通过，包含 schema/TypeScript 一致性与旧主版本拒绝 |
| `just test ash-protocol`、`ash-models-manager`、`ash-prompts` | 分别 39、13、7 项通过 |
| `just test ash-app-server-client`、`ash-agent-roles`、`ash-github` | 分别 42、5、10 项通过 |
| `just test ash-config`、`ash-state`、`ash-history` | 分别 57、24、2 项通过 |
| `just test ash-tui` | 全量运行中 797 项通过；新增 PR 快照审阅接受后，对应单项复核通过（合计 798 项）；1 项需要独立终端的既有测试忽略 |
| `just test-tui actual_tui_issue_` | 3 项真实 PTY 场景通过：浏览/缓存恢复、缺 Skill 拒绝、刷新配置跨重启 |
| `just check ash-app-server`、`ash-tui`、`ash-session`、`ash-exec` | 正常编译检查通过；本轮最终构建无新增 warning |
| 桌面会话适配层独立 TypeScript 检查 | 通过；`session/create` 显式传入 Default |
| 完整 Renderer TypeScript 检查 | 未通过，既有聊天类型与调试模块导出错误仍在 |
| 文档及格式 | 本地链接有效；修改的 Rust 文件格式检查通过；无待接受快照 |

App Server 完整测试中的 `local::tests::custom_provider_catalog_fetch_is_explicit_and_feeds_model_selection` 在“刷新前不存在该 provider 条目”的断言失败，单独重跑仍失败。本轮未修改 `local.rs` 的模型目录读取实现或该测试，不通过更改其断言来掩盖结果。

后续核对确认该断言已过时：[供应商配置规则](../../docs/ash-app-server-api.md)明确规定，自定义连接未填写模型 ID 时使用对应 API 类型的内置模型，远端刷新不自动改写配置模型选择。该测试已更新为 `custom_provider_discovery_preserves_configured_model_choices`，检查刷新成功、空响应、认证失败及恢复时完整列表与配置快照均保持不变，并验证显式保存远端模型 ID 后列表才切换。以上历史测试结果保留。

桌面完整类型检查的剩余错误涉及聊天错误码、`referenceCost`、`threadRestored`，以及调试模块对编辑器的失效导入。本轮只更新会话适配层的 Default 参数，没有宣称整个桌面构建或 Playwright 场景已通过。

新快照覆盖 Issue 列表的三种宽度、Open/Closed、启动/失败状态、配置页，以及普通 `/pr` 任务提交；旧分组/工作流面板和对应基线已删除。文本基线保留终端空白，marker 列与焦点样式另有确定性单元断言。

## 共享模板补齐验证（2026-09-09）

- `just test ash-prompts`：10 项通过，覆盖三种批准模式、资产来源、审查终态和摘要边界转义。
- `just test ash-core`：208 项通过，1 项离线 benchmark 默认忽略。新增真实 ThreadController → ContextPlanner → ModelRequest 流程覆盖批准模式恢复、审查三个终态、checkpoint 覆盖旧 Review，以及接近上限的摘要续接预算。
- `just test ash-app-server agent_session_tests`、`review_turn_freezes`：分别 2、1 项通过，复核真实模型请求接线。
- `just check ash-prompts`、`ash-core`、`ash-app-server`：正常构建检查通过；无新增 warning。
- [补齐后的性能报告](benchmarks/shared-prompts-2026-09-09.md) 保存独立原始样本；前次报告和样本保留，不覆盖旧结果。
- 模板资源继续由现有 `templates/**` 编译清单覆盖，LF 行尾属性已检查。没有新增协议字段、UI 页面或实时语音执行链路。

## 当前验证入口与结束条件

```text
just test ash-core multi_agent
just test ash-app-server agent_session_tests
just test ash-app-server agent_selection
just test ash-models-manager
just test ash-protocol
just test ash-config
just test ash-tui issues::
just test-tui actual_tui_issue_
just generate-protocol
```

离线 benchmark 使用真实选择器与 Core 组合路径，默认测试运行中忽略，需明确调用：

```text
just test ash-core instruction_benchmark -- --ignored --nocapture --test-threads=1
just test ash-app-server instruction_benchmark -- --ignored --nocapture --test-threads=1
```

Core 对照首先断言两种路径发出的 ModelRequest 完全相同，再交错测量平铺输入与 Role 组合。选择基准使用已加载 catalog，磁盘读取不计入该指标；结果保留原始采样与构建模式。本轮结果、环境与原始样本见 [2026-09-09 离线报告](benchmarks/agent-instructions-2026-09-09.md)。

架构接入、本地性能、真实模型行为是不同结束条件。真实模型任务成功率、供应商缓存、完整任务成本和发布构建性能尚待固定模型清单与预算后验证；不能用离线 benchmark 的成功替代它们。
