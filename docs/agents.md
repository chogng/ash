# Agent：统一定义、专化职责与启动关系

> 状态：Proposed。本文件拥有 Ash Agent Role 的产品边界、统一契约、内置清单和维护规则；当前实现见 [`ash-agent-roles`](../ash-rs/agent-roles/README.md)，委托运行与 Agent 树见 [`core-multi-agent.md`](core-multi-agent.md)，自定义对象和 `.ash` 边界见 [`agent-customizations.md`](agent-customizations.md)，`/develop` 的阶段、产物和失效流程见 [`develop.md`](develop.md)。

> 2026-09-09 设计复核：默认启动改为 `Default`，根与子 Thread 共用角色解析；共同规则、模型指导和 Role 的组合、Codex/Claude Code/VS Code 参考与性能评测统一维护在 [Agent 指令组合、模型专化与评测](../ash-rs/docs/agent-instructions.md)。通用启动与组合已接入；本文第 8 节区分已实现能力和剩余产品契约。

Ash 只有一种 Agent 定义。内置 Agent 与 `.ash/agents` 自定义 Agent 的差别是来源、可编辑性和发布周期；“根 Agent”“子 Agent”不是两种定义，只是某次运行在 Agent 树中的相对位置。代码和协议使用“会话入口运行”与“委托运行”表达关系，界面可以在树中把被委托节点简称为“子 Agent”。

## 快速理解

Agent 定义回答“使用什么职责、提示词、模型策略、工具和能力工作”；启动关系回答“这次运行从哪里开始、结果交给谁”。同一份定义可以在它允许的范围内作为会话入口、被其他 Agent 委托，或由确定性工作流启动。内置定义由后端打包，自定义定义从 `.ash/agents/*.md` 读取；内置定义不进入设置，但实际运行始终可观察。

| 常见问题 | 决定 |
| --- | --- |
| 自定义 Agent 是主 Agent 还是子 Agent？ | 都不是。它是一份可复用定义；本次启动来源决定它处于会话入口还是委托位置。 |
| 系统是否保留主 Agent 与子 Agent 两种类型？ | 不保留。领域中只有 Agent；运行时保留根节点、委托关系和父子拓扑。 |
| 内置专化 Agent 放在哪里？ | 作为 `ash-agent-roles` 的只读产品资源随版本发布，不能写入、生成到或同步到 `.ash`。 |
| `.ash/agents` 放什么？ | 只放用户或项目自定义 Agent definition。 |
| 设置里能看到内置专化 Agent 吗？ | 看不到，也不能在设置中编辑或覆盖；设置只管理可编辑的自定义来源。会话选择器和运行树不是设置页，按启动策略显示可用项。 |
| 根 Agent 一定可以调用其他 Agent 吗？ | 不一定。只有实际工具集中包含委托工具、目标定义允许被它调用，并且预算与权限都满足时才能委托。 |
| 被委托的 Agent 能继续委托吗？ | 可以，但不是默认权利；仍按相同工具、目标范围、深度、预算和权限规则继续收窄。 |
| `/develop` 的阶段 Agent 也在这里维护吗？ | 是。定义、提示词、工具和启动范围在本文维护；`develop.md` 只维护阶段流程、输入产物和验收门。 |
| 会继承发起者的全部对话吗？ | 默认不会。定义始终使用自己的提示词；委托运行只接收创建时明确物化并冻结的上下文。 |
| 会继承主模型吗？ | 没有“主模型”这一特殊概念。默认使用当前 Session 的模型与推理配置；没有 Session 的工作流使用自己的模型基线。定义或本次启动可以显式请求其他模型，委托不会自动继续传播中间调用者的临时模型覆盖。 |
| 会继承发起者的全部工具和权限吗？ | 不会。会话入口受系统、会话和环境上限约束；委托运行还要与调用方上限求交集。任何启动来源都不能扩大权限。 |
| 内置定义不可见是否意味着执行也隐藏？ | 不是。Thread、所用定义、工具调用、批准、结果、失败和取消仍须出现在运行记录与 Agent 树中。 |

## 1. 对象与边界

| 对象 | 回答的问题 | 身份与生命周期 |
| --- | --- | --- |
| `AgentRole` | 这个 Agent 的职责、提示词、模型策略、工具、Skill、能力和启动限制是什么？ | 可复用配置；身份包含来源和定义 ID，内容以版本或摘要冻结 |
| Agent 运行实例 | 这一次 Agent 正在执行什么？ | 当前由一个 Thread 表达，不新增与 Thread 一一对应的第二套身份 |
| 启动来源 | 这次运行从会话、委托还是工作流进入？ | 每次运行冻结；不改变定义本身的类型 |
| 委托关系 | 谁交付任务、结果返回给谁、取消和预算如何传播？ | 由 `DelegationId` 和 Thread 来源持久化，只存在于具体运行之间 |

定义不是正在运行的 Agent。会话入口和每次委托都使用同一种定义解析流程，并冻结角色提示词、专长、工具、能力、模型策略和上下文策略；委托另外创建拥有独立 `ThreadId`、Turn、上下文和取消域的 Thread。

内置与自定义定义必须使用带来源的稳定身份，例如 `BuiltIn(explorer)` 与 `Directory(dir_id, explorer)`。内部不能再只用裸 `name` 标识定义；自定义同名项不能覆盖或伪装成内置定义，显式选择出现歧义时必须要求准确来源。`Default` 表示不应用专用 Role，使用正常 Agent 配置；它与专用 Role 共用执行系统，不要求存在 `general.toml`。

## 2. `ash-agent-roles` 统一拥有角色定义

不新增 `ash-subagents`。`ash-agent-roles` 是全部 Agent Role 的唯一 owner，用一个 crate 隔离定义、内置资源、来源加载和校验依赖；它不接管 Agent 运行时。

```text
ash-rs/agent-roles/
├── Cargo.toml
├── README.md
├── assets/
│   └── builtins/
│       └── <role>.toml    # 专用 Role；Default 不需要独立文件
└── src/
    ├── built_in.rs
    ├── catalog.rs
    ├── model.rs
    └── lib.rs
```

| Owner | 长期职责 | 明确不负责 |
| --- | --- | --- |
| `ash-agent-roles` | 拥有统一 `AgentRole`、来源身份和启动策略；打包内置定义；扫描并归一化 `.ash/agents/*.md`；校验并发布不可变 catalog | Thread、模型调用、工具执行、设置 UI、权限授予 |
| `ash-prompts` | 拥有所有 Agent 共用的规则、共享流程模板、artifact 与冻结机制 | 每个 Role 的专用职责、模型特有差异 |
| App Server | 合并 catalog；按会话、委托或工作流筛选定义；把 Agent 模型策略和启动请求交给 `ash-models-manager`；解析工具与能力；创建冻结运行快照 | 自己维护模型候选排序、维护来源专属选择分支、把内置定义变成设置项、保存前端状态 |
| `ash-models-manager` | 维护模型事实、能力筛选和模型选择；模型相关指令资产与选择入口见指令组合设计 | 解释 Agent 职责、读取 Agent 定义、调用模型、保存 Thread |
| `ash-core` | 最终上下文组装；Thread、委托、消息、等待、取消和执行时能力收窄 | 扫描定义、选择产品角色 |
| `ash-protocol` | 定义来源身份、冻结快照、启动来源、上下文模式和能力上限的跨边界结构 | 角色内容和选择策略 |
| Desktop、TUI | 展示运行中的 Agent 树、状态、批准和结果；自定义设置只投影自定义 catalog | 解析或修改内置定义 |

不能把定义、调度、Thread、模型和 UI 装进同一个 crate。`ash-agent-roles` 的边界止于“Agent 是什么、来自哪里、允许从哪里启动、声明了什么上限”；“当前能否启动”由 App Server 结合本次来源和环境解析，“如何运行”由 Core 负责。

## 3. 统一定义契约与内置格式

每个内置专用 Role 使用一个独立的 `assets/builtins/<role>.toml`。描述、能力配置和 `developer_instructions` 作为一个版本单元发布，不拼进所有角色共享的大提示词，也不允许通过设置修改。共同规则与当前 Role 在执行时组合，默认启动不附加专用 Role 正文。

统一领域类型至少包含带来源的 `AgentRoleId`、选择 metadata、提示词、模型策略、工具与 Skill 上限、上下文策略、启动策略和带作用范围的执行能力上限。来源由 catalog loader 注入，不能由内置 Role TOML 或 `.ash/agents/*.md` 自报。当前 `ash-agent-roles::AgentRole` 已统一表达来源、内置版本、内容摘要、提示词及已有的模型、Tool、Skill、Instruction 声明；上下文策略、启动策略和带作用范围能力仍需继续补齐。

下面是计划格式，用于固定字段语义，不表示当前已经存在该 API：

```toml
name = "explorer"
version = 1
description = "定位代码、调用链和实现证据，不修改文件。"
specialties = ["code.explore", "code.trace"]
tools = ["read_file", "grep", "glob", "search_code"]
required_tools = ["read_file", "grep", "glob"]
disallowed_tools = []
delegation_tools = []
required_delegation_tools = []
disallowed_delegation_tools = []
skills = []
required_skills = []
developer_instructions = """
沿真实符号和调用链回答明确的代码问题，给出文件、行号、测试和不确定点。
不要修改文件，也不要执行与调查无关的工作。
"""

[model]
default = "session"
allow_override = true
replacement = "any-compatible"
required_capabilities = ["tools"]

[context]
default = "selected"
allowed = ["fresh", "selected"]

[launch]
allowed = ["session", "delegation"]
allowed_callers = []
workflows = []

[[capabilities]]
kind = "file_read"
scope = "thread_dirs"
```

字段边界如下：

- `description` 只用于选择，必须短、具体，并写清何时使用；完整行为规则放在同一 TOML 的 `developer_instructions`。
- 内置格式的 `version` 是定义内容版本；提示词、工具、Skill、模型、上下文、启动范围或能力上限变化都必须提升，并与完整内容摘要一起冻结。自定义来源继续使用 catalog generation 与内容摘要表达版本身份。
- `specialties` 描述角色擅长解决的问题，用于路由和评测，不产生执行权限。
- `tools` 省略时继承调用方的下放工具上限，存在时是精确白名单；`disallowed_tools` 从继承或白名单结果中删除工具，任何形式都不能扩大调用方的下放上限。
- `required_tools` 只做启动前检查，缺少任一工具就不创建；它不授予工具，也不改变最终可见集合。
- `delegation_tools`、`disallowed_delegation_tools` 和 `required_delegation_tools` 使用相同的白名单、黑名单和启动门禁语义，但只决定该 Agent 能向直接子 Agent 下放的工具上限；省略 `delegation_tools` 表示继承调用方的下放上限。自身 Tool 与下放 Tool 互不隐含，二者都不能越过任何祖先的下放上限。
- 委托的 `skills` 省略时继承调用方已经激活的 Skill，存在时只保留列出的 Skill；根角色从已授权 catalog 解析声明的 Skill。`required_skills` 不授予权限，缺失时创建失败。
- `capabilities` 是带作用范围的执行能力上限，使用现有 `CapabilityKind` 语义；它不能因为提示词或工具引用而扩大。
- `model.default` 使用 `session` 或准确 `provider/model`。`session` 表示当前 Session 的模型与推理配置；没有 Session 的工作流改用自己的模型基线。委托不从中间调用者继承临时模型覆盖。
- `model.allow_override` 独立决定本次启动能否请求其他模型；被禁止的覆盖是无效启动请求，不能被静默忽略。
- `model.replacement` 使用 `none`、`same-provider` 或 `any-compatible`。它只控制启动前的模型替换，不授权在一次模型调用失败后换模型重放请求。
- `model.required_capabilities` 与上下文、推理等级等约束共同描述候选模型必须满足的事实；`ash-agent-roles` 只校验声明结构，实际筛选统一由 `ash-models-manager` 完成。
- 不增加混合多种含义的 `fixed` 策略。需要准确模型时使用“准确 `default` + `allow_override = false` + `replacement = "none"`”表达。
- `context` 同时限制默认上下文和调用方可请求的模式；调用方不能越过角色允许范围。
- `launch.allowed` 明确一份定义能否从会话、委托或工作流启动；它限制使用位置，不把 Agent 分成不同类型。
- `launch.allowed_callers` 只约束委托来源，使用准确的定义来源身份；空列表表示不额外限制调用方，非空列表表示只允许列出的来源。调用方可见的目标集合由目标定义反向计算，不在两端重复保存同一条边。
- `launch.workflows` 只约束工作流来源，绑定准确的工作流和阶段；只有 `launch.allowed` 包含 `workflow` 时才允许非空，普通 Agent 不能伪造工作流身份。

| 启动来源 | 谁能创建 | 额外绑定 |
| --- | --- | --- |
| `session` | 用户或产品创建会话入口时的 Agent 选择器 | 没有父 Agent；使用会话的模型、目录和权限基线。 |
| `delegation` | 当前工具与目标策略允许的任意 Agent 运行 | 记录调用方 Thread 与 `DelegationId`；`allowed_callers` 非空时只允许准确来源身份。 |
| `workflow` | 指定的确定性工作流 | 必须绑定工作流 ID 和阶段；用户或普通 Agent 不能伪造该来源。 |

创建会话入口或委托 Thread 前，App Server 必须冻结启动来源、定义来源、定义版本、内容摘要、提示词摘要、请求模型、实际模型、模型替换原因、推理与服务等级、工具集合、Skill 集合、能力上限、上下文输入和选择原因。恢复旧 Thread 时继续使用冻结值，不能因应用升级、定义变化或模型目录刷新改写历史执行身份。

## 4. 启动与继承规则

Agent 定义本身不继承另一个 Agent。会话入口从会话已经解析的模型、目录、Instructions 和权限基线启动；委托运行拥有独立模型会话，只消费创建时明确物化的输入，调用方之后发生的变化只能通过有来源的 Agent 消息传递；工作流运行只消费该阶段绑定的上下文包。

| 内容 | 委托运行的默认行为 | 例外与限制 |
| --- | --- | --- |
| 委托任务 | 始终传递 | 必须是完整、可独立执行的任务，不能只传一句角色名。 |
| 专用提示词 | 始终使用该 Role 自己的 `developer_instructions` | 不能由调用方对话或设置替换；系统安全规则优先级更高。 |
| 产品安全与基础规则 | 重新应用并冻结适用于委托 Thread 的规则 | 不是复制调用方整段系统提示词，定义提示词不能覆盖它们。新委托在创建前冻结自己的共享规则与模型指导，历史种子继续使用其已记录的内容。 |
| 工作区 Instructions | 按委托 Thread 的准确目录和作用范围重新解析后冻结 | 同一环境且目录作用范围完全一致时可以复用已冻结基线；环境或目录变化时必须重新解析，不能复制无关调用方规则。 |
| 调用方完整对话 | 默认不传递 | `full` 只允许显式请求，且定义必须声明允许；初始内置定义均不默认允许。 |
| 选定消息、检查点和产物 | 按角色默认策略传递 | 创建时复制为不可变种子；不建立实时共享上下文。 |
| 隐藏推理过程 | 不传递 | 传递结论、证据、计划或检查点，不依赖另一 Agent 的未公开推理。 |
| 模型 | 默认使用当前 Session 已解析的模型作为启动基线 | 本次启动覆盖获准时优先于定义偏好；准确模型不可用时按定义策略选择兼容模型并警告。没有兼容候选或策略禁止替换时不创建。 |
| 推理等级与服务等级 | 默认使用 Session 的模型调用配置作为启动基线 | 显式模型没有显式推理等级时使用该模型的默认值；最终配置仍受预算和产品策略限制并随运行冻结。 |
| 工具 | 自身与下放范围分别冻结 | 两组范围分别应用 Role 白名单、黑名单和启动门禁，并与调用方下放上限、环境可用集合求交集；自身不能调用只存在于下放范围的 Tool。 |
| Skills | 只加载定义明确声明且当前已授权的 Skill | 不自动复制调用方全部已激活 Skill。 |
| 能力与批准 | 只继承更窄的上限 | 调用方批准不是被委托方的永久批准；具体动作仍按策略审查。 |
| Environment 与目录 | 默认使用调用方 Thread 的执行环境和已授权目录快照 | 切换环境必须显式选择并重新授权，不能通过定义暗中切换。 |
| 预算与取消 | 使用独立委托预算和取消域，同时受调用方总上限约束 | 取消调用方时按既定树策略处理后代；被委托方不能增加总预算。 |

现有上下文模式继续作为委托执行契约：`fresh` 只包含任务、角色和基础规则；`selected` 只物化明确来源；`lastTurns`、`checkpointAndTail` 与 `full` 只在定义允许并由调用方明确请求时使用。所有模式都在创建时冻结，不共享调用方 Thread 的可变历史。会话入口和工作流分别使用自己的输入契约，不能伪装成一次父子继承。

### 4.1 模型选择与替换

Agent 只声明默认值、覆盖权限、替换范围和能力要求。App Server 组合本次启动上下文后调用 `ash-models-manager`，后者是模型候选筛选与排序的唯一 owner；`ash-model-provider` 只执行已经选定的准确模型。

| 场景 | 请求模型来源 | 结果 |
| --- | --- | --- |
| 没有任何覆盖 | 当前 Session；无 Session 的工作流使用工作流基线 | 使用基线模型；委托不自动继承中间调用者的临时覆盖 |
| 本次启动显式指定且允许覆盖 | 启动参数 | 该模型成为请求模型 |
| 没有启动参数但定义指定准确模型 | `model.default` | 定义模型成为请求模型 |
| 请求模型可用且满足要求 | 准确目录条目 | 直接使用，不产生替换警告 |
| 请求模型不可用，允许同 provider 替换 | 兼容候选 | 先选同 provider 的兼容模型，记录并展示警告 |
| 同 provider 没有候选，允许跨 provider 替换 | 兼容候选 | 再按允许的 provider 顺序选择，记录更醒目的跨 provider 警告 |
| 没有兼容候选或 `replacement = "none"` | 无 | 不创建 Agent，返回类型化原因 |

候选解析顺序固定为：

1. 请求的准确模型。
2. 同一配置、endpoint、账号或订阅 scope 内，目录明确属于同一模型族的兼容模型。
3. 同一 scope 内的其他兼容模型。
4. 同 provider 的其他已允许 scope 中的兼容模型。
5. 其他已允许 provider 的兼容模型。

模型族、能力、生命周期和候选顺序必须来自带来源的模型目录事实，不能根据模型 ID、价格或“看起来更新”猜测。候选至少要满足工具调用、输入类型、上下文长度、推理等级、结构化输出、执行 runtime、账号可用性、组织策略、费用限制和区域限制；事实未知时按本次选择策略明确排除或携带警告，不能把未知当作支持。同 provider 不代表同 endpoint、凭据、订阅或计费来源；跨 scope 也必须记录并警告，策略不允许改变访问来源时直接排除。

替换是启动前的一次确定性选择，不是模型调用重试。选择结果必须包含请求模型、实际模型、替换原因、是否跨 provider、使用的目录 generation 和最终推理配置；客户端在 Agent 开始工作前显示非阻塞警告，运行记录和 Agent 树继续显示实际模型。运行开始后目录刷新、Session 换模型或上级 Agent 改配置都不能切换该运行的模型；真实调用失败按原模型返回错误，不能跨 provider 重放可能已经产生副作用的请求。

## 5. 内置 Agent 清单

普通会话与普通 worker 都选择 `Default`，不通过任务关键词寻找专用 Role，也不继承父 Role 的职责。当前 catalog 打包 `issue`、三个 Team 角色、五个 Develop 阶段角色及三个 Intent 私有角色；根角色通过 `session/create.agent` 选择，工作流角色只能经过其运行入口。以下普通可选清单目前只有 `issue` 已上线，其余普通角色仍为设计；阶段表中的完整能力目标与当前工具边界分开说明。

### 5.1 普通可选 Agent

这些定义允许用于会话入口和 Agent 委托，可以被用户或模型显式选择，但仍不进入设置页。模型可以参考描述作出选择，执行框架不按任务文本重新替它选择角色。

| ID | 允许启动来源 | 专长与自己的提示词重点 | 默认上下文 | 工具规则 | 执行能力上限 | 明确不做 |
| --- | --- | --- | --- | --- | --- | --- |
| `issue` | 会话、委托 | 读取 Issue 引用，通过 GitHub Skill 管理 Issue 状态，并把实现交给 Default worker | `fresh` 加明确 Issue 引用 | 自身只保留 GitHub 与协调 Tool；下放范围受会话与祖先上限约束 | 本次启动已经授权的能力上限 | 直接修改代码、拥有 Issue 专属执行状态机 |
| `explorer` | 会话、委托 | 回答范围明确的代码问题；沿真实符号和调用链给出文件、行号、测试与不确定点 | 会话输入或 `selected` | `read_file`、`grep`、`glob`、`search_code` | 授权目录只读 | 修改文件、运行长任务、泛泛设计 |
| `implementer` | 会话、委托 | 在明确文件或模块责任内完成代码修改；保留他人改动，运行最小验证并报告改动与测试 | 会话输入或 `checkpointAndTail` | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate`、`apply_patch`、`edit`、`write_file` | 授权目录读写、受沙箱约束的进程 | 外部服务修改、凭据使用、超出分配范围的重构 |
| `reviewer` | 会话、委托 | 独立审查目标、最终 diff 与验证证据；先报可操作问题、严重度和证据，再给摘要 | 会话输入或 `fresh` 加显式目标与证据 | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate` | 源码只读、只读进程检查 | 修改代码、接受工作 Agent 的总结代替证据 |
| `test-runner` | 会话、委托 | 运行指定测试或检查；区分首个根因与连带失败，返回命令、退出状态和关键输出 | 会话输入或 `selected` | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate` | 源码只读、受沙箱约束的进程、仅构建产物目录可写 | 修复代码、无界运行、把失败误报为完成 |
| `researcher` | 会话、委托 | 优先使用官方一手资料；核对发布日期、版本和适用范围，区分来源事实与推断 | 会话输入或 `fresh` | `read_file`、`grep`、`glob`、`web_search`、`browser_open`、`browser_observe`、`browser_navigate`、`browser_close` | 授权目录只读、网络读取、浏览器只读交互 | 修改本地文件、登录账户、提交表单、把本地文档当最终事实 |
| `ui-validator` | 会话、委托 | 用真实浏览器或 Electron 流程复现并验证 UI；记录步骤、语义状态和可复查证据 | 会话输入或 `selected` | `read_file`、`grep`、`glob`、`process_start`、`process_wait`、`process_terminate`、`browser_open`、`browser_observe`、`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_back`、`browser_reload`、`browser_screenshot`、`browser_close` | 源码只读、受沙箱约束的进程、网络与 UI 交互 | 修改源码、使用截图代替调试结论、执行不可逆外部操作 |

每个已经上线的表格行都必须对应一个真实 `assets/builtins/<id>.toml`，文档只维护提示词契约，不复制完整正文。这样提示词只有一个可执行 owner，修改时不会出现文档与实际资源两份正文漂移。

`process_start`、`process_wait` 与 `process_terminate` 表示计划中的显式进程资源契约。当前 App Server 的 `shell-command` 默认 30 秒超时，不能可靠承载长测试，也不能单靠工具名证明“只读”。专化角色上线前必须让进程动作产生准确的文件、进程和网络能力需求，以角色能力上限执行检查，并支持等待、取消、超时和未知结果；不能用反复调用短时 shell 维持长任务。

### 5.2 `/develop` 阶段角色

`/develop` 的阶段状态机根据已接受产物创建这些角色。它们不参与普通任务的自动选择，也不能由用户绕过流程直接调用。阶段角色只消费该阶段不可变上下文包，不继承当前聊天的实时完整历史。

| ID | 自己的提示词重点 | 默认上下文 | 自己的工具集 | 执行能力上限 | 产物与停止条件 |
| --- | --- | --- | --- | --- | --- |
| `develop-intent` | 从用户原话和有来源证据中提炼问题、期望、约束、非目标与未决判断，不把方案伪装成意图 | `selected`：命令锚点、用户决定和调查证据 | `write_intent_candidate`、`spawn_agent`、`send_agent_message`、`wait_agent` | 只能写当前工作 Intent 候选并调用三个私有角色 | 产出可追溯候选；缺产品判断时返回 `NeedsUserDecision` 并停止，由工作流向用户提问 |
| `develop-spec` | 把已接受 Intent 转换成可观察行为、系统边界、失败语义、风险和验收标准 | `selected`：已接受 Intent、项目事实和领域文档 | `read_file`、`grep`、`glob`、`search_code`、`write_spec_candidate` | 项目只读，只能写当前工作 Spec 候选 | 产出 Spec 候选；不能改变 Intent 或实施代码 |
| `develop-plan` | 根据已接受 Spec 和固定代码基线形成有顺序、可验证的工作契约与执行方式 | `selected`：已接受 Intent/Spec、代码基线、测试入口 | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate`、`write_plan_candidate` | 源码只读、只读进程检查，只能写当前工作 Plan 候选 | 产出 Plan 候选；不能降低验收标准 |
| `develop-implementer` | 严格按已接受工作契约修改分配范围，保留他人改动并产生可封存 ChangeSet | `selected`：已接受 Intent/Spec/Plan、工作契约和代码检查点 | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate`、`apply_patch`、`edit`、`write_file` | 只读写分配的代码范围并运行获准验证 | 工作完成、失败或工作契约失效时停止；不能改写上游产物和验收规则 |
| `develop-acceptance` | 独立对照原始意图、固定 Spec、最终差异和真实证据判断是否满足验收标准 | `fresh` 加显式选择的固定验收包 | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate`、获准的 `browser_*` 验证工具、`write_acceptance_candidate` | 源码与控制资源只读，只能运行已定义验证并写验收候选 | 返回逐项证据和未满足项；不能修改候选代码或接受自己的工作 |

`write_intent_candidate`、`write_spec_candidate`、`write_plan_candidate` 与 `write_acceptance_candidate` 是计划中的领域工具，当前不注册。当前阶段 Agent 用最终 JSON 提交候选，工作流只接收所绑定阶段 Thread 的终态结果，再按版本保存；接受与失效只能由用户命令触发，普通 `write_file` 不能改写领域候选。Spec、Plan、Acceptance 当前仅有 `read_file/grep/glob/board_read/board_write`，不获任意 Shell；Intent 另有协调工具。实现者使用获准工具上限，并且只能委托 Team 协调者。表中的进程资源、按文件范围授权与封存契约仍为目标。

`develop-acceptance` 的浏览器工具不是每次全部加载。工作流从已接受 Spec 的验证方法推导本次必需工具，并在创建时冻结实际子集；任何必需工具不可用时验收阻塞，不能删掉该验收项继续通过。

表格中的 `browser_*` 是阅读缩写，实际 Role TOML 必须逐项列出允许的浏览器工具。当前 `ToolDefinition` 没有来源可信、可签名的“只读/修改”动作 metadata，因此通用专化角色不动态接入 Connector；`issue` 是明确绑定 GitHub Skill 的协调角色，仍只能从调用方当前已授权的 `search_tools` 与 `call_mcp_tool` 上限中收窄，具体外部写操作继续经过工具策略和批准。

### 5.3 Intent 私有角色

以下角色只注册到 `develop-intent` 的私有能力面：不进入设置、不进入普通协调层 catalog、不接受用户直接选择，也不能被其他阶段 Agent 调用。每次委托只回答一个可验证问题并返回有来源的证据，不写任何阶段产物。

| ID | 自己的提示词重点 | 默认上下文 | 自己的工具集 | 执行能力上限 | 唯一允许的调用方 |
| --- | --- | --- | --- | --- | --- |
| `intent-project-investigator` | 调查一个明确的本地事实，返回源码、Git、测试证据、代码基线与不确定性 | `fresh` 或 `selected` | `read_file`、`grep`、`glob`、`search_code`、`process_start`、`process_wait`、`process_terminate` | 项目只读、只读 Git/构建/测试进程、仅构建产物目录可写 | `develop-intent` |
| `intent-researcher` | 调查一个明确的外部事实，优先一手来源并说明时间、版本、适用范围和不确定性 | `fresh` 或 `selected` | `web_search`、`browser_open`、`browser_observe`、`browser_navigate`、`browser_close` | 网络和外部来源只读；不得登录、提交或修改外部状态 | `develop-intent` |
| `intent-conflict-reviewer` | 比较指定的用户原话、项目事实、外部来源和候选产物，列出冲突双方、影响与可确定优先级 | `selected` | `read_file`、`grep` | 只读明确提供的来源 | `develop-intent` |

三个私有角色的 `launch.allowed` 都只包含 `delegation`，`launch.allowed_callers` 只包含内置 `develop-intent` 的来源身份。App Server 为 `develop-intent` 计算可用定义时反向得到这三个目标，并把 `spawn_agent` 的可选范围冻结到该集合；仅靠提示词要求“不要调用其他 Agent”不构成隔离。

### 5.4 与 `/develop` 的责任联动

| 契约 | Canonical owner |
| --- | --- |
| 角色 ID、提示词、工具、能力、模型与启动范围 | 本文件和 `ash-agent-roles` |
| 阶段顺序、接受门、产物版本、上游失效、恢复与用户等待 | [`develop.md`](develop.md) |
| 委托 Thread、上下文种子、消息、取消、等待和持久结果 | [`core-multi-agent.md`](core-multi-agent.md) |
| Team 的委托、消息、等待和结果 | [`core-multi-agent.md`](core-multi-agent.md) |

阶段协调必须由确定性工作流完成，不能把 `develop.md` 整篇作为提示词交给会话入口 Agent。工作流创建阶段 Agent 时提交固定阶段身份、已接受上游版本、代码基线、工具范围、预算、时间和停止条件；阶段 Agent 只返回候选或证据，不能自行推进、接受或重写工作流状态。

## 6. 选择、可见性与执行流程

当前内置定义用 `launch = any/workflow/delegation`、`callers` 与 `delegates` 表达启动范围。运行时校验准确内置来源、调用方定义摘要及委托目标；普通选择目录只列通用角色，Default 也不能绕过私有角色门禁。资源正文归 `ash-rs/agent-roles/assets/builtins`。

| Team 角色 | 入口与当前工具边界 |
| --- | --- |
| `team-coordinator` | `/team` 或 `develop-implementer` 委托；源码读取、讨论板与协调工具，只能委托下面两个角色 |
| `team-implementer` | 仅协调者委托；继承获准实现工具，不能继续委托 |
| `team-reviewer` | 仅协调者委托；源码与已有证据读取、讨论板，不获代码写入或 Shell |

```mermaid
flowchart LR
    Launch[会话、委托或工作流启动请求] --> Eligible[App Server 计算可用定义]
    BuiltIn[内置 catalog] --> Eligible
    Custom[.ash/agents 自定义 catalog] --> Eligible
    Baseline[启动模型、工具、能力与环境基线] --> Eligible
    Eligible --> Select[Default 或准确来源的专用 Role]
    Select --> Freeze[冻结定义、模型、工具、能力与上下文]
    Freeze --> Thread[创建 Agent 的 Thread]
    Thread --> Record[运行树、批准、结果与失败记录]
    BuiltIn -.不投影.-> Settings[设置中的自定义 Agent 管理]
    Custom --> Settings
```

选择规则：

1. 先按 `launch` 筛选本次会话、委托或工作流允许的定义，再按所需工具、能力、模型和上下文模式计算可用集合；不可执行的定义不能被启动。
2. 委托来源继续检查准确调用方身份、Agent 树深度和预算；工作流来源继续检查工作流与阶段身份。
3. 显式选择必须解析到唯一的来源身份；显式名称也不能绕过调用范围，内置名称不能被自定义定义覆盖。
4. 省略专用角色表示 `Default`，不按任务关键词匹配，也不继承父 Role。描述和 `specialties` 可供用户或模型选择时参考；准确指定的定义不存在或有歧义时必须返回错误。
5. 选择成功后冻结全部输入，再创建 Thread；不能先创建再补工具、权限或提示词。
6. 内置 catalog 只投影给本次启动来源允许的选择器和运行观测，不进入设置服务、设置 schema 或自定义 Agent 管理页。

“不进入设置”只限制编辑和配置。运行时必须展示内置定义 ID、来源、启动关系、状态、工具调用、批准请求、结果和失败原因，用户可以停止正在运行的 Agent。

## 7. 安全与失败语义

- **失败即关闭**：提示词缺失、摘要不一致、模型策略无法解析出兼容候选、必需工具缺失、能力越权、上下文来源无效或定义版本未知时，不启动 Agent。
- **权限只收窄**：定义清单不是授权凭证；即使清单声明某项能力，也必须处于启动基线和系统授权之内。
- **无同名覆盖**：自定义定义不能替换内置定义；迁移旧的裸名称前必须先增加来源身份。
- **无身份特权**：位于根节点不会自动获得委托能力，被委托节点也不会自动失去委托能力；是否可以继续委托完全由冻结工具、允许目标、深度、预算和权限决定。
- **委托能力显式受控**：自身 Tool 决定能否调用委托工具，下放 Tool 上限独立决定后代能获得什么；不能仅凭角色名称授予或禁止委托。当前 `issue` Role 已把自身协调 Tool 与实现 Tool 下放上限分离；目标限制、深度与预算仍由通用运行时检查，不能只依赖提示词。
- **控制资源隔离**：Intent、Spec、Plan、验收记录、测试入口、项目指令、权限和验证配置不能通过普通文件写工具越权修改；修改控制资源的角色不能用修改后的规则批准自己的结果。
- **无实时上下文共享**：委托运行只读冻结种子和有来源的后续消息；不能读取调用方实时草稿、未提交推理或其他 Agent 的内存。
- **批准保持可见**：内置定义不可配置不代表可以绕过批准、沙箱、网络规则、凭据边界或外部修改审查。
- **本地文档不是最终事实**：设计与实现状态必须由源码、测试和一手外部文档交叉验证；发现冲突时在文档中明确 Current 与 Proposed，不能选择更方便的一份作为事实。

## 8. 当前实现与缺口

| 能力 | 状态 | 证据或缺口 |
| --- | --- | --- |
| `.ash/agents/*.md` 自定义定义 catalog | 已实现 | `ash-agent-roles` 扫描、校验并发布不可变 snapshot。 |
| 根与委托的准确角色选择 | 已实现 | `server/agent_selection.rs` 共用 Default/Exact 解析，不使用任务关键词路由。 |
| 独立委托 Thread、消息、等待、取消与持久结果 | 已实现 | `ash-core` 多代理运行时。 |
| `fresh`、`selected`、`lastTurns`、`checkpointAndTail`、`full` | 已实现 | `spawn_agent` 当前默认 `fresh`，其他模式显式传入。 |
| 委托工具只能从调用方下放上限中收窄 | 已实现 | `AgentCapabilityScope` 分别冻结自身 Tool、下放 Tool 与 Skill；每一代都从父 Agent 的下放上限和当前环境可用集合求交集。 |
| Role Tool 白名单、黑名单与启动门禁 | 已实现 | 自身与下放两组 Tool 都支持精确白名单、黑名单减法和 `required_*` 启动门禁；最终集合进入 `AgentContextSeed`，自身 Tool 继续约束模型输入、直接调用和 Code Mode 内层调用。 |
| 自己调用与下放给子 Agent 的 Tool 上限分离 | 已实现 | `issue` 自身只拥有 GitHub 与协调 Tool，下放范围独立继承调用方上限；实现 Agent 可以获得写入 Tool，而 `issue` 本身不能调用。历史种子没有下放字段时按空集合读取，不获得新增的工具下放权限。 |
| 委托运行使用完整模型调用基线 | 尚未完成 | 当前 Agent Role 选择明确冻结 `ModelRef`；推理等级和服务等级还需要作为同一模型策略核对并冻结。 |
| Agent 模型继承、覆盖和兼容替换 | 尚未完成 | 当前委托只使用调用方当前 `ModelRef` 或定义中的准确模型；`ash-models-manager` 目前只解析指定模型，没有跨 provider 候选选择、替换决定和用户警告。 |
| 会话入口选择 Agent 定义 | 已实现 | `session/create.agent` 接收带来源的选择，配置与 ThreadCreated 同批提交；重试复用原配置。 |
| Default 与共同规则、模型指导、Role 组合 | 已实现 | 共同规则归 prompts，模型指导独立冻结，Role 通过统一 Thread 配置生效；见 [指令组合设计](../ash-rs/docs/agent-instructions.md)。 |
| 统一定义契约 | 部分具备 | 内置 TOML 和目录 Markdown 已统一产出 `AgentRole`；内置启动范围已接入，模型完整策略、上下文策略和带作用范围能力仍需补齐。 |
| 内置专化 catalog 与本文角色资源 | 部分具备 | `issue`、Team、Develop 阶段与 Intent 私有角色已打包；其他普通角色仍未加入。 |
| 启动来源与 `/develop` 私有范围 | 已实现当前入口 | 会话、工作流与委托入口检查准确内置来源、调用方摘要和允许目标；私有角色不进入通用工具目录，不能通过 Default 绕过。 |
| 带来源的定义身份 | 已实现 | `AgentRole` 与 `FrozenAgentDefinitionRef` 都冻结 `BuiltIn` 或准确目录 ID，内置 Role 同时冻结版本与内容摘要。 |
| 每个角色的带作用范围执行能力上限 | 尚未完成 | 当前 `AgentCapabilityScope` 已分离自身与下放 Tool，但仍需冻结并执行检查文件、进程、网络等 `Capability` 上限。 |
| 委托基础指令与角色隔离 | 已实现 | 新委托冻结自己的共享规则和模型指导，不复制父 Role 或父 Turn 的专用审查模板；目录规则继续由实际环境提供。 |
| 长时进程资源 | 尚未完成 | 当前 `shell-command` 默认 30 秒超时；需要可等待、可取消、可终止并能表达结果未知的进程资源，以及准确的构建产物写入范围。 |
| 动态外部工具的动作 metadata | 尚未完成 | 当前 `ToolDefinition` 没有权威只读/修改分类；在来源签名、动作能力和摘要冻结完成前，专化角色不动态接入 Connector。 |
| `/develop` 用户判断交互 | 部分具备 | `needs_user_decision` 候选保存问题，用户用 `/develop resume <决定>` 作答；交互式 server request 尚未接入。 |
| 内置不进设置、运行时仍可观察 | 尚未完成 | 需要分别测试设置投影和 Agent 树投影，不能共用一个“是否可见”字段代替两个行为。 |
| 内置角色选择与评测 | 部分具备 | 已覆盖准确来源、Default、根角色、缺 Tool/Skill、白黑名单与恢复；真实模型任务质量评测仍未完成。 |

当前代码里“委托 Role 未声明模型时使用调用方当前模型”和“未传上下文时使用 `fresh`”已经存在，但前者不是目标继承语义：目标是从 Session 基线、Role 偏好和获准的本次启动请求生成一个请求模型，再由统一模型目录选择并冻结实际模型。会话入口已可选择并冻结 Agent Role；`issue` 对普通入口开放，Team、Develop 及 Intent 私有角色按入口和调用方收窄，Default 不读取专用定义。会话、委托与工作流复用同一解析契约；执行继续复用既有子 Thread、上下文种子和工具/Skill 冻结机制，不建立第二套运行时。

## 9. 维护与验收

每次新增或修改内置 Agent，必须同时完成：

1. 更新唯一的 `assets/builtins/<role>.toml`，提升定义版本并生成稳定摘要。
2. 校验 ID、提示词非空与大小上限、工具引用、能力作用范围、模型策略、上下文策略和禁止递归规则。
3. 增加 Default、准确来源选择、同名歧义和错误目标测试，证明任务文字不会改变已经确定的角色。
4. 增加行为评测，覆盖结果格式、证据质量、禁止动作和工具最小化；只读角色必须有“不能修改”的执行测试。
5. 增加权限交集、缺工具、准确模型、同 provider 替换、跨 provider 替换、无兼容候选、替换警告、上下文泄漏、恢复后摘要一致和取消传播测试。
6. 验证设置页不出现内置定义，同时 Agent 树和运行记录能够显示真实执行身份。
7. 工作流或私有定义还要验证普通选择器和错误调用方无法发现、选择或调用它们。
8. 对照源码与测试更新本文件的状态表；不能只依据其他本地 Markdown 宣布完成。

涉及提示词组合、模型专化或性能结论时，同时遵循 [评测与文档维护要求](../ash-rs/docs/agent-instructions.md#文档与实验的维护)，保留对照结果、失败样本和适用版本。

## 10. 长期不变量

- Ash 只有一种 `AgentRole`，不建立主 Agent、子 Agent 或工作流 Agent 的并列类型。
- 会话入口、委托和工作流是运行时启动来源；父子只表示具体运行之间的委托拓扑。
- Agent 能否委托由冻结工具、允许目标、深度、预算和权限共同决定，不从它位于根节点还是委托节点推断。
- 每个 Agent 定义独立拥有提示词、模型策略、工具、Skill、上下文策略和能力上限；职责描述不产生权限。
- Agent 默认使用 Session 模型基线；默认值、启动覆盖权限和替换范围分别表达，不建立 `fixed` 混合策略，也不自动传播中间调用者的临时模型覆盖。
- 模型替换只发生在运行创建前，确定性地先检查同 provider 再检查其他允许 provider；请求模型、实际模型、原因和跨 provider 状态必须可见并随运行冻结。
- 内置与自定义定义共用契约，但保留不可伪造的来源身份；自定义定义不能覆盖内置定义。
- 内置定义随 `ash-agent-roles` 发布，不写入 `.ash`，不进入设置；允许选择的定义和实际运行仍按来源完整展示。
- 当前一个 Agent 运行由一个 Thread 表达；没有跨多个 Thread 延续的真实身份需求前，不增加第二套 Agent 运行聚合。

## 11. 外部参考与取舍

Codex、Claude Code、VS Code 本地 Copilot 与 Copilot Agent Host 的指令组合、固定源码版本、采用范围和评测限制统一见 [外部产品参考](../ash-rs/docs/agent-instructions.md#外部产品参考与采用范围)。

- [OpenAI 模型指南](https://developers.openai.com/api/docs/guides/latest-model) 使用“多 Agent / 子 Agent”描述一个 Agent 协调多个执行者，说明该词首先表达运行时协作关系。Ash 不从该术语推导独立定义类型。
- [Claude Code 自定义子代理文档](https://code.claude.com/docs/en/sub-agents) 同时描述独立提示词、工具、模型与上下文，并明确同一 Agent 文件也可通过 `--agent` 或设置作为主会话 Agent 运行。Ash 采用“定义与运行位置分离”的结论，但不复制其文件优先级和同名覆盖规则。

外部产品的文件格式和优先级只作为设计输入，不是 Ash 的兼容契约。Ash 的最终行为以本文件明确的长期不变量、实际源码和通过的测试为准。
