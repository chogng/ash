# Microsoft MXC 依赖补丁

- 保存 Microsoft MXC 固定版本中需要修正的四个现有 crate。
- 通过根 `Cargo.toml` 的 `[patch]` 统一平台与账户后端使用的依赖；其余依赖直接来自同一上游 revision。
- 保留上游的框架与平台实现，不承载 Ash 授权、审批或产品策略。
- Cargo 与 Bazel 使用同一份源码；产品包包含原始 MIT 许可证。

来源与包路径在 [upstream.json](upstream.json)，完整差异在 [changes.patch](changes.patch)。
固定 revision 为 `46ce71d0da7b97bb531a33e175bf4166ffa730c0`。
这些是上游已有的 SDK 包。`mxc_engine` 副本已删除；请求转换和 PTY 交接由 [Ash 适配器](../../mxc-sandbox/README.md) 维护。当前上游仍未提供按完整请求准备 PSEC 且保留结构化错误的公开入口，因此保留该项平台补丁。

## 补丁范围

| 上游包 | 修正 |
| --- | --- |
| `wxc_common` | 文件对象身份与 ACL 授权及受信交接序列化；独立日志和严格恢复；继承传播前记录旧格式对象，授权、撤销与异常恢复均保留原始 `AI` 标记；不传播到子项的祖先属性授权；退出观察保留 PID 到回收；代理环境保留 SOCKS 协议 |
| `seatbelt_common` | 隐藏父目录中的授权例外；独立禁止 Unix socket；完整环境与句柄生命周期 |
| `bwrap_common` | 固定执行路径；恢复根挂载后的虚拟文件系统；封闭隐藏父目录；代理环境与退出观察；网络监控在进程树清理前不回收 PID；以 seccomp 禁止绕过 Linux 命名空间的 `AF_VSOCK` 宿主通信 |
| `process_container_common` | 按本次请求构造 PSEC 规格并实际准备，保留能力缺失与运行故障的结构化区别；Ash 直接调用 PSEC 运行器 |

Cargo 清单具体化了上游 workspace 继承，以便根 Cargo 与 Bazel 对路径依赖得到同一结果。
上游仓库根的四份 telemetry-consent、三份 provision 配置及开发契约的完整请求 fixture，随包复制到 `wxc_common/tests/fixtures`，对应测试使用包内路径。
上游的 `mod.rs` 改为同名文件模块，保留模块路径与可见性。
框架源代码不依赖 `ash-*`、`sandboxing` 或 `network-proxy`。

目录授权仍由 Windows 传播权限项。变更日志先保存根与未保护子项中原先没有 `SE_DACL_AUTO_INHERITED` 的对象；每次传播后用当前 DACL 恢复这些对象的控制标记，保留其他执行的 SID 权限项。受保护根单独写回，再由未保护子项取得父目录授权并向下传播，保留根上历史继承项的标记。受保护子目录的子树与重解析点不参与扫描。日志也用于传播中断后的恢复，相关实测见 [ACL 复测](../../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-acl-恢复与公网-ipv6-复测)。

Bubblewrap 在执行命令前安装套接字过滤器，并由后代继承。WSL 的可执行文件互操作可使用内核保存的 `/init` 解释器引用，单靠隐藏 `/init` 或 Windows 挂载不能阻止 Windows 进程创建；拒绝 `AF_VSOCK` 阻止其建立跨系统启动通道。过滤器保留 IP 和 Unix socket 操作，支持 Linux x86_64 与 aarch64 的 64 位系统调用 ABI；不允许兼容的 32 位或 x32 ABI 绕过检查。传递过滤器的文件描述符仅由本次 Bubblewrap 继承，在工作负载启动前关闭。

## 复核

对照干净的上游固定版本 checkout：

```sh
python3 -B ash-rs/vendor/mxc/verify.py --upstream /path/to/mxc
```

修改或升级依赖后，重新生成并审阅差异，再运行针对行为的测试：

```sh
python3 -B ash-rs/vendor/mxc/verify.py --upstream /path/to/mxc --write-patch
just test ash-mxc-sandbox
just test seatbelt_common --manifest-path ash-rs/vendor/mxc/Cargo.toml profile_builder::tests --lib --locked
just check ash-mxc-sandbox --target x86_64-pc-windows-msvc --tests
just check ash-mxc-sandbox --target x86_64-unknown-linux-gnu --tests
just check ash-mxc-sandbox --target aarch64-apple-darwin --tests
bazel build //ash-rs/mxc-sandbox:mxc-sandbox
```

Windows 账户原型已退出本 fork 和产品包。Ash 的后端选择属于 `sandboxing`，MXC 不负责调用其他供应商实现。

SDK 自身测试使用本目录的 workspace 与 lockfile：

```sh
just test wxc_common --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib host_changes::tests --locked
just test process_container_common --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib psec_tests --locked
```

两份 lockfile 分别锁定产品消费图和 SDK 测试图；发布使用根 lockfile。
Linux/Windows 系统隔离与异常恢复仍须实机验证；固定上游版本的预览限制继续适用。
