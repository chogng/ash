# Windows 沙箱验收手册

本手册分别验证 MXC PSEC 路径和独立 Windows 账户实现，保留各轮实机证据。2026-10-02 的 Windows 11 23H2 x64 管理员验收已通过当前服务安装、更新、账户执行和清理；随后完成 WSL2 回归与 DNS/IPv6 网络矩阵。PSEC 在 Windows 11 25H2 ARM64 CI 上取得成功路径证据，本机 23H2 仍缺少能力。WSLC SDK 部分通过，一次性容器清理仍报错；Ash 尚未接入它。具体范围见 [补充验收](#2026-10-02-psecwslc-与网络补充验收)。
账户 CI 的 ACL 标记差异已修复并完成本机回归，公网 IPv6 的临时出口矩阵在 Windows 与 WSL 两种模式均通过，见 [ACL 与 IPv6 复测](#2026-10-02-acl-恢复与公网-ipv6-复测)。
实现契约见 [mxc-sandbox](../ash-rs/mxc-sandbox/README.md) 与 [windows-sandbox](../ash-rs/windows-sandbox/README.md)。历史账户原型的结果不能作为当前候选的通过证据。

## 当前入口

2026-10-02 起源码固定 MXC `46ce71d0da7b97bb531a33e175bf4166ffa730c0`，直接使用平台运行器及发布的 1.0 请求类型。下面 9 月 10–11 日的实机记录使用旧 pin `6cd3d58f05d3447e67109cfb75e042803b843ca4`，不作为新版验收通过证据。

当前 MXC Windows 后端只接受完整 PSEC 能力。此前的账户原型已退出源码和产品包，不能再通过 `mxc-user` 或 `tests/local.ps1` 安装它。独立实现使用 `ash-windows-sandbox`，安装与验收需要明确授权；通过依据是下述当前源码的实机记录，不能沿用旧原型的结论。

2026-10-02 新增独立 `ash-windows-sandbox-service` 后，账户验收脚本先安装 SCM 服务，再通过认证管道安装账户、执行用例、替换运行器并复测，然后替换服务程序、重启并验证执行，最后删除账户和服务。本机已完成这条管理员实机路径，证据见 [本轮验收记录](#2026-10-02-服务及账户管理员验收)。当前安装约束和操作入口见 [服务说明](../ash-rs/windows-sandbox-service/README.md)。

```powershell
just test ash-sandboxing --lib
just test ash-tool-executor --lib
just test ash-mxc-sandbox --lib --test windows
# 先探测实际 Ash 策略，再逐项运行 PSEC 成功路径；缺能力返回失败：
./scripts/test-psec.ps1
```

23H2 本机不能作为 PSEC 完整执行的通过证据。缺少能力时应在准备阶段拒绝，不转入旧账户原型或普通进程。
当前 PSEC 成功路径覆盖工作目录写入、参考目录只读、隐藏目录、元数据、真实退出码、执行身份隔离、取消与后代回收。Windows Managed 目前在准备阶段拒绝，测试覆盖代理策略存在和缺失时均不启动命令；不再保留与此实现相反的代理成功断言。

### GitHub Actions

[Windows sandbox acceptance](../.github/workflows/psec.yml) 在 main 或 `codex/psec-*` 分支相关文件更新时，使用 `windows-2022`、`windows-2025`（x64）和 `windows-11-arm`（ARM64）。每种系统独立运行 PSEC 检查与账户执行测试，任一失败不取消其他任务。Run workflow 的 `hosted` 运行全部托管机器，也可单独选择一种。

| 运行器 | PSEC 验收预期 | 账户验收 |
| --- | --- | --- |
| Windows Server 2022 x64 | 启动前明确返回能力不支持 | 实际执行、权限与清理 |
| Windows Server 2025 x64 | 启动前明确返回能力不支持 | 实际执行、权限与清理 |
| Windows 11 ARM64 | PSEC 准备及执行成功 | 实际执行、权限与清理 |

这是固定测试环境的预期，不是产品按版本分流的代码。产品仍按本次请求准备结果选择 MXC 或账户后端，严格策略不降低要求，启动错误不重跑。三种运行器的 PSEC 预期均已有 CI 结果，见 [补充验收](#2026-10-02-psecwslc-与网络补充验收)。镜像能力改变时测试应失败并要求复核，不能自动把失败变为通过。Windows 11 x64 和具体旧版客户端仍需对应运行器，不由 Server 或 ARM64 结果替代。

PSEC 检查不安装账户、不改变系统权限。`test-psec.ps1 -Capability absent` 只在适配器明确返回 `UnsupportedPolicy` 时通过；其他准备故障仍失败。默认 `required` 则必须先成功创建 PSEC 环境，再逐项运行命令、文件和生命周期测试，汇总全部失败。不存在的测试名不能计为通过。

账户任务在独立的临时托管机器上运行 `test-windows-sandbox.ps1`，按已有安装计划创建账户，执行测试，并在 finally 中移除安装；同时运行后端选择与禁止重跑测试。手动 `self-hosted` 只运行 PSEC 成功路径，要求 `self-hosted`、`Windows`、`psec` 标签，以及 PowerShell 7、Python 3.11+、Rustup 和 MSVC 工具链。

PSEC 报告包含系统版本、架构、工具链、MXC pin、各项退出码和输出。账户结果见独立任务日志及安装计划。能力不支持用例通过只证明拒绝行为，不是 PSEC 成功证明。PSEC ConPTY、完整网络矩阵、App Server 产品链路及 WSL 尚未纳入此任务。

## 2026-10-02 服务及账户管理员验收

Windows 11 专业版 23H2、build `22631.6199`、`x86_64-pc-windows-msvc`，使用提升权限的管理员令牌。最终完整入口运行于北京时间 07:21:11–07:22:26，结果为 `passed`；基线提交为 `30b68cfd25df87512d41e7af9a0170ffb0de7083`，实际运行还包含证据目录中 `source.diff` 保存的未提交修复。

| 验证 | 本机结果 |
| --- | --- |
| helper、服务和网络探针构建 | 全部通过 |
| SCM 安装、认证管道配置账户、状态查询 | 通过；账户仍存在时拒绝服务卸载 |
| 服务真实管道与安装权限测试 | 9 项通过、0 忽略 |
| 账户库测试，含真实登录与 ACL 恢复 | 34 项通过、0 忽略 |
| 文件与元数据、真实退出码、IPv4 代理、IPv6 断网、双账户并发、跨执行文件写入、取消及后代回收 | 10 项执行用例通过、0 忽略 |
| 运行器程序更新 | SHA-256 改变，账户及 WFP 对象不变；10 项执行用例再次全部通过 |
| 服务程序更新 | SHA-256 改变，SCM 停止、替换和重启成功，账户及 WFP 对象不变；文件、元数据与退出码执行用例再次通过 |
| 卸载清理 | WFP 删除逐项查询确认；独立检查服务不存在、安装目录不存在、没有新增账户残留 |
| 同机 PSEC 能力检查 | `test-psec.ps1 -Capability absent` 通过，结果为 `passed-unsupported-capability`；只证明准备阶段正确拒绝 |

更新验收通过在临时程序副本末尾添加一个 PE overlay 字节改变程序摘要，不改变协议或测试执行逻辑；它验证实际替换和重启流程，不是两个不同发布版本之间的兼容性证明。

实机验收发现并修复了三个产品问题：服务断开会丢弃客户端尚未读完的响应；复用管道实例会沿用上一连接缓存的 EOF；ACL 已恢复后留下的空日志目录被误判为未完成执行，阻止运行器更新。协议现为版本 2，响应增加限时收讫确认，每次连接使用新实例；管道客户端不能创建额外服务端实例。另将网络测试的端点文件改为写完后原子发布，消除读取未完成文件的共享冲突。对应回归与完整入口均通过。

本机证据位于 `.build/acceptance/windows-sandbox-service/run-20261002-072108/`：`result.json` 保存最终状态与清理断言，`verification.json` 保存程序摘要、对象保留核对及再次检查的清理结果，`acceptance.log` 保存完整命令输出，`source.diff` 保存实际修复，`plans/` 保存安装、两次更新与删除清单，`psec/` 保存能力报告和测试日志。这些文件是本机证据，不随源码提交。原始完整入口为 [`scripts/test-windows-sandbox.ps1`](../scripts/test-windows-sandbox.ps1)。

该结果限于本机 WindowsAccount 请求及以上用例。其他 Windows build、ARM64、PSEC 成功执行、完整崩溃恢复、App Server 产品链路和 WSL 未在本轮验收；WindowsAccount 仍不承诺整个宿主只读，`Strict` 请求在启动前拒绝。

## WSL 验收边界

Windows、WSL 2 中的 Linux 进程和 MXC 的 WSL Container（WSLC）是不同的执行路径，验收结果不能互相替代。

| 场景 | 验收要求 | 当前范围 |
| --- | --- | --- |
| Windows 版 Ash 执行 Windows 命令 | 按所选后端分别验证账户模型与 PSEC | WindowsAccount 的本机 23H2 服务路径已通过；同机 PSEC 能力不足，未执行成功路径 |
| Windows 受限命令调用 `wsl.exe` | 检查能否跨入 WSL 后越权访问文件、直连网络或留下存活进程 | 本机调用者发行版和 `--system` 入口在禁止/允许网络下均被拒绝；其他入口未穷尽 |
| WSL 2 内运行 Linux 版 Ash | 在 WSL 2 内执行 Linux 沙箱验收，并检查跨系统边界 | Ubuntu x64 的文件、生命周期、互操作，以及下述 NAT/mirrored DNS/IPv6 矩阵通过；PTY 未验证 |
| Windows 通过 MXC WSLC 启动 Linux 容器 | 验证 WSLC 的文件、网络、输入输出及完整容器生命周期 | SDK 已实际验证，一次性清理报错；Ash 未接入，不能计为产品执行链通过 |
| WSL 1 内运行 Linux 版 Ash | 独立验证其系统能力，不能沿用 WSL 2 结果 | 本轮不作支持或验收通过声明 |

当前 Ash 直接使用 Windows PSEC、Linux Bubblewrap、macOS Seatbelt 运行器，没有接入 WSLC。
当前固定上游版本将 WSLC 列为 v0.9 后端，不要求运行时实验开关；Rust 构建仍需启用 `wslc` feature、携带独立的 `wslcsdk.dll`，并具备 WSL 2.9.9+。本机 WSL 3.0.1 满足版本要求，其他组件须由 WSLC SDK 实际探测。可以单独验证 SDK，但 Ash 尚无 WSLC 执行链，SDK 通过不能计为 Ash 接入通过，见 [固定版本的 WSLC 说明](https://github.com/microsoft/mxc/blob/46ce71d0da7b97bb531a33e175bf4166ffa730c0/docs/wsl/wsl-container-getting-started.md)。

WSL 2 的 Linux 验收复用 [Linux 测试入口](../ash-rs/mxc-sandbox/README.md#验证)，另外必须覆盖：

- Linux 文件系统工作目录与 `/mnt/c` 工作目录分别验证目录授权、只读元数据、隐藏目录和路径别名。
- 检查通过 Windows 可执行文件及 WSL 互操作入口，能否越过文件和网络限制；取消后检查两侧进程和延迟写入。
- 对承诺支持的 NAT、mirrored 网络模式分别验证代理、Windows 宿主地址、回环、DNS、IPv4 和 IPv6。
- 缺少用户命名空间、Bubblewrap 或网络隔离依赖时明确拒绝启动，不把未执行计为通过。

WSL 2 使用 Linux 内核，但提供跨系统文件与命令互操作；mirrored 模式还改变宿主回环的可达性。
因此普通 Linux CI 通过不足以证明上述边界通过，见 [WSL 版本区别](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)、[文件与命令互操作](https://learn.microsoft.com/en-us/windows/wsl/filesystems)、[网络模式](https://learn.microsoft.com/en-us/windows/wsl/networking)。

## 2026-10-02 WSL2 实机验收

在同一台 Windows 11 23H2 / `22631.6199` x64 上安装 WSL `3.0.1.0`，Linux 内核 `6.18.40.1-microsoft-standard-WSL2`，导入 Ubuntu `24.04.5 LTS` 为 `AshAcceptance`。Linux 验收使用普通用户 `ashcheck`（UID 1000）、Rust `1.98.0`、Bubblewrap `0.9.0`、slirp4netns `1.2.1` 和 Just `1.58.0`；没有用 root 执行 Linux 用例。安装器提示重启，但本轮实际 Linux 命令与隔离测试均已成功执行，未重启 Windows。

源码基线为 `1bd1217ef490b2e6787c6a14edd10e33d5c09369`，另包含本轮互操作修复与新增回归；MXC pin 仍为 `46ce71d0da7b97bb531a33e175bf4166ffa730c0`。Windows 完整入口运行于北京时间 07:48:54–07:50:44。mirrored 阶段为 08:19:59–08:21:42，实际 `wslinfo --networking-mode` 返回 `mirrored`；结束后撤销本轮临时 `.wslconfig`，再次读取结果为原来的 `nat`。

| 验证 | 实际结果 |
| --- | --- |
| Windows 服务与账户完整入口 | 9 项服务、34 项账户、10 项执行用例通过；运行器更新后重跑 10 项，服务程序更新后文件用例通过 |
| Windows → WSL 账户边界 | 1 项回归通过：调用者发行版/系统发行版 × 禁止/允许网络共 4 次受限执行均未进入 Linux；同一入口的普通调用者对照先成功 |
| WSL2 Linux 文件系统及 `/mnt/c` | 每种网络模式和文件系统组合的 3 项回归均通过：目录写入、参考目录只读、隐藏兄弟路径与符号链接、`.git` 保护、退出码 125、进程树关闭、互操作拒绝 |
| Linux 退出、超时和取消 | 每种文件系统分别验证三个结束方式；先证明工作负载已启动，再确认后代延迟写入没有发生 |
| Linux → Windows 可执行文件互操作 | 可读 Windows `cmd.exe` 在禁止和受管网络下均不能启动；每轮先证明未受限 Linux 进程能正常调用它，未关闭宿主互操作 |
| NAT/mirrored 受管网络 | 两种模式分别通过同一实机探针：获批 HTTP/SOCKS 请求成功，未获批请求拒绝，IPv4 回环及代理网关直连被阻止，UDP 未到达宿主接收端 |
| SDK 及适配器 | 正常 Cargo 构建、check、warning 门禁通过；SDK 运行器 39 项测试通过，Linux ARM64 测试目标交叉检查通过；补丁与固定上游源码复核通过 |
| 清理 | 服务和安装目录不存在，没有新增账户残留；WFP 删除按对象查询确认；临时网络模式配置已撤销 |

**发现并修复的互操作越界：** 首轮 Linux 测试中，在 Windows 系统目录获只读授权后，`cmd.exe` 仍能启动，产生 `windows-interop-started`，测试以 101 失败。WSL 的 binfmt 解释器持有内核保存的 `/init` 引用，隐藏路径不能消除这条通道。Bubblewrap 现在在工作负载启动前安装禁止 `AF_VSOCK` 的 seccomp 过滤器，由后代继承；过滤器不限制 IP/Unix socket，传入的描述符在执行前关闭。修复后互操作回归与两种网络模式的代理测试均通过。解释器引用和互操作机制见 [Linux binfmt 文档](https://www.kernel.org/doc/html/latest/admin-guide/binfmt-misc.html) 与 [WSL 互操作说明](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/interop.md)。

SDK 复测还发现一个旧用例让外部代理携带 MXC 主机列表，却期望通过校验。当前 SDK 不把该列表传给外部代理，已有相应用例检查拒绝；本轮将成功用例改为 SDK 自带测试代理，保留其应通过策略校验并到达环境检查的断言。

本机证据目录为 `.build/acceptance/wsl/run-20261002-073047/`。`wsl-result.json` 汇总各阶段与未覆盖项，`result.json` 和 `acceptance.log` 保存 Windows 完整入口及清理；`linux-wsl-nat.log` 保留原始越界失败，`linux-wsl-nat-rerun.log`、`linux-network-nat-after-fix.log`、`linux-wsl-mirrored.log` 保存修复后的实机结果；`linux-sdk.log` 保留旧用例失败，`linux-sdk-rerun.log` 保存修正后的结果。`sources/`、`source-final.diff` 和 `source-manifest.json` 保存最终源码及摘要，`plans/` 保存 Windows 安装、更新与移除清单。这些本机证据不随 Git 提交。复跑入口见 [Windows 后端](../ash-rs/windows-sandbox/README.md) 和 [MXC 适配器](../ash-rs/mxc-sandbox/README.md#验证)。

WSL、发行版和构建工具保留在本机用于复测。上述早轮结果只覆盖这些用例；DNS/IPv6、Windows 宿主地址、WSLC SDK 和 PSEC CI 证据由下轮补充，不能沿用早轮结论。WSL1、ARM64 Linux 实机、Linux PTY、完整崩溃恢复与 App Server 产品链路仍未验证。Bubblewrap 也未通过 Ash `Allowed` 执行路径，其要求的全部入站权限由 SDK 拒绝；没有降低该请求。PSEC 成功资格不受 WSL 结果影响。

## 2026-10-02 PSEC、WSLC 与网络补充验收

本轮证据位于 `.build/acceptance/sandbox-followup/run-20261002-083938/`。新增网络回归走 CommandExecutor 与真实平台后端，先在沙箱外逐个确认目标可达，再执行沙箱与后代进程；接收端计数检查实际 TCP/DNS 事务没有外泄。不是只检查代理环境变量或连接错误。

| 环境与请求 | 结果及范围 |
| --- | --- |
| WindowsAccount，23H2 x64，Denied / Managed / Allowed | `tests/network_matrix.rs` 通过，包含 IPv4/IPv6 TCP、HTTP/CONNECT/SOCKS 的地址与域名授权、未获批域名及 IPv6 目标拒绝、TCP/UDP DNS 的 A/AAAA、IPv6 端口 53、后代继承与监听拒绝；Allowed 的直连与 DNS 对照成功 |
| WSL2 Ubuntu x64，NAT，Denied / Managed | 同一矩阵通过；Windows 宿主 IPv4 网关及 IPv6 链路本地地址先证明可达，受限命令及后代不能直连或发送 DNS；Windows IPv6 DNS 接收端实际监听端口 53 |
| WSL2 Ubuntu x64，mirrored，Denied / Managed | 同一矩阵通过，Windows IPv4 回环服务及 DNS 对照成功；Linux IPv6 目标与代理授权成功，直连及原始 DNS 被阻止 |
| 依赖与构建 | 两个平台的代理库 8 项测试通过；三个受影响包的 check 与 warning 门禁、Windows 探针与账户 helper、Linux 适配器的正常构建通过；vendor 与固定上游复核通过 |

镜像模式的 Windows IPv6 回环 `::1` 在沙箱外即不可达，不计为隔离通过；Windows 物理接口 IPv6 地址的对照也未连通。微软文档明确 mirrored 的宿主回环仅支持 `127.0.0.1`，见 [WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)。本机没有公网 IPv6 地址和默认 IPv6 路由，因此没有公网 IPv6 成功路径证据。NAT 的 Windows IPv6 链路本地目标、两种模式的 Linux IPv6 目标和域名代理已验证；这些边界仍需区分。Bubblewrap `Allowed`、PTY、App Server 产品链路不在本轮通过范围。

复跑 Windows 矩阵时，向既有入口显式提供一个在宿主可达、同时支持 TCP/UDP DNS 的端点：`./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc -NetworkDnsServer '<resolver-ip>:53'`。多个端点使用逗号分隔，IPv6 使用 `[address]:53`。Linux 入口与可选 Windows 宿主目标见 [适配器验证](../ash-rs/mxc-sandbox/README.md#验证)。本轮专用接收端共享计数，相关实机测试必须串行执行。

**PSEC CI：** 已读取并归档 [run 36941123878](https://github.com/chogng/ash/actions/runs/36941123878/job/110632598456) 的日志和原始 ZIP。Windows 11 Enterprise 25H2 ARM64，build `26200.9457`，Rust `1.98.0`，MXC pin `46ce71d0da7b97bb531a33e175bf4166ffa730c0`。适配器库 12 项、普通回归 2 项通过；随后 7 项指定验收各自实际执行且通过：PSEC 准备、cmd/PowerShell 输出与退出码、文件作用域和元数据、取消/超时及后代回收、跨执行写入隔离、正常退出后代回收。ZIP SHA-256 为 `d59bf71b427265351805fe9cb7e14e8eff2e75796b4852db6546affe049aef5c`，原始报告为 `passed-listed-scope`。

该 CI 提交为 `1bd1217ef490b2e6787c6a14edd10e33d5c09369`；与本轮源码核对，PSEC 生产代码、请求契约、Cargo 清单/锁文件及 PSEC 脚本未变。本轮新增 Linux 过滤器与网络测试不属于该 CI 的覆盖。Server 2022/2025 只通过能力不足时拒绝的用例。PSEC ConPTY、Allowed/Denied 网络流量矩阵和产品链路仍未验证，也不能用 ARM64 结果声明 Windows 11 x64 成功。

整个 CI run 不是全绿：账户任务的文件作用域用例因恢复后多出 DACL `AI` 标记而失败（ARM64 日志中 ACE 和所有者相同，继承控制标记不同）。该失败保留在本轮证据中；本机账户路径通过不能替代其他系统上的恢复验证。

**WSLC SDK：** 在同一台 23H2 主机，使用固定上游源码独立构建 `wxc-exec --features wslc` 和 `wxc-wslc-daemon`，未改 Ash 后端选择。SDK NuGet `Microsoft.WSL.Containers 2.9.9` 与固定 SHA-256 核对后加载，`WslcGetMissingComponents` 返回 0；实际拉取 `alpine:3.22`，镜像 ID 为 `c83674e1999044d33d751661371b873539f47e5b5c5ca3320c7e0377acca6238`。

一次性容器的输出/退出码 42、只读/读写目录及隐藏兄弟目录、断网、超时与正常退出后代回收共 5 项行为通过；延迟写入未发生。但每次退出都报告 `WslcStopContainer` 清理失败，HRESULT `0x80010108`。源码同时启用 `AUTO_REMOVE` 并在退出后手动 stop/delete；这是错误报告的排查线索，尚不能据此宣布清理已经合格。持久容器的 provision → start → 写入 → 后续命令读取同一状态 → 退出码 7 → stop → deprovision 7 步通过，daemon 随后按本轮短空闲期限退出。

WSLC 状态为**部分通过**。SDK 的 cooperative 外部代理只设置代理环境，不保证任意客户端流量均经代理，不能据此满足 Ash Managed；Ash 仍没有 WSLC 执行链。PTY、输入、完整取消/崩溃矩阵未验证。上游 executor 构建另有硬编码 PowerShell 7 安装路径的测试前置 warning；本机使用另一位置的 pwsh，该 warning 不影响已执行的 Alpine 用例，但不计为该上游全部 E2E 测试通过。

`network-windows.log`、`network-nat-host.log`、`network-mirrored-host.log` 保存最终网络结果；原始测试配置错误、共享接收端并发造成的无效轮次和运行器源文件被重建导致的身份拒绝另存日志，不计为通过。本轮把执行 helper 复制到独立验收目录后安装，避免 Cargo 重建改变已批准摘要。`.wslconfig` 已恢复为原来的不存在状态，实际网络模式再次为 NAT；服务、账户、WFP 与临时接收端已清理。WSL 发行版和隔离于证据目录内的 SDK、镜像缓存保留以便复测。

## 2026-10-02 ACL 恢复与公网 IPv6 复测

证据目录为 `.build/acceptance/sandbox-acl-fix/run-20261002-095459/`，包含原始失败、最终日志、构建检查及清理结果。此前 CI 因撤销权限后多出 DACL `AI` 标记失败；本轮保存传播前旧格式对象的路径，在授权、撤销与日志恢复时保留原始控制标记。受保护根还可能保留启用保护前的继承权限项，直接传播写回会清掉这些项的继承标记；现改为单独写根，再由未保护子项重新取得父目录授权并向下传播。恢复操作使用当前 DACL，保留其他执行的 SID 权限项。完整 SDDL 比较继续保留，账户文件用例在每台验收主机显式运行有无 `AI` 两种基线。

| 本机复测 | 结果 |
| --- | --- |
| SDK ACL | 最终源码的 37 项全部通过，包含旧格式恢复、混合继承、保留历史继承项的受保护根、受保护子树、子项及孙级授权、重叠授权和传播中断后的日志恢复 |
| Windows 11 23H2 x64 账户 | 36 项库测试、10 项完整执行用例通过；文件权限、元数据、退出码与完整 ACL 恢复均通过 |
| Windows 公网 IPv6 | 网络矩阵 1 项通过，包含 Denied / Managed / Allowed、HTTP/CONNECT/SOCKS 目标拒绝、直接 TCP、TCP/UDP DNS 的 A/AAAA 与后代继承 |
| WSL2 Ubuntu 24.04.5 x64 | NAT 与 mirrored 各 1 项公网 IPv6 矩阵和 1 项既有受管网络回归通过；实测前普通进程先完成目标往返 |
| 构建 | SDK、账户与代理 warning 门禁通过；Windows helper/服务与两平台探针正常构建通过；账户 ARM64 测试目标编译通过，固定上游 vendor 复核通过 |

公网目标为 `[2606:4700:4700::1111]:80` 与 `:53`。测试通过独立 TUN 网卡和现有代理中支持 IPv6 的节点提供临时出口，增加两个公网地址的 `/128` 路由；沙箱外另验证了证书校验成功的 HTTPS 响应及 TCP/UDP A/AAAA 解析。初始节点无法进行 IPv6 数据往返的轮次保留为失败，TCP 握手单独成功不计为通过。实际覆盖范围是这个隧道出口；物理网络仍没有公网 IPv6 地址与默认路由。

NAT 用临时 IPv6 地址及接口转发连接 Linux 与测试出口，完成后删除地址、路由并恢复转发状态。mirrored 自动取得测试接口的 IPv6 路由，完成后恢复为 NAT 和原先不存在的 `.wslconfig`。测试网卡、进程、账户、服务与临时凭据配置均已清理；用户现有代理选择和配置未改动。镜像模式的 Windows IPv6 回环限制仍按上一轮范围记录。

Windows 的两个旧网络用例还暴露出 TCP 临时端口落入 Hyper-V UDP 保留范围的测试配置错误；UDP 改为独立分配端口，探针与 Linux 调用方同步更新。共享 DNS fixture 同样分别分配 TCP/UDP 端口，保持所有事务与接收计数断言。

复跑时显式提供可达出口，例如 `./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc -NetworkDnsServer '[2606:4700:4700::1111]:53' -NetworkPublicIpv6Http '[2606:4700:4700::1111]:80'`。Linux 使用 `ASH_PUBLIC_IPV6_HTTP_ENDPOINT` 与包含公网 IPv6 的 `ASH_DNS_SERVER`。公开目标必须完成 HTTP 或 DNS 数据往返的正向对照；缺少出口即失败。脚本不自动配置隧道或修改用户的网络设置。

ARM64 与 Server 2022/2025 的新源码 CI 尚未重跑；此前失败的 run 保持原状态，本机通过和 ARM 编译结果不能声明整条 CI 已绿。WSLC 一次性清理失败不属于本轮修复范围。

## 已退出账户原型的受管网络记录

账户原型曾以 WFP 按账户拒绝 IPv4/IPv6 连接、监听及接收，仅给 Managed 槽位开放一个固定 TCP 回环端口。
执行期间独占该端口并转发至本次 Core 代理，其他槽位不能使用这个端口。
SDK 原有 runtime proxy 身份模式仍保留原校验，账户实现不通过放宽它来获得启动。

真实验收必须确认限制令牌仍命中 WFP 的账户条件；还须检查 IPv6、DNS、跨槽位代理、端口占用、账户并发和宿主崩溃恢复。
不能用进程启动、HTTP_PROXY 存在或单个 TCP 拒绝作为全部网络边界通过的证据。

## 证据与发布状态

保存完整命令、退出码、标准流、SDK 诊断、文件和 ACL 差异、存活进程检查。
下列历史记录保留当时失败、修复和清理的边界；当前服务路径的本机结果见 [2026-10-02 验收](#2026-10-02-服务及账户管理员验收)，不能扩写为所有平台或完整生产隔离资格。
Microsoft 对当时固定预览版的限制见 [上游说明](https://github.com/microsoft/mxc/tree/6cd3d58f05d3447e67109cfb75e042803b843ca4)。

### 2026-09-10 首次实机记录

- 源码：`11496080773c6598b99a7539148c50b59b20d676`，MXC revision 为 `6cd3d58f05d3447e67109cfb75e042803b843ca4`。
- 系统：Windows 11 专业版 23H2，build `22631.6199`，`x86_64-pc-windows-msvc`；Rust `1.98.0`。
- 执行环境：未提升权限，PowerShell `LocalMachine=RemoteSigned`，其他执行策略范围均为 `Undefined`。
- 本机完整构建和测试输出：`.build/acceptance/mxc-windows-20260910/check.log`、`windows.log`；这些是本机证据文件，不随 Git 提交。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `just check ash-mxc-sandbox --tests` | 0 | 通过，未报告编译 warning |
| `just test ash-mxc-sandbox --test windows -- --include-ignored --test-threads=1` | 1 | 1 项通过、2 项失败、0 项忽略；测试构建完成，未报告编译 warning |
| `wsl --status` | 50 | 无可用状态输出 |
| `wsl --list --verbose` | 1 | 返回帮助文本，未取得可执行的发行版信息；WSL 测试未执行 |

通过的是严格受管网络拒绝测试：拒绝请求，且命令写入标记和代理回调均未出现。
这只证明拒绝行为，不表示 Windows 已支持严格受管网络。

两个失败均发生在 SDK 启动阶段：SDK 报告 BaseContainer 不可用，对文件策略中的不存在路径检查 `WRITE_DAC` 时返回 `os error 2`。
多根目录测试失败于 `work/.agents`；进程树测试失败于 `.git`，尚未进入超时和取消断言。
当时适配器把全部保护目录名加入只读策略，SDK 对这些路径使用 `OPEN_EXISTING` 检查访问权；当次错误是路径不存在，不能仅根据外层错误文案判断为用户缺少 ACL 权限。

文件隔离、退出码、进程树终止、ACL 正常与异常恢复、网络绕过和 WSL 跨系统边界均仍待验收。

### 2026-09-10 修复与复测

适配器按元数据契约检查路径是否存在：已存在的文件、目录及链接仍进入只读策略，确认不存在的路径不提交给 ACL 实现，也不创建空目录。
检查遇到其他错误时拒绝请求；工作目录授权、隐藏存储和网络要求继续保留。
新增回归覆盖空工作目录，以及同时存在元数据文件、目录和缺失路径的多根目录策略。

`platform-checks.yml` 已改为 `--include-ignored`，Windows CI 同时执行严格网络拒绝和实机用例。
进程树测试名称及忽略说明改为描述 MXC 能力要求，移除已退场的自建运行器前置条件。

复测时，两个实机用例均已越过缺失元数据检查，但 SDK 报告 BaseContainer 不可用，且当前账户不能对 `C:\` 执行 `WRITE_DAC`，因此仍在启动阶段失败。
这是宿主只读基线所需权限未满足，不能删去磁盘根目录要求、改为普通进程或将失败改成跳过。
继续验收需要具备相应系统隔离能力、且能完整满足文件策略的执行环境；本次没有更改宿主 ACL 或系统功能配置。

| 修复后命令 | 退出码 | 结果 |
| --- | --- | --- |
| `just test ash-mxc-sandbox --lib` | 0 | 4 项通过，含 2 项新增文件策略回归 |
| `just check ash-mxc-sandbox --tests` | 0 | 通过 |
| `python -B scripts/cargo.py build -p ash-mxc-sandbox` | 0 | 正常构建通过 |
| `just test ash-mxc-sandbox --test windows -- --include-ignored --test-threads=1` | 1 | 1 项通过、2 项失败、0 项忽略；失败原因均为上述 `C:\` 权限限制 |

本轮编译未报告 warning。对应本机日志位于同一证据目录的 `fix-lib.log`、`fix-check.log`、`fix-build.log`、`fix-windows-final.log`。

### 2026-09-10 VMware 普通用户与管理员结果

用户在虚拟机内分别运行验收光盘中的 `START.cmd` 和提升权限后的 `ADMIN.cmd`，并返回两份结果包。
测试程序的 SHA-256 与分发包一致：`5436fd082ad160ba6dfa0bf4d38a78fa408a712ff936b9ee18d3dc1b5c3c3218`。
构建来源为 `3275ffc3019cf5e05c628cf455d362bfb2e68c71`；执行命令为 `windows.exe --include-ignored --test-threads=1 --nocapture`。

虚拟机系统为 Windows 11 专业版 23H2，build `22631.2861`，64 位。
日志中的实际管理员标志分别为 `false` 和 `true`，已确认两次权限不同。

| 执行身份 | 结果 | 测试程序退出码 | 失败位置 |
| --- | --- | --- | --- |
| 普通用户 | 1 项通过、2 项失败、0 项忽略 | 101 | `C:\` 的 `WRITE_DAC` 检查被拒绝 |
| 管理员 | 1 项通过、2 项失败、0 项忽略 | 101 | `C:\DumpStack.log.tmp` 打开失败，`os error 32`（共享冲突） |

两次均未触发验收脚本的 150 秒超时；失败来自测试本身。
唯一通过项是严格受管网络请求被拒绝。多根目录、元数据和退出码用例，以及超时和取消用例，均在 SDK 启动检查阶段失败，尚未执行对应的隔离断言。

管理员结果说明，当前问题不能仅归结为未提升权限：Ash 的 `mxc_engine` 补丁将宿主磁盘根目录及所有直接子项展开成文件授权，所选 DACL 实现随后逐项检查访问权。
管理员可以越过 `C:\` 检查，但系统占用文件仍会使该请求失败。当前宿主文件基线与所选实现的匹配问题尚未解决，不能通过删除系统文件、关闭分页或放宽隔离要求取得通过。

ACL 证据的边界：

- 两份日志各采样 17 个路径；普通用户成功读取 11 个，管理员成功读取 14 个，其余路径有读取错误。
- 独立重算执行前后样本差异，成功读取的 ACL 没有变化，读取错误也相同，与 `acl-changes.json` 的空数组一致。
- 这不代表全盘 ACL 清理或异常恢复通过；本次启动检查失败，没有验证正常沙箱执行后的清理，也没有执行崩溃恢复测试。

原始结果包及独立核对摘要保存在本机 `.build/acceptance/mxc-windows-20260910/vm-results/`：`results-current.zip`、`results-elevated.zip`、`summary.json`。
原始归档 SHA-256 分别为 `5ce4b734091491df1927efa3d2f10fed60e076cd591b77d556b67afae7475f08` 和 `4725dfc3b0ddf23d22290e73df1d5b484fedebb3eb4a12f249d5f4e1df161b61`。
本轮结论是该 Windows 11 23H2 环境未通过验收；其他 Windows build、完整网络绕过、WSL 和异常恢复仍未验收。

### 2026-09-11 新账户实现的本机准备检查

准备检查时，系统为上述 23H2 本机，执行令牌未提升；当时尚未配置账户运行时，也未创建本机账户或 WFP 规则。

| 验证 | 结果 |
| --- | --- |
| SDK 独立 ACL 授权测试 | 4 项通过 |
| SDK 请求与精确代理测试 | 2 项通过 |
| MXC 账户实现测试 | 7 项通过；其中 2 项直接调用本机 Windows 的限制令牌、文件 ACL、独立桌面和子进程 API |
| Ash 适配器 lib / Windows 非忽略测试 | 4 + 1 项通过；5 项完整执行测试待配置后运行 |
| `just check ash-mxc-sandbox --tests --locked` | 通过 |
| Cargo 正常构建 `mxc-user` / 网络 probe | 通过 |
| Bazel `//ash-rs/vendor/mxc:mxc-user` | 通过 |
| 打包与签名流程单测 | 42 项中 38 项通过，4 项既有平台条件跳过；没有进行正式代码签名 |
| 未配置运行时与缺少授权参数的 setup | 均拒绝，运行时目录未创建 |
| vendor 差异与固定上游复核 | 已重新生成；源文件对照通过 |

本机真实文件测试发现并修正了错误的限制 SID 类型；当前使用每次执行随机生成的 SID。
测试复用实际运行器的令牌创建方法，确认工作目录写入、元数据只读和后续执行不能借用旧文件所有权。
独立桌面测试确认受限子进程经实际标准流退出并保留 `125`；这些仍不代表专用账户登录和 WFP 网络限制已通过。

适配器 Bazel 目标另外遇到上游 `plm` build script 的 Windows 版本资源编译工具缺失（`program not found`）。
账户 helper 的 Bazel 目标已单独通过；不能把该结果写成整个适配器 Bazel 构建通过。
完整账户、网络、并发、崩溃恢复和 WSL 验收继续待完成。

### 2026-09-11 清理补强

- 移除原先保留 helper 和锁文件的行为；加入账户、账户配置目录与 WFP 对象删除后的重新查询。
- 正在获取账户槽位的执行与配置/删除互斥，避免清理开始后仍启动新命令。
- 3 项新增临时目录清理回归通过：已知产物清理、未知文件/未完成执行保留恢复记录、被替换的 helper 拒绝删除。账户模块共 10 项测试通过。
- 本轮没有配置或删除真实本机账户与网络规则；这些系统对象的清理仍需在获得明确授权后的完整验收中验证。
- 测试报告和构建产物继续保存在工作区；Windows 自身的审计记录不属于测试清理目标。

### 2026-09-11 授权后的本机账户验收

宿主仍为 Windows 11 23H2 / 22631，正式测试进程的 `elevated=false`。用户明确授权配置、测试和清理后，执行 5 轮配置与清理；每轮只有 6 个账户和其 26 个过滤器，前一轮清理成功后才创建下一轮。

发现并修复：

- 新账户加入本地 Users 组，名称通过固定 SID 解析，不依赖系统语言。
- 运行器复制后单独设置文件 ACL，修复目录 ACL 没有应用到已有子文件的问题。
- 运行时移至本次独占的 ProgramData 目录，使系统登录服务能够读取运行器；凭据文件不继承账户的读取权限。
- 配置阶段需要的 Shell32 API 改为从 System32 按需加载，避免登录工作进程尚未执行就因界面 DLL 初始化而失败。
- 可信启动进程退出后、用户命令恢复执行前应用 Job 的界面限制；用户命令仍在相同文件、网络与限制令牌要求下执行。
- Windows 接受的套接字显式改为阻塞模式，避免代理转发收到 `WSAEWOULDBLOCK` 后提前关闭连接。
- 增补启动进程的错误和退出码诊断；ACL 采样使用系统 .NET 文件接口，避免测试依赖 PowerShell 模块自动加载。

| 实际运行 | 结果 |
| --- | --- |
| `just test appcontainer_common --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib user:: --locked -- --include-ignored --test-threads=1` | 12 项通过，包括真实账户登录、运行器/凭据访问边界、限制令牌、文件写权限和独立桌面 |
| `tests/local.ps1 -Phase Test -Output .build/acceptance/mxc-local/round5` | 2 项通过、4 项失败、0 项忽略；测试程序退出码 101 |
| 受管网络 | 获批 HTTP 与 SOCKS 请求成功，未获批目标返回拒绝；直接 TCP、其他端口、监听和后代绕过被阻止，UDP 没有到达宿主接收端 |
| PowerShell 文件与退出用例 | 超时，没有进入预期断言；不能记作文件范围与退出码验收通过 |
| PowerShell 后代终止用例 | 没有生成预期子进程 PID；取消、超时与正常退出后的后代终止仍未通过完整调用链验收 |
| 每轮 Remove | 均成功，删除后按记录重新查询账户与 WFP 对象，并移除运行时文件 |

PowerShell 未完成初始化的根因仍需定位。没有放宽文件、网络、界面或宿主 ACL 要求来取得通过。此次结果只覆盖本机及上述探针；IPv6、跨执行并发、完整崩溃恢复和 WSL 仍未验收。

最终清理核验记录在 `.build/acceptance/mxc-local/round5/cleanup-verification.json`：

- 最后一轮 6 个账户已不存在，对应用户配置目录为 0。
- 查询测试使用的 powershell / mxc-user / probe / cmd 进程，没有属于这些账户的进程。
- 每个记录的 WFP filter、sublayer 和 provider 删除后均查询为不存在。
- ProgramData 运行时目录和前几轮 LocalAppData 运行时目录均不存在。
- 工作区中的测试日志、源码和构建产物保留；不删除 Windows 审计记录。

完整日志位于 `.build/acceptance/mxc-local/round1` 至 `round5`；最初一次测试另保存为 `test-1.log`。最后一轮 helper SHA-256 为 `e2637448c13ad504afc3592ceb2e60e8f5c900942ef506f77bb2f77c419f14d6`。

最终 helper 的 Bazel 构建通过。一次重复 Cargo 构建在等待其他任务的 `ash-app-server` 构建锁时被取消；没有把这次取消记为通过。此前本轮 MSVC 正常 helper 构建、12 项账户测试和完整调用链测试均已实际完成。

额外按 SID 查询可读取的进程，未发现测试 SID；有 140 个进程的所有者信息不可读取，完整输出在 `process-owner-audit.json`。该结果不能扩大为对所有受保护系统进程的证明。共享 MXC ACL 恢复目录内没有剩余恢复文件。

### 2026-09-11 统一契约与原型退出

- Ash `sandboxing` 增加执行前候选选择；仅 `UnsupportedPolicy` 允许考虑下一个候选，运行故障和启动错误均不自动换实现。
- 被选后端与该进程绑定，Executor 使用实际进程的后端解释拒绝，覆盖并发准备后反序启动的情况。
- App Server 的两个本地执行入口通过同一注册方式装配。目前只有 MXC 实际注册；Codex Windows 候选没有被伪装成已接入。
- 删除原型账户运行器、构建目标、打包/签名入口及 CI 配置。15 份原型源码及摘要、原 vendor 补丁和打包补丁保存在 `.build/acceptance/mxc-local/prototype-source`。
- Windows 的 MXC 请求要求完整 PSEC 能力；原先的账户选择和 AppContainer/DACL 转入路径不再用于 Ash 的请求。23H2 没有被宣布支持。
- 保留独立 ACL 授权、对象身份检查、跨平台测试和 MXC 许可证；App 包也保留许可证，且不包含退场运行器。

| 本轮验证 | 结果 |
| --- | --- |
| `just test ash-sandboxing --lib` | 10 项通过，含 6 项新增选择/生命周期回归 |
| `just test ash-tool-executor --lib` | 4 项通过，含真实子进程结果由选中后端判定的调用链回归 |
| `just test ash-mxc-sandbox --lib --test windows` | 4 + 1 项通过；5 项 PSEC 端到端用例保留但本机未执行 |
| SDK `host_changes::tests` / `request::tests` | 4 + 2 项通过 |
| `just check ash-app-server --lib` | 通过 |
| `python -B scripts/cargo.py build -p ash-mxc-sandbox --locked` | 通过 |
| `bazel build //ash-rs/sandboxing:sandboxing` | 通过；保留仓库既有 GTK 依赖注解提示 |
| Windows 打包与签名相关检查 | 9 项通过，含退场运行器排除和许可证保留 |
| 完整相关 Python 套件 | 38 项中 1 项失败、4 项跳过：现有协议主版本断言为 2，当前工作区生成为 3；未修改并行的协议工作 |

这次没有重新安装测试账户或网络规则。候选 Windows 实现仍需要解决安装身份、宿主修改授权与完整策略兼容性，并通过独立验收；本轮接口和构建结果不能替代这项资格。

### 2026-09-11 协议生成同步复核

- 当前 Rust 协议主版本已为 4；提交的 TypeScript fixture 与前端生成产物仍为 3。此前的 Python 打包主版本断言已改为读取生成元数据，因此单独运行 Python 测试没有暴露这次漂移。
- `just test ash-app-server-protocol --lib --locked` 实际结果为 42 项通过、1 项失败，失败项为 `tests::schema_fixtures_match_the_generators`。
- 执行 `just generate-protocol`，同步 fixture、解码器及前端生成产物。除主版本和 schema hash 外，同步了现有源码中的消息检查点及历史类型；没有修改这些领域接口的源码。
- 仅复跑失败项：`just test ash-app-server-protocol --lib tests::schema_fixtures_match_the_generators --locked -- --exact` 通过。生成命令也完成了普通构建；本轮编译没有报告 warning。
- `python -B scripts/test-python.py release`：55 项中 50 项通过、5 项平台条件跳过。打包回归现在比较完整协议元数据，并验证显式生成元数据在装包与签名记录更新后保留。
- Platform checks 增加上述 Rust fixture 一致性检查，避免 Python 打包测试通过却携带过期协议。

本次 Windows 工作是 Codex 源码核对，具体接入差异见 [Windows 候选评估](sandboxing.md#windows-候选评估)。没有注册第二后端、安装账户或修改宿主 ACL、网络规则；Windows 23H2 的执行兼容问题仍未解决。

### 2026-09-11 独立候选接入与 CLR 边界定位

后续按用户“去补”的指令实现独立 `ash-windows-sandbox`，接入 App Server、冻结的安装上下文、产品 helper、签名摘要和许可证清单。普通执行不安装账户或修复宿主权限；每次执行使用独立租约、文件 SID、代理归属和 ACL 日志。

用户先授权每轮 3 个测试账户、13 条 WFP 规则、3 个设备 SID 授权和专用 ProgramData 目录；随后单独授权两个 BaseNamedObjects 目录的非继承权限。按此范围执行 3 轮安装与清理，未将实验中的 Everyone 限制 SID 带入产品。

| 实机证据 | 结果与边界 |
| --- | --- |
| CNG、KsecDD、Null 设备授权 | PowerShell 越过 bcrypt 初始化失败，随后 CLR 返回 `HRESULT 80070005` |
| BaseNamedObjects 目录授权 | 越过全局共享内存的目录权限拒绝，未解决 CLR 初始化 |
| 完整系统调用追踪 | `NtCreatePrivateNamespace` 返回 `STATUS_ACCESS_DENIED`；边界名称为 `Cor_CLR_IPCBlock_<pid>`，边界 SID 为 Everyone |
| 仅加入账户 SID 的诊断对照 | CLR 仍失败 |
| 加入 Everyone 的诊断对照 | PowerShell 管道成功，但令牌不再满足宿主只读要求，未采用 |
| 私有桌面、标准流与退出码单测 | `cmd.exe` 经实际受限创建路径成功退出 `125` |
| 普通 lib 测试 | 14 项通过，3 项需要安装的用例忽略；另新增 Everyone 可写宿主文件仍须拒绝写入的回归并通过 |
| `just check ash-windows-sandbox --tests --locked` | 通过 |
| `just rust-warnings ash-windows-sandbox --locked` | 通过，未报告编译 warning |
| `bazel build //ash-rs/windows-sandbox:ash-windows-sandbox` | 通过；修正别名误带入测试依赖造成的循环 |

私有命名空间的调用者必须满足边界描述符，见 [Microsoft CreatePrivateNamespace 文档](https://learn.microsoft.com/en-us/windows/win32/api/namespaceapi/nf-namespaceapi-createprivatenamespacew)。目录 ACL 与该边界检查是两项不同要求。额外目录授权已从候选的安装清单移除；诊断用 syscall 跟踪和 AppContainer 实验代码已移出产品源码。

三轮清理均返回成功，并在普通权限下独立复查：9 个记录的账户、39 个过滤器、3 个 provider、3 个 sublayer 均不存在；3 个设备上的两代测试 SID 条目均已撤销；两个命名对象目录上的测试 SID 条目已撤销；ProgramData 运行时目录不存在。没有把删除 API 返回成功当作唯一证据。

本机证据位于 `.build/acceptance/windows-sandbox/round-1` 至 `round-3`；最终独立核验为 `cleanup-verification.json`。第三轮完整追踪保存为 `round-3/private-namespace.log`，诊断源码归档为同证据目录的 `trace.rs`。这些本机日志不随 Git 提交。

系统 Windows PowerShell 和依赖它的完整执行用例仍未通过，IPv6、完整并发/崩溃恢复及 WSL 也未取得资格。后续必须确定兼容平台和隔离机制，不能继续靠扩大宿主 ACL 或限制 SID 取得表面通过。

### 2026-09-11 WindowsAccount 模型验收

用户明确选择采用 Codex 的 Windows 账户与 ACL 模型，接受其与严格宿主只读模型的区别。`SandboxPolicy` 增加显式隔离要求：默认 `Strict`；Windows 本地工具选择 `WindowsAccount`。账户后端在准备阶段拒绝 Strict，其他平台保持原有要求。

本轮完成：

- 保留文件 SID、登录 SID 和 Everyone，恢复 CLR 私有命名空间兼容性。
- 可信登录工作进程使用默认登录桌面；用户命令在独立桌面创建，验证身份和 Job 后才启动。登录工作进程先退出，用户命令不能借用其不受限令牌。
- 工作目录和已有元数据分别授权；隐藏存储的必要祖先允许查询属性，但不允许枚举其内容，其他隐藏对象继续拒绝访问。
- 增加有预算限制的 Everyone 可写路径审计。审计外的宿主整体只读不属于此模型的保证；发现未授权的可写路径时报告并拒绝启动。
- ACL 日志按独占账户分开保存，避免并发执行恢复其他执行的权限。
- 移除设备与命名对象目录配置和诊断代码。安装仅创建独立账户、WFP 对象及专用运行时目录。

用户另行批准了 `C:\Users\lanxi`、`AppData`、`AppData\Local` 和 `AppData\Local\Temp` 的临时属性查询与遍历 ACE（0xa0、无继承）。只有缺少相关权限的必要祖先才调整，并由每次执行的日志恢复。

| 验证 | 实际结果 |
| --- | --- |
| Windows lib 全部用例，包含真实登录 | 21 项通过、0 忽略 |
| 原有完整执行用例 | 7 项通过、0 忽略 |
| IPv6 TCP、UDP、监听拒绝 | 新增实机用例通过 |
| 双账户并发、独立 ACL 生命周期 | 新增实机用例通过 |
| 祖先权限不允许枚举、不继承到子项、恢复标记 | 回归通过；包含与父目录不同的历史继承 ACE |
| 沙箱选择与作用域契约 | 10 项通过 |
| Python release 套件 | 55 项：50 通过、5 平台条件跳过 |
| Node 开发包套件 | 15 项通过 |

本机六轮安装的 18 个账户、78 个过滤器及对应 provider/sublayer 已逐项查询确认不存在，运行时目录已删除；早期设备及命名对象目录授权也已撤销。最终清理结果见本机 `.build/acceptance/windows-sandbox/cleanup-verification.json`。当前四个祖先目录的 SDDL 与执行前快照逐字相同，见 `traversal-restored.json`。

**第五轮继承重算副作用：** 旧 SDK 在添加非继承 ACE 时仍调用 `SetNamedSecurityInfoW`，触发用户目录子树的继承重算。测试进程已停止，按日志恢复并清理安装；四个有快照目录已按对象恢复原始 DACL 与继承标记。未采样子目录没有完整执行前快照，不能保证逐项原样恢复，不能将最终清理结果扩写为整个用户目录从未发生权限变化。差异记录为本机 `inheritance-recalculation.json`。

已修正 SDK 的非继承写入和恢复路径：只更新当前对象，并保留继承控制标记；回归确认不会重算子文件的历史继承 ACE。第六轮目录、网络、进程用例及新增 IPv6、并发用例均在此实现上通过。

Windows CI 改为执行当前产品选择的账户模型，通过 `scripts/test-windows-sandbox.ps1` 完成构建、清单安装、全部实机用例和 finally 清理。MXC 库测试与 PSEC 专用用例保留；PSEC 完整执行须在具备相应能力的主机单独运行。没有把当前账户模型当作 PSEC 的通过证明，也没有验证 WSL 或其他 Windows 系统。
