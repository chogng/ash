# ash-mxc-sandbox

- 将 Ash 已批准的文件、网络和宿主 ACL 要求转换为 Microsoft MXC 请求。
- 管道与 PTY 均通过 MXC 的 `SandboxBackend::spawn` 调用选定的平台运行器；Ash 拥有请求准备和终端交接。
- 将 SDK 进程句柄接入 Ash 的输入输出、取消与关闭接口。
- 隔离 SDK 类型和错误；平台运行器及基础策略由 SDK 实施，Ash 将自己的持续路径规则编译为追加的 Seatbelt 限制。

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

| 要求                         | 当前行为                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 目录读写、隐藏存储和授权例外 | 转换为 SDK 文件策略；适配器在启动前重新检查规范路径                                                                     |
| 保护元数据                   | 将已存在的 `.git`、`.agents`、`.codex`、`.ash` 设为只读；macOS 还按名称保护尚未创建的路径，不在宿主创建占位目录 |
| macOS 持续路径规则           | 支持拒绝与只读 glob，覆盖执行期间新建的匹配路径及匹配目录的后代；祖先目录不能通过移动绕过限制 |
| 宿主 ACL                     | MXC 路径始终禁止改动宿主 ACL；账户候选独立检查 `HostAclChanges`，由 `windows-sandbox` 负责改动和恢复                    |
| 网络禁止 / 允许              | 传入发布的 1.0 契约，明确出口、入站与宿主回环要求，由 SDK 判断后端能否完整实施                                          |
| 受管网络                     | 一个执行专属端口承载 HTTP、CONNECT、SOCKS；保持禁止直连及其他入站要求                                                   |
| Windows 后端                 | MXC 只接受具备完整策略能力的 PSEC；其他实现由 Ash 沙箱层分别评估和选择                                                  |
| Windows 严格受管网络         | 当前适配器在启动前拒绝；尚不能同时满足代理端点与禁止未授权入站要求                                                      |
| 完全文件访问＋允许网络       | 显式授权的普通进程，使用通用进程实现                                                                                    |

App Server 的固定沙箱配置允许策略范围内的宿主 ACL 改动，命令参数不能更改此要求。
本轮账户原型及 `mxc-user.exe` 已退出源码和产品包。适配器不配置账户或持久网络规则。
Windows 账户候选的 ACL 恢复由独立后端维护；异常退出仍需实机验收。
子进程退出码不再经过私有运行器重映射。输出中的权限错误只产生“可能已有副作用”的诊断，不能证明进程未启动或授权重跑。
启动失败保留 SDK 错误类别、说明与扩展系统错误；PTY helper 传回实际启动和等待错误。所有启动失败均关闭本次执行，不重新选择后端。
Linux 网络提供进程退出时，SDK 监控终止工作负载并报告网络丢失；监控与退出观察均不提前回收进程，进程树关闭后才释放 PID。Bubblewrap 在命令启动前安装禁止 `AF_VSOCK` 的 seccomp 过滤器，防止 WSL 可执行文件互操作绕过 Linux 文件与网络限制；这一约束由工作负载后代继承，适用于禁止和受管网络。

### macOS 文件边界与 glob

SDK 的 Seatbelt 策略固定可写根以及只读、拒绝路径的祖先目录，防止目录移动改变权限路径。受限文件策略拒绝 `F_MAKECOMPRESSED` 和 `F_TRANSFEREXTENTS`，因为这两种 `fcntl` 可以通过只读描述符修改文件；Ash 的持续路径限制也安装同一防护，包括带有 glob 限制的 `FullAccess`。

持续规则由 [Seatbelt 编译器](src/seatbelt.rs) 使用后端已有的 `globset` 语法解析，支持 `*`、`**`、`?`、花括号备选和 ASCII 字符类，统一将反斜杠视为路径分隔符。中文等 Unicode 字面量可用；Seatbelt 无法保持后端字节字符类的非 ASCII 语义，因此拒绝此类规则。持续模式不用于新增写授权。持续拒绝规则在准备阶段拒绝已命中的符号链接与多重或无法确认的硬链接；别名及外部进程改变链接关系仍未完成对象级隔离验收。

前端搜索与过滤保留本地 glob，权限解析和实施归后端；两端用共同语法案例检验结果，不通过前端生成的正则授权。前端的相邻文件 `when` 条件不属于沙箱规则。更完整的边界见 [文件权限契约](../../docs/sandboxing.md#文件权限目标)。Unix socket 的路径拒绝规则保留，文件身份快照绑定其所在目录，避免把 socket 当作普通文件打开。

## PTY 启动

- Unix 直接使用 SDK 的 `StdioMode::Pty`，由 SDK 分配终端并启动 Bubblewrap 或 Seatbelt。Ash 接入终端输入、合并输出、resize、前台作业中断及进程树关闭。
- Windows 的 Rust SDK 仍不支持 ProcessContainer 分配 PTY，因此宿主通过 `with_pty_helper` 提供启动器。`utils-pty` 启动该程序的 `--ash-mxc-pty` 角色，产品入口先调用 `arg0::dispatch`。
- Windows 交接格式归 Ash，包含具体命令、显式环境、文件和网络策略、准备阶段的文件身份。内部角色通过官方发布的 1.0 契约重建 SDK 请求，不反序列化 SDK 内部执行模型。新增宿主 ACL 授权字段会被拒绝。
- Windows 交接请求最多 1 MiB UTF-8，按字符边界拆成不超过 8 KiB 的环境项；帮助进程检查块数、总字节数、缺块、重复键及多余字段。工作负载环境与启动器环境分开，传输变量不注入工作负载，显式空环境保持为空。PSEC 所需的 `SYSTEMROOT` 和 `LOCALAPPDATA` 由执行器提供。
- `tests/pty.rs` 在 Unix 实际验证输入、resize、环境、只读拒绝、退出、前台作业中断和回收；Windows 普通回归验证帮助进程入口，[PSEC 终端用例](tests/pty/windows.rs) 另检查真实终端输入、尺寸、大环境、传输变量隔离、只读拒写、退出码及后代回收。[执行服务验收](../exec-server/README.md#pty-边界) 通过产品可执行文件和 RPC 检查帮助进程装配、重连与退出输出。这些用例须在支持 PSEC 的系统显式执行，已接入 `scripts/test-psec.ps1`；交叉编译不代表对应系统已通过运行验收。

## SDK 依赖

固定 Microsoft MXC `c45e7d5a485036d88f469aa363efaa3c651564bc`，使用官方合并后的 `mxc-sdk 1.0.0` 单包。源码及可复核补丁保存在 [vendor/mxc](../vendor/mxc/README.md)，Cargo 与 Bazel 消费同一份源码。

适配器使用 SDK 已提供的契约和平台运行器导出。公开的 `v1::spawn` 尚不能明确禁止 ACL 改动、锁定 PSEC 运行器或指定受信 Bubblewrap 路径，因此当前保留直接选择运行器的接入；不让 SDK 的实现选择改变 Ash 已确定的隔离要求。

文件身份快照由 `sandboxing` 持有，使用 `file-identity` 的句柄检查；Windows ACL 授权范围由 `windows-sandbox` 持有。SDK 补丁只处理隔离边界、平台能力诊断和资源生命周期。Unix PTY 复用官方实现，补充前台作业中断接口。

升级时固定 commit、对照上游复核补丁，再验证消费者及平台行为。该 pin 是源码快照，上游已移除早期预览说明；这不替代产品自己的隔离验收。[上游源码](https://github.com/microsoft/mxc/tree/c45e7d5a485036d88f469aa363efaa3c651564bc)

## 验证

2026-10-07 的 Codex 对照修改在 macOS ARM64 上通过适配器 34 项库测试和 7 项实际 PTY 测试，1 项需要显式局域网地址的用例未运行；执行服务库及 15 项执行集成回归串行通过，PowerShell 路径分类定向回归通过。两 crate 的 Windows ARM64/x64 全部测试目标通过编译及 warning 门禁，但本轮没有运行新增的 Windows PSEC/ConPTY 用例。Windows 验收脚本只有在逐项实际通过后才记录对应范围成功。

本轮执行服务普通 Cargo 构建和 Bazel 适配器库构建通过。Bazel 的固定 SDK 裁剪清单已补入 MXC 进程回收所需的 `libproc`，此前失败的 PTY 测试与执行服务可执行目标已成功构建；Bazel 运行的 7 项 PTY 测试通过，执行服务实际启动及 SIGTERM 退出验证通过。首次并发执行服务回归停在既有延迟输出测试，单独及串行复测通过，该逻辑未修改。

2026-10-06 在 macOS 27.0.1（build 26A434）ARM64 上实测：适配器库 27 项、PTY 7 项、`sandboxing` 库 20 项及 SDK Seatbelt 策略生成 89 项测试通过，前端已有 glob 的 3 项测试通过。新增用例通过真实 SDK 子进程验证祖先目录移动、未创建的元数据、执行后新文件的拒绝/只读规则、Unicode 字面量与受限 `fcntl`，PTY 另覆盖同一持续路径策略。新版 macOS 的基础文件与终端行为已有实机证据；网络流量矩阵、私有 IPC 完整矩阵与 Intel Mac 仍待验收。

同机执行器库 14 项、执行服务 `execution` 集成测试 15 项通过；适配器、`sandboxing`、SDK 的普通 check 与 all-targets warning 门禁通过，适配器的 Linux ARM64、Windows ARM64 测试目标交叉编译通过。依赖检查、固定 pin 的 vendor 补丁校验及 Bazel 适配器库构建通过。Bazel 仍输出已有的第三方 crate 系统库注解建议；本次不修改这些无关依赖设置。

2026-10-07 升级至 `c45e7d5a` 后，Windows 适配器 13 项单元测试、文件身份 11 项测试、文件快照 2 项测试、账户文件策略 8 项测试、SDK ACL 35 项测试与继承 2 项测试、PSEC 诊断 2 项测试通过。WSL2 中 Linux 适配器 11 项单元测试和文件快照 2 项测试通过，官方 PTY 的 6 项实机测试通过，覆盖前台作业中断后 shell 继续运行；文件/退出码、后代回收和 Windows 程序互操作绕过的 3 项回归通过。Linux SDK 的退出观察测试和 Seatbelt 策略生成 84 项测试通过；后者不代表 macOS 实际执行验证。

Windows/Linux warning 门禁、Windows 执行服务 Cargo 构建、适配器 Bazel 构建及依赖检查通过。Bazel 会提示官方构建脚本的 3 条 `cargo:rustc-link-arg-bin` 指令不受支持：这些指令给 SDK 的辅助程序添加资源，本次 Ash 库目标不构建这些程序。该提示仍存在，不能据此宣布辅助程序已完成 Bazel 验证。Windows PSEC 成功执行与 PTY 仍需对应系统验收。

2026-10-02 在 Windows 11 23H2（build 22631）完成适配器、执行器、执行服务与账户后端的活动测试、执行服务 Cargo 构建、依赖检查和 warning 门禁。另显式运行 PSEC 不可用用例，确认执行前拒绝。同机 WSL2 的 Ubuntu 24.04.5 x64 已实际验证 Bubblewrap：NAT 和 mirrored 模式下，Linux 文件系统及 `/mnt/c` 上的目录权限、隐藏路径与别名、元数据保护、退出码、后代回收和 Windows 可执行文件互操作回归均通过，受管代理用例分别通过。正常构建、适配器及 SDK 的 check 和 warning 门禁通过；SDK 运行器测试 39 项通过。Windows 11 25H2 ARM64 CI 另有 7 项 PSEC 成功路径证据；它不能证明本机 x64 支持。截至该次验收，macOS ARM64 只有测试目标编译结果，Bazel 打包未验证；当前文件与终端实测见上方 2026-10-06 记录。具体环境、原始失败及范围见 [WSL 验收记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-wsl2-实机验收) 与 [补充验收](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-psecwslc-与网络补充验收)。

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

Bubblewrap 当前拒绝 Ash `Allowed` 所要求的全部入站权限；不能把该请求的拒绝当作允许网络的执行验收。`tests/network_matrix.rs` 另通过 CommandExecutor 验证 Denied/Managed：IPv4/IPv6 HTTP、CONNECT、SOCKS 的地址和域名授权、未获批目标拒绝、直接 TCP 与 TCP/UDP DNS 的 A/AAAA、实际接收计数和后代继承。NAT/mirrored 实机均通过；两种模式还通过临时隧道出口的公网 IPv6 HTTP 与 TCP/UDP DNS 验证。NAT 覆盖可达的 Windows IPv6 链路本地端口 53，mirrored 覆盖 Windows IPv4 回环；mirrored 的 Windows IPv6 宿主目标仍没有可达性对照。具体出口与清理证据见 [ACL 与 IPv6 复测](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-acl-恢复与公网-ipv6-复测)。独立 WSLC SDK 已实测但一次性清理报错，Ash 未接入它。

```sh
python3 -B scripts/cargo.py build -p ash-network-proxy --example matrix
export ASH_NETWORK_MATRIX_PROBE="$PWD/.build/cargo/debug/examples/matrix"
# 使用宿主实际可达、支持 TCP/UDP DNS 的端点；可逗号分隔，IPv6 写为 [address]:53。
export ASH_DNS_SERVER="10.255.255.254:53"
# 有可达公网 IPv6 出口时，增加真实 HTTP 往返与沙箱拒绝检查。
export ASH_PUBLIC_IPV6_HTTP_ENDPOINT="[2606:4700:4700::1111]:80"
just test ash-mxc-sandbox --test network_matrix --locked -- --ignored --nocapture
```

设置了 `CARGO_TARGET_DIR` 时，探针路径使用该目录的 `debug/examples/matrix`。可提供 `ASH_WINDOWS_NETWORK_ENDPOINT` 和 `ASH_WINDOWS_DNS_ENDPOINT`，向同一矩阵增加 Windows 接收端；格式为逗号分隔的 socket 地址，链路本地 IPv6 的 scope ID 使用 Linux 接口编号。所有端点必须先通过普通进程的可达性检查。自建接收端可通过 `ASH_WINDOWS_NETWORK_COUNTER` 提供原子发布的累计请求数文件；对照后若计数增加，受限执行即失败。共享接收端的测试须串行运行。

Windows 实机步骤见 [验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。


macOS 的局域网验收使用本机可达的私有 IPv4 地址，接收端由测试创建，不需要公网。
下面的定向测试先验证普通进程可达，再验证 Denied 直连拒绝、Managed 直连拒绝、
显式授权目标的代理 HTTP 成功及未授权目标拒绝；另验证私有 IPC 目录内的创建与连接例外、目录外拒绝及 SSH socket 拒绝。
私有 IPC 目录必须是与命令目录不重叠的独立授权目录。

```sh
ASH_SANDBOX_LAN_IP="$(/usr/sbin/ipconfig getifaddr en0)" just test ash-mxc-sandbox --lib network_tests --locked -- --include-ignored
```

接口不叫 `en0` 时，改用该 Mac 实际可达的局域网接口地址。此入口只覆盖 IPv4 HTTP 与
Unix socket；IPv6、CONNECT、SOCKS、DNS 和远端局域网接收端仍需各自验收。
