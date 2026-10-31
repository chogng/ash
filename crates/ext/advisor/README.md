# Advisor

- 提供 `advisor` 工具，向当前 Turn 已选定的模型咨询。
- 只返回建议，不提供工具，不执行动作，不递归调用顾问。
- 从 `agent-roles` 读取[顾问角色](../../agent-roles/assets/advisor.md)，本 crate 负责咨询执行。
- 校验问题并限制每个 Turn 的调用次数。
- 委托 Core 固定上下文、处理附件、取消调用并记录用量。
- 通过既有工具执行记录恢复；已开始但结果未知的调用不自动重发。

## 调用与模型选择

`advisor` 工具只接收 `question`。执行模型无需传入模型标识或重新复述整段对话；后端使用当前 Turn 已冻结的 `AdvisorConfig.model`。模型身份是 `ModelRef { provider, model }`，其中 `model` 为模型 ID，显示名称只用于界面。修改全局选择不影响已接受的 Turn。

工具描述提示执行模型在复杂任务规划、重要决策、策略调整、反复且原因不明的失败或尚未消除的完成风险中寻求战略指导。当指导能改善结果时按需调用，是否调用由执行模型判断。建议以 ToolResult 返回给执行模型，由它核实建议并继续完成原任务。

工具参数与描述以 [工具定义](src/lib.rs) 为准；配置和显式咨询协议见 [App Server API](../../../docs/app-server-api.md#advisor)。

## 上下文范围

顾问拿到的是当前 Thread 在请求组装时的有效上下文快照，加上本次 `question`，包括：

- 用户消息、助手回复，以及已完成的工具调用和对应结果。
- 当前 Turn 的任务约束。
- 顾问角色指令和本次具体咨询问题。

Core 剔除本次咨询及其他尚未完成的工具调用，保留已完成调用与结果的配对。历史中的附件经同一附件处理链路处理。已有压缩摘要会与未覆盖的历史一起使用，工具结果仍遵循通用长度限制，因此不会逐字重发所有历史原文。

通用上下文处理后仍超出顾问模型窗口时返回错误，要求先压缩对话或选择更大窗口的模型；咨询本身不自动改写主对话的压缩记录。上下文组装、取消和用量记录由 [Core ToolModel](../../core/src/tool_model.rs) 负责。

## 前端与配置归属

桌面端的 [Advisor contribution](../../../src/ash/workbench/contrib/advisor/browser/advisor.contribution.ts) 注册设置模型和“配置顾问”命令，提供专属模型选择交互。Preferences 通过公共设置注册契约统一渲染；配置继续经 Chat 服务写入后端的 `[agent.advisor]`，页面不维护另一份持久状态。

桌面设置选择器从统一模型目录读取推荐用于 `advisor` 且未隐藏的模型，推荐字段的归属与默认行为见 [模型目录规范](../../model-provider-info/docs/model-template.md)。推荐或显示状态变化不会替换已保存的选择。

桌面设置中，选择模型即启用，选择 Off 关闭并保留模型及预算，不再提供重复的启用开关。设置页、快捷选择、Code 和 Cowork 命令共用 [配置切换规则](../../../src/ash/workbench/services/chat/common/advisor.ts)：切换模型保留调用和输出预算，推理档位按目标模型的支持情况处理。TUI 的配置交互见 App Server API 中的客户端说明。

## 限制与验证

默认每个 Turn 最多咨询 3 次，每次最多输出 2048 token。可配置范围分别为 1–16 次和 256–32768 token。每次咨询有独立的模型费用。

验证：`just verify ash-advisor --profile ci-test`。已有测试覆盖冻结配置、工作模型收到建议后继续执行、次数限制、关闭时隐藏工具、上下文超限、供应商失败和取消调用。
