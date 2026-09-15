# `ash-fast-regex-search`

Worker 进程测试通过仅供测试依赖的 [`test-binary-support`](../test-binary-support/README.md) 启动当前测试程序，并直接运行本 crate 的 worker 入口；无需构建产品宿主。真实产品的入口分派由各宿主集成测试验证。

Worker 端点由 [`ash-uds`](../uds/README.md) 的私有目录对象保护。服务端读取请求前、客户端发送请求前均要求同用户与同提权上下文。权限或身份错误直接失败；仅连接不存在或监听者退出时重新启动 worker。查询连接通过阻塞接收唤醒，不做定时轮询；关闭请求先回复，再通过连接唤醒监听并退出。有效 Unicode 路径使用 JSON 字符串，其他路径保留原始字节或 UTF-16 单元。退出后先释放目录句柄，再移除端点目录。

> Agent `grep` 的执行选择与配置由 [`ash-rs/app-server/README.md`](../app-server/README.md) 维护；编辑器工作区搜索的独立契约见 [`docs/search.md`](../../docs/search.md)。

1. `FastRegexSearch` 使用[固定且版本化的 ASCII 字符对频率表](data/README.md)构造可变长度 n-gram。算法参考 [Cursor 的 Fast Regex Search](https://cursor.com/blog/fast-regex-search)。查询先按最终匹配器的全局与内联大小写规则解析正则，再提取前缀、后缀、内部必需文字及 AND/OR 分支；Unicode 大小写等价分支会保留。
2. 候选索引只保存一份 ASCII 折叠数据；大小写敏感的查询也可使用它缩小范围，最终正则验证决定是否命中。哈希冲突和折叠只会增加候选。大量候选且结果上限较高时，最多 8 个线程并行重读与校验，按路径顺序合并；100 条 Agent 查询按顺序提前停止。
3. `storage.rs` 通过 [`ash-immutable-generation-store`](../immutable-generation-store/README.md)发布 documents、lookup、postings 与 delta。`disk_index.rs` 映射排序 lookup，并通过定位读取加载 posting。当前格式为 v7；旧格式重新扫描构建，不能复用可能被截断的旧文件集合。完整重建后重启 worker 释放构建内存。
4. 默认容量为 250,000 个文本文件、总源码 4 GiB、单文件 16 MiB。前两项超过上限时明确失败，不发布部分索引；目录遍历错误同样返回失败。单文件超限、前 8 KiB 检出 NUL 的二进制文件和非 UTF-8 文件不属于当前文本集合；忽略规则和隐藏文件规则按默认目录扫描处理。
5. 搜索覆盖已发布文件集合及内存 overlay。`statistics.generation` 表明候选来自哪个版本，不能代表最新磁盘状态；调用方负责提交 watcher 事件，需要核对磁盘时调用 `reconcile_dir`。候选重读可检测候选变更，但不能发现未入选文件中的新文字。Agent 空结果明确提示异步更新边界。
6. 本 crate 服务 Agent `grep`；目录授权、工具注册和 watcher 生命周期由 App Server 负责。worker 只返回有上限的结果。忽略规则变化和 watcher overflow 会核对文件集合，delta 达到压缩阈值时重建 base。

## 验证与基准

- 运行 `just check ash-fast-regex-search`、`just test ash-fast-regex-search`、`just rust-warnings ash-fast-regex-search`，并运行 `just test ash-app-server --lib agent_grep`。
- `cargo bench -p ash-fast-regex-search --bench fast_regex_vs_rg -- --require-faster` 分别测完整结果和最多 100 条结果，交替执行两方，报告 p50/p95。rg 的全局结果限制通过读取第 101 条后终止进程实现；`rg -m` 是每文件上限，不能替代。
- 基准逐条核对路径、行号和文本，并包含内部文字、前后缀、分支、无匹配和短模式。稀有案例同时验证完整性；100 条模式允许不同遍历顺序，但每条必须属于完整结果集。
- 冷启动指标指新建 worker/索引，不代表清空操作系统缓存。RSS 是阶段快照；重建磁盘峰值为估计值，均不代表构建期间的实际内存峰值。进程 abort 测试不等同机器断电测试。
