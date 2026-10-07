# ash-automation

## 快速理解

本 crate 管理自动化计划与运行记录，隔离日期、时区和 SQLite 依赖。

- 校验一次性、固定间隔及指定星期的规则，计算下一次执行时间。
- 事务保存计划版本、幂等命令和运行历史，处理错过执行、重叠、暂停与停止。
- 由 profile 后台宿主持有调度线程，通过执行接口调用现有 Agent，并核对原 Thread/Turn。

运行时间戳使用 protocol 的 `UnixMillis`；日历计算使用 `chrono` 和 `chrono-tz`。不在这里实现模型调用或工具执行。规则和接入边界见[自动化架构](../docs/automation.md)。
