# `ash-tgrep`

公共 [`grep`](../grep/README.md) 的 tgrep 进程与协议适配器。有提交的 Git worktree 共用仓库服务和不可变基础索引，各 Directory 持有独立租约；普通目录、未提交的新仓库和目录子范围使用单目录服务。索引、文件监听和差异核对由包内 tgrep 负责。

## 安装与生命周期

- 固定上游源码提交 `e9d55dbbf232f0e228695f15a640cf207d4b3348`，位于正式 v1.0.11 与 v1.0.12 之间，Ash 包内版本为 `1.0.12-ash.e9d55db.1`。源码和小型接入补丁的校验值见 [`runtime-lock.json`](../../third_party/tgrep/runtime-lock.json)。正式 v1.0.12 发布后再核对差异并更新。构建时编译，查询时不下载或编译。
- 开发准备、发布构建与 Remote runtime 都包含 `ash-resources/tgrep/tgrep[.exe]`。查询不联网下载，不搜索系统 `PATH`。显式 `ASH_TGREP_PATH` 可指定开发 executable；覆盖路径无效时直接报错。
- `just test` / `scripts/cargo.py run` 对依赖本 crate 的开发目标准备锁定的 executable；普通产品从安装目录解析。
- 首次查询懒启动 `tgrep serve --shared --shared-storage <目录>`，从 Git common directory 的 `tgrep-daemon-v1.json` 读取发现信息，通过 `hello` 校验协议、能力和索引 profile。每个请求与成功响应校验服务实例和仓库身份；worktree 请求另校验 root、view 和精确 generation。
- 注册使用明确的起始提交和调用方预先分配的唯一 lease。注册中断后用同一 token 完成恢复与释放；服务重启后分配新租约。普通目录与未提交的新仓库启动 `serve --index-path <目录> --no-require-git`，按自身目录隔离存储；目录子范围也使用单目录服务。
- 单个租约释放不影响其他使用者。删除 worktree 前，App Server 通过公共 grep 等待已开始的搜索并确认释放索引租约；最后一个 Session 释放时回收子进程。State Runtime 的索引租约和临时存储随服务持有；正常宿主退出统一清理服务。
- 查询有 30 秒截止时间，初次注册允许 10 分钟完成基础索引和 worktree 核对。取消关闭连接或终止扫描子进程；服务中的已开始请求仍可能完成。服务退出、协议错误和超时显式返回错误。共享索引暂未就绪或查询期间被失效时，在原截止时间内核对后重试；不按错误文案判断是否重试。

## 查询与新鲜度

基础索引按 Git tree、索引格式和大小上限区分，由提交中的完整文件构建。每个 worktree 的新增、修改、删除和 ignore 变化只写入自己的 overlay；提交分支修改不会清空这些差异。overlay checkpoint 绑定精确基础索引和 worktree root，重启后先核对当前磁盘内容。首次注册仍需遍历和校验文件；路径提示可减少后续核对的内容读取，完整核对仍读取文件内容。基础索引和 checkpoint 由上游保留，不进行在线回收。

索引查询由服务一次完成候选筛选、按路径排序和全局匹配行上限。正向 glob 筛选遵守 ignore 规则的非隐藏文件，显式隐藏目录 scope 可查询可见子文件。Current、单文件或含未保存文档的查询仍读取当前内容；Current glob 可以主动包含被忽略文件。匹配文本保持完整。返回的 `index_stats` 统计本次查询的候选和总文件数，包含已处理的 Ash 写入；扫描没有索引统计。

Ash 文件工具写入后记录待确认的路径，下一次索引查询先向所属 worktree 发送 `refresh(changed, full)`，收到 `processed_epoch` 并确认就绪后清空待确认集合；单目录服务使用 `reload` 确认写入。Ash 不自行扫描这些文件并拼接索引结果。共享服务监听每个 worktree，并在每次完整核对结束 120 秒后再次完整核对；索引在失效和 checkpoint 发布期间关闭查询。刷新确认表示指定修改已处理，不表示整个文件系统的瞬时快照。外部修改仍受异步通知时机影响，Current 明确要求读取当前内容。遍历、存储或内容读取失败返回错误。

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

核心测试使用锁定的真实 executable，覆盖共享与单目录服务、全局上限、作用域、特殊文件名、Unicode 固定字符串和正则、即时写入、新增和删除文件、独立租约、注册中断恢复，以及进程回收。
