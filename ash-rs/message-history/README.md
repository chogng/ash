# `ash-message-history`

- 定义本机 Profile 的用户输入记录、追加、分页搜索、清理和保留策略。
- 输入记录用于再次编辑和提交；不参与 Thread 恢复、分支、模型上下文或输入分类。
- `ash-state` 实现 SQLite 存储；`MessageHistory` 提供有界、按顺序执行的后台读写，关闭时完成已接收的写入。
- 每个输入框持有独立 `MessageHistoryRecall`，按需读取旧页并丢弃过期查询；编辑器和完整草稿留在各产品。
- 每页最多 128 条、64 KiB 文本；单条大文本独占一页。默认保留最近 10,000 条、8 MiB，始终保留最新一条。
- `clear` 只清除输入记录，不修改 Thread 事件；记录 ID 在清理后继续递增。
- `read` 返回从新到旧的记录，`next_before` 是下一页的排他边界；查询使用 Unicode 小写转换后的字面子串，`%` 和 `_` 没有通配含义。

验证：`just test ash-message-history` 与 `just test ash-state message_history`。

TypeScript Chat 尚未接入，后续工作见 [Chat 输入历史接入待办](../../app-ts/docs/chat-input-history.md)。
