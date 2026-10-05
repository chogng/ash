# Terminal services 边界

此目录拥有 [embedderTerminalService.ts](common/embedderTerminalService.ts)：宿主提供输出 PTY，通过 `IEmbedderTerminalService.createTerminal` 发起创建；contribution 尚未订阅时保留请求，窗口释放时关闭未接入的 PTY。服务只拥有创建通知与宿主 PTY 生命周期，实例列表和屏幕由 [Terminal contribution](../../contrib/terminal/README.md) 管理。

Web 宿主从 [Web API](../../browser/web.api.ts) 返回的 `window.createTerminal` 发起请求 → embedder 服务 → [TerminalMainContribution](../../contrib/terminal/browser/terminalMainContribution.ts) → `ITerminalService.createTerminal` 的 `customPtyImplementation` → 同一个窗口实例列表与 Terminal View。实例先公布再打开 PTY，保留界面订阅前的同步输出和退出事件；`onDidChangeName` 更新标题，退出码 `0` 原样保留。显式关闭或窗口释放会释放 PTY 和监听，宿主已通知退出时不重复关闭。

与本地 `../vscode/src/vs` 的 `services/terminal/common/embedderTerminalService.ts` 对应，宿主契约提供 `open`、`close`、输出、可选退出与改名。该契约没有输入和尺寸回调；界面按只读输出终端接入，复制、链接、清屏和关闭仍走现有界面。宿主 PTY 不要求 Workspace folder，也不随 Rust 连接状态改变。

[平台契约](../../../platform/terminal/common/terminal.ts) 当前只补齐这条宿主输出链需要的 launch config、进程事件、标题属性和启动/关闭生命周期。完整 VS Code `ITerminalChildProcess` 的输入、signal、通用属性与解析后数据确认尚未完成；不能将此输出链的实现记为完整 Shell backend 对齐。真实 Shell 继续通过 [platform/terminal](../../../platform/terminal/README.md) 接入 Rust PTY 后端。

Tasks、Debug 的执行编排位于各自 contribution；共享层保留纯契约和配置解析。`ITaskRun` 只公开 `terminalId`，界面从 `ITerminalService.instances` 定位实例，避免共享契约反向依赖终端 contribution。处理记录见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。
