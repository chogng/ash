# Windows sandbox

- 实现 Windows 专用账户、限制令牌、文件授权、WFP 网络限制与进程树回收。
- 隔离 Windows API 依赖，消费 `sandboxing` 的统一策略和 `install-context` 的安装身份。
- 安装、更新和删除通过独立 Windows 服务执行，必须提供当前变更清单的摘要；普通执行不自动安装或修复。
- 每次执行独占账户、随机文件 SID、Job、桌面、代理路由和 ACL 恢复记录。
- 产品包提供执行 helper 和管理服务；运行时校验 helper 路径与 SHA-256，不搜索 PATH。

2026-10-02 在 Windows 11 23H2 x64 完成了新版服务路径的管理员实机验收：34 项账户单测、9 项服务测试和 10 项完整执行用例全部通过，运行器更新后复测全部执行用例，服务程序更新后再验证实际执行。服务、账户和安装目录已清理，WFP 删除逐项查询确认；具体证据见 [本轮验收记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-服务及账户管理员验收)。随后安装 WSL2 并重跑完整入口，额外验证受限账户在禁止与允许网络下均不能进入调用者发行版或系统发行版；普通调用者的相同命令先成功执行，见 [WSL 记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-wsl2-实机验收)。这些结果不证明 PSEC 或其他 Windows 系统通过，也不代表全部 WSL 入口已穷尽。

| 归属 | 职责 |
| --- | --- |
| `windows-sandbox` | 账户、令牌、WFP、ACL、PTY、进程树及执行租约的 Windows 实现；helper 通过管理管道请求安装操作 |
| [`windows-sandbox-service`](../windows-sandbox-service/README.md) | SCM 注册与生命周期、管理员持有的服务程序、本地管道认证，以及管理请求的调用者权限 |
| `mxc-sandbox` | 独立 PSEC、Seatbelt、Bubblewrap 适配器；不承担旧版 Windows 的账户安装 |

服务运行器和账户状态位于系统 ProgramData 下的 `AshWindowsSandbox`。账户状态仍以调用者的 DPAPI 身份加密；服务在同一操作系统线程上模拟经过认证的管道调用者完成管理操作。管理员持有状态和运行器的所有权，调用者只读；执行租约、运行目录和 ACL 日志具有各自所需的写权限。

运行器更新先独占安装锁及全部账户租约，再记录新程序摘要并替换文件，保留账户和 WFP 对象。中断后执行保持拒绝；新的明确更新或删除请求处理记录中的程序。版本 3 的旧账户目录不被版本 4 服务接管，升级前须用原 helper 的明确删除命令移除旧安装。

`FileSystemIsolation::WindowsAccount` 使用 Codex 的兼容令牌和有预算限制的可写路径审计，不承诺整个宿主只读。要求 `Strict` 时在启动前拒绝；未获授权的宿主审计修正不会自动执行。

`HostAclChanges::ScopedWithTraversal` 允许范围内的 ACL 调整，以及必要祖先目录的非继承属性查询和遍历。它不授予祖先目录枚举或文件读取权限。设备与命名对象目录授权已退出实现，普通执行不触发安装或提升权限。

直接进程参数按 Windows 参数规则序列化。`cmd.exe /C` 与 `/K` 后须传一个完整命令字符串；这段字符串按 cmd 语法保留内部引号，不能再用普通参数的反斜线转义，否则带引号的程序路径无法启动。

ConPTY 在创建它的账户运行器内保持整个生命周期，不能把 `HPCON` 当作内核句柄跨进程复制。私有管道传递有长度上限的输入、尺寸和中断，沿用 `utils/pty` 的 Windows 换行规则；输出合并为终端标准输出，标准错误管道保持为空。运行器在创建命令前恢复正常 Ctrl+C 策略，避免继承后台启动器的忽略设置。运行器的进程、令牌、已有线程和后续线程只授予调用者与 System 管理权限，账户的隐含所有者权限被抑制；受限命令不能注入或取得其账户令牌。终端及运行器与命令一起回收，正常退出则先关闭 ConPTY 并排空输出。管道模式仍在恢复用户命令前退出登录进程。私有运行器请求协议为版本 5；安装状态版本不变，更新仍校验程序摘要。

契约、审计限制与实机证据见 [沙箱架构](../../docs/sandboxing.md) 和 [Windows 验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。

```powershell
just test ash-windows-sandbox --lib --locked
just check ash-windows-sandbox --tests --locked
just rust-warnings ash-windows-sandbox
just test ash-windows-sandbox-service
just rust-warnings ash-windows-sandbox-service
python -B scripts/cargo.py build -p ash-windows-sandbox --bin ash-windows-sandbox --locked
bazel build //ash-rs/windows-sandbox:ash-windows-sandbox
```

需要真实账户的测试显式标为忽略，须在获准配置的验收环境执行。`scripts/test-windows-sandbox.ps1` 提供服务与账户安装、全部用例、运行器及服务程序更新后执行，以及 finally 清理入口；调用方须已获得安装与验收授权。

该入口构建 `terminal_probe` 并在运行器更新前后运行 `tests/terminal.rs`，覆盖管道持续输入、终端输入与尺寸、调用者归属、文件写入边界、运行器进程及线程权限，以及正常退出、Ctrl+C、取消、主动终止、释放执行器和超时后的进程回收。23H2 x64 的普通用户实机结果见 [账户模型及终端验收](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-codex-账户模型与交互终端验收)。

App Server 的 `windows_shell_turn_enforces_account_isolation_through_rpc` 用例从 RPC 创建 Session 和 Shell Turn，要求沙箱执行，检查已登记账户身份、真实 cmd → PowerShell 命令、目录边界、`.env`、Git 配置、退出码、单次执行及 ACL 恢复。它须在 PSEC 不可用、账户后端已明确安装的 Windows 环境中，以未提升权限的调用者运行；`ASH_WINDOWS_SANDBOX_BIN` 指向与该安装摘要相符的 helper。管理员运行会被测试拒绝，默认 CI 不包含这个 App Server 用例。

```powershell
just test ash-app-server --lib windows_shell_turn_enforces_account_isolation_through_rpc --locked -- --ignored --test-threads=1
```

可显式提供当前调用者已经能运行的 WSL2 发行版，增加 `wsl.exe --distribution` 与 `--system` 的账户边界回归。也可提供在宿主可达、支持 TCP/UDP DNS 的端点，增加 `tests/network_matrix.rs`；它验证 Denied/Managed/Allowed 的 IPv4/IPv6、HTTP/CONNECT/SOCKS 地址与域名授权、原始 A/AAAA DNS、后代继承和监听限制。`-NetworkPublicIpv6Http` 另验证可达公网 IPv6 的 HTTP 往返及直连和代理拒绝。每个目标先在沙箱外验证可达。本机已通过临时隧道出口的公网 IPv6 矩阵，文件作用域用例同时覆盖有无 `AI` 标记；具体证据见 [ACL 与 IPv6 复测](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-acl-恢复与公网-ipv6-复测)。默认 CI 入口不安装 WSL，也不把缺少 WSL 或 DNS 对照的机器算作这些用例通过。

```powershell
./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc -WslDistribution AshAcceptance
./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc -NetworkDnsServer '<resolver-ip>:53'
./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc -NetworkDnsServer '[2606:4700:4700::1111]:53' -NetworkPublicIpv6Http '[2606:4700:4700::1111]:80'
```

网络连接进程归属实现参考 Codex `da20788df913189878ebca7f4963d8a363ee6bf2`；对应许可与归属保存在 `LICENSE-APACHE` 和 `NOTICE`。文件 ACL 日志复用固定版本的 `wxc_common`，不引入 Codex 的协议或产品配置。
