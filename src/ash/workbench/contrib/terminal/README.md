# Terminal 界面与贡献

此目录拥有终端实例契约、窗口内实例管理及界面。Shell 进程和授权由 Rust 后端拥有，经 [platform/terminal](../../../platform/terminal/README.md) 的进程契约访问；contribution 不导入生成协议。

| Owner | 职责 |
| --- | --- |
| `browser/terminal.contribution.ts` | 实例服务、View 与动作/菜单的装载入口，以及 find、links、voice 贡献 |
| `browser/terminalMainContribution.ts` | BlockRestore 时订阅宿主 PTY 创建通知，交给实例服务并显示 View |
| `browser/terminal.ts` | `ITerminalService`、实例、profile、尺寸及前端事件契约 |
| `browser/terminalService.ts` | 窗口实例列表、顺序与活动项；创建实例并维护列表生命周期 |
| `browser/terminalInstance.ts` | 每实例身份、创建/关闭、连接状态、宿主 PTY、进程管理器及唯一 xterm 的生命周期；原始输入绑定与 sendText |
| `browser/terminalExtensions.ts` | 实例贡献注册元数据；实例通过自己的容器装配和释放贡献 |
| `browser/terminalProcessManager.ts` | Shell 输入队列、UTF-8 分块、二进制顺序、尺寸合并、输入/尺寸确认、增量读取、双游标、分页排空、解析等待与取消 |
| `browser/terminalView.ts` | 可见性、初始化、标题 toolbar、屏幕 attach/detach 及焦点；屏幕由实例保留 |
| `browser/xterm/xtermTerminal.ts` | 每实例一份屏幕：ANSI/VT 解析、alternate scroll、主题、选择、输入编码、fit、链接与命令标记 |
| `browser/terminalTabbedView.ts` | Tab 列表、选择、关闭、拖动与右侧分栏；服务仍是实例集合 owner |
| `browser/terminalActions.ts`、`terminalMenus.ts` | 标准命令 ID 的静态注册与菜单；执行时从当前窗口 accessor 取得 View，不保存窗口回调 |
| `browser/terminalIcon.ts` | Ash 可信 profile 标识的产品图标映射 |
| `browser/media/terminal.css`、`terminalVoice.css` | Ash 终端屏幕、Tab、标题与听写样式 |
| `common/terminalColorRegistry.ts`、`terminalContextKey.ts` | 终端颜色 token、标题动作与 Find 焦点上下文；不保存实例或后端资源 |
| `terminalContrib/find` | 按实例保留的查找控件、标准命令和无障碍帮助；屏幕负责搜索与高亮 |
| `terminalContrib/links` | URL 用户命令，扫描与选择由屏幕实现，真实打开委托 Opener |
| `terminalContrib/voice` | 听写会话与动作，消费实例输入契约和已有 dictation 服务 |


桌面原始输入链路是 xterm 的 onData/onBinary → TerminalInstance 绑定 → `TerminalProcessManager.write`/`processBinary` → `ITerminalProcessService.write` → Renderer protocol client → MessagePort → Main 透明 relay → App Server → `exec-server` → PTY。Tasks、DAP runInTerminal 和听写通过实例 `sendText` 进入同一管理器。输出走相反方向，实例创建并保留唯一 xterm 屏幕；Rust Desktop 的终端网格属于另一个产品，并不作为 Electron 屏幕的后端副本。

Shell 实例从平台契约消费原始字节和前端退出码，不解析生成 DTO 或 base64。`TerminalProcessManager` 拥有轮询与两个读取游标，实例转发 `IProcessDataEvent`。屏幕同步设置 `writePromise`，只在 xterm write 回调中完成；管理器等待解析后才续读、发布对应命令完成和退出。没有屏幕消费者的 Shell 不制造解析确认，命令状态仍可供 Tasks 使用。已退出进程的输出和命令流均排空分页后才报告退出；未来输出对应的命令事件留在管理器中等待。

宿主提供的输出 PTY 从 `services/terminal/common/embedderTerminalService.ts` 经 `TerminalMainContribution` 接入同一个实例列表。实例先登记、发布再打开 PTY，保留界面订阅前的输出和退出；标题直接跟随宿主改名，后端连接变化不影响宿主 PTY。xterm 禁止输入，语音输入不启动；关闭与 Relaunch 使用宿主的生命周期，不请求 Rust Shell，也不要求打开 Workspace folder。宿主 PTY 无 OS 子进程，PID 使用 `-1`，cwd 为空。

当前已有多实例、输入、主题、Tab、标题动作、Find、URL 与语音能力。Find 支持解析后的屏幕与回滚内容、大小写／整词／正则、匹配导航、结果读出和自己的无障碍帮助；终端输出专属 Accessible View、帮助与 verbosity 设置仍未接通。查找历史、命令历史、Quick Fix、Sticky Scroll、扩展提供 PTY、编辑区终端与真正的分组分屏也仍待补齐；不能根据 xterm 可用或上游文件名相同宣称完成这些贡献。

`terminalExtensions.ts` 注册实际实例贡献；实例 attach 创建唯一屏幕后通过自己的 DI 作用域装配贡献，屏幕就绪时调用 `xtermReady`，关闭实例统一释放。`TerminalFindContribution` 只承接实例上下文、控件与命令，`TerminalFindWidget` 持有查询和选项，`XtermTerminal.findNext/findPrevious` 持有按需加载的 SearchAddon、高亮与结果事件。关闭 Find 使等待加载的旧查询失效，不向 PTY 发送搜索输入；切换实例不共享查询、匹配或服务作用域。标准贡献的其他进程／布局 hook 仍待真实消费者，当前不创建空能力。

完整文件对应关系、仅 Ash 文件及实施准入见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。本目录说明现有职责，不授权移动、删除或批量创建上游文件。

## 实例与创建生命周期

Workbench 与 Sessions 核心入口注册所选 `ITerminalProcessService`；共同加载的 Terminal contribution 声明依赖并经容器 `createInstance(TerminalService)` 创建窗口唯一实例服务。缺少进程或 Workspace 注册时，创建立即失败。Terminal View、Tasks、Debug、Testing View 和 voice 消费同一个公开实例契约；共享 services 不导入它。

| 行为       | 当前约定                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建       | 验证 Workspace folder；多根窗口保存选定 `dirId`；后端返回真实 profile、PID 与启动目录 后才公布实例；`onDidCreateInstance` 在启动轮询之前触发，界面可先订阅输出；窗口已释放时关闭晚到的 PTY 并取消创建；创建和 Relaunch 开始读取前查询窗口的当前连接状态 |
| 列表事件   | 创建、释放和移动均触发 `onDidChangeInstances`；事件到达时列表、顺序、标题与活动项已更新，创建的初始连接状态已应用                                                                                                                                       |
| 输入与尺寸 | 文本与二进制共用发送队列，二进制前先发送全部待处理文本批次；UTF-8 单批不超过 60 KiB；尺寸在微任务内合并；write/processBinary/setDimensions 的 Promise 等待 RPC 确认；关闭/退出/断线拒绝未完成操作，恢复后不回放旧输入                                                                                                         |
| 读取       | 管理器按输出和命令的独立 sequence 续读；有屏幕时等待真实解析；命令事件按 `afterOutputSequence` 发布，分页未排空时不报告退出；后端输出缺口明确提示截断                                                                                                   |
| 本地断线   | `connectionOwned` 实例进入 `disconnected`，连接重新 ready 不自动创建或恢复 Shell；创建或 Relaunch 返回前已断线时同样适用，不发起读写                                                                                                                    |
| SSH 断线   | `reconnectable` 实例进入 `reconnecting`；连接 ready 后开始续读，首次成功读取才进入 `running`；创建或 Relaunch 返回前已断线时先保持 reconnecting；恢复失败进入 `error`，由用户 Relaunch                                                                  |
| 退出与关闭 | 进程退出保留实例与屏幕；close 立即停止输入和读取，同一实例的并发 close 等待同一后端释放结果，完成后移出实例；直接 dispose 同步移出实例并开始关闭 PTY；窗口不持有已释放实例；隐藏 Panel 保留实例                                                         |
| Relaunch   | 保留 UI 实例身份，创建新 PTY，更新 PID/启动目录并重置两个游标；并发请求合并为一次重启，采用首个请求尺寸；创建期间关闭实例或窗口，关闭晚到的 PTY，close 等待这次清理；创建失败可重新尝试                                                                 |

实例 attach 时通过 DI 创建并加载唯一 xterm，包括已有隐藏实例，避免后台 Tasks 等待显示面板才完成；隐藏实例仍不显示、不抢焦点。detach 只将屏幕移出 DOM，reattach 复用屏幕和输入绑定；关闭实例释放屏幕。没有进程的隐藏面板仍不读取 profile、创建 Shell 或加载 xterm。解析等待在断线或关闭时取消；同一 Shell 恢复时先等原屏幕写入，保留已提交字节的游标；Relaunch 更换管理器，旧解析回调不影响新进程。

解析确认约束 Renderer 的续读，不阻塞 Rust 的 OS PTY drainer；后端 bounded ring 仍可能截断超过历史上限的输出，并通过 outputGap 显式报告。完整服务器 flow control 仍待实现。

公开契约目前承接 Ash 已有行为；与 VS Code 完整 backend、child process、profile/configuration、group 和 editor terminal API 仍有差异。本批完成对应 owner 与实例装配，不能记为整个 Terminal API 已对齐。


本轮迁回八个已确认的 UI 文件，并拆出实例、Tab、菜单与动作 owner；独立的主题、滚动和 profile 图标实现保持原有行为。`XtermTerminal.raw` 暴露已初始化的真实解析器，初始化前与释放后访问会失败。`clearBuffer` 控制屏幕。实例旧 stdin `write` 已退出；`sendText(text, shouldExecute, bracketedPasteMode?)` 归一 CRLF/LF、按需追加一次 Enter，并仅在 Shell 开启模式时包装粘贴。原始键盘、鼠标和终端应答不经过文本归一。管理器 `write`/`processBinary`/`setDimensions` 返回 Promise；这表示 RPC 接受输入或尺寸，不表示命令执行完成。Tasks 等待发送结果，失败结束运行并清理终端；DAP 确认写入后才回复成功。其余完整 VS Code 构造与公开契约、profile 选择参数仍有差异。
