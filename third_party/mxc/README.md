# Microsoft MXC SDK

Ash 声明官方 `mxc-sdk = "=1.0.0"`，通过根 `Cargo.toml` 的 `[patch.crates-io]` 固定兼容 fork。实际来源和提交由 `Cargo.lock` 记录，Cargo 与 Bazel 消费同一份外部源码。本目录只保存许可证和补丁审查依据，不保存 SDK 源码、复制的测试 fixture、二进制构建依赖或独立 lockfile。

发布包 `1.0.0` 来自 Microsoft `a846837d827b496fc4a08dfe60554515758c6647`，早于 Ash 已验证的官方基线 `c6f301d53a1430c4c921a05c57af838f7392348f`。兼容 fork 从后一提交建立，保留上游目录、清单的 workspace 继承和测试来源；不能仅按相同版本号认定发布包与当前实现等价。完整修正见 [固定差异](https://github.com/chogng/mxc/compare/c6f301d53a1430c4c921a05c57af838f7392348f...d4bc220668130f941d117aab4326edb4c1812e78)。

## 必须保留的修正

| 修正                                                  | 保留原因与验证依据                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seatbelt 文件、元数据、目录移动和 `fcntl` 边界        | 保持隐藏目录内的授权例外，固定可写根与受保护对象的祖先，拒绝通过只读描述符修改文件。由适配器库测试、`tests/macos.rs` 和 SDK profile 测试覆盖。                                                                                                                                          |
| Seatbelt Unix socket、环境、系统目录查询和回收        | 私有 IPC 仅开放指定目录；持续路径规则仍由 Ash 编译。保留完整环境、Xcode 启动器所需的 `dirhelper` 查询及后代关闭。由网络、系统启动器和 PTY 回归覆盖。                                                                                                                                    |
| Bubblewrap 挂载、受信执行路径、网络监控与 WSL seccomp | 根挂载与隐藏父目录不能覆盖已授权例外；网络提供进程退出时关闭工作负载；禁止 `AF_VSOCK` 的跨系统启动绕过。Linux/WSL 执行与进程生命周期测试仍是运行验收门槛。                                                                                                                              |
| Unix 退出观察与 PTY 前台中断                          | `waitid(WNOWAIT)` 保留 PID 到最终回收，避免网络监控提前消费退出状态；交互中断作用于终端当前前台作业。SDK 退出观察测试与 Ash 真实 PTY 场景覆盖。                                                                                                                                         |
| PSEC 的完整请求准备与错误类别                         | 在启动前确认本次策略可实施；缺能力允许 Ash 评估其他候选，系统 API 故障不能授权重选。严格 Managed 组合继续拒绝，启动失败不重跑。由 Windows 准备、执行服务和 PSEC 验收覆盖。                                                                                                              |
| Windows ACL 日志、授权范围和恢复                      | 账户后端仍使用 SDK ACL 实现；必须保持独立日志、严格恢复、遍历范围与原有继承标记。`ash-windows-sandbox` 的恢复测试和实机验收继续覆盖这一依赖。                                                                                                                                           |
| SOCKS 环境与 Windows 命令解释语义                     | 保持代理协议和空绕过变量；`cmd.exe /C` 的完整命令不能被普通参数转义破坏。由代理环境、Windows 命令与执行回归覆盖。                                                                                                                                                                       |
| Windows 资源 UTF-8 与 Unix `rustix` 依赖              | 资源编译器必须识别 UTF-8；`rustix` 提供退出观察。保留必要构建改动，不展开或重写其余上游清单。                                                                                                                                                                                           |
| SDK 的严格准备接口与句柄                              | `v1::prepare_restricted` 接受 typed 请求和宿主控制，禁止宿主 ACL 改动、锁定 Windows PSEC、选择受信 Bubblewrap，并组合 Seatbelt 拒绝规则。标准 SDK 句柄承接管道、PTY 和继承控制台；公开前台中断、命令行及文件身份 helper。Ash 无需导入平台 runner、解析内部请求或生成 SDK 基础 profile。 |

以上修正保留当前行为，不扩大产品支持范围。Windows 账户后端的 ACL helper 仍通过 SDK 的兼容导出接入；它是剩余的实现耦合，不能仅为取消依赖而复制一套恢复机制。

## 已移除的维护差异

- `mod.rs` 重命名、模块路径重写和无关格式改动。
- SDK 清单的 workspace 展开、独立 SDK workspace/lockfile、外部 fixture 的重复复制。
- Ash 请求中的 SDK 内部模型、网络策略反向还原、运行时标记修补以及各平台 runner 装配。
- 对 vendored 大文件的豁免和按文件块顺序比较补丁的校验脚本。来源由固定 Git 提交与 Cargo/Bazel lockfile 校验。

## 退出兼容 fork

官方发布版须包含上述隔离与清理修正，并提供等价的严格准备、宿主执行路径、追加限制和前台中断接口。届时移除根清单的 `mxc-sdk` patch 和安全来源豁免，更新 lockfile 与适配器，再运行同一组行为回归。不得通过启用 SDK 默认 fallback、放宽网络入站或丢弃持续路径规则来消除 override。

```sh
just verify ash-mxc-sandbox
just test ash-mxc-sandbox --test macos --test pty --locked -- --test-threads=1
just check ash-mxc-sandbox --target aarch64-unknown-linux-gnu --tests --locked
just check ash-mxc-sandbox --target x86_64-pc-windows-msvc --tests --locked
bazel build //crates/mxc-sandbox:mxc-sandbox --lockfile_mode=error
just dependencies
just dependency-security
```

SDK 自身测试在该固定 fork 的完整 checkout 中执行，例如 `just test mxc-sdk --manifest-path /path/to/mxc/src/Cargo.toml --lib profile_builder --profile test --locked`。Ash 根 workspace 不运行外部 dependency 的 dev-dependencies。真实 Windows/WSL 隔离仍须使用对应平台的验收入口，交叉编译不代表运行通过。既有平台证据见 [适配器](../../crates/mxc-sandbox/README.md) 和 [Windows 验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。
