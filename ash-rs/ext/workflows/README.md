# workflows

- 执行 `/team`、`/develop` 命令，保存工作、阶段、候选版本和用户接受记录。
- 冻结阶段输入与专用角色，通过 Core 启动和取消同一 Agent 树中的成员。
- 按稳定命令身份恢复未完成提交，保留旧候选及下游失效原因。
- 持久状态使用 profile 数据库；临时会话使用内存，删除 Session 时清理。
- 讨论使用 `agent-message-board`；模型执行、权限和 Thread 日志由 Core 负责。

命令与当前边界见 [Develop](../../../docs/develop.md#当前可执行命令)；角色定义见 [Agents](../../../docs/agents.md)。

验证：`just check ash-workflows`、`just test ash-workflows`、`just rust-warnings ash-workflows`。
