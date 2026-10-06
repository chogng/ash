# `ash-app-server`

`ash-app-server` 组合一个环境中的服务并实现 App Server 协议，具体职责如下：

1. 分发类型化协议，管理请求取消、产品会话组织和通知订阅。
2. 通过 `core-api::AgentRuntime` 调用 Agent 操作；Core 负责执行、重试、取消和恢复。
3. 在文件、搜索、Git、Terminal、语言服务和目录贡献入口校验 Permission，传递有效授权。
4. 组合 profile 配置、环境服务与 Core 实现；目录贡献只在获得对应授权后生效。
5. 在 Agent、Shell 和上下文压缩执行期间持有空闲防休眠租约，同一进程内的目录服务共享系统资源。
6. 为窗口装配通话、LiveKit 和音频设备助手；连接关闭时释放该窗口的通话资源。
7. 将产品 Turn 绑定到发起连接，通过生成协议委托该窗口编辑未保存文档。

`client_host` 管理双向宿主请求和 Turn 的连接身份；浏览器和文档领域各自拥有
`browser_host`、`text_document_host` 的领域状态与协议转换。文档工具只依赖
`ash-file-system::TextDocumentEditor`，不依赖 Renderer 模型或 App Server DTO。
前端模型与工作区编辑服务执行编辑器文档的版本检查、撤销和保存；文件工具成功返回前
保存受影响文档，后续命令可读到结果。`grep` 用同一连接的未保存文本替换对应磁盘结果。
同目录子 Turn 在开始运行前继承原连接；独立 checkout 和后台任务显式使用磁盘文档接口。
父 Turn 完成不会释放仍在运行的子 Turn 绑定。
绑定窗口关闭后，工具失败；提交回复丢失时报告不确定结果。没有文档能力或
产品连接的执行明确使用磁盘工具，现有磁盘格式和版本校验继续生效。

连接建立、鉴权和消息队列由 `ash-app-server-transport` 负责。Core 契约和装配边界见
[`Core 架构`](../../docs/core.md#7-依赖边界)。

## 请求执行与容量

直接连接与 Agents 网关的本地请求共用 `server/request_dispatch.rs`。`server/request_processing.rs` 负责参数边界、取消登记和响应收尾；领域处理器负责 DTO 转换和调用所属领域服务。共享进程不要求全部操作使用同一种执行方式。

请求先按协议声明的资源范围排队，取得执行资格后执行；同一资源的修改按接收顺序串行，允许共享读取的方法可以并发，但不越过已等待的修改。每条直接连接使用一个执行器，一条网关的已打开本地路由共用一个执行器。

| 范围 | 普通请求 | 控制请求 | GitHub 网络请求 |
| --- | --- | --- | --- |
| 单个连接执行器 | 64 | 独立保留 16 | 包含在普通额度中，最多 8 |
| 同一后台进程 | 256 | 独立保留 64 | 包含在普通额度中，最多 32 |

请求额度覆盖资源等待、执行、网络等待和响应交付。耗尽时返回 `ServerOverloaded`，不在消息读取线程中等待容量。每个进程最多同时持有 64 个请求执行器；超出时关闭新连接，避免连接数量无限增加工作线程。窗口关闭只结束自己的请求，共享进程继续服务其他窗口。

GitHub 仓库 API 的异步处理器位于 `server/request_processors/github.rs`，只依赖 GitHub 凭据供应商与 HTTP 服务，不持有 App Server。全进程共享一个两线程异步执行器，底层同步 HTTP 使用最多 32 个阻塞线程；等待网络不占交互、后台或控制工作线程。领域处理器声明其网络方法，注册表覆盖测试要求新增 GitHub 仓库方法同步声明执行方式。账户连接和账户列表使用账户管理服务；取消由发起连接的操作 ID 处理。

同步业务操作仍使用每个执行器的两个交互线程、一个后台线程和一个控制线程。网络提交及完成另由一个连接工作线程处理，响应交付不会阻塞共享异步执行器。同步通知和遥测的线程上下文不跨越异步等待。同步嵌入接口 `handle_json` 调用同一个 GitHub 异步处理器并等待完成；产品流连接使用异步调度。

取消与断线等待实际 HTTP 工作结束后回收资源；已经开始的写入保留领域报告的成功或不确定结果，不自动重放。资源许可在响应交付前释放，避免慢连接占住其他连接的仓库许可。

`initialize` 仅按当前连接串行，不等待其他领域的全局写许可，避免长请求阻止新窗口完成协议初始化。

Git 请求按实际仓库公共目录排队，默认仓库选择、显式 repository ID 和 linked worktree 使用同一身份；同一仓库的读写按接收顺序串行，因为读取也更新状态缓存或游标并取得仓库操作锁。此排队跨目录运行时生效，不占用执行线程等待，也不阻止其他仓库或普通查询。后台提交仍使用 Git 领域已有的仓库操作锁。

`git/clone` 在后台执行队列运行，不取得全局许可。Git 领域在启动子进程前原子创建目标目录；并发克隆领取不同目录，父目录别名不会绕过这个约定。失败或取消只清理空的目录预留，保留部分克隆数据。`clone`、`fetch`、`pull`、`push` 观察发起请求的取消信号；socket 断线时结束 Git 进程树和管道读取，并退出仓库操作锁及运行时锁的等待。取消可能发生在 Git 已修改仓库之后，不回滚已完成的更改；后续读取重新查询状态。自动 fetch 使用自己的生命周期信号，停止 watcher 时取消正在进行的 fetch。

Agents 的本地目录服务由 profile 注册表的固定启动线程池解析路径并打开；每个 profile 最多同时执行 4 项、排队 32 项启动工作，并保留 64 个待完成目录等待容量；同一规范化目录的请求共享初始化结果，不占用额外启动线程。`managed/gateway/local.rs` 只等待共享服务并初始化自己的连接，不在网关读取循环中执行磁盘操作。每条网关连接最多持有 32 个本地路由；每个路由最多接纳 64 个普通请求和 16 个控制请求，包括启动等待及响应尚未交付的请求。打开后的路由共用网关的执行线程。目录启动失败完成该路由请求，其他路由继续运行；断开时停止接纳请求，取消已打开连接，并立即退出尚未完成的目录等待，不执行积压请求。共享初始化继续服务其他连接；已取消且尚未开始的启动提交直接跳过。注册表退出时回收启动线程；已经进入操作系统的同步文件操作不会因单个窗口关闭而被强行中断。

Agents 的 SSH 路由由 `managed/gateway/remote.rs` 拥有独立消息队列和子进程。每条网关连接最多持有 32 个远端路由，每个路由分别保留 64 个普通请求、16 个控制请求的未完成容量，并为宿主回复单独保留 16 个待写消息容量；普通请求容量耗尽返回 `ServerOverloaded`。宿主回复先于控制请求写入，控制请求先于普通积压请求写入，各组内部保持接收顺序。已经阻塞的管道写入不能被优先队列抢占；关闭路由时终止子进程以唤醒写入。宿主回复或订阅转发无法入队时只关闭对应路由，结束其未完成请求。SSH 初始化写入和回复共同受 10 秒期限约束，管道读写不占用网关请求读取线程。超时、远端退出和窗口断开结束该路由的请求并终止、回收子进程；其他路由和本地请求继续执行。

请求还受保留消息的字节预算约束。全进程共同限制保留的普通输入为 320 MiB、控制输入为 16 MiB；直接连接同时独立计数；同一网关的 profile、本地和 SSH 路由共用普通请求 320 MiB、控制请求 16 MiB、SSH 宿主回复 320 MiB 的预算。本地请求从等待到响应交付完成持有输入预算；SSH 消息从入队到管道写入完成持有预算。路由间转交不重复计数，初始化消息的路由副本共享同一份原始内容。预算保留单条最大合法编辑器消息的空间，并限制多条大消息同时积压；这些数值计量序列化消息大小，不是进程总内存上限。

后台通知独立于请求执行发送；一个请求直接产生的通知仅在该请求的响应入队后发布。Session 修改期间，该 Session 的后台事件也等待响应入队，保留 response-before-causal-notification 约定；其他 Session 的事件与宿主调用继续发送。响应与通知使用同一有界输出队列，最多 256 条消息、320 MiB；正在写入的消息也占用字节预算，写入失败唤醒等待容量的生产者。每条连接的通知源、请求因果事件和 Session 延后事件另共用 320 MiB 预算；耗尽时按已有约定清理临时事件并发布 transcript reset，无法容纳持久事件时关闭通知源。输出背压不保留跨连接共享的资源许可。Socket 断线时取消排队和运行中的请求，并唤醒待回复的宿主调用；有限的 stdio 输入结束后继续处理已接收请求，但不再等待宿主回复。

RPC trace 从请求接收开始计时，记录资源等待、执行队列等待、执行和进入输出队列的等待；`rpc.outbound` 子 span 记录输出队列等待与实际写入耗时。并发回归可运行 `just test ash-app-server --lib request_dispatch`、`just test ash-app-server --lib github` 和 `just test ash-app-server --lib managed::gateway`。测试覆盖并发挂起 GitHub 请求时的查询与取消、断线清理、跨连接容量、路由副本字节计数和写入终态。

交互式 PTY、输出缓存和重连租约由 [`ash-exec-server`](../exec-server/README.md) 管理；
`src/server/terminal_operations.rs` 负责协议转换和调用，环境装配负责传入有效授权。

配置监听分别处理 profile 状态提交和目录配置更新，订阅后先应用当前状态，覆盖初始装配与
监听启动之间的变化。运行时使用 ConfigStore 已提交的 profile 快照；用户或目录文件的损坏编辑
不会阻塞 plugin、connector 与 MCP 的独立状态更新。目录配置每次读取都检查当前 `LoadConfig`；
首次授权与撤销无需重启。有效目录配置恢复后再更新环境服务。
目录执行、调试配置读取和扩展发现分别检查自己的权限；缺少调试或扩展权限不阻止已获准的目录执行服务启动。
会话目录 hooks 在全部获准配置读取成功后统一替换，读取失败不会提交空注册列表；授权撤销仍在调用时检查。
语义索引重建先准备新资源，成功后替换工具和监听；失败保留当前服务。删除 grep 索引只更新
grep 后端，不重建或移除目录执行规则。

环境和目录授权语义见 [`docs/environment-access.md`](../../docs/environment-access.md)，wire contract 见
[`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

```text
just test ash-app-server
```

Windows 的后台进程生命周期集成测试使用 `just test-processes ash-app-server --test managed_lifecycle`，避免 Cargo 的测试 Job 阻止后台独立存活。入口及过滤方式见[构建测试说明](../../docs/build.md#测试)。

## 模型上下文预算

`src/local/model_context.rs` 统一解释模型容量：模型列表、普通请求、历史压缩和辅助模型读取同一份规则。Provider 提供静态模型规格和按连接隔离的发现结果；模型列表和执行读取当前连接已缓存的发现结果，读取预算不会请求远端目录。

- ModelsManager 计算有效窗口和压缩阈值。单模型声明优先于自定义连接默认值；配置不能超过目录的已知上限。GPT 未显式配置时使用 272k。
- App Server 先读取连接的输出配置，再读取 provider 声明的输出默认值；两者都未声明时使用产品的 4,096 token 上限，并预留 1,024 token 安全余量。Core 将这个输出上限写入实际请求，再执行输入分配、测量和压缩。
- 目录上限、有效窗口和可用输入预算分别通过已有模型字段返回。目录没有声明上限时保持未知，不把产品可选档位当作模型真实上限。
- 窗口未知或输出、压缩预留导致没有输入空间时，模型仍可列出；执行在调用 provider 前以 `ModelConfiguration` 失败，保留具体配置原因，不重试。
- 每轮执行冻结配置和目录信息。后续配置修改或目录刷新不能改变正在执行的预算；辅助模型使用同一轮冻结的目录和配置。

验证：`just test ash-app-server --lib local::tests`，覆盖单模型配置、未知容量、真实 Core 执行、输出预留与目录刷新隔离。

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

## 远端 Agent 消息板

App Server 按 profile 的 `messageBoard` 配置选择本地存储或外部消息板服务，沿用 `board_read` 与 `board_write` 的授权和参数。默认使用本地存储，同一 App Server 内的主代理和子代理可直接共享消息板。远端模式要求已有服务实现客户端协议；Ash 提供客户端接入，不提供独立消息板服务。配置、接口约定和通知生命周期见 [扩展文档](../docs/extensions.md#远端客户端)。

## 跨机器任务

持久 profile 的目录运行时安装 `remote_task_targets/send/list/read`，通过已保存的 SSH 连接把代码
快照和验收要求交给目标机器。接收端提供 version 1 `taskDelivery` contract，以现有 Core、Queue
和隔离工作目录创建独立 Session；状态和报告通过同一 SSH route 查询。包和回执归
[`task-delivery`](../task-delivery/README.md)，App Server 只组合领域流程、目录权限、协议和传输。
