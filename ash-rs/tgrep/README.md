# `ash-tgrep`

公共 [`grep`](../grep/README.md) 的 tgrep 进程与协议适配器。grep 按 Directory 持有一个 `Session`；索引、压缩和文件监听由包内 tgrep 负责。

## 安装与生命周期

- 版本固定为 1.0.11，平台 archive 与 SHA-256 见 [`runtime-lock.json`](../../third_party/tgrep/runtime-lock.json)。grep 按适配器版本选择索引子目录。
- 开发准备、发布构建与 Remote runtime 都包含 `ash-resources/tgrep/tgrep[.exe]`。查询不联网下载，不搜索系统 `PATH`。显式 `ASH_TGREP_PATH` 可指定开发 executable；覆盖路径无效时直接报错。
- `just test` / `scripts/cargo.py run` 对依赖本 crate 的开发目标准备锁定的 executable；普通产品从安装目录解析。
- 首次查询懒启动 `tgrep serve`；初始化期间查询可扫描。State Runtime 保存的索引使用独立版本目录；没有持久化存储时使用临时目录。释放 Session 会终止并回收子进程；正常宿主进程退出时也统一清理仍被后台引用持有的服务。强制终止或 abort 不执行正常退出钩子。
- 请求有 30 秒截止时间；取消立即关闭查询连接或终止扫描子进程。上游服务没有逐查询取消接口，断开连接后已开始的索引查询仍可能完成。服务退出、协议错误和超时显式返回错误。

## 查询与新鲜度

索引查询先取匹配文件，再分批获取内容，以实现按路径顺序的调用者指定的全局行数上限。正向 glob 直接筛选索引候选，不再强制扫描。显式 Current、单文件或初始索引未就绪时调用同一 executable 的 `--no-index`。Indexed 目录查询的 glob 只筛选遵守 ignore 规则的非隐藏文件，初始化扫描和即时写入也保持这一约定；Current 的正向 glob 可以主动包含被忽略的文件，显式单文件仍直接读取。匹配文本保持完整，由调用方决定展示长度。忽略大小写直接通过查询参数传递；上游同时处理 Unicode 和正则内联、局部大小写标志。

索引结果携带 `index_stats`：查询计划、过滤前后的候选文件数和索引总文件数。统计只取第一次文件筛选请求，不累加分批内容查询，也不计入 Ash 写入覆盖；扫描结果没有索引统计。文件筛选显式限制每文件一个匹配，避免为了统计遍历同一文件的全部命中。查询计划是诊断文字，不作为稳定语法解析。

Ash 文件工具写入后同步标记路径，后续查询直接读取这些文件并替换对应索引结果；手动重建后清空标记。隐藏路径、ignore 规则、请求 scope 与禁止路径仍受检查。显式指定隐藏目录为 scope 时可搜索其可见子文件，扫描、索引与即时写入保持一致。Shell 和外部编辑通过 tgrep 自己的异步 watcher 更新，状态中的 `ready` 只表示覆盖完整，不代表所有最新文件变化已经处理；漏掉的通知依赖上游周期性核对。

旧 `fastRegex` 配置由 Config 迁移为 `tgrep`。旧 FRS 索引不读取；关闭并删除由 App Server 经 State Runtime 租约删除公共 grep 索引目录。

## 验证

```sh
just test ash-tgrep
just test ash-app-server --lib grep
just test ash-app-server --lib grep_rpc
just test ash-install-context
just test-python build scripts
pnpm run test:build
```

核心测试使用锁定的真实 executable，覆盖全局上限、作用域、特殊文件名、Unicode、即时写入、新增和删除文件，以及进程回收。
