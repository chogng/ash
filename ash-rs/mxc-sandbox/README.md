# ash-mxc-sandbox

- 将 Ash 已批准的文件、网络和宿主 ACL 要求转换为 Microsoft MXC 请求。
- 管道进程通过 `mxc_sdk::spawn_sandbox` 启动；PTY 通过继承终端的内部启动器调用 MXC 底层后端。
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

`SandboxLaunch` 保存已完成能力选择和对象身份检查的 SDK 请求，直到 Executor 确认执行起点后才启动。
`SandboxProcess` 接口暴露标准流、等待和关闭；SDK 句柄保留到输出排空后再释放。
正常结束、取消和超时均调用 SDK 的终止与等待，随后关闭 Ash 的代理。

动作授权属于 `action-policy` / Core。代理按同一授权检查真实目标。
`tool-executor` 提交已确定的执行预算；进程、输出和超时实施属于 `exec-server`。Ash 的 `SandboxBackends` 在执行前选择后端；MXC 负责自身实现的进程创建和资源清理。

## 权限与支持范围

| 要求 | 当前行为 |
| --- | --- |
| 目录读写、隐藏存储和授权例外 | 转换为 SDK 文件策略；适配器在启动前重新检查规范路径 |
| 保护元数据 | 构造请求时，将已存在的 `.git`、`.agents`、`.codex`、`.ash` 文件或目录设为只读；不存在的路径不创建，其他检查错误拒绝请求 |
| 宿主 ACL | `HostAclChanges::Denied` 禁止改动；`Scoped` 单独授权 Grant 与隐藏目录内的 ACL 改动，并在正常关闭时撤销；宿主只读范围不隐含 ACL 修改权 |
| 网络禁止 / 允许 | 传入 schema 0.8 的明确网络要求，由 SDK 判断后端能否完整实施 |
| 受管网络 | 一个执行专属端口承载 HTTP、CONNECT、SOCKS；保持禁止直连及其他入站要求 |
| Windows 后端 | MXC 只接受具备完整策略能力的 PSEC；其他实现由 Ash 沙箱层分别评估和选择 |
| Windows 严格受管网络 | 只接受 PSEC 能完整实施的端点和入站约束；本机 23H2 不具备该能力 |
| 完全文件访问＋允许网络 | 显式授权的普通进程，使用通用进程实现 |

App Server 的固定沙箱配置允许策略范围内的宿主 ACL 改动，命令参数不能更改此要求。
本轮账户原型及 `mxc-user.exe` 已退出源码和产品包。适配器不配置账户或持久网络规则。
SDK 的 ACL 正常关闭清理不等于宿主崩溃后的恢复保证；Windows 异常退出仍需实机验收。
子进程退出码不再经过私有运行器重映射。输出中的权限错误只产生“可能已有副作用”的诊断，不能证明进程未启动或授权重跑。

## PTY 启动

- 宿主通过 `with_pty_helper` 明确提供启动器路径；`utils-pty` 分配 PTY 后启动该程序的 `--ash-mxc-pty` 内部角色。启动器必须在产品入口前调用 `arg0::dispatch`；适配器不自行解析当前可执行文件，未配置时拒绝受限 PTY。
- 受信启动交接保存完整权限、固定执行路径和准备阶段的文件身份；普通 MXC 配置仍不能反序列化这些授权字段。
- 启动参数仅由宿主生成，通过有界环境项交给内部角色；序列化上限 16 KiB，超限在启动前拒绝。
- 工作负载环境与启动器环境分开，MXC 在应用约束后设置工作负载环境。
- Seatbelt、Bubblewrap 和 Windows PSEC 继承终端；Windows 不进入其他实现。
- PTY 输入输出、尺寸、信号和进程树关闭归 Ash 执行句柄管理。
- macOS 真实进程测试覆盖断连输入、resize、只读拒绝和取消回收；Linux/Windows 交叉编译通过不代表实机验收。

## SDK 依赖

固定 Microsoft MXC `6cd3d58f05d3447e67109cfb75e042803b843ca4`。
为承接 Ash 的现有契约，部分上游 crate 以可审查源码补丁保存在
[vendor/mxc](../vendor/mxc/README.md)，由根 Cargo patch 配置和 Bazel 使用。
这些是 MXC 自己的核心和平台 crate；Ash 适配器依赖 SDK 与执行引擎的受信启动交接接口。

上游仍将此版本标为早期预览，接线与测试不代表生产隔离资格。
[上游说明](https://github.com/microsoft/mxc/tree/6cd3d58f05d3447e67109cfb75e042803b843ca4)

## 验证

```sh
just test ash-mxc-sandbox
just test ash-tool-executor
just check ash-mxc-sandbox --target x86_64-pc-windows-msvc --tests
just check ash-mxc-sandbox --target aarch64-unknown-linux-gnu --tests
```

Linux 受管网络由 SDK 使用 `bwrap`、`slirp4netns`、`unshare`、`nsenter`、iptables/ip6tables 及其 restore 工具实施。
需要相应用户命名空间和内核网络功能；缺少依赖时拒绝启动。产品包只携带 Bubblewrap，不再携带 Ash namespace helper。

```sh
python3 -B scripts/cargo.py build -p ash-network-proxy --example probe
export ASH_NETWORK_PROBE="$PWD/.build/cargo/debug/examples/probe"
just test ash-mxc-sandbox --test linux -- --ignored
```

Windows 实机步骤见 [验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。
