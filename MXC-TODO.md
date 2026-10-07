# MXC 升级验收与去除 vendor

本轮固定官方提交 `c45e7d5a485036d88f469aa363efaa3c651564bc`，采用 `mxc-sdk 1.0.0`。Windows 由本任务继续验收；Linux、macOS 由用户另行验收。每个平台记录实际源码、系统版本、架构、命令、通过数和清理结果，旧 pin 的结果不算新版通过证据。

## 为什么目前保留 vendor

官方单包 SDK 已直接提供 Unix PTY、请求契约和平台运行器。文件身份快照、宿主 ACL 授权范围和 Windows 终端交接格式已移回 Ash。

当前仍有官方未合入的隔离和生命周期修正：隐藏父目录内的授权例外、Windows ACL 日志与继承恢复、精确 PSEC 能力准备、WSL `AF_VSOCK` 禁止、进程树清理前保留 PID，以及 Unix 终端前台中断和 Bubblewrap 作业控制。直接改成官方 Git 依赖会失去这些修正；改用 fork 仍需维护同样的补丁。

完整差异和来源校验见 [vendor 说明](ash-rs/vendor/mxc/README.md)；已运行项目见 [适配器验证](ash-rs/mxc-sandbox/README.md#验证)。本轮补丁包含 51 个 `mod.rs` 文件模块改名，不能把补丁文件数量全部当作功能修改数量。

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
- [ ] 新 pin 的 PSEC 成功执行：在具备完整能力的 Windows 主机运行 `scripts/test-psec.ps1 -Capability required`；本机无法覆盖，旧 ARM64 CI 结果不能复用。

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

WSL 复测、Windows 挂载目录和可选公网 IPv6 的完整参数见 [现有入口](ash-rs/mxc-sandbox/README.md#验证)。不改网络授权来让测试通过。

## macOS：用户验收

- [ ] 在 macOS 实机编译并运行适配器和官方 PTY 的 6 项测试；本轮目前仅完成 ARM64 测试目标交叉编译。
- [ ] 验证 Seatbelt 的只读目录、写入范围、隐藏父目录授权例外、元数据和进程树回收。
- [ ] 验证禁止网络和受管代理的实际流量；独立检查 Unix socket 禁止、执行私有 IPC 例外与敏感 socket 拒绝。
- [ ] 验证 PTY 输入、尺寸、环境、中断前台作业后 shell 存活、退出和回收。
- [ ] 若支持 Intel Mac，补 x86_64 实机验收；记录 macOS 版本与架构。

```sh
just test ash-mxc-sandbox --lib --locked
just test ash-mxc-sandbox --test pty --locked
just test ash-tool-executor --lib --locked
just test ash-exec-server --test execution --locked
just test mxc-sdk --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib profile_builder::tests --locked
just rust-warnings ash-mxc-sandbox
```

Seatbelt 策略生成单测不证明实际访问受到限制；网络、文件与 IPC 项需通过真实沙箱进程验证。

## 去除 vendor 的条件

- [ ] 逐项对照 `changes.patch`，把仍需要的通用修正提交官方或确认官方已有等价实现；Unix PTY 作业控制与 UTF-8 资源构建可单独提交。
- [ ] 确认官方代码完整实施 Ash 已批准的文件、网络、ACL 和进程生命周期要求。
- [ ] 固定新的官方 commit，用未经修改的 SDK 重新完成三个平台的受影响验收。
- [ ] 将 `mxc-sdk` 改为官方 Git `rev` 依赖，更新 Cargo/Bazel/依赖审查记录，再删除 vendor 源码、补丁校验与过时链接；保留许可证归属。
