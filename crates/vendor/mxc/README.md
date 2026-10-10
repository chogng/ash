# Microsoft MXC 依赖补丁

保存官方 `mxc-sdk 1.0.0` 单包，固定 revision `c6f301d53a1430c4c921a05c57af838f7392348f`。来源在 [upstream.json](upstream.json)，相对该版本的完整差异在 [changes.patch](changes.patch)。根 Cargo 通过路径依赖接入，Bazel 使用相同源码；保留原始 MIT 许可证。

上游合并后的 SDK 负责平台进程、PTY、契约转换和资源清理。[Ash 适配器](../../mxc-sandbox/README.md) 负责授权转换、后端选择及 Windows 终端交接。文件身份快照、ACL 授权范围和交接格式均已移回 Ash，不再扩展 SDK 内部模型的反序列化能力。

## 保留的修正

| 模块 | 修正 |
| --- | --- |
| `mxc_common` | 独立 ACL 日志与严格恢复、继承标记和祖先属性授权；退出观察保留 PID；SOCKS 环境保持协议；Windows 命令行保留调用方的命令解释语义 |
| Bubblewrap | 指定执行路径、根挂载下的系统文件恢复、隐藏父目录内的授权例外、网络监控的 PID 生命周期、禁止 WSL 的 `AF_VSOCK` 绕过 |
| Seatbelt | 隐藏父目录内的授权例外、独立禁止 Unix socket、完整环境和进程清理；固定可写根及受保护路径的祖先目录，拒绝通过只读描述符修改文件的 `fcntl` 80/110 |
| ProcessContainer | 按完整请求准备 PSEC，区分能力缺失与系统调用故障；准备和启动使用相同的 PSEC 1.0 无包身份代理兼容判断；Ash 明确选择 PSEC 运行器 |
| Unix PTY | 直接使用官方 PTY；添加向终端当前前台进程组发送中断的接口；避免 Bubblewrap 再次创建 session，保留控制终端与作业控制 |
| Windows 构建 | 资源文件明确使用 UTF-8，Cargo 与 Bazel 均可编译；Bazel 资源编译器使用现有 LLVM 工具链 |

`mod.rs` 改为同名文件模块，保留路径和可见性。SDK 测试所需的外部 fixture 复制到包内，避免依赖 Microsoft 仓库根目录。独立 SDK workspace 保留上游依赖版本与功能定义，包清单展开 workspace 引用供 Bazel 解析；两个 Windows 构建工具放入通用构建依赖，仅 Windows 构建脚本使用。产品使用根 lockfile，SDK 测试使用本目录 lockfile。SDK 源码不依赖 Ash。

2026-10-10 从 `c45e7d5a` 合入 26 个上游提交，SDK 包版本及依赖声明保持不变。上游已删除旧网络策略字段和内置测试代理；Ash 终端交接直接检查出站、入站及宿主回环策略，拒绝不能完整表达的规则。Seatbelt 禁读路径显式拒绝 `file-read-metadata`，隐藏父目录中的授权例外仍保留。上游新增的无包身份代理能力要求显式允许宿主回环及私网入站，不满足 Ash 的严格 Managed 请求，因此产品继续在准备阶段拒绝该组合。

目录授权仍由 Windows 传播权限项。变更日志先保存根与未保护子项中原先没有 `SE_DACL_AUTO_INHERITED` 的对象；每次传播后用当前 DACL 恢复这些对象的控制标记，保留其他执行的 SID 权限项。受保护根单独写回，再由未保护子项取得父目录授权并向下传播，保留根上历史继承项的标记。受保护子目录的子树与重解析点不参与扫描。日志也用于传播中断后的恢复，相关实测见 [ACL 复测](../../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-acl-恢复与公网-ipv6-复测)。

Bubblewrap 在执行命令前安装套接字过滤器，并由后代继承。WSL 的可执行文件互操作可使用内核保存的 `/init` 解释器引用，单靠隐藏 `/init` 或 Windows 挂载不能阻止 Windows 进程创建；拒绝 `AF_VSOCK` 阻止其建立跨系统启动通道。过滤器保留 IP 和 Unix socket 操作，支持 Linux x86_64 与 aarch64 的 64 位系统调用 ABI；不允许兼容的 32 位或 x32 ABI 绕过检查。传递过滤器的文件描述符仅由本次 Bubblewrap 继承，在工作负载启动前关闭。

## 复核

```sh
python3 -B crates/vendor/mxc/verify.py --upstream /path/to/mxc --write-patch
python3 -B crates/vendor/mxc/verify.py --upstream /path/to/mxc
just test ash-mxc-sandbox
just test mxc-sdk --manifest-path crates/vendor/mxc/Cargo.toml --lib psec_tests --locked
just check ash-mxc-sandbox --target x86_64-unknown-linux-gnu --tests
just check ash-mxc-sandbox --target aarch64-apple-darwin --tests
bazel build //crates/mxc-sandbox:mxc-sandbox
```

Linux/macOS 的真实隔离行为须在对应系统验证。Windows 的 Rust ProcessContainer PTY 尚不可直接使用；Node 端的 PTY 接入不改变此限制。

2026-10-06 的 macOS 27.0.1 ARM64 实测已覆盖上述文件边界及官方 PTY，SDK 策略生成 89 项测试通过。Ash 特有的持续 glob 和未创建元数据规则由适配器追加，SDK 不依赖 Ash 的规则类型或 glob 实现。具体通过数及未验收范围见 [适配器验证](../../mxc-sandbox/README.md#验证)。
