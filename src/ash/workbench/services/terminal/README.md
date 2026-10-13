# Terminal services 边界

此目录拥有跨领域 Terminal 服务契约：[common/terminal.ts](common/terminal.ts) 定义 profile/provider 与 resolver 端口，[browser/terminal.ts](browser/terminal.ts) 定义窗口实例、创建参数、事件与 `IXtermTerminal` 浏览器屏幕端口。Extension Host、Tasks、Debug、Agent 和终端功能消费同一份服务标识与契约；契约不导入 contribution 或具体 xterm 实现。服务实现、安装注册、实例列表和屏幕仍由 [Terminal contribution](../../contrib/terminal/README.md) 管理，Rust PTY 继续经平台进程服务访问。

[embedderTerminalService.ts](common/embedderTerminalService.ts) 拥有宿主输出 PTY 的创建通知：宿主通过 `IEmbedderTerminalService.createTerminal` 发起创建；contribution 尚未订阅时保留请求，窗口释放时关闭未接入的 PTY。

Web 宿主从 [Web API](../../browser/web.api.ts) 返回的 `window.createTerminal` 发起请求 → embedder 服务 → [TerminalMainContribution](../../contrib/terminal/browser/terminalMainContribution.ts) → `ITerminalService.createTerminal` 的 `customPtyImplementation` → 同一个窗口实例列表与 Terminal View。实例先公布再打开 PTY，保留界面订阅前的同步输出和退出事件；`onDidChangeName` 更新标题，退出码 `0` 原样保留。显式关闭或窗口释放会释放 PTY 和监听，宿主已通知退出时不重复关闭。

与本地 `../vscode/src/vs` 的 `services/terminal/common/embedderTerminalService.ts` 对应，宿主契约提供 `open`、`close`、输出、可选退出与改名。该契约没有输入和尺寸回调；界面按只读输出终端接入，复制、链接、清屏和关闭仍走现有界面。宿主 PTY 不要求 Workspace folder，也不随 Rust 连接状态改变。

[平台契约](../../../platform/terminal/common/terminal.ts) 当前只补齐这条宿主输出链需要的 launch config、进程事件、标题属性和启动/关闭生命周期。Shell 的字节事件与解析 promise 已由 [TerminalProcessManager](../../contrib/terminal/browser/terminalProcessManager.ts) 接入 xterm，约束 Renderer 续读；完整 VS Code `ITerminalChildProcess` 的输入、signal、通用属性与服务器 flow control 尚未完成，不能将此输出链记为完整 Shell backend 对齐。真实 Shell 继续通过 [platform/terminal](../../../platform/terminal/README.md) 接入 Rust PTY 后端。

Tasks、Debug 的执行编排位于各自 contribution；共享层保留纯契约和配置解析。`ITaskRun` 只公开 `terminalId`，界面从 `ITerminalService.instances` 定位实例，避免共享契约反向依赖终端 contribution。处理记录见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。

`ITerminalScreenHost` 限定 xterm 需要的事件和尺寸接口；原实例与无进程的 `DetachedTerminal` 都使用该端口。`ITerminalOutputSnapshot` 是平台终端的只读数据契约，Chat 的 draft/handoff 传递接受时的文字与列数；IPC 校验可选快照的字段、大小和尺寸，不从格式化 context 内容重建屏幕。capability store 从原已提交元数据读取 cwd/命令，无第二份 Shell 历史；具体 readonly capability 与实现仍属于其明确 owner。
