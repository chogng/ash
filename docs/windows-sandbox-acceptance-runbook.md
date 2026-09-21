# Windows 沙箱验收手册

本手册分别验证 MXC PSEC 路径和独立 Windows 账户候选，保留各轮实机证据。WindowsAccount 模型已在 23H2 通过当前完整执行用例；同机仍缺少完整 PSEC 能力。旧 SDK 继承重算的副作用与恢复边界见文末记录。
实现契约见 [mxc-sandbox](../ash-rs/mxc-sandbox/README.md) 与 [windows-sandbox](../ash-rs/windows-sandbox/README.md)。历史账户原型的结果不能作为当前候选的通过证据。

## 当前入口

2026-09-21 起源码固定 MXC `ca7ea12ac6bd9f5420d6adecb37e32a8158da476`，直接使用平台运行器及发布的 0.8 契约。下面 9 月 10–11 日的实机记录使用旧 pin `6cd3d58f05d3447e67109cfb75e042803b843ca4`，不作为新版验收通过证据。

当前 MXC Windows 后端只接受完整 PSEC 能力。此前的账户原型已退出源码和产品包，不能再通过 `mxc-user` 或 `tests/local.ps1` 安装它。独立候选使用 `ash-windows-sandbox`，仍需单独授权和验收，不能沿用旧原型的通过结论。

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

[Windows PSEC acceptance](../.github/workflows/psec.yml) 在 main 或 `codex/psec-*` 分支相关文件更新时并行使用 `windows-2025`（x64）和 `windows-11-arm`（ARM64），一侧失败不取消另一侧。Run workflow 的 `hosted` 选项运行两者，也可单独选择一种。专用机器注册到本仓库后，添加 `self-hosted`、`Windows`、`psec` 标签，手动选择 `self-hosted`；机器须预装 PowerShell 7、Python 3.11+、Rustup 和对应 MSVC C++ 工具链。不假设运行器标签代表具备 PSEC 能力。

工作流不安装沙箱账户，不改变系统功能或放宽文件策略。能力用例通过 Ash 适配器准备含隐藏存储、工作目录写入、只读元数据和禁止网络的真实请求，创建并关闭 PSEC 环境及启动属性，不启动用户命令。失败时工作流失败，随后四项成功路径不执行；测试名未匹配也不能算通过。

每次上传 `.build/acceptance/psec`，包含系统版本、架构、Rust 工具链、MXC pin、各阶段命令/退出码/输出和 `report.json`。通过状态仅表示报告列出的范围；PSEC ConPTY、Allowed/Denied 完整网络矩阵、App Server 产品链路及 WSL 尚未纳入此任务，不能据此宣布完整生产验收通过。托管运行器缺能力时，需要已确认支持相同策略的专用运行器，不能以账户后端结果代替。

## WSL 验收边界

Windows、WSL 2 中的 Linux 进程和 MXC 的 WSL Container（WSLC）是不同的执行路径，验收结果不能互相替代。

| 场景 | 验收要求 | 当前范围 |
| --- | --- | --- |
| Windows 版 Ash 执行 Windows 命令 | 执行本手册的 ProcessContainer 验收 | 必须完成，本次实机未通过 |
| Windows 受限命令调用 `wsl.exe` | 检查能否跨入 WSL 后越权访问文件、直连网络或留下存活进程 | 纳入 Windows 绕过检查；需要可正常执行命令的 WSL 环境 |
| WSL 2 内运行 Linux 版 Ash | 在 WSL 2 内执行 Linux 沙箱验收，并检查跨系统边界 | 若将此用法列入支持范围，发布前必须单独通过 |
| Windows 通过 MXC WSLC 启动 Linux 容器 | 验证 WSLC 的文件、网络、输入输出及完整容器生命周期 | 当前未启用，不属于已接入功能的验收 |
| WSL 1 内运行 Linux 版 Ash | 独立验证其系统能力，不能沿用 WSL 2 结果 | 本轮不作支持或验收通过声明 |

当前 Ash 直接使用 Windows PSEC、Linux Bubblewrap、macOS Seatbelt 运行器，没有接入 WSLC。
固定上游版本将 WSLC 列为需要显式启用的实验能力，见 [WSLC SDK 说明](https://github.com/microsoft/mxc/blob/6cd3d58f05d3447e67109cfb75e042803b843ca4/docs/wsl/wsl-container-getting-started.md#rust-sdk)。

WSL 2 的 Linux 验收复用 [Linux 测试入口](../ash-rs/mxc-sandbox/README.md#验证)，另外必须覆盖：

- Linux 文件系统工作目录与 `/mnt/c` 工作目录分别验证目录授权、只读元数据、隐藏目录和路径别名。
- 检查通过 Windows 可执行文件及 WSL 互操作入口，能否越过文件和网络限制；取消后检查两侧进程和延迟写入。
- 对承诺支持的 NAT、mirrored 网络模式分别验证代理、Windows 宿主地址、回环、DNS、IPv4 和 IPv6。
- 缺少用户命名空间、Bubblewrap 或网络隔离依赖时明确拒绝启动，不把未执行计为通过。

WSL 2 使用 Linux 内核，但提供跨系统文件与命令互操作；mirrored 模式还改变宿主回环的可达性。
因此普通 Linux CI 通过不足以证明上述边界通过，见 [WSL 版本区别](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)、[文件与命令互操作](https://learn.microsoft.com/en-us/windows/wsl/filesystems)、[网络模式](https://learn.microsoft.com/en-us/windows/wsl/networking)。

## 已退出账户原型的受管网络记录

账户原型曾以 WFP 按账户拒绝 IPv4/IPv6 连接、监听及接收，仅给 Managed 槽位开放一个固定 TCP 回环端口。
执行期间独占该端口并转发至本次 Core 代理，其他槽位不能使用这个端口。
SDK 原有 runtime proxy 身份模式仍保留原校验，账户实现不通过放宽它来获得启动。

真实验收必须确认限制令牌仍命中 WFP 的账户条件；还须检查 IPv6、DNS、跨槽位代理、端口占用、账户并发和宿主崩溃恢复。
不能用进程启动、HTTP_PROXY 存在或单个 TCP 拒绝作为全部网络边界通过的证据。

## 证据与发布状态

保存完整命令、退出码、标准流、SDK 诊断、文件和 ACL 差异、存活进程检查。
Windows 实机及生产隔离资格尚未取得；下列部分结果不能代替完整验收。
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
