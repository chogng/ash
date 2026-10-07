# `ash-arg0`

- 统一宿主程序的内部辅助入口；普通参数交回各产品处理。
- 调用方传入实际可执行路径，并在正常产品启动前调用 `dispatch`。
- 分发 MXC PTY 内部角色，保持终端继承与产品初始化分开。
- 辅助能力及其运行生命周期仍由对应 crate 实现。
- 验证：`just test ash-arg0`；真实进程覆盖见 App Server、Remote Server 与 CLI 集成测试。
