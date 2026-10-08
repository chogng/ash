# workflows

- 执行 `/team`、`/develop` 命令，保存工作、阶段、候选版本和用户接受记录。
- 冻结阶段输入与专用角色，通过 Core 启动和取消同一 Agent 树中的成员。
- 按稳定命令身份恢复未完成提交，保留旧候选及下游失效原因。
- 持久状态使用 profile 数据库；临时会话使用内存，删除 Session 时清理。
- 讨论使用 `agent-message-board`；模型执行、权限和 Thread 日志由 Core 负责。
- `parallel` domain aggregate 保存并发开发运行的任务范围、依赖、Worker attempt、快照引用、review/check 历史和接受记录；Store 提供 revision CAS 与命令回执。
- App Server 的目录绑定读取持久化 intent，以冻结的 Git tree 创建子工作树；缺少 intent 的并发委派会被拒绝。`/team develop` 在专用运行流程接通前返回错误；Worker 调度、真实 check runner 和 SCM landing 仍未接入。

命令与当前边界见 [Develop](../../../docs/develop.md#当前可执行命令)；角色定义见 [Agents](../../../docs/agents.md)。

验证：`just check ash-workflows`、`just test ash-workflows`、`just rust-warnings ash-workflows`。
