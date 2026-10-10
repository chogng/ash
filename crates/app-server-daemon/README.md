# `ash-app-server-daemon`

- 管理独立的 `ash-app-server --managed` 进程，记录其 PID、启动身份、可执行文件摘要和随包 `buildId`。
- 串行化生命周期操作，所选服务探测成功后才返回 ready。Agent 连接验证 initialize 和必需能力；Execution 连接验证执行协议，不打开 Agent 历史。普通 start/connect 复用同一 profile 已运行且协议与必需能力兼容的进程；`ensure-selected` 在可执行文件内容变化时更换运行代次，`restart` 总是更换运行代次。
- 提供同用户控制端点与 stdio 连接程序；`ManagedEndpoint` 由后台服务进程持有。
- `ManagedEndpoint` 非阻塞轮询连接握手与控制响应，同时最多保留 32 个待完成握手，每个握手期限为 5 秒；未完成握手不会阻止其他连接或停止命令，也不增加握手线程。
- 停止宽限期继续响应控制请求并拒绝新业务连接。生命周期 API 返回 `LifecycleError::ServerShuttingDown`；stdio 连接程序将其作为初始化请求的 JSON-RPC 错误返回，保留请求 ID，错误码为 `-32600`、`data.kind` 为 `ServerShuttingDown`，由客户端决定是否重试。
- `ManagedEndpoint` 在运行期间每秒检查日志，超过 1 MiB 时在原文件上清空；后台继承的 stdout/stderr 文件句柄继续可写，无需重启。该限额是按轮询周期维护的预算，周期内的写入可以暂时超过限额。
- 启动失败时终止并回收新子进程，仅清理该代记录；仍存活或已被后继进程替换的记录受到保护。
- Windows 通过同一进程句柄读取创建时间、验证身份、终止并等待退出；后台启动要求脱离控制程序的 Job。Unix 验证启动身份后终止。
- App Server 持有目录服务、队列和自动化运行；本 crate 的正常依赖不包含 App Server 实现。

## 命令与路径

- `ash-app-server-daemon connect` 取得共享 profile 服务连接并代理 stdio。
- `ash-app-server-daemon start|update|ensure-selected|restart|stop|version` 输出单行 JSON；`pid` 是实际后台进程 PID。`version` 同时报告 `daemonVersion` 和已选中的 `installedVersion`，便于看出更新是否还在等待重启；后台未运行时，`daemonVersion` 是本次调用程序的版本。
- 发布包首次连接时，后台将完整的、包含独立 JavaScript 运行环境的调用方安装包复制到 `ASH_HOME/app-server-packages`，并从其中启动服务。后续普通连接只使用该 profile 选中的后台版本。`ensure-selected` 明确安装并固定调用方构建；相同时复用，不同时先结束旧进程再启动新进程。开发命令 `just ash-code` 和 `just ash-package-run` 使用它选择开发构建。切换可能中断旧进程中的任务。
- 含有可信更新公钥的 release 后台运行一分钟后检查 stable 版本，随后每小时检查一次。检查在后台进程内进行，不另起常驻更新进程；下载和安装不打断当前任务。新包在后台自然退出后下次启动生效，也可明确执行 `restart`。显式固定的构建不被自动检查覆盖。
- `update` 用调用方安装包中的公钥验证独立发布的 App Server stable 描述和归档，再安装并选中较新的完整后台包。它也会取消显式固定，恢复 stable 自动检查。App Server stable 版本可独立于 Code stable 版本提升。
- `ASH_APP_SERVER_PATH` 显式选择后台可执行文件，必须是绝对路径；默认使用控制程序同目录的 `ash-app-server[.exe]`。
- 发布产品通过 `ASH_APP_SERVER_SHA256` 传入后台程序的预期摘要，匹配后才启动；开发 generation 使用实际内容身份。
- `--product-services PATH` 显式指定产品服务配置；profile 路径和随包资源发现由 `install-context` 提供。
- 包租约覆盖启动交接，后台服务自己持有运行期间的租约。
- Desktop 开发重载通过准备包中的 `lease-development <current.json 的绝对路径>` 取得构建租约。命令持有 `publish.lock` 完成读取与租约获取后输出单行 `{ "runtime": "绝对路径" }`，直到 stdin 关闭才释放租约；Electron 在旧连接停止和新进程启动期间持续持有这条管道。

本地端点按 profile 固定，不随产品包版本、schema hash 或后端文件摘要变化。它使用 [`ash-uds`](../uds/README.md) 的私有目录和同用户校验。不同版本安装通过 initialize 校验协议主版本、生成协议指纹和必需能力可用性；schema hash 不同会拒绝连接。普通 start/connect 遇到协议不兼容时连接失败；只有明确的 `ensure-selected` 或 `restart` 会替换后台进程。协议不兼容的旧客户端需要更新后才能使用新后台。控制程序不需要长期驻留；每个窗口保留自己的连接。

## SSH 连接范围

Desktop 的 Remote 窗口同样连接本地共享后端；每个连接通过版本 2 prelude 提交经过校验的
SSH host、可选远端目录和精确 runtime 路径。远端路径不会成为本机目录授权。本地后端创建并
持有该连接的 OpenSSH stdio 子进程，Main 只启动本地 connector 并透明转发。
连接关闭结束对应 SSH 子进程，其他窗口和共享后端继续运行。

命令环境使用 `ASH_REMOTE_HOST`、`ASH_REMOTE_ROOT` 和 `ASH_REMOTE_RUNTIME`；host 与 runtime
必须同时提供，不能混入本地 `ASH_WORKSPACE_ROOT` 或 Agents role。启动共享后台进程时清除这些
连接字段，首个窗口不能决定后台进程的执行目标。健康检查始终使用无目录的本地连接，远端不可达
不会让其他本地窗口失效。

本地连接和控制请求继续发送版本 1 prelude，SSH 范围发送版本 2，执行连接发送版本 3。
后台控制响应报告版本 3；连接前检查对应范围的最低版本，旧后端明确拒绝不支持的范围。
App Server initialize 仍在独立协议连接上
校验业务协议兼容性。

## 验证

```text
just test ash-app-server-daemon --lib
just test ash-app-server --test managed_initialize --test managed_lifecycle
```

Windows 身份与终止测试位于 `src/process/windows_tests.rs`，须在 Windows 执行实测。
