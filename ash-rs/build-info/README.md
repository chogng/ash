# Build info

`ash-build-info` 定义稳定的版本、编译目标与构建来源数据契约，供协议和诊断使用。`BuildInfo::new` 接收宿主提供的 commit 与构建 ID；默认构建 ID 是 commit 与 target 的 SHA-256，表示构建来源，不表示可执行文件字节或未提交改动。

[`ash-build-identity`](../build-identity/) 在编译时读取 Git，产品宿主通过 `build_identity::current()` 获取完整身份。发布可以注入 `ASH_BUILD_COMMIT` 与 `ASH_BUILD_ID`；源码构建从当前 checkout 读取 commit。未注入身份且无 Git 元数据的源码包返回空 commit 与构建 ID。运行时不调用 Git。

Git 变化只使身份库和直接消费它的产品宿主重新编译。协议、诊断、TUI 等消费者只依赖稳定的数据契约；诊断快照由宿主传入身份。

验证：`just test ash-build-info`；产品身份可通过正常构建及 `ash doctor --json` 输出核对。
