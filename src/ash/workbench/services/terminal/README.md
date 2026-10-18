# Terminal services 边界

此目录保留宿主终端接入与跨宿主持久化数据。标准 Workbench 终端契约已归回 [contrib/terminal/browser/terminal.ts](../../contrib/terminal/browser/terminal.ts)（实例、创建意图、组、编辑器和屏幕）及 [contrib/terminal/common/terminal.ts](../../contrib/terminal/common/terminal.ts)（profile、provider、resolver 和状态）。Extension Host、Tasks、Debug、Agent 使用这些唯一契约；平台进程契约不反向依赖 Workbench。

[common/terminal.ts](common/terminal.ts) 只定义 Ash 的不可变 reload checkpoint、凭据和屏幕快照数据，不拥有活跃实例、profile 目录或服务标识。实例与屏幕的状态 owner 仍位于 [Terminal contribution](../../contrib/terminal/README.md)。

[embedderTerminalService.ts](common/embedderTerminalService.ts) 拥有宿主输出 PTY 的创建通知：宿主通过 `IEmbedderTerminalService.createTerminal` 发起创建；contribution 尚未订阅时保留请求，窗口释放时关闭未接入的 PTY。

Web 宿主从 [Web API](../../browser/web.api.ts) 返回的 `window.createTerminal` 发起请求 → embedder 服务 → [TerminalMainContribution](../../contrib/terminal/browser/terminalMainContribution.ts) → `ITerminalService.createTerminal` 的 `customPtyImplementation` → 同一个窗口实例列表与 Terminal View。实例先公布再打开 PTY，保留界面订阅前的同步输出和退出事件；`onDidChangeName` 更新标题，退出码 `0` 原样保留。显式关闭或窗口释放会释放 PTY 和监听，宿主已通知退出时不重复关闭。

与本地 `../vscode/src/vs` 的 `services/terminal/common/embedderTerminalService.ts` 对应，宿主契约提供 `open`、`close`、输出、可选退出与改名。该契约没有输入和尺寸回调；界面按只读输出终端接入，复制、链接、清屏和关闭仍走现有界面。宿主 PTY 不要求 Workspace folder，也不随 Rust 连接状态改变。

[平台契约](../../../platform/terminal/common/terminal.ts) 定义进程创建、字节输入输出、信号、属性查询与生命周期端口。真实 Shell 经 [platform/terminal](../../../platform/terminal/README.md) 接入 Rust PTY；[TerminalProcessManager](../../contrib/terminal/browser/terminalProcessManager.ts) 将字节事件、输入确认、SIGINT 与屏幕解析等待接入实例，消费确认约束后端续读和输出保留。宿主输出 PTY 按自身的只读契约接入，不声明输入或尺寸能力。

Tasks、Debug 的执行编排位于各自 contribution；共享层保留纯契约和配置解析。`ITaskRun` 只公开 `terminalId`，界面从 `ITerminalService.instances` 定位实例，避免共享契约反向依赖终端 contribution。跨层调用与生命周期见 [Terminal 职责与运行契约](../../../../../docs/terminal.md)。

`ITerminalScreenHost` 限定 xterm 需要的事件和尺寸接口；原实例与无进程的 `DetachedTerminal` 都使用该端口。`ITerminalOutputSnapshot` 是平台终端的只读数据契约，Chat 的 draft/handoff 传递接受时的文字与列数；IPC 校验可选快照的字段、大小和尺寸，不从格式化 context 内容重建屏幕。capability store 从原已提交元数据读取 cwd/命令，无第二份 Shell 历史；具体 readonly capability 与实现仍属于其明确 owner。
