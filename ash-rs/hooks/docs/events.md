# Hook 事件

Hooks 浏览页始终展示 33 种事件。显示名称使用 `PreToolUse` 等标识，TOML 与进程输入使用
`preToolUse` 等 camelCase 值；两者来自 [事件定义](../../protocol/src/hook.rs)。

表中描述 Ash 的触发点。事件存在不代表兼容 Claude 的全部 matcher、输出字段或控制能力；
当前动作只支持 process，严格输出契约见 [运行时](runtime.md)。

| 事件 / TOML 值 | 触发时机 |
| --- | --- |
| `PreToolUse` / `preToolUse` | 工具执行前 |
| `PostToolUse` / `postToolUse` | 工具执行成功后 |
| `PostToolUseFailure` / `postToolUseFailure` | 工具执行失败后 |
| `PostToolBatch` / `postToolBatch` | 一批工具调用结束后 |
| `PermissionDenied` / `permissionDenied` | 工具权限被拒绝后 |
| `Notification` / `notification` | 用户通知送达客户端时 |
| `UserPromptSubmit` / `userPromptSubmit` | 用户提交提示词时 |
| `UserPromptExpansion` / `userPromptExpansion` | 斜杠命令展开时 |
| `SessionStart` / `sessionStart` | 会话开始时 |
| `Stop` / `stop` | 当前接到轮次完成调用，完成事实已经提交 |
| `StopFailure` / `stopFailure` | 轮次因错误结束时 |
| `SubagentStart` / `subagentStart` | 子代理启动时 |
| `SubagentStop` / `subagentStop` | 子代理产生终止结果后、交付结果前 |
| `PreCompact` / `preCompact` | 上下文压缩前 |
| `PostCompact` / `postCompact` | 上下文压缩后 |
| `PreModelSwitch` / `preModelSwitch` | 请求切换模型前 |
| `PostModelSwitch` / `postModelSwitch` | 会话模型变化后 |
| `SessionEnd` / `sessionEnd` | 会话结束时 |
| `PermissionRequest` / `permissionRequest` | 权限请求展示前 |
| `Setup` / `setup` | 项目初始化设置开始时 |
| `TeammateIdle` / `teammateIdle` | 队友完成分配工作时 |
| `TaskCreated` / `taskCreated` | 计划步骤创建时 |
| `TaskCompleted` / `taskCompleted` | 计划步骤完成时 |
| `Elicitation` / `elicitation` | MCP 请求用户输入前 |
| `ElicitationResult` / `elicitationResult` | 用户回应 MCP 请求后 |
| `ConfigChange` / `configChange` | 会话期间配置变化时 |
| `InstructionsLoaded` / `instructionsLoaded` | 指令文件读取时 |
| `WorktreeCreate` / `worktreeCreate` | 工作树创建前 |
| `WorktreeRemove` / `worktreeRemove` | 工作树移除前 |
| `CwdChanged` / `cwdChanged` | 活动目录变化后 |
| `FileChanged` / `fileChanged` | 受监视文件变化时 |
| `DirectoryAdded` / `directoryAdded` | 会话添加目录后 |
| `MessageDisplay` / `messageDisplay` | 助手文本推送给客户端时 |

## Matcher 与拒绝

`preToolUse`、`postToolUse`、`postToolUseFailure`、`permissionDenied` 和 `permissionRequest`
允许设置非空 `matcher.toolNames`，使用精确工具名称；其余事件要求工具列表为空。
工具成功和失败分开匹配，不能用成功事件观察失败工具。

`preToolUse` 的拒绝会成为模型可见的工具失败。压缩前、模型切换前、权限请求前、工作树操作前和
MCP 输入请求前由各自调用方读取拒绝决定。已经发生的事件只用于观察，`deny` 不能撤销完成的
文件变化、消息投递或轮次事实；`Stop` 当前也不支持通过拒绝让模型继续工作。

## 旧事件

历史配置中的 `beforeTool`、`afterTool`、`turnCompleted` 继续读取和执行：

| 旧值 | 保留的行为 |
| --- | --- |
| `beforeTool` | 工具执行前，允许工具匹配 |
| `afterTool` | 工具执行后，成功与失败都匹配，允许工具匹配 |
| `turnCompleted` | 轮次完成后，不允许工具匹配 |

浏览页仅在这些旧值有配置时追加对应行，不把它们计入 33 种新事件。编辑其他字段不会替换
旧事件值；是否迁移由用户根据所需触发语义决定。
