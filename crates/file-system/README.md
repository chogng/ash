# `ash-file-system`

- `FileSystem` 定义读取、元数据、列举、创建、写入、条件写入、重命名和删除。
- `LocalFileSystem` 必须持有显式 Grant 或 Authorization；每个入口按完整绑定和对应动作检查授权。
- 读取使用 `ReadFiles`，元数据和列举使用 `BrowseFiles`，所有修改使用 `WriteFiles`。
- 操作通过环境驱动保留的目录句柄执行；路径检查之后的替换不能把操作导向新根或目录外。
- 版本条件检查和替换在同一物理目录的写锁内完成；外部程序的写入不受该进程内锁约束。
- 创建文件会创建缺失的父目录；已有目标仍严格遵守 Error、Ignore 或 Overwrite 的显式选择。
- `TextDocumentEditor` 定义任务文档读取、版本绑定修改、未保存搜索快照和引用释放；编辑器和磁盘实现共用工具算法。`FileTextDocuments` 在授权目录内保存字节版本和 BOM，提交前检查所有源版本；成功返回代表文件已保存。
- `TextFileFormat` 统一 Agent 补丁、字符串替换和完整文本写入的换行及文件末尾约定；新文件读取授权目录内的 EditorConfig，已有文件沿用原内容格式。
- `commit_file_mutations` 由已完成目录授权的 host 调用；批次先校验所有源版本并准备临时文件，再使用相同目录写锁提交。新建和移动目标必须不存在，移动沿用源文件权限。发布中途失败时记录已完成路径，不承诺多文件事务。
- `MissingOrEmpty` 写入在发布时确认目标仍缺失或为空：缺失目标以不可覆盖的硬链接发布，空文件仅在没有其他硬链接时通过已打开的文件追加，不用重命名覆盖编辑器新保存的内容。
- 撤销等待已获准操作完成；返回后，旧授权不能开始新的操作。

- `LocalFileSystem::write_file_elevated` 仍持有 `WriteFiles` 授权，OS 权限错误与 Ash 授权拒绝分别返回；仅显式产品请求可以调用，不自动绕过授权。
- 一次性 helper 通过系统授权启动当前可执行文件，随机 capability 认证的 loopback socket 传输原始字节，最多 50 MiB；凭据保存在自动清理的私有临时文件中，命令参数仅传路径。根目录身份、相对路径、目标身份和字节 revision 都在 helper 中校验，拒绝 symlink 目标；缺少 revision 只允许创建。
- 提权写入复用父目录中的原子 staging；Unix 在写入字节前限制 staging 权限，并保留 owner/group/mode（新建文件为发起用户所有，mode 0600），Windows `ReplaceFileW` 保留目标 ACL，并用拒绝删除的祖先目录句柄固定其路径。未提交的断线或取消由 Drop 清理 staging；最终提交持有原目录写锁并重新检查 revision，提交后等待实际结果，丢失回执返回 `WriteOutcomeUnknown`。
- macOS 使用带有 Ash 提示的系统管理员授权，Linux 优先使用 pkexec（禁用终端内部代理），缺失时回退到 kdesudo，Windows 使用 UAC。拒绝授权、能力不可用、超时和授权程序失败分别返回稳定错误；启动失败诊断以有界内容写入 App Server 日志，私有凭据路径被遮蔽。不采集密码，不重放未知结果的写入。
- 显式普通覆盖使用 `UnlockAndReplace`：仍要求 `WriteFiles` 和原字节 revision，在目录锁内仅增加 owner-write 位（Windows 清除只读属性），成功后保留可写权限；写入失败通过原文件句柄恢复权限。它不触发系统授权，且拒绝符号链接和多硬链接目标，避免改变授权目录外别名的权限。
