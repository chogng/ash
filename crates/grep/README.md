# `ash-grep`

跨能力依赖、宿主组装与实现状态统一见[搜索架构](../../docs/search.md#目标依赖关系)。

- 提供已授权目录内的公共内容搜索能力；Agent、Codebase 和编辑器消费同一份结构化 API。
- `Search` 定义查询与结果契约；`Service` 选择引擎，并按 `DirId` 复用一个索引会话。
- 内部适配包内 tgrep 与冻结的 rg；调用方不依赖引擎参数、进程、TCP 或索引格式。
- `Jobs` 提供绑定调用者的分页与取消，持有不可变目录授权；授权撤销后停止查询并拒绝读取。
- 分页仅在查询结束且当前页已读完全部结果时标记完成，并返回实际新鲜度模式和可选的索引查询统计。
- `Query` 表达文字/正则、大小写、相对 scope、include/exclude、结果上限和新鲜度；不转发命令行参数。
- `Freshness::Indexed` 允许异步索引，包含同步通知的 Ash 写入；`Current` 直接读取磁盘。索引 `ready` 表示覆盖完整，不保证最新。
- tgrep 的 Indexed 目录 glob 筛选遵守 ignore 规则的非隐藏文件；Current glob 可以主动包含被忽略文件。单文件 scope 直接读取。
- `index_stats` 提供本次索引查询的计划、候选文件数和总文件数，包含已确认处理的写入；扫描时为空。分页保留同一份统计。
- 未保存文档需要当前磁盘与编辑器内容的合并视图；文档列表为空时仍按请求的新鲜度执行。
- 结果按路径、行号排序；每行保留完整文本与 UTF-8 byte ranges。UTF-16 高亮、模型文本格式和各自结果预算由调用方转换。
- 每次最多 5,000 个匹配行；引擎执行有 30 秒期限和输出容量限制。错误和取消显式返回，不自动切换引擎。
- `configure` 更新同一服务，所有使用者共同生效；切换前等待已有搜索结束，再释放索引进程和租约。
- `release_directory` 等待已开始的搜索并确认释放目录租约，App Server 在 worktree 删除前调用。其他 worktree 的服务和租约继续有效。
- State Runtime 按仓库身份持有 `Grep` 目录，worktree 共享基础索引并保留独立差异缓存；配置位于 `[grep].backend`，默认 `tgrep`。

```sh
just test ash-grep
just test ash-tgrep
just test ash-app-server --lib grep
```
