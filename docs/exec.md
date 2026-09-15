# 无界面 Agent 执行

> 目标物理位置：`ash-rs/exec/`  
> 当前状态：阶段 1–2 已实现；远程执行环境的进程/文件通路已实现，可靠自动化与远程 Agent worker 仍是 Proposed
> 当前 crate 实现契约：[`ash-rs/exec/README.md`](../ash-rs/exec/README.md)
> App Server Client：[`app-server-client.md`](app-server-client.md)  
> App Server contract：[`ash-app-server-api.md`](ash-app-server-api.md)  
> Canonical 产品模型：[`protocol.md`](protocol.md)

## 快速理解

`ash-exec` 的长期角色是无交互 Agent runner。它把一次本地 CLI 请求或远程调度 Job 转换为
canonical Session/Thread/Turn command，持续消费 App Server result/update，并输出机器可处理的
终态、事件和退出状态。

它不是 shell command executor，也不是第二个 Agent runtime：

```text
local CLI / remote scheduler
            │
            ▼
        ash-exec
            │ typed App Server request/update
            ▼
 ash-app-server-client
            ▼
      ash-app-server
            ▼
         ash-core
            │ tool execution port
            ▼
 ash-exec-server → ash-tool-executor
```

长期必须区分：

- `ash-exec`：运行完整的 headless Agent Job；
- `ash-tool-executor`：在本机执行一个经过 approval/sandbox 的 process；
- `ash-exec-server`：把 process/filesystem execution 暴露给宿主配置的远程环境；
- scheduler protocol：提交、租约、取消和观察远程 Agent Job。

这四者不能共享一个含义含糊的 `exec` API。

| 用户或调度器想做什么 | 正确入口 | 当前状态 |
| --- | --- | --- |
| 无交互地运行完整 Agent 任务 | `ash-exec` | 本地 run-once 已实现 |
| 执行一次已经批准的本地命令 | `ash-tool-executor` | 已实现并与 Agent runner 分离 |
| 在远程机器执行进程或文件操作 | `ash-exec-server` | 已接入 Core 审批与结果记录 |
| 排队、租约和取消远程 Agent 任务 | 调度协议 | 潜在方向 |

## 2. Codex 参考与 Ash 取舍

本方案参考本地 `../codex` workspace 的三层边界：

- `codex-rs/exec/` 是非交互 Agent 产品入口；
- `codex-rs/app-server-client/` 被 exec 与 TUI 共享，集中处理 embedded App Server startup、
  initialize、typed request/event channel、backpressure 和 bounded shutdown；
- `codex-rs/exec-server/` 单独负责 process、PTY、filesystem 和远程 execution environment。

Ash 应采用：

- exec 与 TUI 共用 App Server Client；
- embedded hot path 使用 typed channel；
- request completion 与 server event stream 分离；
- cloneable request handle；
- bounded queue、lag signal 与显式 shutdown；
- headless exec 只通过 App Server 创建/恢复 Thread、启动/中断 Turn；
- remote Agent scheduling 与 remote process execution 分层。

Ash 不照搬：

- exec 直接依赖 Core、rollout 或 provider 私有类型；
- caller 自由选择任意 `request_typed<T>` result 类型；
- 一个数千行 client/exec module；
- remote event 使用 unbounded queue；
- 复制一套与 canonical ThreadItem 平行的内部领域状态机；
- 按具体 notification 名字硬编码永久的 lossless/best-effort 列表。

Ash 已有 durable aggregate sequence、snapshot + gap subscribe 和 typed command replay，应利用
这些契约实现 resync，而不是依赖“所有实时 event 永不丢失”。

## 3. 当前仓库偏差与迁移

命名迁移已经完成：

```text
former ash-rs/exec
  → ash-rs/tool-executor
  → crate ash-tool-executor

current ash-rs/exec
  → crate/binary ash-exec
  → headless Agent runner
```

`ash-tool-executor` 继续拥有 `CommandRequest`、process capture、timeout、sandbox 与 approval start
gate；`ash-exec` 当前拥有 new/resume/fork、Turn start/interrupt、事件输出与终态映射。Sandbox 的
共享 policy、进程生命周期与 MXC 三平台适配边界见
[`sandboxing.md`](sandboxing.md)。

当前远程 process/filesystem execution 的实现契约见
[`ash-exec-server`](../ash-rs/exec-server/README.md)。桌面 PTY 与远程受限 PTY 均归该 crate；远程 PTY 通过内部启动器继承终端并保留 MXC 约束。

```text
ash-tool-executor
  → local backend of ash-exec-server

ash-exec-server-protocol
  → process / PTY / filesystem / HTTP execution contract
```

不能直接把当前 `ToolExecutor` 扩张为远程 Agent scheduler，否则 scheduler job、Agent lifecycle、
process lifecycle 和 sandbox authority 会混在同一 crate。

## 4. 职责与非职责

### 4.1 `ash-exec` 拥有

- 一次 headless run 的输入、工作目录和输出选项；
- create/resume/fork 哪种产品入口意图；
- 使用 `ash-app-server-client` 启动或连接 App Server；
- 创建/选择 Session 与 Thread，启动一个 Turn；
- 关联当前 Job、Session、Thread 与 Turn；
- 同时等待 request completion、App Server event、cancel 和 shutdown；
- 把 canonical update 映射为 human/JSONL/scheduler event；
- headless approval 行为；
- Ctrl-C 与 scheduler cancellation 到 `session/request` `InterruptTurn` 的映射；
- terminal Turn status 到 `ExecOutcome`、退出码和 scheduler status 的映射；
- run-once 与长期 worker 的应用级生命周期。

### 4.2 `ash-exec` 不拥有

- Session/Thread/Turn reducer；
- model loop、tool loop 或 context assembly；
- command receipt、writer lease 或 rollout recovery；
- App Server initialize、channel wiring 和 connection shutdown 的具体实现；
- process spawn、PTY、filesystem sandbox 或 network proxy；
- scheduler 的全局 queue、placement、quota 或 billing authority；
- 从日志、stderr 或人类文本推断 Turn 终态；
- 直接读取 Core、store 或 rollout 作为 App Server 旁路。

## 5. 本地单次运行

当前支持一次进程运行一个 Agent Job：

```text
parse ExecRunRequest
  → start embedded AppServerSession
  → create/read Session
  → create/read Thread
  → subscribe Thread
  → start Turn
  → consume result + AppServerEvents
  → observe terminal durable update
  → unsubscribe
  → shutdown AppServerSession
  → emit ExecOutcome
```

建议状态机：

```text
Preparing
  → StartingAppServer
  → StartingThread
  → Running
  → Cancelling
  → Terminal
  → Closing
  → Closed
```

任意阶段失败都必须产生明确 `ExecOutcome`。Connection EOF 不是 Turn failure；若终态未知，
exec 应重新连接/read/subscribe 或返回 `OutcomeUnknown`，不能伪造 `Failed`。

## 6. 公共接口

当前 library API 以 typed request、sink 和 cancellation signal 为边界：

```rust
impl ExecRunner {
    pub fn run(
        &self,
        request: ExecRunRequest,
        output: impl ExecEventSink,
        cancellation: &impl ExecCancellation,
    ) -> Result<ExecOutcome, ExecError>;
}
```

输入使用 enum，而不是多个 bool：

```rust
pub struct ExecRunRequest {
    pub run_id: ExecRunId,
    pub entry: ExecEntry,
    pub approval: HeadlessApprovalMode,
}

pub enum ExecEntry {
    New { title: String, input: Vec<InputItem> },
    Resume { session_id: SessionId, thread_id: ThreadId, input: Vec<InputItem> },
    Fork { session_id: SessionId, parent_thread_id: ThreadId, title: String, input: Vec<InputItem> },
}

pub enum AppServerTarget {
    Embedded(EmbeddedAppServerOptions),
}
```

`AppServerTarget::Remote(RemoteAppServerOptions)` 仍是 Proposed。它将表示连接相同 App Server
contract，不表示 scheduler job protocol，也不表示 remote process executor。

`ash-cli` 负责参数和帮助；`ash-exec` 负责这些参数解析后的运行语义。

## 7. 输出契约

Human 输出可以演进；JSONL 与 scheduler event 是机器契约，必须 versioned、typed 且与 stdout
诊断隔离。

```rust
pub struct ExecEvent {
    pub schema_version: u32,
    pub run_id: ExecRunId,
    pub event: ExecEventKind,
}

pub enum ExecEventKind {
    RunStarted {
        origin: ExecOrigin,
        session_id: SessionId,
        thread_id: ThreadId,
    },
    TurnStarted { session_id: SessionId, thread_id: ThreadId, turn_id: TurnId },
    ThreadUpdated { update: Box<ThreadUpdateEnvelope> },
    RunCompleted { outcome: ExecOutcome },
}

pub enum ExecOrigin {
    Local,
}
```

当前 schema version 是 1。Item-specific event、warning 与
`Scheduled { job_id, attempt_id }` origin 属于阶段 3/4 的扩展点；当前先机械传递 canonical
`ThreadUpdateEnvelope`，避免过早复制一套 item lifecycle。

`ExecEvent` 是外部展示/automation envelope，不是新的 authoritative domain model：

- ID、status、item payload 优先机械复用 protocol；
- 展示所需的 delta 可以映射，但不能改变 durable 事实；
- terminal event 必须由 canonical Turn terminal status 产生；
- JSONL stdout 每行一个完整 event；
- stderr 只用于诊断；
- human 模式默认只把最终 Agent message 写入 stdout，进度写 stderr；
- event schema 变更必须有 fixture 与 compatibility policy。

## 8. 无界面批准与服务端请求

无交互运行不能等待不存在的用户界面。

```rust
pub enum HeadlessApprovalMode {
    DenyInteractiveRequests,
    AutomaticReview,
    BypassPermissions,
}
```

当前规则：

- `DenyInteractiveRequests` 在 Turn 进入 approval/user-input/capability wait 时发送 typed
  `InterruptTurn`，观察 canonical `Interrupted` 后返回 `RequiresInteraction`；
- `AutomaticReview` 映射为 App Server `AutoReview`，但无法呈现的 user-input/capability 仍会中断；
- `BypassPermissions` 只由显式 `--dangerously-bypass-permissions` 选择，绝不是 worker 默认值；
- Ctrl-C 和 turn timeout 都先发送 typed interrupt，再等待 bounded terminal observation；
- 当前没有 remote reviewer channel，不能把交互请求悬挂给不存在的 UI。

远程 reviewer 的 Proposed 规则：

- remote scheduler 支持 reviewer 时，请求必须携带 Job/Attempt/Thread/Turn/Tool identity；
- reviewer response 必须防重放并校验 action digest；
- approval timeout、scheduler disconnect 和 worker shutdown 都必须结束 pending server request；

因此 App Server Client 的长期 event stream 需要同时支持：

- `ServerNotification`；
- `ServerRequest`；
- `Lagged/Desynced`；
- `ConnectionClosed`。

## 9. 远程调度

### 9.1 两种运行模式

```text
RunOnce
  = 一个 ash-exec process
  = 一个 App Server session
  = 一个前台 Agent Job

Worker
  = 一个长期 ash-exec worker
  = 一个或多个隔离的 App Server session
  = 多个有 lease 的 Agent Job
```

Worker mode 不能简单地在循环中调用 CLI `main`。它需要明确：

- worker registration；
- capability/host/workspace advertisement；
- job lease 与续租；
- attempt fencing；
- cancellation；
- event ack/cursor；
- reconnect 与 replay；
- draining shutdown；
- tenant、credential、workspace 和 state-root isolation。

### 9.2 身份

以下身份不能混用：

| Identity | Owner | 用途 |
| --- | --- | --- |
| `ExecRunId` | ash-exec | 当前 runner 内的一次运行 |
| `JobId` | scheduler | 一次逻辑远程任务 |
| `AttemptId` | scheduler | 一次 placement/execution attempt |
| lease/fencing token | scheduler | 阻止过期 worker 继续提交 |
| `CommandId` | App Server caller | durable command 幂等与 replay |
| Session/Thread/Turn ID | App Server domain | canonical Agent lifecycle |
| JSON-RPC request ID | App Server Client | 当前 connection 的 result pairing |
| durable sequence | aggregate | update replay 与 resync |
| scheduler event cursor | scheduler protocol | scheduler-side delivery ack |

推荐保存稳定映射：

```text
JobId + AttemptId
  ↔ SessionId + ThreadId + TurnId
  + last durable sequence
  + scheduler event cursor
```

Scheduler receipt 不是 App Server command receipt。两者可以在同一 Job flow 中关联，但不得放进
同一个 ID 或假设原子跨系统事务。

### 9.3 远程 Job 流程

```text
scheduler assigns Job(attempt, lease)
  → worker validates isolation/capability
  → ash-exec starts/selects AppServerSession
  → stable CommandId creates/resumes Session/Thread/Turn
  → worker streams mapped ExecEvent
  → scheduler acks event cursor
  → worker observes terminal durable update
  → worker commits terminal Job result with fencing token
```

断线恢复时：

- scheduler 可以重新投递同一 `JobId` 的新 `AttemptId`；
- worker 使用 mapping 与 App Server read/subscribe 判断原 Turn 是否仍运行或已终态；
- 相同逻辑 App Server command 重试复用原 `CommandId + exact payload`；
- durable gap 通过 snapshot + committed gap 恢复；
- transient delta 丢失只影响低延迟展示，不能影响 terminal Job result；
- 过期 lease 的 worker 不得提交 scheduler terminal result。

## 10. 远程 Agent 调度与远程执行平面

远程调度完整 Agent Job：

```text
scheduler → ash-exec worker → App Server → Core
```

远程执行某个 tool process/filesystem operation：

```text
Core tool port → ash-exec-server client → remote ash-exec-server
```

二者的 security 和 lifecycle 不同：

| Plane | Authority | Stable unit | Disconnect behavior |
| --- | --- | --- | --- |
| Agent scheduling | scheduler + App Server | Job/Session/Thread/Turn | durable recovery/reschedule |
| Process execution | executor connection | process/filesystem request | terminate, resume or report unknown by exec protocol |

`ash-exec-server` 不得接受 Agent `session/request`，`ash-exec` scheduler adapter 不得提供裸
`process/start` 旁路。

## 11. 工作进程隔离与并发

第一版 remote worker 应保守选择：

- 一个 Job 一个 workspace lease；
- 一个 tenant/credential scope 一个 App Server authority；
- 同一 Thread 只有一个 active writer；
- worker 只在 capability、sandbox 和 state-root scope 完全相容时复用 App Server session；
- 不在不同用户间共享 Resource ownership、subscription 或 transient cursor；
- worker restart 依赖 durable store 恢复，不依赖内存 pending table。

并发可以随 App Server per-Thread serialization 演进，但 scheduler placement 不能把“不同
Thread 可并行”误解为“不同 tenant 可以无隔离共享进程”。

## 12. 背压与重放

所有 queue 有界：

- App Server Client request channel；
- App Server event channel；
- exec output sink；
- remote scheduler outbound buffer。

处理规则：

- durable update 不静默丢弃；
- event queue 满时发出 `Lagged/Desynced` 并按 aggregate sequence resubscribe；
- transient delta 可以按明确 policy 丢弃或合并；
- terminal update 在成功交付或完成 snapshot resync 前不能宣称 Job 完成；
- scheduler event 使用独立 cursor/ack，不能复用 Thread durable sequence；
- scheduler 长时间不 ack 时施加 backpressure、持久化 spool 或终止 attempt，不能无限占用内存。

## 13. 取消与关闭

RunOnce Ctrl-C：

```text
signal
  → session/request { type: interruptTurn } with stable CommandId
  → wait terminal update within deadline
  → unsubscribe
  → AppServerSession.shutdown()
  → interrupted ExecOutcome
```

Worker Job cancellation：

```text
scheduler cancel(JobId, AttemptId, fencing token)
  → validate current attempt
  → session/request { type: interruptTurn }
  → publish terminal Job event
  → keep worker/App Server alive for other jobs
```

Worker shutdown 应有具名模式：

```rust
pub enum WorkerShutdownMode {
    Drain,
    InterruptActiveJobs,
}
```

`Drop` 只做 best-effort cleanup；正常路径必须等待 job terminal handling 与 App Server Client
shutdown。

## 14. 目标 crate 与依赖

```text
ash-cli
├─► ash-tui ─────┐
└─► ash-exec ────┤
                  ▼
       ash-app-server-client
                  ▼
          ash-app-server
                  ▼
              ash-core
                  │
                  ▼
        ash-shell-command
                  ▼
        ash-tool-executor
```

未来可增加：

```text
ash-exec-server-protocol
ash-exec-server
ash-scheduler-protocol
```

`ash-exec` 可依赖 app-server-client、app-server-protocol、protocol 和窄 CLI/output utility。
它不依赖 Core、store、rollout、model provider、sandboxing 或 tool executor。

## 15. 实施阶段

### 阶段 1：消除命名冲突（当前状态）

- 已将原 process `ash-exec` 迁移为 `ash-tool-executor`；
- 已更新直接依赖与 tools、skills、plugins、MCP 文档中的 ownership；
- `ash-exec` crate 名称现由 headless runner 使用。

### 阶段 2：本地无界面纵向切片（当前状态）

- 复用 owned App Server Client request/event session；
- 实现 new/resume/fork、Turn start/interrupt；
- human/JSONL output；
- terminal status 与退出码；
- 显式 shutdown。

### 阶段 3：可靠自动化（计划）

- 稳定 ExecEvent schema；
- output schema、last-message file、stdin 与 workspace input；
- approval delegation；
- reconnect/read/subscribe resync；
- integration fixtures。

### 阶段 4：远程工作进程（计划）

- scheduler protocol；
- Job/Attempt/lease/fencing；
- worker registration、heartbeat 和 draining；
- event cursor/ack 与 reconnect；
- tenant/workspace isolation。

### 阶段 5：远程执行环境（潜在方向）

- 独立 exec-server protocol；
- process/PTY/filesystem handlers；
- authenticated transport；
- 与 Agent scheduler 分开的 reliability 与 security model。

## 16. 验证要求

阶段 1–2 已由 crate/CLI tests 覆盖：

- exec 与 TUI 使用同一个 App Server Client startup/connection contract；
- exec 不直接依赖 Core、store、provider、sandbox 或 tool executor；
- start/resume/interrupt 只通过 typed App Server API；
- request result 与 notification 可并行消费；
- JSONL stdout 永远是合法机器事件；
- terminal outcome 只来自 canonical Turn status；
- connection 断开不会伪造 Turn failure；
- Ctrl-C 发送 typed `session/request` `InterruptTurn`；
- headless approval 不会永久等待不存在的 UI；

阶段 3–5 尚需满足：

- durable gap 可在断线后通过 reconnect/read/subscribe 恢复；
- remote cancel 同样发送 typed `session/request` `InterruptTurn`；
- Job/Attempt/Command/request/sequence identity 有独立 contract tests；
- 过期 lease 无法提交 scheduler terminal result；
- worker shutdown 不泄漏 Job、App Server connection 或后台 task；
- remote Agent scheduling 与 remote process execution 没有协议旁路。
