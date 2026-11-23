# Agent 模式

`AgentMode` 决定当前 Turn 的工作方式。五种内置模式共用模型调用、工具执行、委托和恢复。协议定义稳定 ID，本 crate 提供内置模板。共同规则、Role 和模型指导的组装见 [Agent 指令组合](../prompts/docs/agent-instructions.md)。动态注册见 [自定义模式候选](#自定义模式候选)。

## 内置模式

| 模式                                  | 工作方式与交付                                                   | 子任务默认模式 |
| ------------------------------------- | ---------------------------------------------------------------- | -------------- |
| [Agent](templates/agent.md) · `agent` | 默认模式，按授权推进并验证任务，需要时委托                       | Agent          |
| [Plan](templates/plan.md) · `plan`    | 调查现状，交付包含依赖、可并行步骤和验收条件的计划，等待用户决定 | Plan           |
| [Debug](templates/debug.md) · `debug` | 复现问题，验证假设，修复根因并清理临时调试内容                   | Debug          |
| [Swarm](templates/swarm.md) · `swarm` | 拆分独立工作，并行委托，整合并验证结果                           | Agent          |
| [Ask](templates/ask.md) · `ask`       | 查阅必要材料，回答问题并给出依据                                 | Ask            |

子任务按[委托时解析的模式](../protocol/src/agent_mode.rs)重新组合指令，Role 和能力上限独立解析。选择了自定义 Agent 的用户仍可切换内置模式。

## 分析模式、产品命令与 Goal

- Plan 和 Ask 只执行调查。Core 在审批前拦截文件及外部状态修改，调查进程使用只读、禁网沙箱。执行规则见 [权限系统](../../docs/permissions.md#快速理解)。
- `/init` 保留当前模式，初始化指令与模式模板一起组装。Plan 和 Ask 分析初始化请求，跳过 Setup Hook。直接提交和队列的接受、编辑、交付使用相同的目录上下文。
- Agent、Debug 和 Swarm 可以通过 `/team`、`/develop` 启动工作流。Plan 和 Ask 将同样的命令作为分析请求处理。
- 只有 Agent、Debug 和 Swarm 注入活动 Goal 的持续执行指令，并在满足条件时按原模式续接。Plan 和 Ask 完成或恢复后等待用户，仍可查询 Goal。切换模式保留现有 Goal 状态。实现见 [Goal](../ext/goal/README.md)。
- 独立审查使用 Agent，Advisor 使用 Ask，压缩入口负责生成续接上下文。

## Turn、切换与排队

新 Turn 保存稳定的 `mode` 和模式资产的 owner、ID、revision 与正文。公开 `Turn.mode` 供客户端读取，模式正文作为独立的必需内容参与上下文预算。后续模型调用、压缩、恢复和命令重试使用已保存的指令。模式模板的更新从新接受的 Turn 生效。[协议入口](../app-server-protocol/README.md#agent-模式) · [Turn 指令记录](../protocol/src/turn/instructions.rs)

| 用户操作                              | 提交行为                                         |
| ------------------------------------- | ------------------------------------------------ |
| 只切换输入区的模式                    | 更新下一条消息的草稿选择                         |
| 空闲时发送                            | 按所选模式启动新 Turn                            |
| 运行中提交同模式的追加消息            | 通过 Steer 追加到当前 Turn，沿用已生效的模式指令 |
| 运行中提交不同模式或新选 Skill 的消息 | 排入队列，空闲后通过普通入口启动新 Turn          |
| 主动中断                              | 按当前 Turn 和后代的取消规则处理                 |

[持久队列](../app-server/src/server/request_processors/queue.rs)在接受时保存模式、输入、明确选择的模型、推理档位和批准方式，并解析缺省的工具模式。自动选择的模型在交付时解析。队列通知触发重新读取，桌面输入区按状态显示排队数量和跨模式提交提示。

输入区按聊天身份保存模式，首次打开已有聊天时从最近的 Turn 初始化。刷新、重连及新聊天首次获得 Thread 身份时保留草稿选择。将草稿移到 Agents Window 时同时传递文字、附件和模式。[桌面输入状态](../../src/ash/sessions/browser/chatWidgetModel.ts) · [TUI 模式选择](../tui/LAYOUT.md#任务模式选择与显示)

以相同 `commandId` 重试时改变模式会报冲突。重试失败任务和从改写的历史输入开分支沿用原 Turn 的模式。当前 Turn 内切换由 [`switch_mode`](../../docs/tools/tools.md#当前-turn-的模式切换) 持久化新模式和指令。

## Swarm 的执行边界

Swarm 由当前 Agent 识别依赖、委托互不依赖的工作、等待并验收结果。子任务在 `spawn_agent` 成功后取得委托和 Thread 身份。依赖步骤等待前置结果，同一工作区的修改按文件或任务分工。隔离、并发上限、超时、取消和恢复由运行环境和[委托契约](../../docs/core-multi-agent.md)管理。小任务可直接完成。

[`/team` 工作流和持久 Team](../teams/README.md#产品入口与已有命令)分别管理会话内的角色分工和跨任务的成员关系。Swarm 适用于当前 Agent 直接组织的委托。主 Turn 的后台交接和 Plan 专用的并行实施入口尚未提供。后台交接需要明确的任务身份、执行所有权、在途工具与取消边界。

Swarm 与模型推理档位独立选择。桌面 Chat 的 Ultra 设置由[模型请求配置](../model-provider/README.md#ultra-与推理档位)解析。终端可通过 [`/effort`](../tui/README.md#推理档位与-swarm) 设置下一条消息的模式。

## 自定义模式候选

自定义模式尚未安排实施。用户可通过定义和 prompt 保存可复用的任务方式，桌面与 TUI 从同一后端目录读取。

- 候选 `ModeId` 保留内置 ID，自定义 ID 按来源命名。定义保存名称、说明、prompt 资产、revision 和可选运行规则。各端按 ID 管理内置名称、主题和快捷键，自定义名称来自定义。
- 后端校验身份、修订、引用和运行选项，发布版本化目录。App Server 通知客户端重新读取，校验失败的定义返回诊断。新请求引用已删除或不可用的 ID 时提示重新选择。
- 目录更新适用于后续接受的请求。Turn 和持久队列在接受时保存模式身份、定义 revision、已解析规则和完整指令，供交付、恢复与重试使用。命令重试检查原定义是否一致。
- 普通定义延用已有 Goal 和工作流规则，子任务沿用所选模式。后端可支持三项显式例外：等待用户、只分析工作流并跳过 Setup Hook、创建子任务时解析指定模式。写入限制与新增执行能力由所属领域提供。
- 实施前明确保存范围、访问和命名冲突规则、文件格式与目录协议、旧记录兼容规则，以及子任务额外指令的继承。验证覆盖发送、排队、跨模式追加、恢复、重试、分支、委托与 Goal。

## 维护与验证

修改模板时同步 [revision](src/lib.rs) 和对应行为测试。下表使用固定模型和工具验证运行契约。模型遵循率和任务质量按[行为评测方法](../prompts/docs/agent-instructions.md#benchmark-与行为评测方法)单独测量。

| 范围                                 | 验证入口                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式 ID、序列化和模板                | `just test ash-protocol`、`just test ash-agent-mode-templates`                                                                                                                                     |
| 指令预算、历史、恢复与重试           | `just test ash-core --lib`、`just test ash-history`                                                                                                                                                |
| 发送、产品命令、队列与当前 Turn 切换 | `just test ash-app-server-runtime --lib modes`、`just test ash-app-server-runtime --lib queue_`、`just test ash-app-server-runtime --lib switch_mode`                                              |
| 委托、Role 上限、工作流与 Goal       | `just test ash-agent spawn_tool_uses_frozen_intent_parent_to_launch_private_investigator`、`just test ash-workflows`、`just test ash-goal`                                                         |
| 桌面与浏览器                         | ChatViewPane、ChatInputPart、WindowActions、本地化和 Chat 输入 Playwright 场景                                                                                                                     |
| TUI 模式选择、提交、快捷键与配色     | `just test ash-tui agent_modes_tests`、`just test ash-tui submit_prompt_carries_every_agent_mode_to_the_app_server`、`just test ash-tui composer_agent_modes_color_both_rules_prompt_and_selector` |

协议变更同步运行 `just generate-protocol` 和 `pnpm run typecheck:protocol`。Rust 变更按受影响包运行 `just rust-warnings`。

## Cursor 参考记录

2026-09-30 核对 Cursor 3.22.12（`3a92974361033b2051526321308c2740fe5912c0`）。普通 Agent 也可并行委托，子任务拥有独立上下文，前台和后台任务有各自的等待方式。Multitask、Queue、Interrupt 是独立动作。Plan 可将独立步骤交给 Build in Parallel。[Cursor 子 Agent](https://cursor.com/docs/subagents) · [Multitask 支持说明](https://forum.cursor.com/t/multitask-qui-ne-fonctionne-plus/170340/5) · [多 Agent 帮助](https://cursor.com/help/ai-features/multi-agent) · [3.2 发布说明](https://cursor.com/changelog/04-24-26)
