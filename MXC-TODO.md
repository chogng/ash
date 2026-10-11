# MXC 升级验收与去除 vendor

下述记录属于 2026-10-07 的官方提交 `c45e7d5a485036d88f469aa363efaa3c651564bc`，采用当时的 `mxc-sdk 1.0.0`。Windows 和 macOS ARM64 已有这些实机结果；Linux 发行版及各平台未覆盖的组合继续单独验收。每个平台记录实际源码、系统版本、架构、命令、通过数和清理结果，旧 pin 的结果不算新版通过证据。

## 当前依赖方式

2026-10-11 已删除 Ash 中的 SDK vendor，改为官方版本声明加固定兼容 fork。上游模块布局、workspace 清单和 fixture 来源均保留，必要的隔离修正通过 Git 提交复核；具体保留原因和退出条件见 [SDK 依赖说明](third_party/mxc/README.md)。适配器只保存 Ash 执行规格，通过 typed 严格准备接口和 SDK 句柄接入。

下述 2026-10-07 验收属于原 pin 的历史证据；它不证明当前 fork 已在 Windows/WSL 重新运行。当前 macOS 行为回归和跨平台编译结果由 [适配器验证](crates/mxc-sandbox/README.md#验证) 记录。

### 当前 SDK 的 Windows／WSL 实机复测

- [ ] 在支持 PSEC 的 Windows 宿主重跑当前固定 fork 的文件、网络、ConPTY、执行服务 RPC、后代回收和清理验收，记录系统版本、架构、SDK 提交及原始结果；入口见 [Windows 验收手册](docs/windows-sandbox-acceptance-runbook.md) 和 `scripts/test-psec.ps1`。
- [ ] 在该宿主的 WSL2 中重跑 Linux 适配器、PTY、执行服务及网络矩阵，补 Windows 挂载目录边界，记录发行版、内核和 Bubblewrap 版本；使用下文 Linux 命令及 [WSL 验证入口](crates/mxc-sandbox/README.md#验证)。

2026-10-11 当前工作环境只有 macOS，无法直接运行 Windows／WSL2；本轮未接入可用的 Windows 宿主，因此以上两项保持待办。可以使用具备 PSEC 与 WSL2 的同一台 Windows 机器，通过 SSH 控制或相应 Windows CI 运行；交叉编译和历史 pin 的结果均不能替代当前 SDK 的实机证据。本轮 macOS 沙箱 45 项及执行服务 70 项测试通过，Linux ARM64、Windows x64 测试目标编译通过，Bazel 构建及依赖安全检查通过。

## Windows：本任务负责

- [x] Windows 适配器 13 项单元测试、终端启动器请求缺失拒绝、文件身份与快照测试。
- [x] 账户文件策略 8 项测试，覆盖目录替换、junction 越界、硬链接、隐藏父目录与独立 ACL 日志。
- [x] SDK ACL 35 项、继承恢复 2 项、PSEC 诊断 2 项测试。
- [x] 当前本机 PSEC 缺能力验收：13 项单元测试、2 项普通回归、1 项明确缺能力拒绝通过；本机 build 22631，不作为 PSEC 成功执行证据。
- [x] Windows Cargo 构建、Rust warning 门禁、依赖检查与 Bazel 适配器库构建。
- [x] 执行服务库测试：首轮 34 项通过，1 项因 Windows 路径前缀的字符串断言失败；改为比较实际目录后，仅重跑失败项通过，warning 门禁通过。程序目标没有测试，未计入通过数。
- [x] Windows 服务 9 项测试，覆盖真实认证管道、连续连接、延迟读取、受限令牌和安装文件权限；没有安装 SCM 服务或账户。
- [x] 账户库完整普通测试：38 项通过，2 项需安装账户的用例忽略；包括真实受限 PowerShell、ConPTY、输出排空、ACL 恢复与代理身份边界。账户库与服务的 warning 门禁通过。
- [ ] 管理员账户验收：安装、认证管道、真实文件权限、网络、PTY、后代回收、运行器更新、服务更新和清理。程序已构建；首次 UAC 启动返回“操作已被用户取消”，尚未安装测试账户或服务。
- [x] 新 pin 的 PSEC 成功执行：Windows 11 25H2 ARM64、build `26200.9457` 的 CI 实际通过 7 项适配器执行、3 项 ConPTY 和 4 项产品 RPC，包含目录别名限制；Server 2022/2025 x64 通过适配器及产品缺能力拒绝。三个 PSEC 任务全部通过，源码提交、原始失败及边界见 [本轮验收](docs/windows-sandbox-acceptance-runbook.md#2026-10-07-psec-终端与执行服务-rpc-验收)。本机 23H2 仍缺能力；网络矩阵与 App Server PSEC 产品链未覆盖。

本轮本机证据保存在 `.build/acceptance/mxc-upgrade-windows-20261007/`。Bazel 已构建 Ash 库，但官方构建脚本仍产生 3 条辅助程序 `cargo:rustc-link-arg-bin` 不受支持提示；这些辅助程序没有取得 Bazel 构建资格。Windows Rust ProcessContainer 仍不提供 PTY，Ash 保留自己的终端启动器。

管理员入口已准备在 `.build/acceptance/mxc-upgrade-windows-20261007/run-admin-acceptance.ps1`。它调用仓库现有验收脚本，使用已完成 TCP/UDP DNS 正向对照的 `10.60.1.2:53`，最后独立检查账户、SCM 服务、安装目录、四个祖先目录的 SDDL，以及本次 WFP 对象是否恢复或删除。

```powershell
# 在本机管理员 PowerShell 中运行；入口按本机绝对路径准备。
pwsh -NoProfile -File .build/acceptance/mxc-upgrade-windows-20261007/run-admin-acceptance.ps1
```

## Linux：用户验收

- [ ] 在真实 Linux 主机运行适配器、执行服务和终端测试，记录系统、架构及 Bubblewrap 版本。
- [ ] 验证读写目录、参考目录只读、隐藏父目录中的授权例外、元数据、符号链接和真实退出码。
- [ ] 验证 Denied/Managed 的 HTTP、CONNECT、SOCKS、IPv4/IPv6、TCP/UDP DNS、直连拒绝和后代继承；先做普通进程可达性对照。
- [ ] 验证 PTY 输入、尺寸、显式环境、前台作业中断后 shell 继续运行，以及退出、关闭和丢弃后的回收。
- [ ] 若支持 ARM64，补对应实机验收；交叉编译不算运行通过。

本机 WSL2 已有新版的 6 项 PTY、3 项跨系统回归、11 项适配器单测及 2 项文件快照测试通过。用户仍需确认实际 Linux 发行版上的行为。

```sh
just test ash-mxc-sandbox --lib --locked
just test ash-mxc-sandbox --test pty --locked
just test ash-exec-server --test execution --locked
python3 -B scripts/cargo.py build -p ash-network-proxy --example probe --example matrix --locked
export ASH_BWRAP_PATH=/usr/bin/bwrap
# 设置 CARGO_TARGET_DIR 时，以下路径改为该目录下的 debug/examples。
export ASH_NETWORK_PROBE="$PWD/.build/cargo/debug/examples/probe"
export ASH_NETWORK_MATRIX_PROBE="$PWD/.build/cargo/debug/examples/matrix"
# 设为普通进程能够进行 TCP/UDP DNS 往返的实际端点。
export ASH_DNS_SERVER="<resolver-ip>:53"
just test ash-mxc-sandbox --test linux --locked -- --ignored
just test ash-mxc-sandbox --test network_matrix --locked -- --ignored --test-threads=1
just rust-warnings ash-mxc-sandbox
```

WSL 复测、Windows 挂载目录和可选公网 IPv6 的完整参数见 [现有入口](crates/mxc-sandbox/README.md#验证)。不改网络授权来让测试通过。

## macOS：ARM64 实机与剩余验收

- [x] 在 macOS 27.0.1（build 26A434）ARM64 实机运行适配器库 27 项和官方 PTY 7 项测试。
- [x] 验证 Seatbelt 的只读目录、写入范围、隐藏父目录授权例外、元数据和进程树回收；新增祖先目录移动、未创建的元数据、持续 glob 的新文件及 `fcntl` 80/110 回归。
- [x] 使用本机实际局域网私有 IPv4 接收端验证 HTTP 对照、Denied/Managed 直连拒绝，以及代理目标批准与拒绝。
- [x] 验证 Unix socket 默认禁止、执行私有 IPC 目录中的创建与连接、其他可写目录 socket 拒绝，以及模拟 SSH agent socket 拒绝。
- [ ] 补齐 IPv6、CONNECT、SOCKS、TCP/UDP DNS、后代网络继承及另一台局域网设备；真实 Docker/GPG socket 仍需对应环境验收。
- [x] 验证 PTY 输入、尺寸、环境、中断前台作业后 shell 存活、退出和回收；终端内同样实施持续拒绝与只读规则。
- [ ] 若支持 Intel Mac，补 x86_64 实机验收；记录 macOS 版本与架构。

```sh
just test ash-mxc-sandbox --lib --locked
just test ash-mxc-sandbox --test pty --locked
just test ash-tool-executor --lib --locked
just test ash-exec-server --test execution --locked
just test ash-sandboxing --lib --locked
just test mxc-sdk --manifest-path /path/to/mxc/src/Cargo.toml --lib profile_builder --profile test --locked
just rust-warnings ash-mxc-sandbox
```

2026-10-06 使用当前 pin 加本地补丁执行上述文件与终端回归：`sandboxing` 库 20 项、SDK Seatbelt 策略生成 89 项及前端现有 glob 3 项通过。本次文件边界参考本地 Codex `822e58cc3d666166c7446c5b1ea2e52f5d09594c` 的 `seatbelt.rs`；继续由 MXC 负责平台运行器与基础策略，Ash 负责自身路径规则。持续 glob 支持共同路径语法及 Unicode 字面量，非 ASCII 字节字符类和持续写授权明确拒绝。前端保留本地匹配，权限规则由后端独立解析和实施。

执行器库 14 项、执行服务集成 15 项也通过；适配器、`sandboxing`、SDK 的正常 check 与 warning 门禁通过，Linux/Windows ARM64 测试目标交叉编译通过。依赖检查、vendor 校验和 Bazel 适配器库构建通过；Bazel 的既有系统库注解提示仍存在。

补充 3 项 ARM64 实测通过：本机实际局域网私有 IPv4 接收端的 HTTP 对照、Denied 与 Managed
直连拒绝、代理目标批准与拒绝；私有 IPC 目录内创建与连接成功且其他可写目录 socket 被拒绝；
私有目录中的模拟 SSH agent socket 仍被拒绝。每个接收端都有普通进程可达性对照和实际请求计数。
这些测试不依赖公网；IPv6、CONNECT、SOCKS、TCP/UDP DNS 及另一台局域网设备仍未覆盖。

TS 聊天工作区文件选择器已通过 `file/search/glob` 复用 Agent 的后端文件查询；
前端保留已有路径匹配与独立浏览器资源遍历。查询取消与连接绑定，搜索 ignore 规则不参与沙箱授权。

Seatbelt 策略生成单测不证明实际访问受到限制；尚未完成网络实际流量矩阵、私有 IPC 完整矩阵和 Intel Mac 验收，不能据此宣称完成所有 Codex 能力对齐。

## 退出兼容 fork 的条件

- [ ] 逐项对照固定 fork 与官方基线的差异，把仍需要的通用修正提交官方或确认官方已有等价实现；Unix PTY 作业控制与 UTF-8 资源构建可单独提交。
- [ ] 确认官方代码完整实施 Ash 已批准的文件、网络、ACL 和进程生命周期要求。
- [ ] 固定新的官方 commit，用未经修改的 SDK 重新完成三个平台的受影响验收。
- [ ] 移除根清单的兼容 patch，保留官方 SDK 版本声明，更新 Cargo/Bazel lockfile、来源审查与链接；保留许可证归属。
