# ash-mxc-sandbox

- 将 Ash 已批准的文件、网络和宿主 ACL 要求转换为 Microsoft MXC 请求。
- 管道与 PTY 均通过 MXC 的 `SandboxBackend::spawn` 调用选定的平台运行器；Ash 拥有请求准备和终端交接。
- 将 SDK 进程句柄接入 Ash 的输入输出、取消与关闭接口。
- 隔离 SDK 类型和错误；不实现 PSEC、DACL、Bubblewrap 或 Seatbelt。

## 实际调用链

```text
Core / action-policy → tool-executor → exec-server → sandboxing
                                         ↓ 注入
                                    mxc-sandbox
                                         ↓
                                  Microsoft MXC SDK
                                    ├─ ProcessContainer
                                    ├─ Bubblewrap
                                    └─ Seatbelt
```

`SandboxLaunch` 保存 Ash 封装的 MXC 请求及文件对象身份，直到 Executor 确认执行起点后才启动。
`SandboxProcess` 接口暴露标准流、等待和关闭；SDK 句柄保留到输出排空后再释放。
正常结束、取消和超时均调用 SDK 的终止与等待，随后关闭 Ash 的代理。

动作授权属于 `action-policy` / Core。代理按同一授权检查真实目标。
`tool-executor` 提交已确定的执行预算；进程、输出和超时实施属于 `exec-server`。Ash 的 `SandboxBackends` 在执行前选择后端；MXC 负责自身实现的进程创建和资源清理。

## 权限与支持范围

| 要求 | 当前行为 |
| --- | --- |
| 目录读写、隐藏存储和授权例外 | 转换为 SDK 文件策略；适配器在启动前重新检查规范路径 |
| 保护元数据 | 构造请求时，将已存在的 `.git`、`.agents`、`.codex`、`.ash` 文件或目录设为只读；不存在的路径不创建，其他检查错误拒绝请求 |
| 宿主 ACL | MXC 路径始终禁止改动宿主 ACL；账户候选独立检查 `HostAclChanges`，由 `windows-sandbox` 负责改动和恢复 |
| 网络禁止 / 允许 | 传入发布的 1.0 契约，明确出口、入站与宿主回环要求，由 SDK 判断后端能否完整实施 |
| 受管网络 | 一个执行专属端口承载 HTTP、CONNECT、SOCKS；保持禁止直连及其他入站要求 |
| Windows 后端 | MXC 只接受具备完整策略能力的 PSEC；其他实现由 Ash 沙箱层分别评估和选择 |
| Windows 严格受管网络 | 当前适配器在启动前拒绝；尚不能同时满足代理端点与禁止未授权入站要求 |
| 完全文件访问＋允许网络 | 显式授权的普通进程，使用通用进程实现 |

App Server 的固定沙箱配置允许策略范围内的宿主 ACL 改动，命令参数不能更改此要求。
本轮账户原型及 `mxc-user.exe` 已退出源码和产品包。适配器不配置账户或持久网络规则。
Windows 账户候选的 ACL 恢复由独立后端维护；异常退出仍需实机验收。
子进程退出码不再经过私有运行器重映射。输出中的权限错误只产生“可能已有副作用”的诊断，不能证明进程未启动或授权重跑。
启动失败保留 SDK 错误类别、说明与扩展系统错误；PTY helper 传回实际启动和等待错误。所有启动失败均关闭本次执行，不重新选择后端。
Linux 网络提供进程退出时，SDK 监控终止工作负载并报告网络丢失；监控与退出观察均不提前回收进程，进程树关闭后才释放 PID。Bubblewrap 在命令启动前安装禁止 `AF_VSOCK` 的 seccomp 过滤器，防止 WSL 可执行文件互操作绕过 Linux 文件与网络限制；这一约束由工作负载后代继承，适用于禁止和受管网络。

## PTY 启动

- 宿主通过 `with_pty_helper` 明确提供启动器路径；`utils-pty` 分配 PTY 后启动该程序的 `--ash-mxc-pty` 内部角色。启动器必须在产品入口前调用 `arg0::dispatch`；适配器不自行解析当前可执行文件，未配置时拒绝受限 PTY。
- 受信启动交接保存完整文件策略、受管代理端点、固定执行路径和准备阶段的文件身份；普通 MXC 配置仍不能反序列化这些授权字段。
- 启动参数仅由宿主生成，通过有界环境项交给内部角色；序列化上限 16 KiB，超限在启动前拒绝。
- 工作负载环境与启动器环境分开，MXC 在应用约束后设置工作负载环境。
- 显式空环境保持为空，不隐式继承宿主变量；Windows PSEC 要求调用方提供 `SYSTEMROOT` 和 `LOCALAPPDATA`，执行器统一准备它们，缺失时拒绝启动。
- Seatbelt、Bubblewrap 和 Windows PSEC 继承终端；Windows 不进入其他实现。
- PTY 输入输出、尺寸、信号和进程树关闭归 Ash 执行句柄管理。
- `tests/pty.rs` 是仅用于测试的最小宿主，直接调用本 crate 的 PTY 入口；通过 `test-binary-support` 在测试运行器启动前分派，独立验证终端输入、尺寸、权限、退出与回收。
- macOS 真实进程测试覆盖断连输入、resize、只读拒绝和取消回收；Linux/Windows 交叉编译通过不代表实机验收。

## SDK 依赖

固定 Microsoft MXC `46ce71d0da7b97bb531a33e175bf4166ffa730c0`。
为承接 Ash 的现有契约，部分上游 crate 以可审查源码补丁保存在
[vendor/mxc](../vendor/mxc/README.md)，由根 Cargo patch 配置和 Bazel 使用。
适配器直接依赖 `mxc_config_contract`、`wxc_common` 及对应平台 crate，不再依赖 `mxc-sdk` 或维护 `mxc_engine` 副本。请求直接构造已发布的 `1.0.0` Rust 类型，再交给 SDK 的契约转换入口；上游 `1.1.0-alpha` 仍是开发契约，crate 版本 `0.9.0` 不等于配置版本。

升级在 Ash 内维护：核对上游 release/stable 变更，固定 commit，复核必要补丁，再通过平台与打包验证。当前 pin 是本次审查的源码快照，不将其称为稳定发行版，也不自动追踪 HEAD。

上游仍将此版本标为早期预览，接线与测试不代表生产隔离资格。
[上游说明](https://github.com/microsoft/mxc/tree/46ce71d0da7b97bb531a33e175bf4166ffa730c0)

## 验证

2026-10-02 在 Windows 11 23H2（build 22631）完成适配器、执行器、执行服务与账户后端的活动测试、执行服务 Cargo 构建、依赖检查和 warning 门禁。另显式运行 PSEC 不可用用例，确认执行前拒绝。同机 WSL2 的 Ubuntu 24.04.5 x64 已实际验证 Bubblewrap：NAT 和 mirrored 模式下，Linux 文件系统及 `/mnt/c` 上的目录权限、隐藏路径与别名、元数据保护、退出码、后代回收和 Windows 可执行文件互操作回归均通过，受管代理用例分别通过。正常构建、适配器及 SDK 的 check 和 warning 门禁通过；SDK 运行器测试 39 项通过。Windows 11 25H2 ARM64 CI 另有 7 项 PSEC 成功路径证据；它不能证明本机 x64 支持。macOS ARM64 仍只有本轮测试目标编译结果，Bazel 打包未验证。具体环境、原始失败及范围见 [WSL 验收记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-wsl2-实机验收) 与 [补充验收](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-psecwslc-与网络补充验收)。

```sh
just test ash-mxc-sandbox
just test ash-mxc-sandbox --test pty
just test ash-tool-executor
just check ash-mxc-sandbox --target x86_64-pc-windows-msvc --tests
just check ash-mxc-sandbox --target x86_64-unknown-linux-gnu --tests
just check ash-mxc-sandbox --target aarch64-apple-darwin --tests
```

Linux 受管网络由 SDK 使用 `bwrap`、`slirp4netns`、`unshare`、`nsenter`、iptables/ip6tables 及其 restore 工具实施。
需要相应用户命名空间和内核网络功能；缺少依赖时拒绝启动。产品包只携带 Bubblewrap，不再携带 Ash namespace helper。

```sh
python3 -B scripts/cargo.py build -p ash-network-proxy --example probe
export ASH_NETWORK_PROBE="$PWD/.build/cargo/debug/examples/probe"
just test ash-mxc-sandbox --test linux -- --ignored
```

WSL2 的跨系统回归入口为 `tests/wsl.rs`。在可正常使用 Windows 可执行文件互操作的 WSL 发行版内运行，先验证 Linux 文件系统，再将 `TMPDIR` 指向 Windows 挂载上的测试目录；下例假定仓库位于 `/mnt/c`。关闭宿主互操作不能作为通过依据，测试在每轮受限执行前验证普通进程能启动 Windows 程序。

```sh
export ASH_BWRAP_PATH=/usr/bin/bwrap
export ASH_WSL_WINDOWS_PROGRAM=/mnt/c/Windows/System32/cmd.exe
TMPDIR=/tmp just test ash-mxc-sandbox --test wsl --locked -- --ignored --test-threads=1
mkdir -p .build/acceptance/wsl/fixtures
TMPDIR="$PWD/.build/acceptance/wsl/fixtures" just test ash-mxc-sandbox --test wsl --locked -- --ignored --test-threads=1
```

Bubblewrap 当前拒绝 Ash `Allowed` 所要求的全部入站权限；不能把该请求的拒绝当作允许网络的执行验收。`tests/network_matrix.rs` 另通过 CommandExecutor 验证 Denied/Managed：IPv4/IPv6 HTTP、CONNECT、SOCKS 的地址和域名授权、未获批目标拒绝、直接 TCP 与 TCP/UDP DNS 的 A/AAAA、实际接收计数和后代继承。NAT/mirrored 实机均通过；NAT 还覆盖可达的 Windows IPv6 链路本地端口 53，mirrored 覆盖 Windows IPv4 回环。公网 IPv6 和 mirrored 的 Windows IPv6 宿主目标没有可达性对照，不计为通过。Linux PTY 未验证；独立 WSLC SDK 已实测但一次性清理报错，Ash 未接入它。

```sh
python3 -B scripts/cargo.py build -p ash-network-proxy --example matrix
export ASH_NETWORK_MATRIX_PROBE="$PWD/.build/cargo/debug/examples/matrix"
# 使用宿主实际可达、支持 TCP/UDP DNS 的端点；可逗号分隔，IPv6 写为 [address]:53。
export ASH_DNS_SERVER="10.255.255.254:53"
just test ash-mxc-sandbox --test network_matrix --locked -- --ignored --nocapture
```

设置了 `CARGO_TARGET_DIR` 时，探针路径使用该目录的 `debug/examples/matrix`。可提供 `ASH_WINDOWS_NETWORK_ENDPOINT` 和 `ASH_WINDOWS_DNS_ENDPOINT`，向同一矩阵增加 Windows 接收端；格式为逗号分隔的 socket 地址，链路本地 IPv6 的 scope ID 使用 Linux 接口编号。所有端点必须先通过普通进程的可达性检查。自建接收端可通过 `ASH_WINDOWS_NETWORK_COUNTER` 提供原子发布的累计请求数文件；对照后若计数增加，受限执行即失败。共享接收端的测试须串行运行。

Windows 实机步骤见 [验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。
