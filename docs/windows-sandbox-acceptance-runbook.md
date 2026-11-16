# Windows 沙箱验收

SDK 来源及兼容补丁见 [MXC 依赖](../third_party/mxc/README.md)，隔离契约见 [沙箱](sandboxing.md)。验收必须使用当前 checkout 构建的程序，并检查实际测试数量、退出码及进程回收；交叉编译和能力查询不能代替运行。

## PSEC

先区分 Windows 宿主、Windows 虚拟机和 WSL 中的 Linux 环境。外层宿主缺少 PSEC API，不代表现有 Windows 来宾不可验收。启动前检查已有虚拟机；来宾必须自行确认本次请求所需的能力。

```powershell
just verify ash-mxc-sandbox
just verify ash-exec-server
./scripts/test-psec.ps1 -Capability required
```

PSEC 入口不安装账户或修改宿主 ACL。它先准备实际策略，再验证文件授权与拒绝、命令与退出码、IPv4／IPv6 TCP 回环、ConPTY、取消、后代回收及独立执行服务 RPC。缺少能力的宿主使用：

```powershell
./scripts/test-psec.ps1 -Capability absent
```

`absent` 只在准备阶段返回 `UnsupportedPolicy` 且产品服务未启动工作负载时通过；其他系统故障仍失败。启动失败不能通过重跑或降低隔离要求变为成功。

虚拟机验收使用与宿主同批构建的程序，通过只读介质或已认证连接传入，在来宾逐个校验摘要后以未提权账户执行。不能复用旧候选的通过结果。测试结束后关闭本轮启动的来宾及辅助进程。

### GitHub Actions

[Windows sandbox acceptance](../.github/workflows/psec.yml) 分别运行 PSEC 与账户任务。下表是固定 CI 镜像的预期，产品不按 Windows 版本选择后端；镜像能力变化时须复核失败原因。

| 运行器                                   | PSEC 预期                  |
| ---------------------------------------- | -------------------------- |
| Windows Server 2022 x64、Server 2025 x64 | 在执行前明确报告能力不支持 |
| Windows 11 ARM64                         | 策略准备及实际执行成功     |

手动 `self-hosted` 仅运行 PSEC，需要 `self-hosted`、`Windows`、`psec` 标签及 PowerShell 7、Python 3.11+、Rustup、MSVC。`probe-psec-network.py` 只查询 PSEC 版本与 `NetworkIngress`，不能单独证明 Managed 策略可实施。

## 账户沙箱

[账户后端](../crates/windows-sandbox/README.md) 和 [管理服务](../crates/windows-sandbox-service/README.md) 独立于 PSEC。普通单元测试不注册服务或创建账户：

```powershell
just verify ash-windows-sandbox
just verify ash-windows-sandbox-service
```

完整入口需要已授权的管理员验收环境：

```powershell
./scripts/test-windows-sandbox.ps1 -Target x86_64-pc-windows-msvc
```

脚本生成并批准安装计划，验证账户执行、运行器更新、服务替换及重启，最后恢复 ACL、移除账户、WFP 对象和服务。已有安装不会被自动接管或删除。执行过程使用未提权调用者；安装权限不能扩大命令的文件授权。

## 隔离边界

PSEC 的完整请求准备与 WindowsAccount 的有界 ACL 审计是不同保证。WindowsAccount 不能满足 `Strict`；普通 AppContainer 或 LPAC 令牌也不能作为已经实现 Strict 的依据。具体决策及令牌约束归 [沙箱契约](sandboxing.md#windows-候选评估)。

Windows Managed 在准备阶段拒绝不具备完整入站隔离的 PSEC 组合；不能通过放宽入口或仅设置代理变量宣布支持。

## WSL2 与 WSLC

Windows 受限进程调用 `wsl.exe`、WSL2 中的 Linux Ash、MXC WSLC 容器是三个独立边界。Ash 的 Linux 后端使用 Bubblewrap，尚未接入 WSLC。

Linux 验收使用 [适配器入口](../crates/mxc-sandbox/README.md#验证)，另须分别验证 Linux 文件系统与 `/mnt/c` 的文件授权、元数据、别名和生命周期。普通进程先确认 Windows 可执行文件可用，再验证沙箱不能通过互操作绕过限制；不能通过关闭宿主互操作使拒绝测试通过。

账户验收可通过 `-WslDistribution` 指定当前调用者已能使用的发行版。NAT 与 mirrored 网络、WSL1 与 WSL2 的结果不能互相替代；缺少所需内核或网络能力时明确拒绝启动。

## 网络

TCP 回环验收不证明外部网络隔离。外部 HTTP、DNS、IPv4、IPv6 及代理矩阵须先有普通进程可达性对照，再检查 Denied／Managed／Allowed、后代继承和接收端计数。DNS 端点必须同时支持 TCP 与 UDP，IPv6 地址使用 `[address]:port`。

账户入口通过 `-NetworkDnsServer` 启用网络矩阵，`-NetworkPublicIpv6Http` 增加公网 IPv6 HTTP。Linux 与 macOS 使用 [网络矩阵入口](../crates/mxc-sandbox/README.md#linux-网络)。代理或临时隧道出口只能证明该链路，不能代替独立出口验收。

测试输出留在 `.build/acceptance/` 或 CI artifact。报告须绑定系统、架构、SDK 来源、源码及程序摘要、实际命令与退出码；缺能力拒绝、未执行和成功执行分别报告。
