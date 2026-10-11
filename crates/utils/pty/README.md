# `ash-utils-pty`

> 本 README 解释 PTY/pipe process adapter、channel lifecycle 与跨平台 kill-tree 语义。
> Source provenance 与第三方许可见 [`NOTICE`](NOTICE)。

`ash-utils-pty` 为 Ash 提供统一的 interactive PTY、non-interactive pipe 与 externally-driven
process handle。它拥有 process spawn plumbing、stdin/output/exit channels、resize、interrupt 和
process-tree cleanup。Windows 子进程在运行前必须加入 Job；失败直接返回错误。

它不拥有 Tool authorization、sandbox policy、command allow-list、timeout、output persistence 或
Agent execution lifecycle。

`ProcessHandle::process_id` 返回 child 在交给回收任务前捕获的 OS 身份；外部 driver 没有本地身份时返回 None。
`current_working_directory` 在 macOS/Linux 查询该 root child 的实际目录；退出或平台无法查询时返回 None。
PTY 的 Unix Interrupt 从终端查询当前前台进程组，避免只中断仍在等待命令的 shell group；
pipe 的进程组信号与强制终止整棵子进程树的语义保持不变。

## 来源边界

PTY integration 基于 `NOTICE` 中固定的 OpenAI Codex revision 并在 Ash 内适配，Apache-2.0。
本 crate 的 Unix PTY 与 Windows ConPTY 底层实现统一位于 [`portable-pty 0.9.0`](../../../third_party/wezterm/README.md)
的本地副本，MIT license 位于 `third_party/wezterm/LICENSE`。
`src/win.rs` 只适配 Ash 的 Job 与正常退出策略，并为沙箱转换控制台接口。
这是 source reuse，不是 Codex wire protocol/runtime dependency。

同步上游实现时必须保留 provenance，并按 Ash 当前 public contract、process-group tests 和 Windows
tests 审查行为；不能用“来自上游”替代本地 correctness review。

## 公共契约

### Spawn 与统一结果

| Symbol                        | 职责                                        | 当前语义                                           |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `spawn_pty_process`           | interactive PTY spawn                       | stdout/stderr 是 terminal 合并流；支持 resize      |
| `spawn_pipe_process`          | stdin/stdout/stderr pipes                   | stdout 与 stderr 分离                              |
| `spawn_pipe_process_no_stdin` | stdin 立即关闭的 pipe spawn                 | 适合不接收输入的 child                             |
| `SpawnedProcess`              | `session + stdout_rx + stderr_rx + exit_rx` | 三种 spawn path 的统一 result                      |
| `ProcessHandle`               | input、state、resize、signal、terminate     | Drop 终止进程并取消 I/O，child waiter 继续回收进程 |
| `ProcessSignal::Interrupt`    | cooperative interrupt request               | Unix 发 SIGINT；unsupported backend 返回 error     |
| `TerminalSize`                | rows/cols                                   | 默认 24 × 80                                       |
| `combine_output_receivers`    | split mpsc → one broadcast stream           | 不保证 stdout/stderr total order                   |

`spawn_*` 参数包括 program、args、cwd、完整 env map 与 optional arg0；PTY 额外接收
`TerminalSize`，pipe 额外接收 Unix inherited FDs。PTY 不支持额外的 FD 继承；当前生产调用没有
该需求。Spawn 前 `env_clear`，因此 child 只看到 caller 显式提供的 environment。
Unix PTY 要求 Tokio runtime 启用 I/O driver；缺少 driver 时在创建子进程前返回错误。

### 外部驱动适配器

| Symbol                                          | 职责                                                                       | Implementation obligation                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ProcessDriver`                                 | 接入已有 stdin/output/exit backend                                         | output sender 必须在 final bytes 后关闭                       |
| `spawn_from_driver`                             | 转成 standard `SpawnedProcess`                                             | exit signal 后继续 drain 到 broadcast close                   |
| `ProcessHandle::resize`                         | local PTY 或 driver resizer                                                | pipe/no-resizer 返回 error                                    |
| `ProcessHandle::writer_sender`                  | clone raw-byte stdin sender                                                | handle closed 后返回 disconnected sender                      |
| `ProcessHandle::close_stdin`                    | drop owned stdin sender                                                    | 已 clone sender 仍可保持 channel alive                        |
| `ProcessHandle::request_terminate`              | kill child、保留 I/O tasks 以 drain EOF                                    | killer 只消费一次                                             |
| `ProcessHandle::terminate`                      | kill child 并取消 reader/writer；child waiter 继续回收，driver waiter 取消 | 不保证剩余 output drain；真实子进程仍报告 exit                |
| `ProcessHandle::{has_exited,exit_code}`         | non-blocking observed exit state                                           | `exit_rx` 是 authoritative completion notification            |
| `ProcessHandle::release_pty_handles_after_exit` | authoritative exit 后处理 parent-held PTY/ConPTY handles                   | 新版 Windows 保留 console 至 session 结束；旧版释放后排空输出 |

Output channels 以 chunk 数 bounded；总 captured bytes、truncation 与 persistence 必须由 consumer 实施。

## 内部接口地图

| Symbol                             | 可见性              | 当前职责                                                   | 方向约束                                                       |
| ---------------------------------- | ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `ChildTerminator`                  | crate-private trait | backend-specific interrupt/hard kill                       | 与 helper-task abortion 分离                                   |
| `PipeChildTerminator`              | private             | Unix process group 或 Windows job/process kill             | pipe backend 不泄漏 OS handle                                  |
| `PtyChildTerminator`               | private             | PTY child/process-group control                            | interactive descendants 必须一起 cleanup                       |
| `ProcessHandle::new`               | crate-private       | 组装 writer、killer、tasks、exit state、PTY handles        | 所有 spawn paths 共享 lifecycle                                |
| `PtyHandles`                       | internal            | 持有 portable-pty master 与 Windows slave                  | 所有者必须存活到释放 PTY handles                               |
| `read_output_stream`               | private async fn    | 8 KiB pipe reads → bounded mpsc                            | stdout/stderr reader 独立 drain                                |
| `spawn_process_with_stdin_mode`    | private async fn    | pipe command + containment + channel/tasks                 | public pipe variants 的唯一 spawn path                         |
| `pty::spawn_process`               | exported async fn   | 唯一 portable-pty/ConPTY spawn path                        | 不另行创建 Unix PTY                                            |
| `unix_io::PtyIo`                   | crate-private, Unix | 非阻塞 master FD、异步读写与背压                           | 取消不等待 slave 关闭                                          |
| `WaitTask`                         | crate-private enum  | 区分 child 回收与 driver exit 转发                         | child waiter 即使仍在排队也必须执行；driver 转发随 handle 取消 |
| `pipe::close_inherited_fds_except` | crate-private, Unix | pipe exec 前清理非 stdio/non-preserved FDs                 | 保留 stdio、explicit FDs 与 exec-error pipe                    |
| `exit_code_from_status`            | crate-private       | exit code；Unix signal → `128 + signal`；unknown `-1`      | 所有 wait paths使用一致编码                                    |
| `ClosureTerminator`                | private             | driver closure → hard-kill adapter                         | driver signal 当前 unsupported                                 |
| `WindowsTtyInputNormalizer`        | Windows-only public | LF→CR、CRLF collapse、backspace→DEL                        | state 跨 write chunk 保留                                      |
| process-group helpers              | public module       | detach、pdeathsig、SIGINT/SIGTERM/SIGKILL group operations | non-Unix 多数为 no-op                                          |

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

Linux 的 `pre_exec` 从 `/proc/self/fd` 用栈缓冲区读取描述符，并用 `fcntl` 设置 `CLOEXEC`；
不在 fork 后分配内存。读取或设置失败会终止 spawn。macOS 的 `pre_exec` 描述符清理只使用
内核查询、`fcntl` 与 `close`，不枚举目录或分配内存。
遍历上限来自当前子进程的描述符表容量，覆盖稀疏高位 FD，也覆盖降低 `RLIMIT_NOFILE` 后仍然
打开的 FD。保留 stdio、显式传入的 FD 与用于报告 exec 失败的 CLOEXEC 管道；清理失败会让
spawn 返回错误。

Windows pipe 通过 `JobObject::spawn_contained` 挂起创建进程，加入禁止主动脱离的 Job 后才恢复执行。
创建、加入或恢复失败都会终止启动；不会返回缺少 Job 管理的进程。后台 pipe 不创建控制台窗口。
ConPTY 继续通过进程创建属性加入 Job。正常根进程退出后，现有 pipe/ConPTY 契约允许后台后代继续运行。

`JobObject::spawn_contained` 也供 `ash-git` 使用。调用方必须在整个操作期间保留 Job；取消或错误退出时
释放 Job 会结束后代。只有完整成功后才调用 `preserve_descendants`，释放后的 Job 不能再次创建进程。
Windows 控制台、管道、进程属性和命令构造
由 portable-pty 拥有；Ash 的 Job 也供 pipe 与 Git 使用，保留在本 crate。
沙箱通过 `PreparedConPty` 复用同一控制台实现，自行创建受限进程。
CLI PTY 测试也通过根 Cargo 依赖使用同一份 portable-pty。
CLI 宿主保留原有进程启动策略，不套用执行命令的 Job 包装，允许 App Server 启动后台进程。

Unix 的 MXC 沙箱使用 SDK 的 `StdioMode::Pty`，由 SDK 分配终端并启动 Bubblewrap 或 Seatbelt，
不经过本 crate 的 spawn API。该沙箱实现仍有自己的 PTY 分配与控制代码；本 crate 的统一不代表
整个仓库仅剩一套 PTY 实现。其接入边界见 [MXC PTY 启动](../../mxc-sandbox/README.md#pty-启动)。

## PTY spawn 调用图

```text
spawn_pty_process
├─ validate non-empty program
├─ pty_system → openpty(size)
├─ CommandBuilder + env_clear → spawn child
├─ Unix: AsyncFd reader/writer；Windows: blocking reader + async writer
├─ blocking wait
└─ ProcessHandle::new(PtyChildTerminator, PtyHandles...)
```

PTY stdout 与 stderr 指向同一个 terminal slave，因此 result 的 `stderr_rx` 不承载独立 PTY stderr。
Caller 如果需要 split stderr，应选择 pipe backend。

Unix reader/writer 共享非阻塞 master FD；读、写及输出队列等待都可取消。输出 receiver 关闭后
仍继续 drain child，避免停止消费让正常进程堵住。PTY 在 stdin sender 全部释放后排空输入，
再发送换行与终端当前 VEOF。

Windows 的单个 writer task 独占 portable writer，在写入 ConPTY 前经过 `WindowsTtyInputNormalizer`。Normalizer 维护
`previous_was_cr`，所以 CR 和下一 chunk 的 LF 也只生成一个 carriage return。

Windows 使用系统 ConPTY，不从进程目录加载 `conpty.dll`。客户端创建成功后释放 console 创建阶段的
输入/输出句柄；系统提供 [`ReleasePseudoConsole`](https://learn.microsoft.com/en-us/windows/console/releasepseudoconsole) 时同时交还 console 生命周期控制，使最后一个客户端
退出后自然关闭输出。根进程退出而后代仍运行时，`release_pty_handles_after_exit` 保留 console，
后代仍可读写。最终 session disposal 仍负责关闭 console。

没有该系统 API 的 Windows 版本在根进程退出后由 `release_pty_handles_after_exit` 关闭 console，
允许 reader 排空后收到 EOF。支持新 API 的生命周期测试只能在对应 Windows 系统上执行。

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

`signal(Interrupt)` 是 cooperative signal；`terminate` 是 hard cleanup。Unix PTY 的 signal 查询当前
前台进程组；pipe/driver 通过各自 killer 发送，killer 被消费后不再发送。重复 terminate 不会再次
执行 hard kill。Caller 需要 graceful deadline 时应先 signal，再等待 `exit_rx`，最后 terminate；
本 crate 不提供 timer。

## 方向偏差检查

- Tool command/policy/sandbox 进入 spawn API：utility 获得 execution authority；
- Pipe/PTY 各自实现一套 `ProcessHandle` lifecycle：cleanup semantics 分叉；
- 只 kill root PID、不测试 descendants：process tree 泄漏；
- 把 bounded output channel 当作总字节上限：内存/输出安全假设错误；
- PTY caller 期待 split stderr：terminal stream contract 被误读；
- Driver 在 final output 前关闭 sender：tail output 被丢弃；
- Driver sender 永不关闭：exit 后 reader task 泄漏；
- Public API 暴露 portable-pty/Tokio child/Windows raw handles（Windows interop exports 除外）；
- 修改 portable-pty 的本地副本不维护 WezTerm attribution；
- Non-Unix no-op process-group helper 被上层当作 containment guarantee。

## 测试、限制与演进

```text
just test ash-utils-pty
just check ash-utils-pty
just rust-warnings ash-utils-pty
bazel test //crates/utils/pty:pty-unit-tests
```

Cross-platform tests 覆盖 PTY Python REPL、pipe stdin、session detach、统一 result、split stderr、
driver resize/tail drain、terminate reader abort、Unix descendant kill、pipe inherited FDs、spawn failure 与
resize。Windows-only tests 覆盖 job/ConPTY descendant behavior、foreground input、Ctrl-C 与 input
normalization。

`lifecycle_tests.rs` 覆盖 pipe terminate/Drop 回收、PTY 等待任务排队时回收、后台 child 保持 slave
打开、输入/输出背压下取消、关闭输出后 drain、大输入与 EOF，以及 driver 转发清理。macOS
另验证降低 FD limit 后仍能清理高位描述符并保留指定 FD。

部分 integration tests 依赖 Python、`setsid` 或特定 OS capability，会在环境不满足时 skip。当前
Unix pipe inherited-FD cases 还要求 child 能打开 `/dev/fd/<n>`；禁止该访问的 managed sandbox 会使
child 以非零状态退出，即使 FD preservation path 本身已经执行。

当前
没有 cancellation token、deadline、output byte cap enforcement、structured spawn error taxonomy、
sandbox integration 或 lossless broadcast gap reporting。未来能力必须继续由上层拥有 policy，
本 crate只负责可测试的 process/terminal mechanism。
