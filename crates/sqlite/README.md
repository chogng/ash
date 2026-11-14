# ash-sqlite

SQLite 公共基础：安全打开文件、连接参数和按组件执行的原子迁移。依赖仅包含 `rusqlite`，不依赖 Profile、会话、协议或协作业务。

调用方选择数据库路径和 `SqliteDurability`。文件数据库使用 WAL、外键和 busy timeout；持久数据使用 FULL 同步，可重建数据使用 NORMAL 同步。Unix 数据库文件权限统一为 0600。

领域保留表结构、SQL、迁移清单和业务事务。`Migrator` 在同一写事务中执行升级并记录 `ash_schema_migrations`；不同组件可共享数据库，也可使用独立文件。`legacy_baseline` 接入既有升级和数据回填，失败整体回滚。

`ash-state` 的既有 SQLite 导出复用此实现；`ash-collab` 的房间、频道资源和 `ash-call` 的通话存储也直接使用此基础，不引入会话与历史依赖。

验证：`just verify ash-sqlite --lib`。
