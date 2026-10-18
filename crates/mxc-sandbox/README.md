# ash-mxc-sandbox

- 将 Ash 已批准的文件、网络和宿主 ACL 要求转换为 Microsoft MXC 请求。
- 将 Ash 执行规格转换为 typed `v1::ContainerRequest`，通过 SDK 的 `prepare_restricted` 及标准句柄启动；Ash 拥有授权、文件身份和终端交接。
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

| 要求                         | 当前行为                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 目录读写、隐藏存储和授权例外 | 转换为 SDK 文件策略；适配器在启动前重新检查规范路径                                                             |
| 保护元数据                   | 将已存在的 `.git`、`.agents`、`.codex`、`.ash` 设为只读；macOS 还按名称保护尚未创建的路径，不在宿主创建占位目录 |
| macOS 持续路径规则           | 支持拒绝与只读 glob，覆盖执行期间新建的匹配路径及匹配目录的后代；祖先目录不能通过移动绕过限制                   |
| 宿主 ACL                     | MXC 路径始终禁止改动宿主 ACL；账户候选独立检查 `HostAclChanges`，由 `windows-sandbox` 负责改动和恢复            |
| 网络禁止 / 允许              | 传入发布的 1.0 契约，明确出口、入站与宿主回环要求，由 SDK 判断后端能否完整实施                                  |
| 受管网络                     | 一个执行专属端口承载 HTTP、CONNECT、SOCKS；保持禁止直连及其他入站要求                                           |
| Windows 后端                 | MXC 只接受具备完整策略能力的 PSEC；其他实现由 Ash 沙箱层分别评估和选择                                          |
| Windows 严格受管网络         | 当前适配器在启动前拒绝；尚不能同时满足代理端点与禁止未授权入站要求                                              |
| 完全文件访问＋允许网络       | 显式授权的普通进程，使用通用进程实现                                                                            |

App Server 的固定沙箱配置允许策略范围内的宿主 ACL 改动，命令参数不能更改此要求。
适配器不配置账户或持久网络规则。
Windows 账户候选的 ACL 恢复由独立后端维护；异常退出仍需实机验收。
子进程退出码不再经过私有运行器重映射。输出中的权限错误只产生“可能已有副作用”的诊断，不能证明进程未启动或授权重跑。
启动失败保留 SDK 错误类别、说明与扩展系统错误；PTY helper 传回实际启动和等待错误。所有启动失败均关闭本次执行，不重新选择后端。
Linux 网络提供进程退出时，SDK 监控终止工作负载并报告网络丢失；监控与退出观察均不提前回收进程，进程树关闭后才释放 PID。Bubblewrap 在命令启动前安装禁止 `AF_VSOCK` 的 seccomp 过滤器，防止 WSL 可执行文件互操作绕过 Linux 文件与网络限制；这一约束由工作负载后代继承，适用于禁止和受管网络。

### macOS 文件边界与 glob

SDK 的 Seatbelt 策略固定可写根以及只读、拒绝路径的祖先目录，防止目录移动改变权限路径。受限文件策略拒绝 `F_MAKECOMPRESSED` 和 `F_TRANSFEREXTENTS`，因为这两种 `fcntl` 可以通过只读描述符修改文件；Ash 的持续路径限制也安装同一防护，包括带有 glob 限制的 `FullAccess`。

`tests/macos.rs` 的 `fcntl` 回归复用自身测试可执行文件的子进程入口，直接调用 Darwin syscall，分别检查普通进程对照及只读、目录写入、持续只读路径限制。生产库仍禁止 `unsafe`；只有该测试目标中的 syscall 模块允许经过注释说明的 FFI。测试不依赖 Python 或 Xcode 启动器。

同一目标另直接运行 `/usr/bin/python3`、`/usr/bin/git` 和 `/usr/bin/xcrun`，验证关闭的标准输入、Python 输入数据、退出码和预期输出，不提前替换启动器路径。宿主对照和每个受限执行均保留 5 秒预算及进程树清理；`getconf DARWIN_USER_CACHE_DIR` 另检查启动器依赖的系统目录查询。

Seatbelt 基础策略允许查询 `com.apple.bsd.dirhelper`。缺少此服务时，`confstr(DARWIN_USER_CACHE_DIR)` 失败，Xcode 回退到重复初始化运行时，Intel runner 的真实启动超过 5 秒；仅扩大 LaunchServices 查询不能解决这个问题。该修复允许系统目录发现，文件写入和 IPC 路径仍由现有策略限制，执行专属 `TMPDIR` 的生命周期归 `exec-server`。

```sh
just test ash-mxc-sandbox --test macos --locked -- --test-threads=1 --nocapture
```

持续规则由 [Seatbelt 编译器](src/seatbelt.rs) 使用后端已有的 `globset` 语法解析，支持 `*`、`**`、`?`、花括号备选和 ASCII 字符类，统一将反斜杠视为路径分隔符。中文等 Unicode 字面量可用；Seatbelt 无法保持后端字节字符类的非 ASCII 语义，因此拒绝此类规则。持续模式不用于新增写授权。持续拒绝规则在准备阶段拒绝已命中的符号链接与多重或无法确认的硬链接；别名及外部进程改变链接关系仍未完成对象级隔离验收。

精确路径和持续 glob 的禁读规则均显式拒绝 `file-read-metadata`。Seatbelt 基础策略允许元数据读取以支持路径解析，单独的 `file-read*` 拒绝无法覆盖这个显式允许；禁读对象的大小和时间戳也属于保护范围。

前端搜索与过滤保留本地 glob，权限解析和实施归后端；两端用共同语法案例检验结果，不通过前端生成的正则授权。前端的相邻文件 `when` 条件不属于沙箱规则。更完整的边界见 [文件权限契约](../../docs/sandboxing.md#文件权限目标)。Unix socket 的路径拒绝规则保留，文件身份快照绑定其所在目录，避免把 socket 当作普通文件打开。

## PTY 启动

- Unix 使用 SDK 的 `RestrictedLaunch::spawn_with_pty`，由 SDK 分配终端并启动 Bubblewrap 或 Seatbelt。Ash 接入终端输入、合并输出、resize、前台作业中断及进程树关闭。
- Windows 的 Rust SDK 仍不支持 ProcessContainer 分配 PTY，因此宿主通过 `with_pty_helper` 提供启动器。`utils-pty` 启动该程序的 `--ash-mxc-pty` 角色，产品入口先调用 `arg0::dispatch`。
- Windows 交接格式归 Ash，包含具体命令、显式环境、文件和网络策略、准备阶段的文件身份。内部角色从同一份 Ash 执行规格生成 typed SDK 请求，不反序列化 SDK 内部执行模型。新增宿主 ACL 授权字段会被拒绝。
- Windows 交接请求最多 1 MiB UTF-8，按字符边界拆成不超过 8 KiB 的环境项；帮助进程检查块数、总字节数、缺块、重复键及多余字段。工作负载环境与启动器环境分开，传输变量不注入工作负载，显式空环境保持为空。PSEC 所需的 `SYSTEMROOT` 和 `LOCALAPPDATA` 由执行器提供。
- `tests/pty.rs` 在 Unix 实际验证输入、resize、环境、只读拒绝、退出、前台作业中断和回收；Windows 普通回归验证帮助进程入口，[PSEC 终端用例](tests/pty/windows.rs) 另检查真实终端输入、尺寸、大环境、传输变量隔离、只读拒写、退出码及后代回收。[执行服务验收](../exec-server/README.md#pty-边界) 通过产品可执行文件和 RPC 检查帮助进程装配、重连与退出输出。这些用例须在支持 PSEC 的系统显式执行，已接入 `scripts/test-psec.ps1`；交叉编译不代表对应系统已通过运行验收。

## SDK 依赖

使用官方 `mxc-sdk = "=1.0.1"` 声明；当前发布包尚不能保持全部已验证的沙箱行为，根清单通过 `[patch.crates-io]` 固定兼容 fork。它基于官方 1.0.1 的 Microsoft `fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2`，保留上游结构。实际来源由 Cargo.lock 记录，Cargo 与 Bazel 使用同一外部源码。必要补丁、已移除的维护差异及退出条件见 [SDK 依赖说明](../../third_party/mxc/README.md)。

适配器通过 SDK `v1::prepare_restricted` 固定 PSEC、禁止宿主 ACL 改动并传入受信 Bubblewrap 路径及 Seatbelt 追加拒绝规则。SDK 拥有运行器选择、基础 profile 和资源清理；Ash 保存唯一的执行规格，准备和启动时临时生成 SDK 请求。管道、PTY 和 Windows helper 分别取得标准 SDK 句柄。

文件身份快照由 `sandboxing` 持有，使用 `file-identity` 的句柄检查；Windows ACL 授权范围仍由 `windows-sandbox` 持有。终端交接直接保存 Ash 的 Allowed、Denied 或 Managed 模式，以及显式环境和文件身份；SDK 的方向网络策略在接入边界生成，无需反向恢复权限或修补内部运行时标记。

升级时固定 commit 并复核兼容 fork 相对官方基线的差异，再验证两个沙箱消费者及平台行为。源码版本和官方支持说明不能替代产品隔离验收。

## 验证

```sh
just verify ash-mxc-sandbox
just verify ash-exec-server
```

平台能力必须通过实际执行验证；交叉编译不能证明隔离生效。各测试先检查普通进程可达性，再验证受限行为、退出码和进程树回收。剩余平台与外部端点验收见 [MXC TODO](../../MXC-TODO.md)。

### Linux 网络

受管网络需要 `bwrap`、`slirp4netns`、`unshare`、`nsenter`、iptables/ip6tables 及其 restore 工具，以及用户命名空间和内核网络功能；缺少依赖时拒绝启动。产品包只携带 Bubblewrap。

Bubblewrap 无法满足 Ash `Allowed` 的全部入站要求，因此拒绝该模式；这不构成允许网络的成功验收。以下入口验证 Denied／Managed 的 HTTP、CONNECT、SOCKS、IPv4／IPv6、TCP／UDP DNS、直连拒绝和后代继承；网络矩阵也适用于 macOS。

```sh
python3 -B scripts/cargo.py build -p ash-network-proxy --example probe --example matrix --profile ci-test --locked
export ASH_BWRAP_PATH=/usr/bin/bwrap
export ASH_NETWORK_PROBE="$PWD/.build/cargo/ci-test/examples/probe"
export ASH_NETWORK_MATRIX_PROBE="$PWD/.build/cargo/ci-test/examples/matrix"
export ASH_DNS_SERVER="<resolver-ip>:53"
just test ash-mxc-sandbox --test linux --locked -- --ignored
just test ash-mxc-sandbox --test network_matrix --locked -- --ignored --test-threads=1
```

设置 `CARGO_TARGET_DIR` 时，相应替换探针目录。DNS 端点须同时支持 TCP／UDP；多个地址用逗号分隔，IPv6 写为 `[address]:53`。可用 `ASH_PUBLIC_IPV6_HTTP_ENDPOINT` 增加公网 IPv6 HTTP 检查，普通进程对照必须先可达；本地回环或受代理影响的 DNS 不证明外部出口。

`ASH_WINDOWS_NETWORK_ENDPOINT` 和 `ASH_WINDOWS_DNS_ENDPOINT` 可增加 Windows 接收端，格式为逗号分隔的 socket 地址；链路本地 IPv6 的 scope ID 使用 Linux 接口编号。自建接收端可用 `ASH_WINDOWS_NETWORK_COUNTER` 提供原子发布的累计请求数；受限执行后计数增加即失败。共享接收端的测试须串行运行。

### WSL2

`tests/wsl.rs` 检查文件／元数据、退出／取消后代回收和 Windows 互操作边界。分别在 Linux 文件系统与 Windows 挂载目录运行；不能通过关闭宿主互操作让拒绝测试通过。测试会先确认普通进程能够启动 Windows 程序。

```sh
export ASH_BWRAP_PATH=/usr/bin/bwrap
export ASH_WSL_WINDOWS_PROGRAM=/mnt/c/Windows/System32/cmd.exe
TMPDIR=/tmp just test ash-mxc-sandbox --test wsl --locked -- --ignored --test-threads=1
```

第二轮将 `TMPDIR` 设为 Windows 挂载上预先创建的测试目录，用相同命令重跑。

### macOS 局域网与 Unix socket

接收端由测试创建，`ASH_SANDBOX_LAN_IP` 使用本机可达的私有 IPv4 地址。测试覆盖直连拒绝、代理批准／拒绝、私有 IPC 目录内创建与连接、目录外 socket 及 SSH agent socket 拒绝。私有 IPC 目录必须与命令目录分开授权。

```sh
ASH_SANDBOX_LAN_IP="$(/usr/sbin/ipconfig getifaddr en0)" just test ash-mxc-sandbox --lib network_tests --locked -- --include-ignored
```

接口名按实际环境替换。此入口只覆盖 IPv4 HTTP 与 Unix socket；IPv6、CONNECT、SOCKS 和 DNS 使用网络矩阵。

### Windows

PSEC 能力、管理员账户、ConPTY 和执行服务 RPC 的环境准备及命令见 [Windows 验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。
