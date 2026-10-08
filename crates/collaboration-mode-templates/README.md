# `ash-collaboration-mode-templates`

这里集中维护 Agent、Plan、Debug、Multitask、Ask 的模式说明、prompt 和自定义模式候选设计。五种模式共用同一套执行系统，区别主要来自 prompt，以及 Goal、工作流入口和子任务模式的少量后端规则。

当前只支持五种内置模式，身份使用 `CollaborationMode` 的稳定协议 ID。自定义模式、模式目录和动态注册均尚未实现，候选设计暂不实施。

## 阅读入口

| 想看什么                                                    | 文档                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 五种模式的含义、现有行为与后端差异                          | [五种模式](collaboration-modes.md)、[Prompt 与后端规则](collaboration-modes.md#prompt-与后端规则的区别)                |
| Multitask 如何使用已有多 Agent 能力、与 Team 和工作流的关系 | [Multitask 的执行边界](collaboration-modes.md#multitask-的执行边界)                                                    |
| 切换、排队、历史、重试和子任务继承                          | [切换与排队](collaboration-modes.md#切换追加消息与排队)、[子 Agent 模式](collaboration-modes.md#子-agent-使用什么模式) |
| TUI 的快捷键、statusline、默认 Agent 隐藏和颜色             | [Ash Code 布局与模式显示](../tui/LAYOUT.md#任务模式选择与显示)                                                         |
| Cursor 参考与采用范围                                       | [参考记录](collaboration-modes.md#cursor-参考与采用范围)                                                               |
| 后续通过定义与 prompt 加载自定义模式                        | [自定义模式候选](custom-modes-candidate.md)                                                                            |

## Prompt 正文与修改

正文直接维护在 [Agent](templates/agent.md)、[Plan](templates/plan.md)、[Debug](templates/debug.md)、[Multitask](templates/multitask.md)、[Ask](templates/ask.md) 中。App Server 在新 Turn 接受时选择模板，与 Agent 的共同规则和当前 Role 一起保存；已有 Turn 沿用接受时的正文。

本 crate 拥有内置模式 prompt；身份与序列化由 `ash-protocol` 拥有，共同规则由 `ash-prompts` 拥有，Role 职责和工具上限由 `ash-agent-roles` 拥有。模式 prompt 不授予工具或权限。共同指令的组合与模型适配见 [Agent 指令组合](../docs/agent-instructions.md)。

修改正文时同步模板 revision、行为说明和所属测试；验证入口见 [修改与验证](collaboration-modes.md#修改与验证入口)。本目录的文档集中模式行为，执行系统、Team 和模型适配的完整契约通过所属文档链接读取。
