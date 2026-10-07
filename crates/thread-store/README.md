# `ash-thread-store`

- 定义 `ThreadStore` 的完整读取、原子追加、sequence 冲突和 batch 校验；持久记录格式由 `ash-history` 拥有。
- Thread 事件流是对话、Turn、Item、交互、分支关系和 `session_id` 的唯一持久事实源；Session 没有独立事件流。
- 定义按 Session 读取列表记录及从 Thread 目录重建该记录的契约。
- 后端必须 complete-or-none 提交并保留精确顺序；恢复与 reducer 属于 `ash-core`，SQLite 实现属于 `ash-state`。
- 组合 Agent 关系读取契约；绑定随创建事件提交，Session 的 Thread 成员查询使用成员索引。
- 追加时同时保存不可变前缀，提供前缀读取及文件引用清理的待办与确认契约。

- 提供按本地执行目录和时间限定的近期工具输入查询，可选择会话数、每会话命令数与时间；按会话轮流取记录，合计最多 20000 条、8 MiB 输入；存储先筛选再读取，不恢复聊天正文。查询返回来源坐标，过滤后的 Guardian 事实由对应领域拥有。
