# `ash-tool-executor`

- 根据上层审批结果决定命令是否可以进入执行服务。
- 将调用方、Thread、Environment 身份绑定为不可混用的进程访问凭据。
- 委托 `exec-server::execution::ProcessExecutor` 管理进程、输出、取消、超时和沙箱资源。
- 不保存进程表、输出缓存或第二份运行状态；不决定 Core policy，也不自动重跑。

Tool ownership 见 [`docs/tools.md`](../../docs/tools.md)，进程实现见
[`exec-server`](../exec-server/README.md)，隔离契约见
[`docs/sandboxing.md`](../../docs/sandboxing.md)。

## 公共契约

| Symbol | 职责 |
| --- | --- |
| `ApprovalPolicy` | 对 exact program/argv digest 给出 start gate |
| `CommandExecutionAuthority` | 显式区分 sandboxed 与 unrestricted execution |
| `ExecutionLimits` | 固定 wall-clock timeout 与 stdout/stderr 总 byte budget |
| `CommandInput` | 显式选择关闭 stdin 或写入调用方已经限制的 bytes |
| `CommandExecutor::execute` | 检查审批后委托执行服务 |
| `CommandExecutionOutcome` | completed output 或 structured sandbox denial |
| `ExecutionError` | start 前拒绝、spawn failure、取消、timeout 或 sandbox setup failure |
| `CommandSessionOptions` | 分别指定进程运行期限、初次输出等待期限与终端选项 |
| `CommandExecutor::wait_session` | 订阅已有进程的完成状态；中间输出不结束等待，观察取消不调用进程终止 |

等待接口、命令期限与模型 Token 边界见 [Agent 时间与等待](../docs/agent-wait.md)。普通命令仍使用
`ExecutionLimits::timeout`；命令会话的显式运行期限上限为 12 小时，等待不能延长该期限。

真实顺序不可交换：

```text
cancellation checkpoint
→ ApprovalPolicy
→ cancellation checkpoint
→ SandboxManager::prepare
→ cancellation checkpoint
→ spawn prepared command
→ dedicated stdin writer + stdout/stderr readers
→ poll child + cancellation + timeout
→ join stdin/stdout/stderr workers
→ bounded merge
→ SandboxBackend::classify_denial
```

只有 backend 返回的 `PreparedCommand` 会被启动。requested command 不会绕过 backend 直接 spawn。
`Sandboxed` authority 若无法建立 backend boundary，必须失败关闭；调用方不能静默改成
`Unrestricted`。

## stdin、取消、timeout 与输出

`CommandInput::Closed` 把子进程 stdin 接到 null device；`CommandInput::Bytes` 在独立线程写入调用方
提供的完整 bytes，并在写入完成后关闭 pipe。调用方拥有 input budget，本 crate 不截断 stdin。独立
writer 保证不读取 stdin 的 child 不会阻止 cancellation/timeout 监督；终止路径会 kill/wait child
并 join writer 和两个 reader。

spawn 前观察到 cancellation 返回 `CancelledBeforeStart`。spawn 后 cancellation 或 timeout 会
先 kill/wait child，再 join I/O threads；前者返回 `CancelledAfterStart`，后者返回
`TimedOut`。上层必须把两者视为已经跨过 side-effect boundary，不能自动 replay。

stdout 与 stderr reader 各自最多读取总 budget，最终合并时 stdout 优先、stderr 使用剩余空间。
`CommandOutput::{stdout_truncated,stderr_truncated}` 明确指出原 stream 是否超过保留范围。budget 是
byte 数；截断跨 UTF-8 code point 时使用 lossy decoding，调用方不能把 retained string 当作完整
输出。

## 实现归属

进程创建、capture、会话表和资源清理由 `exec-server/src/execution.rs` 与 `session.rs` 拥有。
本 crate 只保留审批及工具身份适配。上述输入、输出和取消语义由执行服务实施。

```bash
just test ash-tool-executor
just rust-warnings ash-tool-executor
bazel test //ash-rs/tool-executor:tool-executor-unit-tests
```
