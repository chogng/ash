# `ash-fast-regex-search`

本 crate 为 Agent `grep` 提供带索引的正则搜索。工具选择、目录授权和 watcher 生命周期由 [App Server](../app-server/README.md) 管理；编辑器搜索契约见 [search.md](../../docs/search.md)。

## 候选过滤与匹配

持久索引 v8 使用 ASCII 折叠的三字节 trigram，加上一个 8 位的后继字节 Bloom 过滤器，设计参考 [tgrep](https://github.com/microsoft/tgrep)（[许可说明](THIRD_PARTY_NOTICES.md)）。同一文件中重复的 trigram 合并后继字节标记；查询要求的标记必须全部存在，最终正则验证决定命中。Bloom 冲突与 ASCII 折叠只会增加候选。

查询按最终匹配器的全局与内联大小写规则解析正则，提取前缀、后缀、内部必需文字及 AND/OR 分支，保留 Unicode 大小写等价分支。没有必要文字的表达式扫描完整已发布集合。首行 UTF-8 BOM 不参与匹配或预览；文件中间的 U+FEFF 保留。

原有可变长度稀疏 n-gram 算法及[固定频率表](data/README.md)保留在 `benches/algorithms/`，供同语料对照。真实仓库实验显示其长文字选择性有时更好，但 gram 种类、posting 数和提取成本明显更高。该结果不代表所有 n-gram 实现或工作负载的上限。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `index.rs` | 公共句柄、状态、打开索引、overlay 与快照 |
| `index/builder.rs` | 流式遍历、文档提取、完整重建 |
| `index/sort.rs` | 有内存预算的 posting 排序、临时文件租约与归并 |
| `index/search.rs` | 候选集合、路径过滤、源文件校验与最终匹配 |
| `index/update.rs` | 已观察事件、目录核对与增量压缩 |
| `trigram.rs` / `query.rs` | gram 编码、后继过滤 / 正则必要条件规划 |
| `storage.rs` / `disk_index.rs` | 版本发布 / lookup 映射与 posting 定位读取 |
| `worker.rs` | 独立 worker 生命周期、请求协议与并发查询 |

## 构建与容量

持久构建逐文件处理内容，使用 64 MiB posting 排序区，分批落盘并最多 32 路归并；文档元数据仍随文件数增长，单文件提取仍随该文件大小增长，因此这不是总内存的硬上限。临时排序目录持有独占租约，下次构建清理已中断构建的无主目录。发布通过 [immutable-generation-store](../immutable-generation-store/README.md) 从文件流式复制与校验，不把整份 posting 重新载入堆内存。纯内存模式保留内存 posting。

v8 与旧版本不兼容，打开旧索引会扫描重建，不能复用可能被截断的旧文件集合。完整重建后 worker 重启以释放构建内存。进程先绑定私有端点，再加载并核对索引；5 秒启动期限只约束进程与端点，打开和重启仍等待实际快照响应后才返回，避免大目录核对被当作启动失败。

默认容量为 250,000 个文本文件、总源码 4 GiB、单文件 16 MiB。前两项超过上限、或目录遍历出错时明确失败，不发布部分索引。单文件超限、前 8 KiB 检出 NUL 的文件和非 UTF-8 文件不属于文本集合。目录扫描应用默认忽略和隐藏文件规则。

大量候选且结果上限较高时，最多 8 个线程并行重读与校验，按路径顺序合并；100 条 Agent 查询顺序验证并提前停止。worker 响应上限为 32 MiB；超过上限返回错误，不能将其作为完整结果计时。库内存模式、worker 完整输出、Agent 有限输出是不同测量口径。

## 更新与进程边界

搜索覆盖已发布集合及内存 overlay。`statistics.generation` 标识候选版本，不代表当前磁盘状态。调用方提交 watcher 事件；需要核对磁盘时调用 `reconcile_dir`。候选文件重读和 SHA-256 校验可发现候选变更，但无法发现未入选文件中的新文字。忽略规则变化、watcher overflow 会核对文件集合，delta 达阈值后重建 base。

worker 端点由 [ash-uds](../uds/README.md) 的私有目录对象保护。读写请求前要求同用户与同提权上下文；身份或权限错误直接失败，仅连接不存在或监听者退出时重启。查询连接阻塞接收，无定时轮询；关闭请求回复后唤醒监听并退出。非 Unicode 路径保留原始字节或 UTF-16 单元。测试通过 [test-binary-support](../test-binary-support/README.md) 运行本 crate 的 worker 入口，产品入口分派由宿主集成测试验证。

## 验证与基准

- `just check ash-fast-regex-search`、`just test ash-fast-regex-search`、`just rust-warnings ash-fast-regex-search`；宿主验证用 `just test ash-app-server --lib agent_grep`。
- `cargo bench -p ash-fast-regex-search --bench algorithms -- EVAL_ROOT CORPUS`：使用 manifest 固定的真实文本和查询，逐文件比较 sparse covering、全部 sparse、trigram 与后继 mask 候选，核对最终正则匹配的文件没有被排除。保留的 n-gram 回归用例由 `tests/legacy_ngrams.rs` 执行。
- [真实仓库评测脚本](benches/repositories/README.md)固定来源与 SHA-256，记录构建、正确性、响应限制、内存与原始计时。macOS 监测 footprint 以覆盖压缩和换出内存；仅 RSS 会漏计。
- `cargo bench -p ash-fast-regex-search --bench fast_regex_vs_rg -- --require-faster` 保留小规模回归基准；它不能代替大仓库结论。完整输出与 100 条输出分别计时，rg 读取第 101 条后终止实现全局限制。
- 新建 worker/索引不代表清空操作系统缓存；进程中断测试不等同机器断电测试。短时间采样可能漏掉瞬时峰值，必须同时披露采样间隔、失败和资源上限。
