# Windows sandbox service

`ash-windows-sandbox-service` 管理 Ash 的 Windows 账户沙箱安装。它是独立 SCM 服务，产品包将它与 `ash-windows-sandbox.exe` 一同构建、校验和签名。MXC 不参与这个服务的安装或协议。

服务名为 `AshWindowsSandbox`，管道为 `\\.\pipe\AshWindowsSandbox`，程序位于系统 ProgramData 下的 `AshWindowsSandbox/bin`。这些身份独立于 Codex。服务不接受任意命令、用户 SID 或删除根目录；协议只包含具体管理操作，未知字段和版本均拒绝。

协议类型由 [`provisioning.rs`](../windows-sandbox/src/provisioning.rs) 定义，客户端和服务共用这份 Rust 定义。版本为 2；每条消息是四字节小端长度加 JSON，长度上限为 64 KiB。客户端完整读取并解析响应后发送一字节收讫确认，服务才断开管道，避免丢失尚未读取的响应；响应和确认合计限时十秒。服务安装和卸载属于管理员安装器，不接受管道请求。

客户端从 SCM 查询服务进程，检查管道所属 PID 与服务程序路径，并持有经过权限检查的程序文件。服务拒绝远程管道连接，模拟 Windows 认证的客户端令牌，拒绝受限令牌和只有身份查询权限的令牌。账户、网络和更新操作还要求调用者具有管理员权限并批准当前完整清单；服务不会替普通客户端取得管理员权限。认证线程上没有异步挂起，操作完成后恢复原线程身份。

服务在报告运行前设置自身进程权限：System 和管理员保留管理权限，普通用户组仅有 `PROCESS_QUERY_LIMITED_INFORMATION`，供客户端核对程序路径。LocalSystem 的默认进程权限可能拒绝普通调用者的这项查询；不能通过删除程序路径认证来处理。进程内存、句柄复制、线程创建、终止及权限修改均不授予普通用户。

管道客户端只有读取和写入数据权限，不能创建额外服务端实例。每次连接使用新的管道实例，避免沿用上一次连接缓存的 EOF；服务先创建下一实例，再断开并释放旧实例，交接期间持续持有管道名称。

管理员持有安装目录和程序，其他用户只有读取及执行权限。复制程序时直接创建具有最终权限的文件，不能先继承源文件的用户可写权限再修正。安装记录与程序不允许普通用户改写；账户凭据仍以所属用户的 DPAPI 身份加密。

在已授权的管理员 PowerShell 中，从产品包的 `bin` 目录执行：

```powershell
$servicePlan = .\ash-windows-sandbox-service.exe plan install | ConvertFrom-Json
.\ash-windows-sandbox-service.exe install --approve $servicePlan.sha256
$setupPlan = .\ash-windows-sandbox.exe plan setup --slots 1 | ConvertFrom-Json
.\ash-windows-sandbox.exe setup --slots 1 --approve $setupPlan.sha256
.\ash-windows-sandbox.exe status
```

服务程序更新使用新版产品包重新生成 `plan install` 并批准执行。它等待正在处理的管理操作结束，然后替换服务程序，账户和网络对象保留。账户运行器更新分别使用 `plan update` 和 `update --approve SHA256`；有执行租约或未恢复的执行记录时拒绝更新。中断更新需要重新生成清单并明确处理。

删除时先对每个所属用户执行 helper 的 `plan remove` 与 `remove --approve SHA256`，再执行服务的 `plan uninstall` 与 `uninstall --approve SHA256`。服务目录仍有任何用户运行时就拒绝卸载。删除只处理已知安装布局，异常数据保留供检查。

初始化在提交状态前中断时，删除清单只允许处理初始锁和加密暂存文件，此时尚未创建账户或网络对象。已提交的安装则按状态记录删除；不能把读取或解密失败当作可以直接删除的依据。

普通测试覆盖真实本地管道、连续连接、延迟读取、禁止客户端创建服务端实例、调用者身份、拒绝低权限及受限令牌、请求大小和线程身份恢复，不注册 SCM 服务或创建账户。完整管理员验收使用已获授权的 [`scripts/test-windows-sandbox.ps1`](../../scripts/test-windows-sandbox.ps1)。2026-10-02 在 Windows 11 23H2 x64 的提升权限令牌下，服务安装、账户执行、运行器更新、服务程序替换与重启、账户和 WFP 对象保留，以及卸载清理均通过；具体用例、源码和证据见 [本轮验收记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-服务及账户管理员验收)。
