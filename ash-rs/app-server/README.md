# `ash-app-server`

`ash-app-server` 组合一个环境中的服务并实现 App Server 协议，具体职责如下：

1. 分发类型化协议，管理请求取消、产品会话组织和通知订阅。
2. 通过 `core-api::AgentRuntime` 调用 Agent 操作；Core 负责执行、重试、取消和恢复。
3. 在文件、搜索、Git、Terminal、语言服务和目录贡献入口校验 Permission，传递有效授权。
4. 组合 profile 配置、环境服务与 Core 实现；目录贡献只在获得对应授权后生效。
5. 在 Agent、Shell 和上下文压缩执行期间持有空闲防休眠租约，同一进程内的目录服务共享系统资源。
6. 为窗口装配通话、LiveKit 和音频设备助手；连接关闭时释放该窗口的通话资源。

连接建立、鉴权和消息队列由 `ash-app-server-transport` 负责。Core 契约和装配边界见
[`Core 架构`](../../docs/core.md#7-依赖边界)。

直接连接与 Agents 网关的本地请求共用 `server/request_dispatch.rs`。请求先按协议声明的资源范围排队，取得执行资格后才交给工作线程；同一资源的修改按接收顺序串行。每个执行器最多接纳 64 个普通请求，并为取消、停止和交互回复单独保留 16 个请求容量。每条直接连接使用一个执行器，一条网关的已打开本地路由共用一个执行器。执行容量分为交互、后台和控制三组，请求容量耗尽时返回 `ServerOverloaded`，避免在消息读取线程中等待空闲工作线程。

`initialize` 仅按当前连接串行，不等待其他领域的全局写许可，避免长请求阻止新窗口完成协议初始化。

Git 请求按实际仓库公共目录排队，默认仓库选择、显式 repository ID 和 linked worktree 使用同一身份；同一仓库的读写按接收顺序串行，因为读取也更新状态缓存或游标并取得仓库操作锁。此排队跨目录运行时生效，不占用执行线程等待，也不阻止其他仓库或普通查询。后台提交仍使用 Git 领域已有的仓库操作锁。

`git/clone` 在后台执行队列运行，不取得全局许可。Git 领域在启动子进程前原子创建目标目录；并发克隆领取不同目录，父目录别名不会绕过这个约定。失败或取消只清理空的目录预留，保留部分克隆数据。`clone`、`fetch`、`pull`、`push` 观察发起请求的取消信号；socket 断线时结束 Git 进程树和管道读取，并退出仓库操作锁及运行时锁的等待。取消可能发生在 Git 已修改仓库之后，不回滚已完成的更改；后续读取重新查询状态。自动 fetch 使用自己的生命周期信号，停止 watcher 时取消正在进行的 fetch。

Agents 的本地目录服务由 profile 注册表的固定启动线程池解析路径并打开；每个 profile 最多同时执行 4 项、排队 32 项启动工作，并保留 64 个待完成目录等待容量；同一规范化目录的请求共享初始化结果，不占用额外启动线程。`managed/gateway/local.rs` 只等待共享服务并初始化自己的连接，不在网关读取循环中执行磁盘操作。每条网关连接最多持有 32 个本地路由；每个路由最多接纳 64 个普通请求和 16 个控制请求，包括启动等待及响应尚未交付的请求。打开后的路由共用网关的执行线程。目录启动失败完成该路由请求，其他路由继续运行；断开时停止接纳请求，取消已打开连接，并立即退出尚未完成的目录等待，不执行积压请求。共享初始化继续服务其他连接；已取消且尚未开始的启动提交直接跳过。注册表退出时回收启动线程；已经进入操作系统的同步文件操作不会因单个窗口关闭而被强行中断。

Agents 的 SSH 路由由 `managed/gateway/remote.rs` 拥有独立消息队列和子进程。每条网关连接最多持有 32 个远端路由，每个路由分别保留 64 个普通请求、16 个控制请求的未完成容量，并为宿主回复单独保留 16 个待写消息容量；普通请求容量耗尽返回 `ServerOverloaded`。宿主回复先于控制请求写入，控制请求先于普通积压请求写入，各组内部保持接收顺序。已经阻塞的管道写入不能被优先队列抢占；关闭路由时终止子进程以唤醒写入。宿主回复或订阅转发无法入队时只关闭对应路由，结束其未完成请求。SSH 初始化写入和回复共同受 10 秒期限约束，管道读写不占用网关请求读取线程。超时、远端退出和窗口断开结束该路由的请求并终止、回收子进程；其他路由和本地请求继续执行。

请求还受保留消息的字节预算约束。直接连接独立计数；同一网关的 profile、本地和 SSH 路由共用普通请求 320 MiB、控制请求 16 MiB、SSH 宿主回复 320 MiB 的预算。请求从等待到执行完成持有预算；SSH 消息从入队到管道写入完成持有预算。路由间转交不重复计数，初始化消息的路由副本共享同一份原始内容。预算保留单条最大合法编辑器消息的空间，并限制多条大消息同时积压；这些数值计量序列化消息大小，不是进程总内存上限。

后台通知独立于请求执行发送；一个请求直接产生的通知仅在该请求的响应入队后发布。Session 修改期间，该 Session 的后台事件也等待响应入队，保留 response-before-causal-notification 约定；其他 Session 的事件与宿主调用继续发送。响应与通知使用同一有界输出队列，最多 256 条消息、320 MiB；正在写入的消息也占用字节预算，写入失败唤醒等待容量的生产者。每条连接的通知源、请求因果事件和 Session 延后事件另共用 320 MiB 预算；耗尽时按已有约定清理临时事件并发布 transcript reset，无法容纳持久事件时关闭通知源。输出背压不保留跨连接共享的资源许可。Socket 断线时取消排队和运行中的请求，并唤醒待回复的宿主调用；有限的 stdio 输入结束后继续处理已接收请求，但不再等待宿主回复。

RPC trace 从请求接收开始计时，记录资源等待、执行队列等待、执行和进入输出队列的等待；`rpc.outbound` 子 span 记录输出队列等待与实际写入耗时。新增并发回归可运行 `just test ash-app-server --lib request_dispatch` 和 `just test ash-app-server --lib managed::gateway`。

交互式 PTY、输出缓存和重连租约由 [`ash-exec-server`](../exec-server/README.md) 管理；
`src/server/terminal_operations.rs` 负责协议转换和调用，环境装配负责传入有效授权。

环境和目录授权语义见 [`docs/environment-access.md`](../../docs/environment-access.md)，wire contract 见
[`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

```text
just test ash-app-server
```

Windows 的后台进程生命周期集成测试使用 `just test-processes ash-app-server --test managed_lifecycle`，避免 Cargo 的测试 Job 阻止后台独立存活。入口及过滤方式见[构建测试说明](../../docs/build.md#测试)。

## 执行环境

- Core 执行作用域结束时释放防休眠租约，包括完成、失败、中断及让出执行的审批或能力等待；恢复执行时重新获取。
- 工具内部的同步交互等待仍保留执行作用域，期间可能还有正在运行的命令；空闲连接和持久化的未完成任务不持有租约。
- 防休眠能力由 [sleep-inhibitor](../utils/sleep-inhibitor/README.md) 提供；系统拒绝获取时记录警告，任务按正常执行规则继续。

- `ASH_EXEC_ENVIRONMENTS` 指定宿主配置的执行环境列表，格式见 [exec-server](../exec-server/README.md)。
- Core 审批后调用显式选定的环境，执行结果仍写回当前 Thread。
- 执行目标在装配时固定身份、实例、根目录和权限上限；审批摘要包含这份绑定，切换当前工作区不会改写目标。
- `environment_runtime` 保留授权、配置激活与 Agent 工具装配；`WorkspaceRuntime` 组合就近索引、搜索、Git 与监听，`ExecutionRuntime` 组合目录绑定的终端与调试资源。
- 额外执行目标独立于当前工作区；容器副本同步与回写尚未接入，不将该目标自动当作当前索引对应的源码。
- 命令观察使用有上限的等待，短暂断线只恢复原进程的读取；取消以实际终态为准。完整语义见 [exec-server](../exec-server/README.md)。

## 进程入口

- `ash-app-server --listen stdio://` 提供直接连接；未设置 `ASH_WORKSPACE_ROOT` 时不继承当前目录授权。
- WebSocket 使用 `--listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 HEX --emit-listen-info stdout-json`，监听成功后输出一条启动记录。
- `src/startup.rs` 负责参数、环境绑定和服务启动；CLI 调用同一 `run`。
- 实时 trace 默认关闭；显式启用后由 [otel-trace-websocket](../otel-trace-websocket/README.md) 提供本机只读流，App Server 只负责配置与生命周期装配，managed 模式的多个目录共享同一个 profile exporter。
- profile 路径和随包产品服务发现由 `install-context` 提供，客户端消费相同契约。
- `arg0` 在普通参数解析前分发内部 worker；启动命令绑定实际宿主可执行路径。
- daemon 的连接和生命周期命令由 [`app-server-daemon`](../app-server-daemon/README.md) 提供。
- 历史维护入口 `history-identity`、`history-import HOST`、`history-bind SESSION_ID ROOT`
  分别读取接收 Profile 身份、原子导入归档和显式绑定缺失的远端目录；导入及绑定前停止当前 Profile
  后台。调用顺序与一次性停写约定见 [remote-server](../remote-server/README.md#history-ownership-transfer)。

验证：`just test ash-app-server --test stdio --test websocket --test worker`。

手动调用和观察协议可使用独立的 [`app-server-test-client`](../app-server-test-client/README.md)。

## 受管后台进程

- `ash-app-server --managed` 运行 profile 级共享服务；PID 记录直接指向此进程。
- `src/managed.rs` 拥有服务循环、连接线程、停止宽限期和空闲退出；daemon 拥有整个进程的停止期限。
- 显式停止先结束执行进程、队列和自动化调度，宽限期后关闭剩余连接并等待连接线程退出，再释放目录和 profile 服务。监听端点及 PID 记录保留到服务清理完成；退出通过正常返回执行析构，不跳过语言服务、扩展宿主等资源的清理。
- `src/managed/registry.rs` 拥有目录服务组合，以及共享队列与自动化运行。
- 目录初始化在连接任务中执行，同一目录只初始化一次；目录注册表只保护查找与发布，不在全局锁内执行初始化、终端统计或队列检查。
- 先取得 profile 端点，再启动后台工作，避免并发启动重复运行任务。
- daemon crate 提供进程管理和控制端点机制，App Server 依赖它；依赖方向保持单向。
- 历史已移交的 Profile 只启动执行服务，不打开 Agent 恢复、队列或自动化。原历史仍可读取，
  任何旧写入方都不能继续修改它。
- Agents 网关先按本地持久 ID 查找 Session/Thread；已导入的 SSH 历史由本地后端读取。
  导入回执中的宿主退出旧远端 Agent 目录发现，已验证的 runtime 配置继续供执行服务使用。

## grep

- 宿主持有公共搜索配置并创建 [`grep`](../grep/README.md) 与 [`file-search`](../file-search/README.md)，分别注入使用者；依赖关系见[搜索架构](../../docs/search.md#目标依赖关系)。
- Agent 工具只负责授权和模型输出（100 行、每行 500 字符）；编辑器使用分页任务与 UTF-16 高亮适配。
- Codebase 检索服务消费文字匹配候选；源码与 chunk 管理不持有搜索引擎。
- 搜索及索引管理使用 `grep/search/*`、`grep/index/*`；查询支持索引或当前磁盘模式，分页返回实际模式。
- 验证命令：`just test ash-app-server --lib grep`。
