# `ash-git-transaction`

本 crate 把已经准备好的 Git commit 条件发布到目标分支，并在进程中断后恢复同一事务。
它依赖 [`ash-git`](../git/README.md) 的类型化对象、引用和工作区接口，不知道 Session、Turn、
SQLite、工作目录归属或界面。调用方通过 `GitTransactions::new(&git)` 复用已有执行器。

| 阶段        | 保证                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| prepare     | 固定目标 HEAD/tree、最终 tree、用户 Git identity、时间和消息，生成确切 commit 对象 |
| publish     | 检查目标与 checkout，保存 journal 和对象保留引用，以 expected HEAD CAS 发布        |
| checkout    | 分别保持原 index、未暂存和未跟踪内容；安装前再次检查版本，冲突不丢弃用户修改       |
| recover     | 复用事务身份和保留对象，恢复 checkout 或报告冲突；不盲目创建第二个 commit          |
| acknowledge | 调用方持久保存成功回执后，清理事务保留引用与 journal；重放仍可安全确认             |

提交事务要求调用方持有 `repository_operation_lock`。该锁按 Git common directory 共享，
协调不同目录指向同一仓库的操作；外部 Git 由 ref CAS、真实 index lock 和 checkout tree 比较检测。
活动 checkout 使用临时 index 的受保护双树合并安装，不执行强制 reset。最终捕获之后的保存
由 Git 安装边界再次校验；并发修改不会触发旧快照的强制恢复。
不执行仓库 commit hooks，真实发布使用仓库配置的 author/committer。三方合并所需的临时对象身份
只用于计算，不能作为用户提交身份。

journal 位于 `<common directory>/ash/commit-transactions`。发布之前保留原/目标 checkout tree
和 commit；即使 Git GC，也能恢复。checkout 安装完成标记单独持久保存，后续外部提交推进分支
不会被旧事务回滚。ref 发布后安装失败时，保留已发布 commit、原/目标 tree 引用和 journal，
检测到实际层变化时立即返回 checkout 冲突，否则返回需要恢复的错误；不回滚 ref 或覆盖实际文件。
恢复会重新校验 index 与 worktree，变化时报告
冲突并继续保留证据，也能完成仅 worktree 已安装、真实 index 尚未替换的中断事务。
调用方的数据库回执和 Git journal 各有明确职责，不能提前删除恢复信息。

`commit_tree_delta` 保留给旧整轮请求的一次性存储迁移流程；新选择走
`prepare_tree_commit` → `publish_prepared_tree_commit`，确认期间目标移动必须重新预览。
未出生分支可以创建首次提交；已删除或已移动的分支、detached 目标和文件冲突返回显式结果。

验证：`just verify ash-git-transaction`。真实仓库测试覆盖 staged/unstaged/untracked 保持、
目标变化、中断恢复、首次提交和当前 Turn 继续执行时提交历史对象。
