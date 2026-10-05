# `ash-tgrep`

公共 [`grep`](../grep/README.md) 的 tgrep 进程与协议适配器。同一仓库的 worktree 共用服务和不可变基础索引，各 Directory 持有独立查询注册；索引、文件监听和差异核对由包内 tgrep 负责。

## 安装与生命周期

- 版本固定为 1.0.12-ash.1；上游源码固定在 `ad8fffa01de96c8b3ce2505a306f8a255c1f4bfb`，共享服务补丁和源码校验值见 [`runtime-lock.json`](../../third_party/tgrep/runtime-lock.json)。构建时编译，查询时不下载或编译。
- 开发准备、发布构建与 Remote runtime 都包含 `ash-resources/tgrep/tgrep[.exe]`。查询不联网下载，不搜索系统 `PATH`。显式 `ASH_TGREP_PATH` 可指定开发 executable；覆盖路径无效时直接报错。
- `just test` / `scripts/cargo.py run` 对依赖本 crate 的开发目标准备锁定的 executable；普通产品从安装目录解析。
- 首次查询懒启动 `tgrep shared-serve`，通过版本化 capability 注册 worktree。仓库身份使用 canonical Git common directory；普通目录使用自身身份。最后一个 Session 释放时回收子进程，单个 worktree 释放不会影响其他注册。State Runtime 的仓库索引租约和临时存储随服务持有；正常宿主退出统一清理服务。
- 查询有 30 秒截止时间，初次注册允许 10 分钟完成基础索引和 worktree 核对。取消关闭连接或终止扫描子进程；服务中的已开始请求仍可能完成。服务退出、协议错误和超时显式返回错误。

## 查询与新鲜度

基础索引按 Git tree、索引格式和大小上限区分，由提交中的完整文件构建。每个 worktree 的新增、修改、删除和 ignore 变化只写入自己的 overlay；提交分支修改不会清空这些差异。overlay checkpoint 绑定精确基础索引和 worktree root，重启后先核对当前磁盘内容。首次注册仍需遍历和校验文件；后续核对仅重读版本变化或显式通知的文件，不把文件时间当作不支持可靠版本信息的平台的新鲜度证明。

索引查询由服务一次完成候选筛选、按路径排序和全局匹配行上限。正向 glob 筛选遵守 ignore 规则的非隐藏文件，显式隐藏目录 scope 可查询可见子文件。Current、单文件或含未保存文档的查询仍读取当前内容；Current glob 可以主动包含被忽略文件。匹配文本保持完整。返回的 `index_stats` 统计本次查询的候选和总文件数，包含已处理的 Ash 写入；扫描没有索引统计。

Ash 文件工具写入后记录待确认的路径，下一次索引查询先向所属 worktree 发送 `refresh`，成功后清空待确认集合。Ash 不再自行扫描这些文件并拼接索引结果。tgrep 独立监听每个 worktree；通知或 120 秒核对期限到达后，在下次请求前核对变化。外部修改仍受异步通知时机影响，Current 明确要求读取当前内容。遍历或核对失败返回错误，不把部分索引报告为就绪。

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
