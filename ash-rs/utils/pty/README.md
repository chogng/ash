# `ash-utils-pty`

> 本 README 解释 PTY/pipe process adapter、channel lifecycle 与跨平台 kill-tree 语义。
> Source provenance 与第三方许可见 [`NOTICE`](NOTICE)。

`ash-utils-pty` 为 Ash 提供统一的 interactive PTY、non-interactive pipe 与 externally-driven
process handle。它拥有 process spawn plumbing、stdin/output/exit channels、resize、interrupt 和
process-tree cleanup。Windows 子进程在运行前必须加入 Job；失败直接返回错误。

它不拥有 Tool authorization、sandbox policy、command allow-list、timeout、output persistence 或
Agent execution lifecycle。

## 来源边界

PTY integration 基于 `NOTICE` 中固定的 OpenAI Codex revision 并在 Ash 内适配，Apache-2.0。
`src/win/` 的 ConPTY 部分来自 WezTerm，MIT license 位于
`third_party/wezterm/LICENSE`。这是 source reuse，不是 Codex wire protocol/runtime dependency。

同步上游实现时必须保留 provenance，并按 Ash 当前 public contract、process-group tests 和 Windows
tests 审查行为；不能用“来自上游”替代本地 correctness review。

## 公共契约

### Spawn 与统一结果

| Symbol | 职责 | 当前语义 |
| --- | --- | --- |
| `spawn_pty_process` | interactive PTY spawn | stdout/stderr 是 terminal 合并流；支持 resize |
| `spawn_pipe_process` | stdin/stdout/stderr pipes | stdout 与 stderr 分离 |
| `spawn_pipe_process_no_stdin` | stdin 立即关闭的 pipe spawn | 适合不接收输入的 child |
| `SpawnedProcess` | `session + stdout_rx + stderr_rx + exit_rx` | 三种 spawn path 的统一 result |
| `ProcessHandle` | input、state、resize、signal、terminate | Drop 终止进程并取消 I/O，child waiter 继续回收进程 |
| `ProcessSignal::Interrupt` | cooperative interrupt request | Unix 发 SIGINT；unsupported backend 返回 error |
| `TerminalSize` | rows/cols | 默认 24 × 80 |
| `combine_output_receivers` | split mpsc → one broadcast stream | 不保证 stdout/stderr total order |

`spawn_*` 参数包括 program、args、cwd、完整 env map、optional arg0 与 Unix inherited FDs；PTY 额外
接收 `TerminalSize`。Spawn 前 `env_clear`，因此 child 只看到 caller 显式提供的 environment。
Unix PTY 要求 Tokio runtime 启用 I/O driver；缺少 driver 时在创建子进程前返回错误。

### 外部驱动适配器

| Symbol | 职责 | Implementation obligation |
| --- | --- | --- |
| `ProcessDriver` | 接入已有 stdin/output/exit backend | output sender 必须在 final bytes 后关闭 |
| `spawn_from_driver` | 转成 standard `SpawnedProcess` | exit signal 后继续 drain 到 broadcast close |
| `ProcessHandle::resize` | local PTY 或 driver resizer | pipe/no-resizer 返回 error |
| `ProcessHandle::writer_sender` | clone raw-byte stdin sender | handle closed 后返回 disconnected sender |
| `ProcessHandle::close_stdin` | drop owned stdin sender | 已 clone sender 仍可保持 channel alive |
| `ProcessHandle::request_terminate` | kill child、保留 I/O tasks 以 drain EOF | killer 只消费一次 |
| `ProcessHandle::terminate` | kill child 并取消 reader/writer；child waiter 继续回收，driver waiter 取消 | 不保证剩余 output drain；真实子进程仍报告 exit |
| `ProcessHandle::{has_exited,exit_code}` | non-blocking observed exit state | `exit_rx` 是 authoritative completion notification |
| `ProcessHandle::release_pty_handles_after_exit` | authoritative exit 后释放 parent-held PTY/ConPTY handles | 运行中调用是 no-op；允许 reader 在 final bytes 后观察 EOF |

`ExecCommandSession` 与 `SpawnedPty` 是 backward-compatible type aliases。新增代码应优先使用
`ProcessHandle` 与 `SpawnedProcess` 的真实名称。

`DEFAULT_OUTPUT_BYTES_CAP` 当前是 public 1 MiB constant，但 crate 内没有读取或 enforce 它。Output
channels 以 chunk 数 bounded；总 captured bytes、truncation 与 persistence 必须由 consumer 实施。
不要把这个常量写成现有 hard limit。

## 内部接口地图

| Symbol | 可见性 | 当前职责 | 方向约束 |
| --- | --- | --- | --- |
| `ChildTerminator` | crate-private trait | backend-specific interrupt/hard kill | 与 helper-task abortion 分离 |
| `PipeChildTerminator` | private | Unix process group 或 Windows job/process kill | pipe backend 不泄漏 OS handle |
| `PtyChildTerminator` / `RawPidTerminator` | private | PTY child/process-group control | interactive descendants 必须一起 cleanup |
| `ProcessHandle::new` | crate-private | 组装 writer、killer、tasks、exit state、PTY handles | 所有 spawn paths 共享 lifecycle |
| `PtyMasterHandle` | crate-private | portable resizable 或 raw-FD PTY master | raw handle 必须存活到 session drop |
| `read_output_stream` | private async fn | 8 KiB pipe reads → bounded mpsc | stdout/stderr reader 独立 drain |
| `spawn_process_with_stdin_mode` | private async fn | pipe command + containment + channel/tasks | public pipe variants 的唯一 spawn path |
| `spawn_process_portable` | private async fn | portable-pty/ConPTY path | 无 inherited FDs 的常规 PTY |
| `spawn_process_preserving_fds` | private async fn, Unix | raw openpty + setsid + controlling TTY | inherited FD contract 不走 portable path |
| `unix_io::PtyIo` | crate-private, Unix | 非阻塞 master FD、异步读写与背压 | 两条 Unix PTY 路径共用；取消不等待 slave 关闭 |
| `WaitTask` | crate-private enum | 区分 child 回收与 driver exit 转发 | child waiter 即使仍在排队也必须执行；driver 转发随 handle 取消 |
| `close_inherited_fds_except` | crate-private, Unix | exec 前关闭非 stdio/non-preserved non-CLOEXEC FDs | 保留 stdio、explicit FDs 与 exec-error pipe |
| `exit_code_from_status` | crate-private | exit code；Unix signal → `128 + signal`；unknown `-1` | 所有 wait paths使用一致编码 |
| `ClosureTerminator` | private | driver closure → hard-kill adapter | driver signal 当前 unsupported |
| `WindowsTtyInputNormalizer` | Windows-only public | LF→CR、CRLF collapse、backspace→DEL | state 跨 write chunk 保留 |
| process-group helpers | public module | detach、pdeathsig、SIGINT/SIGTERM/SIGKILL group operations | non-Unix 多数为 no-op |

## Pipe spawn 调用图

```text
spawn_pipe_process / spawn_pipe_process_no_stdin
└─ spawn_process_with_stdin_mode
   ├─ validate non-empty program
   ├─ Command::new + cwd + env_clear + args
   ├─ Unix pre_exec
   │  ├─ detach_from_tty
   │  ├─ set_parent_death_signal [Linux]
   │  └─ close_inherited_fds_except
   ├─ Windows: create Job → suspended spawn → assign → resume
   ├─ Unix: spawn child
   ├─ stdin writer task
   ├─ stdout/stderr read_output_stream tasks
   ├─ wait task → exit code/state/oneshot
   └─ ProcessHandle::new(PipeChildTerminator, tasks...)
```

Unix pipe child 进入独立 session/process group；terminate/interrupt 作用于 group。Linux
`set_parent_death_signal` 在 `pre_exec` 设置 SIGTERM 并复查 parent PID，降低 fork/exec race。

macOS 的 `pre_exec` 描述符清理只使用内核查询、`fcntl` 与 `close`，不枚举目录或分配内存。
遍历上限来自当前子进程的描述符表容量，覆盖稀疏高位 FD，也覆盖降低 `RLIMIT_NOFILE` 后仍然
打开的 FD。保留 stdio、显式传入的 FD 与用于报告 exec 失败的 CLOEXEC 管道；清理失败会让
spawn 返回错误。

Windows pipe 通过 `JobObject::spawn_contained` 挂起创建进程，加入禁止主动脱离的 Job 后才恢复执行。
创建、加入或恢复失败都会终止启动；不会返回缺少 Job 管理的进程。后台 pipe 不创建控制台窗口。
ConPTY 继续通过进程创建属性加入 Job。正常根进程退出后，现有 pipe/ConPTY 契约允许后台后代继续运行。

`JobObject::spawn_contained` 也供 `ash-git` 使用。调用方必须在整个操作期间保留 Job；取消或错误退出时
释放 Job 会结束后代。只有完整成功后才调用 `preserve_descendants`，释放后的 Job 不能再次创建进程。
Windows 模块入口由 `src/win/mod.rs` 移到 `src/win.rs`，子模块仍位于 `src/win/`。

## PTY spawn 调用图

```text
spawn_pty_process
├─ validate non-empty program
├─ inherited_fds empty / non-Unix
│  └─ spawn_process_portable
│     ├─ platform_native_pty_system
│     ├─ openpty(size)
│     ├─ CommandBuilder + env_clear
│     ├─ spawn child
│     ├─ Unix: AsyncFd reader/writer；Windows: blocking reader + async writer
│     ├─ blocking wait
│     └─ ProcessHandle::new(PtyChildTerminator, PtyHandles...)
└─ inherited_fds non-empty [Unix]
   └─ spawn_process_preserving_fds
      ├─ open_unix_pty + CLOEXEC
      ├─ std::process::Command
      ├─ pre_exec: reset signals, setsid, TIOCSCTTY, close FDs
      ├─ AsyncFd master reader/writer + blocking wait
      └─ ProcessHandle::new(RawPidTerminator, opaque raw master...)
```

PTY stdout 与 stderr 指向同一个 terminal slave，因此 result 的 `stderr_rx` 不承载独立 PTY stderr。
Caller 如果需要 split stderr，应选择 pipe backend。

Unix reader/writer 共享非阻塞 master FD；读、写及输出队列等待都可取消。输出 receiver 关闭后
仍继续 drain child，避免停止消费让正常进程堵住。普通 PTY 在 stdin sender 全部释放后排空输入，
再发送换行与终端当前 VEOF；保留 FD 的 PTY 路径不额外注入 EOF。

Windows portable writer 在写入 ConPTY 前经过 `WindowsTtyInputNormalizer`。Normalizer 维护
`previous_was_cr`，所以 CR 和下一 chunk 的 LF 也只生成一个 carriage return。

Windows portable path 在 child 运行期间保留 slave/master pseudoconsole handles，避免过早关闭
改变前台输入语义。消费 `exit_rx` 后，owner 应调用
`ProcessHandle::release_pty_handles_after_exit`；该方法先检查 `has_exited`，再释放 parent-held
handles，使 reader 在排空 ConPTY tail 后收到 EOF。只观察 exit code 而不释放 handles，会让
依赖 output-close 的上层 terminal lifecycle 无法收束。

## 驱动与输出生命周期

`spawn_from_driver` 把 broadcast output 转成 capacity-256 mpsc。它收到 exit code后只标记
`has_exited/exit_code`，仍等待 driver 的 stdout/stderr broadcast sender关闭，避免丢失 exit signal
之后到达的 tail output。

因此 driver contract 是：

```text
publish final output
→ drop/close output senders
→ exit lifecycle may fully settle
```

若 sender 永不关闭，reader task 会一直等待，直到 `ProcessHandle::terminate`/Drop abort。若 broadcast
receiver发生 `Lagged`，当前 adapter 会跳过丢失的 chunks，没有 error 或 gap signal。需要 lossless
output 的 caller 不应让 producer 超过消费能力。

`combine_output_receivers` 也使用 capacity-256 broadcast；select 顺序只反映运行时可用性，不构造
stdout/stderr 的全局 byte order。

## 终止语义

```text
request_terminate
├─ take ChildTerminator once
└─ hard kill child/tree
   └─ keep read/write/wait tasks alive for drain

terminate / Drop
├─ request_terminate
├─ abort primary reader
├─ abort detached stdout/stderr readers
├─ abort writer
└─ child waiter 继续回收并报告 exit；driver waiter 取消转发
```

`signal(Interrupt)` 是 cooperative signal；`terminate` 是 hard cleanup。Killer 已被
`request_terminate` 消费后，后续 signal/terminate 是 best effort no-op。Caller 需要 graceful
deadline 时应先 signal，再等待 `exit_rx`，最后 terminate；本 crate 不提供 timer。

## 方向偏差检查

- Tool command/policy/sandbox 进入 spawn API：utility 获得 execution authority；
- Pipe/PTY 各自实现一套 `ProcessHandle` lifecycle：cleanup semantics 分叉；
- 只 kill root PID、不测试 descendants：process tree 泄漏；
- 把 `DEFAULT_OUTPUT_BYTES_CAP` 当作已 enforce：内存/输出安全假设错误；
- PTY caller 期待 split stderr：terminal stream contract 被误读；
- Driver 在 final output 前关闭 sender：tail output 被丢弃；
- Driver sender 永不关闭：exit 后 reader task 泄漏；
- Public API 暴露 portable-pty/Tokio child/Windows raw handles（Windows interop exports除外）；
- 修改 `src/win/` 不维护 WezTerm attribution；
- Non-Unix no-op process-group helper 被上层当作 containment guarantee。

## 测试、限制与演进

```text
just test ash-utils-pty
just check ash-utils-pty
just rust-warnings ash-utils-pty
bazel test //ash-rs/utils/pty:pty-unit-tests
```

Cross-platform tests 覆盖 PTY Python REPL、pipe stdin、session detach、统一 result、split stderr、
driver resize/tail drain、terminate reader abort、Unix descendant kill、inherited FDs、spawn failure 与
resize。Windows-only tests 覆盖 job/ConPTY descendant behavior、foreground input、Ctrl-C 与 input
normalization。

`lifecycle_tests.rs` 覆盖 pipe terminate/Drop 回收、PTY 等待任务排队时回收、后台 child 保持 slave
打开、输入/输出背压下取消、关闭输出后 drain、大输入与 EOF，以及 driver 转发清理。macOS
另验证降低 FD limit 后仍能清理高位描述符并保留指定 FD。

部分 integration tests 依赖 Python、`setsid` 或特定 OS capability，会在环境不满足时 skip。当前
Unix inherited-FD cases 还要求 child 能打开 `/dev/fd/<n>`；禁止该访问的 managed sandbox 会使
child 以非零状态退出，即使 FD preservation path 本身已经执行。

当前
没有 cancellation token、deadline、output byte cap enforcement、structured spawn error taxonomy、
sandbox integration 或 lossless broadcast gap reporting。未来能力必须继续由上层拥有 policy，
本 crate只负责可测试的 process/terminal mechanism。
