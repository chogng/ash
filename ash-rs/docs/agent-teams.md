# Agent Team：跨任务的成员组织

> 状态：持久 Team 的创建、成员管理、任务快照、成员身份复用、团队讨论和 Team 记忆作用域已接入 App Server 与 Agents Window。现有 `/team` 命令仍是一次 Session 内的协作工作流。现有 Agent 树的执行事实见 [Agent 委托与运行树](../../docs/core-multi-agent.md)，Agent 定义见 [Agent](../../docs/agents.md)。

Team 回答“哪些 Agent 长期作为一组成员协作”；Team 任务记录回答“哪一组成员参与了哪次工作”；Session 的 Agent 树回答“这次工作如何执行”；并行调度回答“哪些互不依赖的工作同时运行”。这些问题分别建模。同一个 Team 可以顺序或并行执行任务；没有 Team 的 Agent 树也可以并行运行。

## 身份与生命周期

| 对象 | 持久身份 | 唯一负责的事实 |
| --- | --- | --- |
| Team | `TeamId` | 名称、职责说明、成员表、协调者、修订号及归档状态 |
| 成员 | 已有 `AgentId` | 跨任务识别同一 Agent；Team 中的职责和角色选择由成员关系保存 |
| Team 任务 | `TeamRunId` | Team 修订和成员快照、所属 Session、协调者 Thread、工作流来源及结果引用 |
| Session | 已有 `SessionId` | 一个 Agent 树、执行、取消、结果与任务内讨论 |
| 执行分支 | 已有 `ThreadId` | 一个成员在本次任务中的独立历史、上下文和 Turn |
| 委托 | 已有 `DelegationId` | 本次任务中调用方与执行分支之间的工作关系 |

Team 是 profile 范围的持久实体，可以被多个 Project 的任务使用。Team 与 Project、Session 的关联都是明确引用；关联不复制它们的状态，也不授予目录或工具权限。新增成员可以分配新的持久 `AgentId`，也可以明确选择已有身份；Team 创建与成员关系必须原子保存，不能留下只有名字、没有 Agent 身份的成员。成员关系保存职责名称、Agent 定义选择及成员状态。协调者必须是当前成员。成员的角色定义可以更新，但每个新 Thread 仍按启动时解析并冻结自己的模型、提示词、工具和 Skill；旧 Thread 不随成员表变化。

创建或修改 Team 使用命令身份和预期修订号，避免重复提交及覆盖并发编辑。归档 Team 阻止新任务，保留成员、讨论和任务历史。移除成员只影响后续任务；已启动任务使用启动时固定的成员表和授权范围，取消仍由所属 Session 的运行时处理。删除 Session 不删除 Team 或成员身份；Team 任务保留可解释的历史引用与原有结果摘要，不把已删除的 Thread 当成仍可读取的执行记录。

## 一次任务如何使用 Team

1. 用户或受授权的工作流选择 Team、目标、执行位置及本次授权范围。App Server 持久提交一个 `TeamRunId`，固定 Team 修订号和参与成员，并关联一个明确的 `SessionId`。独立 Team 任务建立新 Session；`/develop` 阶段可以使用其已有 Session。
2. 指定协调者以其已有 `AgentId` 获得本次协调 Thread；独立任务使用根 Thread，阶段工作可使用委托 Thread。协调者按任务依赖启动成员；每位成员的子 Thread 使用其原有 `AgentId`，并创建本次独立的 `DelegationId`。直接与一名成员交谈时，该成员是本次任务的负责人，不改变 Team 默认协调者。
3. 现有 Agent 树处理委托、消息投递、等待、预算、取消和恢复。Team 任务仅保存关联与固定成员快照，结果引用指向原有工作流和 Thread 事实。一个 Session 可包含多个 Team 任务，但每个 Team 任务只能属于一个 Session。
4. 下一次任务建立新的协调 Thread 与成员 Thread，并可再次绑定相同 `AgentId`。它不会继承上次任务的可变上下文、权限、取消域或未完成委托。

Team 任务提交与启动使用同一个稳定命令身份。启动中断后按已保存的 `TeamRunId`、成员快照和 Core 委托事实恢复，不能重新选成员或创建第二个协调 Thread。Team 任务不保存自己的 running/completed 执行状态机；可见状态从关联的工作流、Thread 和委托读取。

成员可以离线。长期身份指能够在下一次任务中找回同一成员及其明确保存的工作记录，不要求模型进程常驻。Team 任务的协调 Thread 和带 `team_run_id`、`member_id` 的 `spawn_agent` 委托会使用成员已有的 `AgentId`；未指定 Team 任务的委托继续创建新身份。

## 消息、知识与共同工作

任务内交流继续使用按 Session 和根 Thread 隔离的 Agent 讨论板。Team 另有按 `TeamId` 隔离的持久消息流：消息记录发送成员、接收成员或频道、来源 `TeamRunId`、内容及投递身份。写入时校验发送者成员身份，读取时校验当前成员身份；移除成员后不再向其交付团队消息，用户仍可查阅历史。消息在成员空闲时保留，下次运行可读取。活动 Thread 的提醒由对应运行负责；发帖本身不隐式启动 Agent、扩大授权或接受工作结果。

长期知识使用现有 Memory 领域增加 Team 作用域，保存经过明确选取的决定和经验，并保留来源 Session、Thread、消息或用户输入。新任务按权限和相关性选取知识，作为有来源的输入交给成员；不把整个旧 Thread、讨论板或其他成员的上下文自动拼入模型输入。更新 Team 知识不改写历史执行快照。团队讨论中的“完成”或“通过”不是任务结果或用户验收。

Team 的任务列表从 `TeamRunId` 关联和所属 Session 的事实构成。任务目标、进度、工作分配、结果和验收分别由本次工作流及 Agent 树持有；Team 不建立第二套跨 Session 的执行状态机。成员间可以持续讨论，但一次 Team 任务的取消只作用于对应协调 Thread 及其后代，不取消同一 Session 内的其他工作；预算和权限也不能通过 Team 关联扩张。

## 产品入口与已有命令

长期产品入口分别提供 Team 的创建、成员管理、讨论、任务启动和历史查看。Agents Window 展示 Team 列表、成员、团队讨论和关联任务；进入某次任务后继续使用现有 Agent 树视图。直接与某个成员交谈时，明确选择 Team 和成员，建立归属于该成员的新 Thread，而不修改其旧 Thread。

当前 `/team <任务>`、`/team status|resume|cancel` 实际管理一次临时协作工作，属于任务调度入口。它与 Multitask 模式的关系及入口命名候选集中说明在 [Multitask 的执行边界](../collaboration-mode-templates/collaboration-modes.md#multitask-的执行边界)。历史 `/team` 工作记录保持原 Session 和委托事实，不推断或补造 Team 成员身份。`/develop` 的阶段工作可以选择一个已有 Team；阶段版本和验收仍由 `/develop` 管理。

## 所有权与接口

- Rust Team 领域拥有 Team、成员关系、修订、`TeamRunId` 关联与团队消息的持久化及校验；App Server 暴露带类型的创建、列表、读取、修改、启动和订阅接口。App Server 只协调 Team、Agent 身份、Session 与运行时，不保存另一份 Team 状态。
- `agent-graph-store` 继续拥有 `AgentId` 与 Thread 的不可变绑定，并增加无 Thread 的 Agent 身份创建，使 Team 成员可先于第一次任务存在；对应持久化属于 `ash-state`。Core 扩展委托创建入口，以受验证的 Team 成员身份建立子 Thread，保留现有委托和权限收窄规则。普通 `spawn_agent` 不因名称相同就自动复用成员。
- Team 消息由 Team 领域保存并校验成员资格；现有任务讨论板仍按 Session 隔离。Memory 领域拥有 Team 作用域的长期知识。执行、上下文和授权仍由各自系统决定。
- 前端 Team service 消费 App Server 的 Team 契约；Agents Window 只持有选中项和布局状态。生成协议类型停留在领域适配器，不进入视图组件。

## 当前接口与后续入口

App Server 提供 `team/list|read|command`、`team/run/start|attach|read|list` 和 `team/message/post|list`。`team/run/start` 新建 Session 和协调 Thread，并启动第一轮任务；`team/run/attach` 将已用协调者身份创建的 Thread 关联到它所在的 Session。两者均保存成员快照。Agent 工具通过 `team_run_id` 和 `member_id` 指定委托对象，并通过 `team_read_messages`、`team_post_message` 继续讨论。Memory 的 Team 作用域只向参与该任务的 Thread 提供，具体读取与写入仍受 Memory 策略控制。

Agents Window 目前提供 Team 名册、成员和角色修改、任务启动、历史任务及讨论。`/develop` 尚未增加直接选择 Team 的命令参数；其已有 Session 可通过 `team/run/attach` 关联，但该工作流还未自动选择成员。旧 `/team` 命令也尚未更名为 `multitask`。这些命令入口需要与现有工作流语义一起调整，不能把历史临时委托推断为持久成员。

## 完成条件

从真实入口完成“创建 Team → 加入两个固定 `AgentId` → 启动任务 → 成员协作与结束 → 启动第二个任务”后，应能证明两个任务使用相同成员身份、不同 Thread 与独立取消域，并能按来源读取前次明确保存的决定。还要覆盖在已有 `/develop` Session 中启动 Team 任务、重启恢复、成员变更与运行中快照、跨 Team 消息隔离、重复命令、任务内权限收窄，以及 Desktop 的成员和任务操作。Web 与 Electron 界面使用 Playwright 验证状态和交互，不以截图判断通过。
