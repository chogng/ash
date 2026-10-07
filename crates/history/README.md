# `ash-history`

- 定义持久化 `ThreadEvent` 的稳定 envelope、event identity、时间戳、schema version 与 command receipt；不负责 I/O、事务或恢复。
- Thread event stream 是对话事实源；`session_id` 保存在 Thread 根事件中，用于聚合会话树，不存在独立 Session envelope。
- Store 校验与追加属于 `ash-thread-store`，SQLite 映射属于 `ash-state`，reducer 与恢复属于 `ash-core`。
- 定义带摘要校验的不可变原事件前缀；嵌套引用保持原 Thread、sequence 与 event identity。

当前写入 schema 18：用户文本输入的时间参照保存在 envelope 的可选 `timeContext` 中；模型请求的当前时间快照进入调用记录。旧版本保持可读，缺失参照不会补成现在。语义和恢复规则见 [Agent 时间与等待](../docs/agent-wait.md)。
