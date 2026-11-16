# Microsoft MXC SDK

Ash 声明官方 `mxc-sdk = "=1.1.0"`，通过根清单的 `[patch.crates-io]` 固定兼容 fork 的提交 `37130e3d3a5116cb48ec333c9595fb969f603af2`。Cargo 与 Bazel 使用同一外部源码，来源由 lockfile 记录。本目录只保存许可证和补丁审查依据。

本轮 SDK 版本为 `1.1.0`，上游基线为具体提交 `c6620183`；版本号不限制后续更新。升级时选择经过平台回归的官方提交，合入兼容分支并删除已被上游吸收的补丁，再更新 Ash 固定的 Git revision。Cargo 与 Bazel 使用同一源码，不跟随浮动分支，也不分别维护功能补丁的应用流程。

源码基线为官方 `c6620183`，SDK 版本为 `1.1.0`，V1 typed API 的稳定 schema 仍为 `1.0.0`。兼容分支为 `codex/ash-sdk-compat-1.1.0-simplify`，见 [完整兼容差异](https://github.com/chogng/mxc/compare/c66201839d63cae2239db5e92f1f1d6076cf5181...37130e3d3a5116cb48ec333c9595fb969f603af2)。该提交延续原兼容补丁，并新增 PSEC 直接 PTY、typed Seatbelt 路径限制和版本化账户 ACL 接口。

1.1.0 升级采用官方 Bubblewrap 挂载规划、地址族过滤、受限路径探测、Seatbelt profile 准备及进程标记清理。官方仍缺少严格准备、宿主执行路径、追加限制和前台中断接口，并移除了账户后端使用的 ACL helper；兼容分支保留这些能力，不恢复已删除的降级运行器。Windows Managed 网络仍拒绝缺少完整入站隔离的 PSEC 组合。Ash 按新版 `FilesystemPolicyError::message` 读取委派检查错误。

## 必须保留的修正

| 修正                                                  | 保留原因与验证依据                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seatbelt 文件、元数据、目录移动和 `fcntl` 边界        | 保持隐藏目录内的授权例外，固定可写根与受保护对象的祖先，拒绝通过只读描述符修改文件。由适配器库测试、`tests/macos.rs` 和 SDK profile 测试覆盖。                                                                                                                                          |
| Seatbelt Unix socket、环境与系统目录查询 | 私有 IPC 仅开放指定目录；持续路径规则通过 typed 限制交由 SDK 编译。保留完整环境和 `dirhelper` 查询，后代清理由上游进程标记机制承担。 |
| Bubblewrap 执行路径、会话和网络监控 | probe 与 spawn 使用同一宿主指定路径；PTY 保留前台作业控制；退出观察在进程组清理和网络监控结束前保留 PID。挂载规划和地址族过滤采用上游实现；根目录授权后重建私有 `/dev`、`/proc`，随后仍应用更深路径限制。 |
| Unix 退出观察与 PTY 前台中断 | Bubblewrap 使用 `waitid(WNOWAIT)` 保留 PID 到最终回收；交互中断作用于终端当前前台作业。Seatbelt 使用新版上游进程标记清理。 |
| PSEC 的完整请求准备与错误类别                         | 在启动前确认本次策略可实施；缺能力允许 Ash 评估其他候选，系统 API 故障不能授权重选。严格 Managed 组合继续拒绝，启动失败不重跑。由 Windows 准备、执行服务和 PSEC 验收覆盖。                                                                                                              |
| Windows ACL 日志、授权范围和恢复                      | 账户后端仍使用 SDK ACL 实现；必须保持独立日志、严格恢复、遍历范围与原有继承标记。`ash-windows-sandbox` 的恢复测试和实机验收继续覆盖这一依赖。                                                                                                                                           |
| SOCKS 环境与 Windows 命令解释语义                     | 保持代理协议和空绕过变量；`cmd.exe /C` 的完整命令不能被普通参数转义破坏。由代理环境、Windows 命令与执行回归覆盖。                                                                                                                                                                       |
| Windows 资源 UTF-8、Unix 退出观察与工具链兼容 | 资源编译保留 UTF-8；`rustix` 提供非回收式退出观察；原子取消状态使用兼容上游最低 Rust 版本的 CAS 循环，避免 Ash 工具链弃用警告。 |
| SDK 的严格准备接口与句柄                              | `v1::prepare_restricted` 接受 typed 请求和宿主控制，禁止宿主 ACL 改动、锁定 Windows PSEC、选择受信 Bubblewrap，并组合 Seatbelt 拒绝规则。管道、PTY 和继承控制台直接委托官方引擎；兼容层不再重复选择后端或转换启动错误。公开前台中断、命令行及文件身份 helper。Ash 无需导入平台 runner、解析内部请求或生成 SDK 基础 profile。 |

以上修正保留当前行为，不扩大产品支持范围。Windows 账户后端通过 `v1::filesystem_acl` 使用 SDK 的 ACL 日志与恢复实现；产品代码不再导入 SDK 内部模型。

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

SDK 自身测试在该固定 fork 的完整 checkout 中执行，例如 `just test mxc-sdk --manifest-path /path/to/mxc/src/Cargo.toml --lib profile_builder --profile test --locked`。Ash 根 workspace 不运行外部 dependency 的 dev-dependencies。真实 Windows/WSL 隔离使用 [适配器验证入口](../../crates/mxc-sandbox/README.md#验证) 和 [Windows 验收手册](../../docs/windows-sandbox-acceptance-runbook.md)，交叉编译不代表运行通过。
