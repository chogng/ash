# `worktree`

> 本 README 拥有已有 Git worktree 的切换目标解析和 Codex 兼容归属元数据实现契约；跨 crate 产品状态见 [`docs/git.md`](../../docs/git.md)。

1. `WorktreeManager::list/resolve` 读取同仓库 worktree 清单；`provision` 为 Thread 建立独占受管目录。Git 默认使用 detached linked worktree；显式 `NewBranch` 目标同时创建指定本地分支和 linked worktree。非 Git 使用一次性隔离目录副本，不能请求新分支。
2. `ManagedDirBinding` 固定 Thread、来源 `DirId`、Git 仓库身份、精确目标和绑定摘要；非 Git 绑定不伪装成 repository。
3. 本 crate 只负责受管目录的物化、恢复和清理；Turn 归属、工作契约、验证、提交与产品状态由上层领域拥有。
