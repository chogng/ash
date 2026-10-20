# `ash-utils-sleep-inhibitor`

- 隔离系统空闲休眠接口，提供按作用域释放的防休眠租约。
- 同一控制器及其副本共享一份系统资源，最后一个租约释放时撤销保护。
- macOS 使用 IOKit idle-sleep assertion；Windows 使用 SystemRequired power request。
- Linux 使用 logind 的 `idle` inhibitor，持有返回的文件描述符；需要系统提供该服务并允许调用。
- 获取失败返回错误；不启动辅助进程，不修改系统电源设置。
- App Server 决定执行期间何时持有租约；本 crate 不依赖会话、任务或协议类型。

验证：`just test ash-utils-sleep-inhibitor`。macOS 测试通过 `pmset -g assertions` 核对实际资源的创建、共享和释放。

Linux 的 `linux_logind` 集成测试需要 `dbus-daemon`。它启动私有 D-Bus 与 logind 测试服务，
由独立子进程通过生产入口获取 `idle` inhibitor，核对 UNIX_FD 传递、重叠租约共享及最后一个
租约释放后描述符关闭。它不连接宿主 logind、不改变电源设置，也不覆盖实际系统 sleep/wake。
