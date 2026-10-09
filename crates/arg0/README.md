# `ash-arg0`

- 统一宿主程序的内部辅助入口；普通参数交回各产品处理。
- 调用方传入实际可执行路径，并在正常产品启动前调用 `dispatch`。
- 分发 MXC PTY 与一次性文件提权内部角色，保持内部操作与普通产品初始化分开。
- 文件提权角色只接受 loopback 端口和私有凭据文件路径，由 `ash-file-system` 验证参数、认证连接并执行目录限定的写入；普通产品命令不被消费。
- 辅助能力及其运行生命周期仍由对应 crate 实现。
- 验证：`just test ash-arg0`；真实进程覆盖见 App Server、Remote Server 与 CLI 集成测试。
