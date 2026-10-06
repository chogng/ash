# Agent、Plan、Debug、Multitask、Ask 五种模式

五种模式共用同一套 Agent 执行系统，主要通过不同的 prompt 指导模型处理任务，并由少量后端规则处理 Goal 续接、工作流入口和子任务模式。当前仍使用固定的 `CollaborationMode` 枚举，尚未提供自定义模式或动态注册。

模式决定 Agent **这次怎么做任务**。共同能力所需的提示词和工作规则由 `prompts` 提供，Agent 的职责由 Role 决定。三者独立：同一个 Agent 可以先用 Plan 分析，再用 Agent 实现，也可以用 Debug 查问题。

本文统一维护五种模式的含义、执行边界和产品行为，包括 Multitask、切换、界面显示和外部参考。模板正文以 [templates](templates) 为准；自定义模式的候选设计见 [自定义模式候选](custom-modes-candidate.md)，共同指令的组合与模型适配见 [Agent 指令组合](../docs/agent-instructions.md)，Role 选择见 [Agent 定义](../../docs/agents.md)。

## 五种模式怎么用

| 模式      | 做事方式                                           | 交付什么                                   | 项目修改要求                         |
| --------- | -------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Agent     | 正常推进任务；需要时使用工具或委托                 | 完成的工作及必要说明                       | 按用户授权修改、验证                 |
| Plan      | 先看现状、明确问题、拆步骤和依赖                   | 可以直接执行的计划，标明独立工作和验收条件 | 只分析，等待用户要求执行             |
| Debug     | 取得故障证据，验证假设，定位原因，再修复           | 根因、修复及验证结果                       | 可以修复；临时调试内容需清理         |
| Multitask | 判断哪些工作互不依赖，并行委托，处理依赖，汇总验收 | 已整合的完整任务结果                       | 按授权修改；协调者负责避免冲突和整合 |
| Ask       | 查看必要材料，解释和回答问题                       | 有依据的答案、解释或建议                   | 不修改项目                           |

Agent 是默认的正常执行方式，不等于“只能编码”。它也能调查、解释、调用工具和使用子 Agent。Multitask 更强调拆分、委托和整合；它并不独占多 Agent 能力。

Plan 和 Ask 的不修改要求属于模式的行为约束，写在当前模式模板中。工具授权仍由 Role、目录授权和动作策略执行；当前模式字段本身不建立另一套文件沙箱或授予权限。模型是否遵守行为要求，需与工具执行层实际放行分别验证。

## Prompt 与后端规则的区别

模型调用、工具执行、委托、取消、队列、历史和恢复共用已有系统。Debug 没有独立的调试执行器；Multitask 也没有另一套并行引擎。模型根据当前 prompt 决定调查步骤、是否委托以及如何组织结果，真正的操作通过已有工具和执行系统完成。

| 模式      | Prompt 主要要求                            | 当前后端规则                                                                                     |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Agent     | 按授权完成任务，必要时使用工具或委托       | 可以参与已有 Goal 的自动续接，按产品契约启动工作流；子任务为 Agent                               |
| Plan      | 调查现状、拆步骤与依赖，交付计划并等待用户 | 不注入 Goal 持续执行指令、不自动续接；工作流请求交给模型分析，不触发 Setup Hook；子任务保留 Plan |
| Debug     | 建立复现、区分证据与假设，定位后修复和验证 | 与 Agent 共用执行流程；子任务保留 Debug 的调查要求                                               |
| Multitask | 找出独立工作，委托、等待、检查依赖并整合   | 与 Agent 共用执行与多 Agent 工具；子任务默认转为 Agent                                           |
| Ask       | 查必要材料、解释和回答，不修改项目         | 与 Plan 一样不自动续接、不直接启动执行型工作流、不触发 Setup Hook；子任务保留 Ask                |

上述 Goal 续接仅适用于已经存在且仍活动的 Goal，切换模式不会创建 Goal。Plan 与 Ask 的代码规则减少直接启动修改流程的机会；它们的“不修改项目”要求仍主要来自 prompt，不能据此声称所有写入工具都被模式字段禁止。

代码依据见 [工作流和 Setup 入口](../app-server/src/server/operations.rs)、[Goal 指令选择](../ext/goal/src/lib.rs)、[Goal 续接](../ext/goal/src/runtime.rs)和[子任务模式选择](../protocol/src/collaboration_mode.rs)。新增普通任务风格可以复用这些运行能力；动态加载的候选方式见 [自定义模式候选](custom-modes-candidate.md)。

## 共同规则、模式、Role 和运行系统

| 内容     | 负责什么                                            | 维护位置                                                         |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 共同规则 | 每个 Agent 都具备的工作规则、工具使用要求、授权要求 | `ash-rs/prompts`                                                 |
| 模式模板 | 当前任务采用的处理方式                              | `ash-rs/collaboration-mode-templates`                            |
| 模式字段 | 明确记录本次选择，序列化、恢复和重试                | `ash-rs/protocol` 的 `CollaborationMode`                         |
| Role     | 当前 Agent 的职责、模型选择及能力上限               | `ash-rs/agent-roles` 与 AgentConfiguration                       |
| 执行系统 | 创建任务、派发、消息、等待、结果、取消和恢复        | Core 与所属扩展；App Server 提供产品入口                         |
| 界面     | 选择模式、提交消息、显示正在使用的模式和排队状态    | 各端的 Chat 输入与草稿状态；桌面端 ChatWidgetModel，TUI Composer |

模式模板不复制共同规则，不冒充 Role，也不声称工具已经执行。模式选择与 Agent 选择互不替换；已选择自定义 Agent 时，仍可以切换五种模式。

## 一次 Turn 如何保存模式

1. 客户端通过 `session/request.startTurn.mode` 提交模式；省略时为 `agent`。
2. App Server 选择 Agent 的基础指令、产品命令指令和模型指导，再加入所选模式。
3. Core 把类型明确的 `mode` 和完整指令内容一起写入接受记录。公开的 `Turn.mode` 返回模式，界面不再根据提示词 ID 猜测。
4. `TurnInstructions.modeInstructions` 独立保存模式资产的 owner、id、revision 和正文。共同规则、产品指令和模型指导各保留自己的来源。
5. 每次模型调用使用当前 Turn 保存的模式正文；压缩、恢复和重试沿用该记录。模式指令作为必需内容参与上下文预算。

模式正文明确说明“当前 Turn 的模式生效”，防止历史里出现过的 Plan 或 Multitask 继续决定后续任务。更改模板需同步 revision、测试和本文；已有 Turn 不重新读取修改后的正文。

同一 `commandId` 的重试若改变模式，会返回冲突。更新模板或更改提示词 ID 不会改变已经接受的模式。界面的“重试失败任务”使用失败 Turn 的原模式，而不是输入区后来选中的模式。改写历史输入后启动的分支也保留被改写 Turn 的模式。

## 切换、追加消息与排队

| 情况                             | 当前行为                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| 没有运行中的 Turn                | 下一条消息启动所选模式的新 Turn                                 |
| 运行中，消息模式与当前 Turn 相同 | 消息通过 Steer 追加给当前 Turn；沿用已保存的模式                |
| 运行中，选择了另一种模式         | 下一条消息写入持久队列，当前 Turn 继续；空闲后启动新模式的 Turn |
| 运行中，消息带有新选择的 Skill   | 写入队列，在新 Turn 中解析和激活 Skill                          |
| 仅点击模式菜单，没有发送         | 改变输入区下一次提交的选择；不会改写正在运行的 Turn             |
| 用户主动中断                     | 使用现有 Turn 中断及后代取消规则                                |

队列接受时保存模式、明确选择的模型、推理等级、输入和批准方式。省略工具模式时，后端保存接受时的配置值；重试沿用这次保存的值。模型为空表示自动选择，交付时由当前 Agent/配置决定，不表示已经固定某个模型。

排队消息通过普通 Turn 入口交付，沿用产品命令和指令选择。队列通知只触发重新读取。输入区显示排队数量；正在使用的模式与下一条消息的模式不同时，会说明下一条消息将排队。

输入区的模式选择按聊天身份保存。首次打开已有聊天时用最近 Turn 的模式初始化；后续刷新、重连或其他入口产生新 Turn，不改写输入区的选择。新聊天首次取得 Thread 身份时保留选择。将草稿移到 Agents Window 时，文字、附件和模式一起传递。

TUI 的 `/mode`、Shift+Tab、两种屏幕模式的标签与配色统一见 [Ash Code LAYOUT](../../code/LAYOUT.md#任务模式选择与显示)。

## 产品命令与模式

`/init` 等命令保留当前模式：例如 Ask 下的 `/init` 用于解释初始化要求，Plan 下用于分析初始化步骤。Setup 指令与所选模式一起组合；Plan、Ask 不触发 Setup Hook。目录上下文在直接发送、排队接受、编辑和交付中使用相同处理，避免重复请求冲突。

`/team` 和 `/develop` 是已有工作流入口。Agent、Debug、Multitask 可以按现有契约启动工作流；Plan、Ask 把请求交给普通分析 Turn，避免命令解析直接启动会产出修改的工作流。模式和工作流是两种不同选择。

独立的审查、Advisor 和压缩入口保持各自契约：审查使用 Agent，Advisor 使用 Ask；压缩不执行用户任务。

## 子 Agent 使用什么模式

子 Agent 的 Role 和能力上限依旧按委托契约解析。当前模式另外按下表保存：

| 父 Turn 模式 | 子任务默认模式 | 原因                                 |
| ------------ | -------------- | ------------------------------------ |
| Agent        | Agent          | 正常执行被委托的工作                 |
| Plan         | Plan           | 委托调查仍须保留只分析的要求         |
| Debug        | Debug          | 子调查保留证据、假设和验证要求       |
| Multitask    | Agent          | 父任务协调；执行者专注自己的具体任务 |
| Ask          | Ask            | 委托查询仍须保留不修改项目的要求     |

子任务重新组合自己的模式资产，替换父任务的模式正文。父协调者的 Multitask 正文不会作为子执行者的有效指令保留。子任务有自己的职责和工具上限，模式不能扩大这些上限。

已有 Goal 在 Agent、Debug、Multitask 完成后可以自动续接，后续 Turn 保留前一 Turn 的模式。Plan 和 Ask 不加入 Goal 的持续执行指令，答完后等待用户，不自动续接；恢复会话也遵守这个要求，已有 Goal 的状态不会因此自动改变。用户仍可查询 Goal 状态。

## Multitask 的执行边界

Multitask 模板指导模型确定独立工作、分配范围、等结果、检查依赖和整合交付。切换到 Multitask 不会自动创建子任务；模型实际调用委托工具后，运行系统才记录子任务。小任务仍可直接完成。真正运行任务的是已有的多 Agent 系统：

- `spawn_agent` 返回委托和子 Thread 身份，子任务独立执行。
- 消息、等待和结果消费使用已记录的委托身份；任务没有结果时不能假装完成。
- 父任务中断按现有规则取消后代；失败、超时、恢复和并发上限由运行系统管理。
- 独立任务可以并行，有依赖的任务先等前置结果。同一文件的写入需要明确分工。
- 普通共享目录不会自动变成隔离工作树；是否使用隔离执行取决于实际环境能力和任务启动契约。

**当前已接入：**模式模板、每 Turn 的模式保存、委托时的模式规则、持久消息队列和输入区状态。**尚未提供：**把已经运行的主 Turn 原地转移到另一个后台任务的操作，以及 Plan 的专用 “Build in Parallel” 按钮。模式菜单不表示这两项操作已经发生。

这些操作若加入产品，必须由后端提供明确的任务身份、执行所有权交接、在途工具处理和取消边界；不能只注入“开始后台执行”的提示词就向界面报告交接成功。

Multitask 模式与持久 Team、临时工作流分别选择。模式本身不会创建 Team 或成员；已有 Team 可以顺序或并行执行任务，普通 Agent 也可以委托。Team 的身份和成员规则见 [Agent Team](../docs/agent-teams.md)，委托、等待、取消和恢复的完整运行契约见 [Agent 委托与运行树](../../docs/core-multi-agent.md)。

当前 `/team <任务>`、`/team status|resume|cancel` 管理一次临时协作工作。将这个临时工作流入口更名为 `multitask` 是 Team 设计中的命名候选，尚未实现；它与已经可选的 Multitask 模式是不同的产品入口。历史 `/team` 记录继续使用原 Session 与委托事实，不推断或补造持久 Team 成员身份。

## Multitask、Ultra 与 Ultracode

Ash 中统一选择 Multitask，由 Ash Core 管理委托、消息、取消和结果整合；推理档位独立选择。GPT 与 Claude 都使用这套执行系统。同一次任务只有 Ash 负责协调，不同时启动另一套产品的协作工作流。

| 名称             | 原产品的含义                                                     | Ash 当前的处理                                                                |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ash Multitask    | 强调拆分、委托与整合的任务模式                                   | 以 `multitask` 模式提交 Turn，使用 Ash 多 Agent 工具                          |
| GPT Ultra        | Codex / ChatGPT Work 的多 Agent 预设，结合较高推理投入与主动委派 | `/effort ultra [on\|off]` 作为 Ash Multitask 的入口；保留用户已选推理档位     |
| Claude Ultracode | Claude Code 的协作设置，可在所选 effort 下动态组织工作流         | `/effort ultracode [on\|off]` 作为 Ash Multitask 的入口；保留用户已选推理档位 |

`/effort multitask [on|off]` 是 Ash 的明确入口，`ultra` / `ultracode` 仅为命令别名，提交和恢复仍使用同一个 `multitask` 模式 ID。开启不强制改为 `max` 或 `xhigh`；关闭将 Multitask 改回 Agent，其他模式不变。选择只影响下一次提交，已接受 Turn 的执行模式保持原样。终端交互见 [命令与补全](../../code/README.md#命令与补全)。

模型目录只发布型号支持的推理档位。导入 Codex 目录中的 `ultra` 时，不将其列为 effort；如果目录默认值为 `ultra`，也不据此设置推理默认值或开启 Multitask。Ash 当前尚未接入 OpenAI 托管多 Agent，也不通过 Claude Code 执行 Ultracode；这些命令别名不表示两种外部工作流已经接通。

依据：[OpenAI Max 与 Ultra](https://learn.chatgpt.com/docs/models#know-when-to-use-max-or-ultra)、[Claude Code effort 与 Ultracode](https://code.claude.com/docs/en/model-config#adjust-effort-level)、[Claude Code Ultracode 工作流](https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode)。产品行为核对于 2026-10-03；上述名称描述相近的协作意图，执行系统和默认推理策略各自不同。

## Cursor 参考与采用范围

复核日期：2026-09-30。本机 Cursor 为 3.22.12，提交 `3a92974361033b2051526321308c2740fe5912c0`。公开资料与可读客户端代码可以确认界面和调用边界，不能据此声称取得了服务端完整提示词。

| 公开可确认的行为                                | Ash 采用的设计                     |
| ----------------------------------------------- | ---------------------------------- |
| 普通 Agent 也能委托并行子任务                   | 多 Agent 能力独立于 Multitask 模式 |
| 子任务有独立上下文，前台/后台执行有不同等待行为 | 模式正文与任务运行生命周期分开     |
| 新版 Multitask、Queue、Interrupt 是不同操作     | 切换模式不等同于中断或后台交接     |
| Plan 可将独立步骤交给 Build in Parallel         | 计划明确工作依赖；专用入口尚未提供 |

来源：[Cursor 子 Agent](https://cursor.com/docs/subagents)、[官方 Multitask 支持说明](https://forum.cursor.com/t/multitask-qui-ne-fonctionne-plus/170340/5)、[多 Agent 帮助](https://cursor.com/help/ai-features/multi-agent)、[3.2 发布说明](https://cursor.com/changelog/04-24-26)。这些来源不证明 Ash 已实现 Cursor 的全部工作流，也不证明并行一定更快或更便宜。

## 修改与验证入口

修改模式含义时同时检查模板 revision、协议、普通发送、特殊命令、队列、子任务、Goal、恢复、重试和界面选择；本文是统一行为说明，crate README 只维护入口链接。

实现入口见 [模式身份](../protocol/src/collaboration_mode.rs)、[指令记录](../protocol/src/turn/instructions.rs)、[Core 上下文组合](../core/src/thread_controller/context.rs)、[App Server](../app-server/src/server/operations.rs)、[持久队列](../app-server/src/server/queue_operations.rs)、[Agent 委托工具](../ext/agent/src/tool.rs)、[工作流](../ext/workflows/src/lib.rs)和[桌面端输入状态](../../app-ts/src/ash/sessions/browser/chatWidgetModel.ts)。

协议 capability version 为 11，新历史 schema 为 22。旧记录未携带模式时读取为 Agent；接受事件与命令省略默认 Agent 的序列化字段，保留旧记录的摘要表示。生成协议类型由 `just generate-protocol` 维护。

本地验证采用固定模型和工具 fixture，覆盖请求、持久记录、模型输入和界面行为，不代表真实模型的模式遵循率或任务质量评测。

| 验证入口                                                                                                                            | 必须检查的行为                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `just test ash-protocol`、`just test ash-collaboration-mode-templates`                                                              | 五种模式序列化；替换模式时共同规则和模型指导保持完整                      |
| `just test ash-core --lib`、`just test ash-history`                                                                                 | 模型输入、重新加载、命令重试和旧分支记录的摘要兼容                        |
| `just test ash-app-server --lib modes`                                                                                              | 普通请求、`/init`、Plan/Ask 下的工作流分析，以及排队模式恢复              |
| `just test ash-app-server --lib queue_`                                                                                             | 队列恢复和交付；跨模式 Steer 被拒绝                                       |
| `just test ash-agent spawn_tool_uses_frozen_intent_parent_to_launch_private_investigator`、`just test ash-workflows`                | 实际委托的模式资产、Role 上限、工作流恢复和推理等级                       |
| `just test ash-goal`                                                                                                                | 执行模式按原模式续接；Plan/Ask 不收到持续执行指令、不自动续接             |
| ChatViewPane、ChatInputPart、WindowActions 与本地化测试；Browser/Electron 的 Chat 输入 Playwright 场景                              | 模式与 Agent 独立选择、排队、重试、草稿传递、菜单勾选和键盘操作           |
| `just test ash-tui collaboration_modes_tests`、`just test ash-tui submit_prompt_carries_every_collaboration_mode_to_the_app_server` | 稳定 ID、四种语言、模式选择与快捷键、权限和推理独立选择、跨模式排队与请求 |
| `just test ash-tui composer_collaboration_modes_color_both_rules_prompt_and_selector`                                               | fullscreen 模式标签、默认 Agent 隐藏、颜色与鼠标命中                      |

协议变更还需运行 `just generate-protocol` 和 `pnpm --dir app-ts run typecheck:protocol`；Rust 变更需对受影响包运行 `just rust-warnings`。完整前端类型检查与相关测试编译应同时执行；若被其他文件的既有错误阻断，记录错误，并用相同配置完成受影响文件的编译和验证。
