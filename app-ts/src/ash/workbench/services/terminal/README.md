# Terminal services 边界

终端实例契约与实例管理已迁到 [Terminal contribution](../../contrib/terminal/README.md)：`browser/terminal.ts`、`browser/terminalService.ts`。此目录不再保存 Shell 实例服务，也不保留旧 API 的转发入口。

VS Code 在此目录只有 `common/embedderTerminalService.ts`，用于嵌入者提供的 PTY。目前 Ash 没有对应生产消费者，因此没有创建该实现。真实 Shell 进程继续委托 [platform/terminal](../../../platform/terminal/README.md) 接入 Rust PTY 后端。

Tasks、Debug 的执行编排位于各自 contribution；共享层保留纯契约和配置解析。`ITaskRun` 只公开 `terminalId`，界面从 `ITerminalService.instances` 定位实例，避免共享契约反向依赖终端 contribution。处理记录见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。
