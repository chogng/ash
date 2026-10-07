# Queue

队列输入、编辑和状态类型由 [`ash-queue-contract`](../../queue-contract/src/lib.rs) 定义。协议与客户端直接依赖该契约；本 crate 使用并导出同一份类型，负责执行与持久化。

- SQLite 持久化用户消息、每个 Thread 的 FIFO 顺序、领取租约、交付结果和命令去重凭据。
- App Server 负责校验会话、规范化附件和选定执行目录；队列不直接调用模型或执行工具。
- 空闲时沿既有 Turn 启动入口交付，崩溃恢复先核对同一命令凭据，已接收的消息不会另建 Turn。
- 多进程通过事务、revision 和租约排除重复领取；断开窗口不删除消息。
- 未领取消息可取消；交付中或已开始的消息使用 Turn 中断流程。
- 每 Thread 最多 128 条待交付消息，单条最多 1 MiB；已完成凭据用于去重。
- 验证：`just test ash-queue` 和 App Server 队列集成测试。

## 编辑和生命周期

- `queue/edit` 按 revision 校验暂停、替换、移动和立即发送；编辑期间原内容持久保留为暂停状态。
- 普通发送继续按每 Thread 顺序执行；立即发送可以移至队首，或者指定当前 Turn 作为 steering 目标。已结束的目标不改为新 Turn。
- 删除 Session 时，在 Thread 停止后清除该 Session 的队列内容和去重凭据。
- 队列变化通过 `queue/changed` 通知；客户端重新读取 `queue/list`，TUI 不自行自动出队。

- `install` 注册空闲唤醒与队列展示；同名贡献替换时不保留旧 store。
- 系统职责见 [Agent 扩展](../../docs/extensions.md)。
