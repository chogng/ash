# ash-exec-server

执行环境的能力与依赖边界；App Server/Core 保持唯一的任务业务状态。

- 管理受沙箱限制的进程、输入、取消、超时和有界输出。
- 提供同一处理器的进程内调用、鉴权 TCP 调用和宿主已鉴权的 SSH 执行连接。
- 按宿主目录授权读写文件；10 MiB 文件分块传输，覆盖写入必须匹配当前版本。
- 管理桌面交互式 PTY、输出字节缓存、连接释放与重连租约。
- 不保存 Session、Thread、Turn、Agent、模型和审批状态。
- 依赖方向：App Server/tool-executor → exec-server → sandboxing/file-system/utils-pty；协议独立于实现。

## 构建边界

- 工作区消费者关闭默认 feature，使用执行库、客户端和 PTY 服务。
- `server` feature 启用独立可执行入口及其安装、包租约、内部启动器和进程加固依赖。
- `local-sandbox` feature 提供统一的 `LocalSandbox` 入口，集中配置 MXC 与 Windows 账户候选及 PTY 启动器；App Server、Hook 和独立服务共用它。
- 直接构建本包默认启用 `server`；现有开发与发布打包入口继续构建 `ash-exec-server`。
- 本地调用直接进入处理器；Workspace 索引、搜索与 Git 不进入执行协议。

## 进程所有权

- `execution::ProcessExecutor` 拥有执行准备、进程会话、输出游标、终态、超时及资源清理。
- `process.rs` 只维护远程操作 ID、请求去重、宿主授权及保留期；直接读取执行器中的输出和状态。
- `ProcessSessionOwner` 是调用方提供的不透明凭据；执行服务不解释 Thread 或审批语义。
- `tool-executor` 在调用本 crate 前实施审批，并把工具身份映射为凭据。
- 普通观察接口返回已结束结果后释放本次会话；远程保留接口一直保存结果，直到保留期清理或明确释放。

## 启动与连接

先在执行宿主创建一个仅宿主用户可读的文件，内容为随机生成的 64 位十六进制 token。

```sh
ash-exec-server --listen 127.0.0.1:9001 --root /work/project --environment worker --token-file /secure/worker.token --access read-write
```

- 参数按上述顺序传入；`read-only` 禁止文件写入，`read-write` 允许授权目录写入。
- Windows 注册 MXC、账户沙箱候选，其他平台注册 MXC；网络关闭，客户端不能扩张权限。
- 独立入口保持严格隔离策略；缺少 PSEC 时账户候选也会拒绝，不降低要求或重跑命令。
- 仅监听回环地址；跨机器连接使用宿主管理的 SSH 等加密隧道。
- 启动输出包含地址、环境身份和协议版本，不包含 token。
- SIGTERM/SIGINT 关闭连接处理器并取消、回收活动进程。
- 文件 API 的路径相对宿主授权根目录，不能使用客户端本机路径。
- 客户端固定服务实例 ID；服务重启后拒绝旧实例上的操作。
- 客户端复用连接，最多保留四条空闲连接；并发请求独立借用连接，长等待不占用连接池锁。
- 空闲连接在下次调用时按两秒期限淘汰；服务读写超时为五秒，停止服务时主动关闭连接并回收处理线程。
- 进程记录不依赖 TCP 连接；终态及输出保留一小时，最多 1024 条记录、32 个活动进程。
- 保留期内相同操作 ID 与参数返回原执行；不同参数返回冲突。客户端不重发启动或写入，响应丢失后只查询；无法确认时报告结果未知。

App Server 设置 `ASH_EXEC_ENVIRONMENTS` 指向配置文件：

```json
[{"environment":"worker","address":"127.0.0.1:9001","token_file":"/secure/client-worker.token"}]
```

`address` 是本机隧道入口；token 文件属于宿主配置。Core 的 `environment` 工具显式选择环境，
经过原有审批后执行命令或文件操作，结果写回原 Thread。进程 ID 包含 Session/Thread/Turn/工具调用身份。
Rust 宿主也可以通过 `AppServerOptions::with_execution_environments` 装配本地或远程环境。

本地 Agent 也可以直接使用 SSH 执行环境，不需要创建 TCP token 或手工开隧道：

```json
[{"environment":"worker","host":"build","root":"/work/project","runtime":"/opt/ash/bin/ash-remote-server"}]
```

`runtime` 必须是已安装包内的绝对可执行路径；`host` 使用本机 OpenSSH 配置和 SSH agent。
可选的 `ssh_executable` 由宿主配置选择本机 OpenSSH。配置必须完整指定一种传输；混合字段和
未知字段会被拒绝。SSH 客户端运行在 Rust 后端，模型只能选择已装配的执行环境。
远端通过 `execution-connect worker` 进入共享 profile 进程中的独立执行连接，不接受 Agent RPC。
同一环境 ID 固定到远端的规范目录；其他目录不能复用这个 ID。连接重建保持原实例 ID，
活动命令阻止宿主按空闲期限退出。一个宿主最多保留 64 个执行环境，每个客户端最多同时使用
32 条连接；单次 SSH 读取等待最多 15 秒，写入最多 5 秒。失败连接被释放，不自动重发请求。

这条执行能力可供本地 Agent 使用。旧历史已有 [一次性移交入口](../remote-server/README.md#history-ownership-transfer)，
移交后远端只启动执行服务；Desktop Remote 默认入口及自动迁移尚未切换。

App Server 每次观察最多等待 500 毫秒，输出变化或进程结束时提前返回。读取连接失败后，
允许在五秒恢复窗口内发起新的观察；单次网络调用仍受传输超时限制。恢复保持原实例、操作 ID
和输出游标，不重发启动、文件写入或控制请求。取消后继续查询终态，未确认终态则报告结果未知。
这不提供服务重启后的进程恢复，也不改变远端 App Server 的部署方式。

## 文件传输

`ExecClient` 和 `ExecutionEnvironment` 的 `read_file` / `write_file` 使用同一宿主处理器。
读取绑定首个范围的磁盘版本，途中变化会拒绝整个读取。写入先上传有界字节块，完整内容
通过摘要校验后才条件发布；取消和未完成上传不会改动工作区文件。客户端不重发上传块或提交，
提交响应丢失后只查询原操作结果。Begin/Chunk 阶段断线报告文件尚未发布；发布过程中
的 IO 错误报告结果未知。该结果记录属于执行实例，重启不继承。

Core 继续拥有审批、调用身份与 ToolResult；操作 ID 包含执行实例、Session、Thread、Turn
和工具调用身份。准备审批时不创建上传资源，获批后才开始传输。磁盘版本检查由
file-system 实施；编辑器的未保存内容和外部变更冲突仍由前端 working copy 处理。

## PTY 边界

- `terminal::TerminalService` 承接原 terminal-service 的完整桌面 PTY 生命周期。
- TCP 进程接口支持管道与受限 PTY；`processStart.input` 选择 `terminal` 并提供行列数，后续可写入、调整尺寸、中断或取消。
- 宿主通过 `MxcSandbox::with_pty_helper` 提供内部启动器；App Server 嵌入方使用 `AppServerOptions::with_pty_helper`。未配置时拒绝受限 PTY。
- PTY 由执行宿主分配，内部启动器继承终端后交给 MXC；目录、网络及文件身份约束保持有效。
- PTY 标准错误合并到标准输出；半关闭输入不适用于 PTY，调用方应发送终端 EOF 字符或取消进程。
- 桌面 Terminal API 继续通过目录授权调用；不将桌面交互式终端作为远程沙箱命令的替代执行路径。

协议、大小限制及错误见 [exec-server-protocol](../exec-server-protocol/README.md)。

```sh
just test ash-exec-server
just check ash-exec-server --no-default-features --lib
just rust-warnings ash-exec-server
```
