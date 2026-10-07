# history-notes

- 提供当前 Thread 的历史列举、分页读取和搜索工具。
- 在 SQLite 中保存任务笔记，按 Session/Thread 隔离并检查写入 revision。
- 通过当前调用的真实身份访问数据；不读取其他任务或任意文件。

系统职责、接口和配置见 [Agent 扩展](../../docs/extensions.md)。
