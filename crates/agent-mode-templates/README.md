# Agent 任务命令

普通消息使用默认 Agent 指令。App Server 从用户请求的开头解析任务命令，在受理时冻结指令和执行约束。共同规则、Role 和模型指导由[指令组合](../prompts/docs/agent-instructions.md)负责。

## 指令模板

| 指令模板                    | 入口     | 任务行为                           |
| --------------------------- | -------- | ---------------------------------- |
| [Agent](templates/agent.md) | 普通消息 | 按授权完成并验证任务，按需委托     |
| [Ask](templates/ask.md)     | `/ask`   | 只读调查并回答问题                 |
| [Plan](templates/plan.md)   | `/plan`  | 只读调查，交付计划、依赖和验收条件 |
| [Debug](templates/debug.md) | `/debug` | 复现与诊断问题，修复并验证         |
| [Swarm](templates/swarm.md) | `/swarm` | 委托独立工作，整合并验证结果       |

## 分析模式、产品命令与 Goal

Core 在审批前拒绝 Ask 和 Plan 的文件及外部状态修改。调查进程使用只读、禁网沙箱，委托继承只读约束。计划交付后，用户发送新请求开始实施。见[权限系统](../../docs/permissions.md#快速理解)。

Ask 和 Plan 将参数中的工作流命令当作调查对象，完成后等待用户。执行请求可使用 `/team`、`/develop` 和 Goal。Goal 续跑复用已冻结的指令与执行约束。见 [Goal](../ext/goal/README.md)。

## Turn、切换与排队

任务命令通过普通消息提交，保留附件、队列与草稿。运行中的请求收到另一条任务命令时，命令在新 Turn 中执行。排队保留原始请求，提交后以冻结的 `TurnInstructions.taskCommand` 和指令正文恢复、重试和验证。旧记录可从 `Turn.mode` 和历史切换事件恢复。见 [App Server 协议](../app-server-protocol/README.md#agent-任务命令)。

## Swarm 的执行边界

协调者识别依赖、委托独立工作、等待并验收结果。依赖步骤等待前置结果，同一工作区按文件或任务分工。小任务可直接完成。隔离、并发上限、超时、取消和恢复见[委托契约](../../docs/core-multi-agent.md)。

`/swarm` 独立于模型推理档位。持久 [Team](../teams/README.md#产品入口与已有命令) 管理成员和跨任务协作关系。

## 维护与验证

模板变化同步更新[版本](src/lib.rs)和行为测试。直接请求和队列用 `just test ash-app-server-runtime --lib task_command` 验证，只读约束用 `just test ash-core --lib read_only_commands` 验证，终端用 `just test-tui-unit task_command` 验证。模型质量按[行为评测方法](../prompts/docs/agent-instructions.md#benchmark-与行为评测方法)单独测量。

## Cursor 参考记录

2026-09-30 核对 Cursor 3.22.12（`3a92974361033b2051526321308c2740fe5912c0`）。普通 Agent 也可并行委托，子任务拥有独立上下文，前台和后台任务有各自的等待方式。Multitask、Queue、Interrupt 是独立动作。Plan 可将独立步骤交给 Build in Parallel。[Cursor 子 Agent](https://cursor.com/docs/subagents) · [Multitask 支持说明](https://forum.cursor.com/t/multitask-qui-ne-fonctionne-plus/170340/5) · [多 Agent 帮助](https://cursor.com/help/ai-features/multi-agent) · [3.2 发布说明](https://cursor.com/changelog/04-24-26)
