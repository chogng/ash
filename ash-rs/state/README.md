# `ash-state`

- 产生 Profile 数据库与索引路径，并统一 SQLite 打开参数、文件权限和迁移。
- 提供本机输入历史的 SQLite 存储，独立迁移、原子追加与裁剪、稳定游标和文字搜索。
- 提供 Thread、Git Turn Changes、Project 与 Memory 的 SQLite 存储；各领域使用独立 migration component，Session tree 仍由 Thread 的 `session_id` 聚合。
- Thread 目录与事件同事务写入；目录记录带版本和内容哈希，读取时校验，损坏记录从事件重建。
- Thread 列表使用独立 SQLite 读连接；正常启动只索引查询缺失目录和需要恢复的 Thread。
- Memory 读取授权与正文在同一事务中读取；独立保存授权版本和无正文命令回执，旧数据库升级后默认关闭自动读取。
- 管理可重建目录索引和跨进程占用锁；不解释 Core 生命周期，也不拥有 Codebase 表结构。
- 原子保存 Agent 身份、Thread 绑定、事件与目录记录；按 Agent、Session 和委托关系查询分支。
- 删除任务后保留 Agent 身份；迁移旧历史身份时不改写原事件。
- 原事件按内容只存一份；Thread 与嵌套前缀引用原子提交，最后一个引用删除后回收记录并排队清理 Git pin。
