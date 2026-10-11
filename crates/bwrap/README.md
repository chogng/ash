# `ash-bwrap`

> 本 README 只说明随包 `bwrap` 二进制的机械构建入口；Linux 隔离实现见 [`mxc-sandbox`](../mxc-sandbox/README.md)，上游源码见 [`crates/vendor/bubblewrap`](../vendor/bubblewrap/README.md)。

- `build.rs` 在 Linux 目标上直接编译 `crates/vendor/bubblewrap` 中的 C 源码，并把上游 `main` 重命名为 `bwrap_main`。
- 随包版本为 0.13.0；构建和打包共用 `ash-source.json` 的版本记录，`--version` 输出供 MXC 探测。源码保留 `network.c` 的两处指定字段初始化修正；升级时需包含 `safe_openat.c` 和 `chroot_realpath.c`，随包附带 `COPYING` 与 `COPYING.LIB`。
- `src/main.rs` 只把进程参数交给 `bwrap_main`；它不构造 Bubblewrap 参数，不选择策略，也不发现或启动其他可执行文件。

2026-10-11 在 WSL2 Linux x64 上，`just verify ash-bwrap` 的构建、版本回归和 warning 检查通过。上游 `tests/test-sandbox.py` 使用本次构建的随包二进制，68 项通过、1 项因 user namespace 不支持 mqueue 跳过；覆盖安全路径处理、旧内核 fallback 和递归只读挂载。Ash 沙箱 PTY 6 项通过，WSL 文件、取消和互操作隔离 3 项分别在 Linux `/tmp` 与 Windows 挂载的临时目录通过。macOS 只完成相关 Rust 测试目标交叉编译。
- 修改源码文件集合、编译定义或链接依赖时，必须同步 vendor 来源元数据、发布包测试和 Linux 构建工具链。
