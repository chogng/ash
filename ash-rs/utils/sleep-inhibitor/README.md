# `ash-utils-sleep-inhibitor`

- 隔离系统空闲休眠接口，提供按作用域释放的防休眠租约。
- 同一控制器及其副本共享一份系统资源，最后一个租约释放时撤销保护。
- macOS 使用 IOKit idle-sleep assertion；Windows 使用 SystemRequired power request。
- Linux 使用 logind 的 `idle` inhibitor，持有返回的文件描述符；需要系统提供该服务并允许调用。
- 获取失败返回错误；不启动辅助进程，不修改系统电源设置。
- App Server 决定执行期间何时持有租约；本 crate 不依赖会话、任务或协议类型。

验证：`just test ash-utils-sleep-inhibitor`。macOS 测试通过 `pmset -g assertions` 核对实际资源的创建、共享和释放。
