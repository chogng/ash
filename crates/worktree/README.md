# `worktree`

> 本 README 拥有已有 Git worktree 的切换目标解析和 Codex 兼容归属元数据实现契约；跨 crate 产品状态见 [`docs/git.md`](../../docs/git.md)。

1. `WorktreeManager::list/resolve` 读取同仓库 worktree 清单；`provision` 为 Thread 建立独占受管目录。Git 默认使用 detached linked worktree；显式 `NewBranch` 目标同时创建指定本地分支和 linked worktree。非 Git 使用一次性隔离目录副本，不能请求新分支。
2. `ManagedDirBinding` 固定 Thread、来源 `DirId`、Git 仓库身份、精确目标和绑定摘要；非 Git 绑定不伪装成 repository。
3. 本 crate 只负责受管目录的物化、恢复和清理；Turn 归属、工作契约、验证、提交与产品状态由上层领域拥有。

非 Git 副本在同一受管根下的临时目录中逐块复制并计算绑定摘要，完整复制与绑定写入成功后才发布。
复制或绑定失败会移除临时目录，重试不会恢复半成品；受管根解析符号链接后必须位于来源目录之外，
否则在创建复制目录前返回错误。

## 与 Turn 文件变化的边界

每个执行 Thread 绑定独立工作目录，提供编辑隔离；单独的提交锁不能代替该隔离。
本 crate 物化、恢复和删除目录，`git-turn-changes` 保存修改归属、不可变文件变化和精确提交进度，
App Server 装配清理资格。部分提交仍有剩余文件，不等于整个 Thread 可以清理；历史读取使用保留的
Git 对象库，独立于 checkout 生命周期。能力划分见 [方案](../../docs/git-capabilities.md)。

非 Git 副本没有可恢复正文的 ChangeSet，App Server 不按保留数量自动删除它们。
归档会话保留副本；显式确认舍弃受管目录或工作流终态仍可由调用方提供清理资格。

## 消息检查点与历史恢复

非 Git 消息检查点保存目录内容、空目录、符号链接和文件权限，按内容摘要去重。
恢复使用独立保留的快照并核对摘要，即使原 Thread 副本已删除，也可物化新的受管目录。
该快照缓存目前保留去重内容，尚未接入历史删除后的自动回收。

同一 Thread 的 Undo/Redo 保持目录根的身份。`DirectoryRestoration` 先准备目标和备份，
App Server 写入恢复意图后才安装文件；Core 提交历史游标后确认文件事务。
提交前失败会回滚，进程中断由 App Server 核对历史回执和文件内容后恢复。
发现中断后的额外修改会保留文件和恢复意图，并阻止该 Thread 接收新请求或移动历史。
App Server 和其他对话继续可用；可以读取文件或从保留的检查点恢复新 Thread。

## 工作流目录

`prepare_directory` 在调用方提供的绝对根路径下创建或复用一个直接子目录，
新建目录保持为空，让调用方先完成项目初始化。`adopt_directory` 随后保存同一套
Thread 归属和服务绑定，不再复制工作区。绑定记录版本 7 的 `prepared_root` 保存
实际根路径，恢复和删除重复检查目录包含关系、相对路径和归属；旧记录继续升级和恢复。
工作流终态由 App Server 确认已停止 Turn 后提供 `WorkflowTerminal` 清理资格。
`remove_prepared_directory` 负责尚未绑定的初始化失败目录及启动时终态目录清理，
在脚本执行后再次拒绝符号链接和越界目录。
