# agent-message-board

- 提供同一 Agent 树共享的频道、话题、回复、搜索和订阅。
- 用 `board_read` 查询内容，用 `board_write` 执行受授权的写入。
- 使用 Ash SQLite 策略保存消息和操作凭据，以 Session 和根 Thread 隔离数据。
- 校验成员和调用方身份，只向活动 Turn 发送摘要通知。
- 供团队协作共享发现、阻塞和验证证据；调度与验收由各自的流程负责。

工具参数、通知和清理规则见 [Agent 扩展](../../docs/extensions.md#agent-共享讨论板)。

验证：`just check ash-agent-message-board`、`just test ash-agent-message-board`、`just rust-warnings ash-agent-message-board`。
