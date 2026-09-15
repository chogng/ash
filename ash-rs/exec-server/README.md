# ash-exec-server

执行环境的能力与依赖边界；App Server/Core 保持唯一的任务业务状态。

- 管理受沙箱限制的进程、输入、取消、超时和有界输出。
- 提供同一处理器的进程内调用与鉴权 TCP 调用。
- 按宿主目录授权读写文件，覆盖写入必须匹配当前版本。
- 管理桌面交互式 PTY、输出字节缓存、连接释放与重连租约。
- 不保存 Session、Thread、Turn、Agent、模型和审批状态。
- 依赖方向：App Server/tool-executor → exec-server → sandboxing/file-system/utils-pty；协议独立于实现。

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
- 进程始终经过 MXC 沙箱，网络关闭；客户端不能扩张权限。
- 仅监听回环地址；跨机器连接使用宿主管理的 SSH 等加密隧道。
- 启动输出包含地址、环境身份和协议版本，不包含 token。
- SIGTERM/SIGINT 关闭连接处理器并取消、回收活动进程。
- 文件 API 的路径相对宿主授权根目录，不能使用客户端本机路径。
- 客户端固定服务实例 ID；服务重启后拒绝旧实例上的操作。
- 进程记录不依赖 TCP 连接；终态及输出保留一小时，最多 1024 条记录、32 个活动进程。
- 保留期内相同操作 ID 与参数返回原执行；不同参数返回冲突。客户端不重发启动或写入，响应丢失后只查询；无法确认时报告结果未知。

App Server 设置 `ASH_EXEC_ENVIRONMENTS` 指向配置文件：

```json
[{"environment":"worker","address":"127.0.0.1:9001","token_file":"/secure/client-worker.token"}]
```

`address` 是本机隧道入口；token 文件属于宿主配置。Core 的 `environment` 工具显式选择环境，
经过原有审批后执行命令或文件操作，结果写回原 Thread。进程 ID 包含 Session/Thread/Turn/工具调用身份。
Rust 宿主也可以通过 `LocalAppServerOptions::with_execution_environments` 装配本地或远程环境。

## PTY 边界

- `terminal::TerminalService` 承接原 terminal-service 的完整桌面 PTY 生命周期。
- TCP 进程接口支持管道与受限 PTY；`processStart.input` 选择 `terminal` 并提供行列数，后续可写入、调整尺寸、中断或取消。
- 宿主通过 `MxcSandbox::with_pty_helper` 提供内部启动器；App Server 嵌入方使用 `LocalAppServerOptions::with_pty_helper`。未配置时拒绝受限 PTY。
- PTY 由执行宿主分配，内部启动器继承终端后交给 MXC；目录、网络及文件身份约束保持有效。
- PTY 标准错误合并到标准输出；半关闭输入不适用于 PTY，调用方应发送终端 EOF 字符或取消进程。
- 桌面 Terminal API 继续通过目录授权调用；不将桌面交互式终端作为远程沙箱命令的替代执行路径。

协议、大小限制及错误见 [exec-server-protocol](../exec-server-protocol/README.md)。

```sh
just test ash-exec-server
just rust-warnings ash-exec-server
```
