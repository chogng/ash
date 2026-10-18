# `ash-thread-store`

- 定义 `ThreadStore` 的完整读取、原子追加、sequence 冲突和 batch 校验；持久记录格式由 `ash-history` 拥有。
- Thread 事件流是对话、Turn、Item、交互、分支关系和 `session_id` 的唯一持久事实源；Session 没有独立事件流。
- 定义按 Session 读取列表记录及从 Thread 目录重建该记录的契约。每个分支的管理事实来自外层 `ThreadCatalogRecord.manager`，旧嵌套字段不能覆盖它；Session 汇总使用同一批记录。`resumable_model_providers` 随事件 batch 保存仍可执行的模型选择所引用的 provider，迁移检查据此跳过无关历史；旧目录缺少该字段时由 Core 从原事件补齐，不修改已完成调用的事实。
- 后端必须 complete-or-none 提交并保留精确顺序；恢复与 reducer 属于 `ash-core`，SQLite 实现属于 `ash-state`。
- `ThreadHistoryReader` 为同一权威历史提供 Session 目录、事件页和不可变前缀的窄只读契约，供诊断查询使用；不暴露追加能力或另建历史副本。
- 组合 Agent 关系读取契约；绑定随创建事件提交，Session 的 Thread 成员查询使用成员索引。
- 追加时同时保存不可变前缀，提供前缀读取及文件引用清理的待办与确认契约。

- 提供按本地执行目录和时间限定的近期工具输入查询，可选择会话数、每会话命令数与时间；按会话轮流取记录，合计最多 20000 条、8 MiB 输入；存储先筛选再读取，不恢复聊天正文。查询返回来源坐标，过滤后的 Guardian 事实由对应领域拥有。

- `ThreadHistoryWindow` / `ThreadHistoryPage` 定义可见 Turn 的只读分页。Core 从同一权威状态生成 `ThreadHistoryIndexUpdate`，随事件 batch 原子提交；索引只在 sequence 与事件尾一致时可读。
- 索引按 Turn 保存内容与顺序，保留当前聚合元数据和待处理交互；缺失或损坏时由 Core 从原事件重建。执行恢复仍读取原事件，缓存不拥有执行或命令状态。
