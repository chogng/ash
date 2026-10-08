# Text model consistency

共享文件模型由 `BrowserTextModelService` 维护文本、持久化 revision、dirty 状态和保存恢复状态。watcher 和窗口 focus 通过 `refresh()` 重查干净模型；脏模型保留本地编辑，仅在保存被持久化 owner 拒绝后进入 conflict。这与本机 VS Code 的 `TextFileEditorModelManager` 和 `TextFileEditorModel` 保存错误时序一致。

当前批次修复已经确认的并发缺口：`refresh()` 读取期间，同一模型可能完成一次不改变模型版本的保存。旧读取随后会覆盖刚确认的 revision；bootstrap 模型还可能被旧文本替换。生产修改只限 `browserTextModelService.ts` 的刷新与已有 `saveQueue` 边界，不新增共享接口、状态副本或 Preferences 逻辑。配套行为验证位于 `contrib/codeEditor/test/browser/browserTextModelService.test.ts`。

- [x] 以 dd086508 生产基线和本机字节 SHA revision 复现混合 EOL 保存的 revision 回退和 bootstrap 旧文本覆盖。
- [x] 保存加入队列后丢弃旧读取，同时保留 dirty、模型版本和销毁保护。
- [x] 验证保存 acknowledgement、备份完成失败和显式重试不受旧读取影响。
- [x] 完成 model、pane、备份 tracker 三文件 89 项单测及生产 Renderer 类型检查，修改文件格式检查通过。
- [x] 在 `e05e17e93` 基线上完成正常协议生成（v7）、严格协议与 Renderer 类型检查、automation 编译、完整 Desktop 和 connected Web 生产构建；正常命令均保留预钩子，Cargo 并发为 1。
- [x] 在本树隔离 Python、Cargo、native headers 和输出目录中完成两种正常后端 prepare；两个实际 initialize 均匹配协议 v7 与当前 schema hash，并在 stdin 关闭后正常退出。
- [x] 完成 7 项真实 headless Web 验收：手动保存、两种自动保存、未保存文件重开与保存、浏览器恢复、保存拒绝后的冲突时序，以及 BOM/CRLF 与外部重载 undo。
- [x] 完成 6 项真实 Electron 编辑器验收（独立副本只迁移 Desktop 备份存储断言），以及仓库现有 1 项共享 SQLite 后端重启恢复与保存清除用例；单 worker、单实例，独立 profile、后端和输出。
- [x] 将最小 Desktop SQLite oracle 迁移应用到仓库现有 smoke，用 automation 编译和 6 项真实 Electron 用例验证，全部通过；原始失败日志保留。
- [x] 正常本地提交并 rebase 到最新 fetched main `a139432ec`，四个功能文件逐字保留，`11f6898` 的 owner、测试和文档 blob 与上游一致。
- [x] 在合并后树重跑 154 项 model、pane、备份 tracker 和 App Server 文档身份单测，以及协议、Renderer、automation 类型检查、正常 Desktop/connected Web 构建、两种后端 prepare 与实际 initialize；仓库现有 Web 7 项、Electron 6 项及 SQLite 后端重启恢复 1 项全部通过。
- [x] main 发布前正常 rebase 到 Search/SCM 的 `5db5dfcec`，上游 72 个文件及 `11f6898` 身份改动完整保留；以 Cargo jobs=1 更新本树隔离运行时，在新 v7 schema 下重跑上述 154 单测、全部类型检查、正常生产构建、双后端 prepare/实际 initialize，以及仓库 Web 7 项、Electron 6 项和 SQLite 恢复 1 项，均通过。当前命令与远端发布核对记录位于 `history-reopen-evidence/external-conflict-dd086508/stale-save-revision/publish-main-20261008T113937Z`。

两份功能树此前分别正常 rebase 到 `721e4297e9982c8fab4e3df4c87ebfe41466efff` 并独立保全；保存清理批次仅吸收上游测试格式变化，功能 AST 核对通过。本批次随后单独更新到 `e05e17e93c26f0281357ff9aca53bea8aaf98a67`，生产和测试文件逐字保留，89 项 owner、pane、备份回归仍全部通过。本批次保持为独立功能，按父对话分配的 main 槽串行集成；首次交付未推送，后续发布状态以本机证据目录的远端核对记录为准。未改动其他树或原 checkout。早期命令、退出码和失败证据位于 `history-reopen-evidence/external-conflict-dd086508/stale-save-revision/resume-parallel-e05e17e`；当前本地候选、正常 rebase 和合并后验收记录位于 `history-reopen-evidence/external-conflict-dd086508/stale-save-revision/integrate-oracle-main-20261008T110153Z`。

Electron 原通用用例保留 5 通过、1 失败的原始记录：未保存场景在重启前仅查 IndexedDB，而 Desktop 已迁移到共享 SQLite。独立验收副本只将 Desktop 查询切换到当前 profile 的只读 `backup_contents`，重启后跟踪新 application；原有文本、dirty、落盘、实际重启和清除备份断言全部保留，6 项通过。父对话确认这项 oracle 迁移属于同一功能的必要测试修复：现在纳入仓库现有 helper 与平台分支，沿用 `windows/backup.spec.ts` 的 SQLite 只读路径、client id 和序列化读取方式；不修改生产存储 owner。可单独审阅的差异仍保存在证据目录的 `desktop-backup-oracle-migration.patch`。原始失败日志保留，未将原始未修复套件描述为全部通过。

正常 Rust 准备曾记录 `rust-objcopy` 找不到 `libLLVM.dylib` 的剥离警告；库位于已安装工具链的根 `lib` 目录。本树后续命令补齐加载目录后工具运行正常，未改动共享工具链，原警告日志保留。两个 prepare 和实际 initialize 均成功，不将此记录描述为无警告构建。

旧 JSON 产品用例的 conflict 断言顺序由 Preferences owner 修正。保存清理批次暂停并独立保全，不并入本次 revision 修复。历史设计与验收证据复用 `docs/editor-architecture.md` 及本机 `history-reopen-evidence/external-conflict-dd086508`，本批次不重新审计或改写其他 owner。
