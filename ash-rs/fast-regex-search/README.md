# `ash-fast-regex-search`

Worker 进程测试通过仅供测试依赖的 [`test-binary-support`](../test-binary-support/README.md) 启动当前测试程序，并直接运行本 crate 的 worker 入口；无需构建产品宿主。真实产品的入口分派由各宿主集成测试验证。

Worker 端点由 [`ash-uds`](../uds/README.md) 的私有目录对象保护。服务端读取请求前、客户端发送请求前均要求同用户与同提权上下文。权限或身份错误直接失败；仅连接不存在或监听者退出时重新启动 worker。退出后先释放目录句柄，再移除端点目录。

> Agent `grep` 的执行选择与配置由 [`ash-rs/app-server/README.md`](../app-server/README.md) 维护；编辑器工作区搜索的独立契约见 [`docs/search.md`](../../docs/search.md)。

1. `FastRegexSearch` 使用[固定且版本化的 ASCII 字符对频率表](data/README.md)，以稀有边界构造稀疏 n-gram；查询从正则前缀、后缀和分支提取必需文字，生成覆盖 n-gram 并交叉 posting list，随后重读候选文件执行完整正则验证。哈希冲突只会增加候选，不能直接产生命中；算法对应 [Cursor 的 Fast Regex Search](https://cursor.com/blog/fast-regex-search)。
2. `storage.rs` 通过 [`ash-immutable-generation-store`](../immutable-generation-store/README.md) 以旧快照校验和内容摘要发布 documents、lookup、postings 与 delta；`disk_index.rs` 是唯一 mmap 边界，映射排序 lookup，同时用 positioned read 并发读取 posting。`worker.rs` 让产品 App Server 通过私有 UDS 把建索引、mmap 和完整查询放进一个按目录常驻的子进程，只把有上限的最终结果传回主进程；完整重建后会重启子进程。忽略规则变化和 watcher overflow 先重新核对文件集合，仅在 delta 需要压缩或无法可靠增量时重建 base。
3. 本 crate 只服务 Agent `grep`，不实现编辑器 Search、路径模糊匹配、模型 Tool 注册或代码召回。不足 3 字节或无法提取必需文字的正则会精确扫描所有索引文件；基准先验证 100 条 Agent 结果上限与 `rg --line-number` 一致，再要求稀有、无命中及全量候选用例都快于 `rg`，并报告冷/热启动、lookup 大小、父子进程 RSS 与 p50/p95。修改后运行 `just test ash-fast-regex-search` 和 `cargo bench -p ash-fast-regex-search --bench fast_regex_vs_rg -- --require-faster`，并验证 `ash-app-server` 的 Agent grep 测试；子进程 abort 只能证明进程崩溃恢复，不能替代机器断电测试。
