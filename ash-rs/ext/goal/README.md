# goal

- 提供 Goal 工具和每次模型调用的目标提示。
- 决定后续 Turn 的接纳与恢复，复用 Core 的原子命令和预算状态。
- 不执行模型、不复制 Thread 状态；审核 Turn 不自动续跑。
- Goal 工具的创建和状态更新由 Agent 发起，不构成用户授权。客户端 Goal 修改另有持久事件，供动作审查按来源判断。

系统职责、接口和配置见 [Agent 扩展](../../docs/extensions.md)。
