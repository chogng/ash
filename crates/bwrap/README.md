# `ash-bwrap`

> 本 README 只说明随包 `bwrap` 二进制的机械构建入口；Linux 隔离实现见 [`mxc-sandbox`](../mxc-sandbox/README.md)，上游源码见 [`crates/vendor/bubblewrap`](../vendor/bubblewrap/README.md)。

- `build.rs` 在 Linux 目标上直接编译 `crates/vendor/bubblewrap` 中的 C 源码，并把上游 `main` 重命名为 `bwrap_main`。
- `src/main.rs` 只把进程参数交给 `bwrap_main`；它不构造 Bubblewrap 参数，不选择策略，也不发现或启动其他可执行文件。
- 修改源码文件集合、编译定义或链接依赖时，必须同步 vendor 来源元数据、发布包测试和 Linux 构建工具链。
