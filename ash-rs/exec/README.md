# `ash-exec`

> 本 README 维护无界面 Agent runner 的当前实现契约。跨进程调度、远程执行平面与阶段规划由
> [`docs/exec.md`](../../docs/exec.md) 统一维护；App Server 连接契约见
> [`docs/app-server-client.md`](../../docs/app-server-client.md)。

本 crate 把一次 new、resume 或 fork 意图转换成类型化的 Session/Thread/Turn 请求，观察
canonical Turn 终态，并输出版本化事件。它不执行 shell process，不拥有 Agent loop，也不直接读取
Core、rollout、store、model provider、sandbox 或 `ash-tool-executor`。

## 文件与职责

| 文件 | 当前职责 |
| --- | --- |
| `src/model.rs` | run input、approval mode、versioned event、terminal outcome 与 exit code |
| `src/run_id.rs` | `ExecRunId` 校验和进程内生成 |
| `src/output.rs` | `ExecEventSink`、discard sink 与逐事件 flush 的 JSONL sink |
| `src/connection.rs` | 私有 `ExecConnection` 端口及 App Server session adapter |
| `src/runner.rs` | 公共 runner、timeout 配置、cancellation contract 与显式 shutdown |
| `src/run_loop.rs` | prepare、subscribe、start、observe、interrupt 与 unsubscribe 编排 |
| `src/turn_outcome.rs` | canonical terminal status、交互等待与公开 outcome 的唯一映射 |
| `src/*_tests.rs` | schema、JSONL、终态、取消、交互与断线 contract tests |

## 公共契约

`ExecRunner::run` 是唯一产品执行入口。调用方提供：

- `ExecRunRequest`：稳定 run identity、`ExecEntry` 与 `HeadlessApprovalMode`；
- `ExecEventSink`：按顺序接收完整事件，失败时不自动重试；
- `ExecCancellation`：廉价、非阻塞的取消观察点。

`ExecEntry` 明确区分 `New`、`Resume` 和 `Fork`，避免由多个 bool 或缺省 ID 推断入口意图。
宿主在构造 `ExecRunner` 时提供 App Server 的 stdio 连接命令和客户端身份。根部 CLI 以此连接共享 profile 服务。

`ExecEvent` 是 schema version 为 1 的展示/自动化 envelope。`ThreadUpdated` 机械携带 canonical
`ThreadUpdateEnvelope`，不建立第二套 authoritative item 或 Turn 状态。`JsonLinesExecEventSink`
每次写入一个完整 JSON object、换行并 flush；诊断文本必须由宿主写入 stderr。

终态只由读取到的 canonical `TurnStatus::{Completed,Failed,Interrupted}` 产生：

| `ExecOutcome` | 来源 | 默认退出码 |
| --- | --- | --- |
| `Completed` | canonical `Completed` | 0 |
| `Failed` | canonical `Failed`，保留 `StableTurnError` | 1 |
| `RequiresInteraction` | headless policy 请求 interrupt，随后观察到 canonical `Interrupted` | 2 |
| `Interrupted` | canonical `Interrupted` | 130 |
| `OutcomeUnknown` | Turn 已开始，但连接、观察或 interrupt handshake 未给出终态 | 75 |

## 内部接口地图与调用路径

`ServerConnection` 是 `ash-app-server-client` 的薄适配器；它只构造协议 Params、检查
`SessionRequestResult` variant，并把 notification 映射为私有 `ConnectionEvent`。
`prepare_run` 拥有 new/resume/fork 到 Session/Thread 选择的唯一映射。`terminal_outcome` 是
canonical Turn status 到公开 outcome 的唯一转换点。`required_interaction` 只决定无 UI 时何时请求
interrupt，不改变 App Server 内的批准结论。`best_effort_interrupt` 只用于 event sink 在 Turn 启动后
失败的清理路径。

```text
ExecRunner::run
  → ServerConnection::start_stdio
  → ExecRunner::run_connected
     → prepare_run
     → ExecConnection::subscribe_thread
     → ExecConnection::start_turn
     → ExecRunner::drive_turn
        → read_thread / poll_event
        → interrupt_turn when cancellation, timeout or unsupported interaction wins
        → terminal_outcome
     → ExecConnection::unsubscribe_thread
  → ExecConnection::close
```

`SessionRequestParams.expected_sequence` 在 Thread mutation 路径使用最新 Thread sequence；调用方不能
硬编码新 Thread 的初始 sequence，也不能把 Session sequence 用于 StartTurn/InterruptTurn。
每种 mutation 使用由 `ExecRunId + operation` 生成的稳定 `CommandId`，当前实现不自动 retry。

若在本 crate 出现 Core reducer、provider request、rollout 读取、process spawn、sandbox policy 或
scheduler lease table，说明 ownership 已漂移。底层进程执行只能进入
[`ash-tool-executor`](../tool-executor/README.md)。

## 取消、交互与失败

Turn 创建前取消返回 `ExecError::CancelledBeforeStart`。Turn 创建后取消和 timeout 都先发送类型化
`SessionRequest::InterruptTurn`，然后在 `interrupt_timeout` 内继续读取 snapshot，只有观察到
canonical terminal status 才返回 `Interrupted` 或 `RequiresInteraction`。

默认 `DenyInteractiveRequests` 使用普通 approval policy，但一旦 Turn 等待 approval、user input 或
capability，就请求 interrupt。`AutomaticReview` 允许 App Server 自动审查 approval，仍会停止无法呈现
的 user input/capability。`BypassPermissions` 必须由宿主显式选择，不能成为远程 worker 默认值。

连接关闭不会转换成 `Failed`。Runner 会做一次最终 Thread read；无法确认 terminal status 时返回
`OutcomeUnknown`。当前没有 remote reconnect/resubscribe backend，因而 unknown outcome 必须交给上层
显式处理，不能自动 replay 可能已经产生副作用的 Turn。

Sink 在 Turn 启动后失败会触发一次 best-effort interrupt，再返回 `ExecError::Output`。正常路径始终
unsubscribe 并调用 `AppServerSession::shutdown`；shutdown 失败不会被静默吞掉。

## 宿主接入与验证

`ash-cli` 负责参数、stdout/stderr 和 signal 注册；它不复制 runner 状态机。新的宿主应构造
`StdioAppServerCommand`、客户端身份和明确的 approval mode，并根据 `ExecOutcome::exit_code` 映射进程或 Job
状态。

```bash
cargo test -p ash-exec
cargo test -p ash-cli
cargo clippy -p ash-exec --all-targets --no-deps -- -D warnings
bazel test //ash-rs/exec:exec-unit-tests
```

修改 event JSON shape 时必须更新 schema version、serialization fixture、本 README 和
`docs/exec.md`。修改 interruption、terminal mapping 或 sequence 使用时必须同步覆盖 runner fake
connection tests 与 CLI exit behavior。

## 当前限制与扩展点

- 当前通过 stdio 连接共享 App Server daemon；
- 当前是同步 run-once runner，没有长期 worker、Job/Attempt、lease、fencing 或 event ack；
- JSONL 已 versioned，但尚无跨版本 compatibility fixture、last-message file 或 stdin item stream；
- 自动审查由 App Server 拥有；当前 headless runner 不实现远程 reviewer channel；
- 断线后只做最终 read，不执行 reconnect + snapshot/gap resubscribe。

这些能力的 ownership 与前置条件以 `docs/exec.md` 的阶段 3–5 为准。
