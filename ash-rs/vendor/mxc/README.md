# Microsoft MXC 依赖补丁

- 保存 Microsoft MXC 固定版本中需要修正的五个现有 crate。
- 通过根 `Cargo.toml` 的 `[patch]` 替换 SDK 内部依赖；公开 `mxc-sdk` 仍来自同一上游 revision。
- 保留上游的框架与平台实现，不承载 Ash 授权、审批或产品策略。
- Cargo 与 Bazel 使用同一份源码；产品包包含原始 MIT 许可证。

来源与包路径在 [upstream.json](upstream.json)，完整差异在 [changes.patch](changes.patch)。
固定 revision 为 `6cd3d58f05d3447e67109cfb75e042803b843ca4`。
这些是上游已有的 SDK 包，不是新增的 Ash 平台沙箱 crate。

## 补丁范围

| 上游包 | 修正 |
| --- | --- |
| `mxc_engine` | 结构化 argv、独立 ACL 授权、宿主读取基线、准备阶段传递结构化 PSEC 结果和文件身份、显式 ProcessContainer UI 构造、固定 Bubblewrap 路径和 Unix socket 控制；保留完整权限及文件身份的受信 PTY 启动交接 |
| `wxc_common` | 文件对象身份与 ACL 授权及受信交接序列化；独立日志和严格恢复；不传播到子项的祖先属性授权；退出观察保留 PID 到回收；代理环境保留 SOCKS 协议 |
| `seatbelt_common` | 隐藏父目录中的授权例外；独立禁止 Unix socket；完整环境与句柄生命周期 |
| `bwrap_common` | 固定执行路径；恢复根挂载后的虚拟文件系统；封闭隐藏父目录；代理环境与退出观察 |
| `appcontainer_common` | 按本次请求探测 PSEC 并区分能力缺失与运行故障；禁止 Ash 请求转入其他 Windows 实现 |

Cargo 清单具体化了上游 workspace 继承，以便根 Cargo 与 Bazel 对路径依赖得到同一结果。
五个 `mod.rs` 改为同名文件模块，保留模块路径与可见性。
框架源代码不依赖 `ash-*`、`sandboxing` 或 `network-proxy`。

## 复核

对照干净的上游固定版本 checkout：

```sh
python3 -B ash-rs/vendor/mxc/verify.py --upstream /path/to/mxc
```

修改或升级依赖后，重新生成并审阅差异，再运行针对行为的测试：

```sh
python3 -B ash-rs/vendor/mxc/verify.py --upstream /path/to/mxc --write-patch
just test ash-mxc-sandbox
just test seatbelt_common profile_builder::tests --lib
just check ash-mxc-sandbox --target x86_64-pc-windows-msvc --tests
just check ash-mxc-sandbox --target aarch64-unknown-linux-gnu --tests
bazel build //ash-rs/mxc-sandbox:mxc-sandbox
```

Windows 账户原型已退出本 fork 和产品包。Ash 的后端选择属于 `sandboxing`，MXC 不负责调用其他供应商实现。

SDK 自身测试使用本目录的 workspace 与 lockfile：

```sh
just test wxc_common --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib host_changes::tests --locked
just test mxc_engine --manifest-path ash-rs/vendor/mxc/Cargo.toml --lib request::tests --locked
```

两份 lockfile 分别锁定产品消费图和 SDK 测试图；发布使用根 lockfile。
Linux/Windows 系统隔离与异常恢复仍须实机验证；固定上游版本的预览限制继续适用。
