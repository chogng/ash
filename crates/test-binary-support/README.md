# ash-test-binary-support

- 仅供测试依赖，统一当前测试程序的辅助入口与子进程命令。
- `TestBinary::test` 选择一个独立的 ignored 测试；适用于通过独立 IPC 通道通信的 worker。
- `TestBinary::role` 用于 `harness = false` 测试目标，在显式 `main` 中先分派辅助入口，再启动测试运行器。
- 调用方提供真实能力的入口，持有临时目录并管理进程生命周期；本 crate 无业务依赖。
- 子进程环境与工作目录通过 `Command` 设置，不修改父进程环境。
- 宿主产品的 `arg0` 接线仍由真实程序集成测试验证。

验证：`just test ash-test-binary-support`。
