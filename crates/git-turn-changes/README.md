# `git-turn-changes`

本 crate 保存 Agent 每轮修改的来源，并让同一 Session / Thread 从一轮或多轮选择部分文件提交。
它依赖 [`ash-git`](../git/README.md) 的对象能力和
[`ash-git-transaction`](../git-transaction/README.md) 的发布事务；目录物化、绑定与清理由
[`worktree`](../worktree/README.md) 拥有。产品流程见
[Turn 变更账本](../../docs/chat-session-inspector.md) 和 [能力方案](../../docs/git-capabilities.md)。

| 实现                          | 所有权                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `ledger.rs`、`watcher.rs`     | 按 Session / Thread / Turn / repository 捕获、封存和保留 tree/blob；工具写入生命周期与文件刷新 |
| `summary.rs`                  | 对比 Thread 起点与当前有效检查点；净变更、跨仓库文件身份与版本戳                               |
| `model.rs`                    | 不可变变化证据、捕获与消息状态、revision；提交进度是读取时计算的结果                           |
| `commit.rs`                   | 文件选择、归属与版本校验、按捕获顺序重放、固定预览、提交记录和发布恢复                         |
| `store.rs`、`TurnCommitStore` | 完整记录 CAS、原子选择占用、命令回执与发布回执的存储契约                                       |

`TurnChangeSet` 仍然有用：它记录这一轮到底改了什么。提交不会改写 before/after、路径、blob、mode
或归属证据。`TurnCommitRecord` 单独保存实际选择、目标、固定消息、准备对象、执行状态和结果。
同一 ChangeSet 可以部分提交；`committed_paths` 从成功记录计算，剩余文件可以继续选择。

会话汇总读取 Thread 历史游标选出的 tree，不累计各轮统计。撤销/重做使用恢复点的精确 tree；继续对话后使用新路径的最新捕获。运行中的 after tree 也被内部引用保留，摘要和文件内容使用同一版本戳；历史移动后的旧文件请求会被拒绝。每轮封存证据继续保留供历史审阅和提交使用。

只有归属完整的 sealed 变化可以提交；运行中、不完整、已丢弃、未知、重复、已提交或正在发布的
文件变化不能排队。跨 Session / Thread / 仓库组合被拒绝。工具读范围和 baseline 依赖是审阅提示，
不强制整轮提交；真正能否应用由选中 delta 的三方重放决定。文本合并成功不保证业务依赖正确。

准备时固定目标 HEAD 和最终 commit 对象，保留于 Git 内部引用。确认只发布该对象；目标移动要求
重新预览，不会将当前磁盘或新的消息塞进旧请求。发布先保存请求，Git 成功后原子记账，最后确认
事务日志；数据库写入失败留下 Publishing，重启恢复同一事务。ref 已发布后的 checkout/index
失败持久保存为 `Recovering { paths, error }`，对外继续显示 Committing，并继续占用选中的文件、
阻止 Session 删除。后续调用和启动恢复只读取同一 journal，不重新准备或发布 ref；缺少 journal
或外部编辑仍阻塞时保留待恢复状态。仅提交前冲突进入终态 Conflict。

旧版本误存为 Conflict 的记录在启动时也检查 journal：存在时恢复并转为 Recovering/Committed，
不存在时维持原冲突且不重新发布。新增状态只影响内部提交记录 JSON，不改变客户端协议；旧 JSON
继续可读，`Recovering.error` 可缺省。旧版程序不识别 `recovering` 状态时会拒绝解析提交记录；
仍有此类待恢复记录的 profile 不能降级给旧版读取，不会把未知状态当作可重新发布的请求。

封存快照保留 common directory 位置，读取不依赖 Thread checkout 存在。目录搬迁更新对象库位置，
不改变封存证据。非 Git Thread 不创建 ChangeSet。本次不提供行/块级 Turn 选择或跨仓库原子提交。
内部快照引用目前随历史保留；Session 删除尚未自动回收这些引用，见方案的空间保留限制。

验证：`just verify git-turn-changes`；真实 Git 与 SQLite 组合流程在
`ash-state/src/sqlite/git_turn_commits_tests.rs`，协议流程在 App Server 的本地 RPC 测试。
