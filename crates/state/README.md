# `ash-state`

- 产生 Profile 数据库与索引路径；SQLite 打开参数、文件权限和迁移执行器复用 `ash-sqlite`，既有公开导出保持可用。
- Issue 浏览缓存按 GitHub 主机、仓库、账号与授权隔离。读取授权由 GitHub 领域核对；存储不选择账号、不保存 token，清理仅影响当前授权的仓库页面。
- 提供本机输入历史的 SQLite 存储，独立迁移、原子追加与裁剪、稳定游标和文字搜索。
- 提供 Thread、Git Turn Changes、Project 与 Memory 的 SQLite 存储；各领域使用独立 migration component，Session tree 仍由 Thread 的 `session_id` 聚合。
- Memories 使用 profile 下的 `memories.sqlite3`，以 v4 为基线，后续迁移按顺序执行并在同一事务中更新版本。原 `state.sqlite3` 中的 Memories 表保留在原处。
- 会话列表和单会话刷新从每个 Session 一条的记录读取；记录与 Thread 事件同事务更新，旧数据库升级时从 Thread 目录生成。
- 事件存储格式 17 为 PR 产物分配持久身份，并记录 Agent 来源的 Thread 和 Turn。移除后重新记录会分配新身份。归档格式 6 保留身份与来源，仍可导入格式 2 至 5。
- 事件存储格式 16 为 PR 关联保存产物标记。旧记录按引用读取，重复附加保留已有产物标记。历史归档格式 5 保留该标记，并可导入格式 2 至 4。
- 事件存储格式 14 增加根 Thread 的 `thread_issues`，保存规范化的 Issue 主机、仓库及编号。PR 与 Issue 分别去重，同一编号可以独立关联；标题、状态和账号凭据不入库。引用随根 Thread 删除，受历史迁移停写触发器保护。归档格式 3 包含 Issue 引用，仍可导入格式 2 的旧归档。
- 事件存储格式 13 从已校验的版本 2 Thread 目录重建版本 3 Session 缓存，加入各分支已有的管理事实；不升级 Thread 目录版本，不为显示列表重放完整历史。
- 事件存储格式 12 增加 `thread_pull_requests`，保存 Session 根 Thread 的手动 PR 引用。主机、仓库及编号规范化后去重，不保存标题、状态或账号凭据；删除根 Thread 时同事务清理引用。历史归档格式 2 包含此表，引用遵守相同的迁移停写约束。
- Thread 目录与事件同事务写入；目录记录带版本和内容哈希，读取时校验，损坏记录从事件重建。
- Turn 完成事件与待交付快照同事务写入 `thread-completions`。应用按游标分批处理，副作用持久化后确认；失败记录保留，后续记录可继续处理。快照不参与 Thread 读取，源历史重写或删除不影响待交付内容。存储层不识别 Docs 上下文或选择回复正文。
- Thread 和 Session 列表使用独立 SQLite 读连接；正常启动只索引查询缺失目录和需要恢复的 Thread。
- `thread-voice-index` 从规范事件回填语音索引，并随事件追加原子更新；只保存定位和筛选字段，正文仍读取带哈希校验的历史记录。语音分页固定提交快照，Thread 删除时级联清理索引。
- Memory 读取授权与正文在同一事务中读取；独立保存授权版本和无正文命令回执，旧数据库升级后默认关闭自动读取。
- `SqliteAssetStore` 原子保存素材不可变版本与原始媒体；按内容摘要去重字节，保留独立素材与版本身份，并提供确切版本的分块读取。迁移组件为 `assets`，与 Thread 和窗口生命周期无关。
- 管理可重建目录索引和跨进程占用锁；不解释 Core 生命周期，也不拥有 Codebase 表结构。
- 原子保存 Agent 身份、Thread 绑定、事件与目录记录；按 Agent、Session 和委托关系查询分支。
- 删除任务后保留 Agent 身份；迁移旧历史身份时不改写原事件。
- 历史所有权迁移由 `SqliteThreadStore` 保存稳定 Profile 身份、远端停写标记和本地导入回执。停写与已有写入在 SQLite 中串行提交，数据库触发器阻止已打开的连接和重启后的旧写入方继续修改历史。
- 历史归档只传固定历史表及被引用的附件，不传配置或凭据。流按帧限长 32 MiB、总量限长 8 GiB，附件沿用 16 MiB 上限；导入先在磁盘暂存并校验，再一次提交完整历史和回执。保留原始事件 JSON、Session/Thread/Agent ID、嵌套前缀和 Git change-set 数据，身份冲突整体回滚。
- Agent 父子关系和前缀保留索引必须与原事件一致；重新计算归档摘要不能使被改写的索引通过校验。
- 导入后的 SSH 执行绑定单独持久化，不改写原始事件。目录只能来自原历史或显式绑定命令；没有目录的历史可以读取，不能开始任务或恢复执行。相同归档重试返回原回执，不覆盖已继续写入的本地历史。
- 原事件按内容只存一份；Thread 与嵌套前缀引用原子提交，最后一个引用删除后回收记录并排队清理 Git pin。

## SQLite 迁移

各存储入口维护自己的迁移清单，编号 SQL 位于 `migrations/<component>/`。共用数据库的组件在 `ash_schema_migrations` 中分别记录版本，执行器在同一 SQLite 写事务内运行待执行步骤并提交版本。
领域 crate 在自己的 `migrations/` 下管理 SQL 和版本清单。同一执行器可用于独立的 `memories.sqlite3`、`connectors.sqlite3`，也可用于共用 `state.sqlite3` 的多个组件。
`event-store` 以 v17 为基线，既有建库和升级脚本在 `migrations/event-store/`，数据回填由该版本的 Rust 入口调用。自 v18 起依次追加编号 SQL。已发布的步骤保持原样。
`thread-history-index` 的旧索引从原始事件重建。旧的无版本 Issue 缓存在首次打开时登记为 v1，并保留缓存记录。

## Turn 捕获与提交记录

事件存储格式 11 将旧 ChangeSet 的整轮提交状态一次性转换为独立提交记录，保留旧事务身份与冻结消息。
`SqliteTurnChangeStore` 同时实现 `TurnChangeStore` / `TurnCommitStore`：原子保存文件选择占用、
命令回执、发布结果并推进来源记录 revision。捕获 JSON 不保存计算得到的提交进度；读取时从成功
提交的精确路径计算部分/全部提交。选择资格和状态转换由 `git-turn-changes` 校验，SQLite 不拥有这些规则。
Session 删除与来源记录、提交记录同事务；发布未完成时拒绝删除，避免丢失事务恢复依据。

## 聊天历史读取索引

`thread-history-index` 使用独立的迁移组件，按 Thread 保存当前聚合头，按 Turn 保存有序元数据，按 Item 保存不可变正文和摘要。
Core 提供更新值，SQLite 在事件追加的同一事务中写入；分页在一个读事务中核对事件尾 sequence，并只解码请求范围内的 Turn 和 Item。元数据更新只追加新 Item，保留已有正文。
缺失、过期或损坏的索引由 Core 重建，回填只接受仍与事件尾一致的完整状态。索引不加入历史迁移归档，导入后可重建；删除 Thread 时级联清理。
重连事件读取使用已有的 `(thread_id, sequence)` 索引，只读取游标后的区间，并固定首次读取的尾部，后续提交留到下一次读取。
