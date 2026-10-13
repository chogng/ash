# Terminal 界面与贡献

此目录拥有终端服务实现、窗口内实例管理及界面。跨领域服务契约由 [services/terminal](../../services/terminal/README.md) 拥有；Shell 进程和授权由 Rust 后端拥有，经 [platform/terminal](../../../platform/terminal/README.md) 的进程契约访问；contribution 不导入生成协议。

当前目录生产 TS/CSS 清单 89 项与参照同路径，缺失 0；文件落位表示实际消费链已接通，并不表示上游所有增强或私有 API 都已实现。

创建由 TerminalInstanceService 保存不可变启动参数，AgentHostTerminalService 按窗口执行目标选择 Local / Remote backend。各 backend 索引原 PTY 句柄；实例持有唯一释放 lease。RemoteTerminalChannelClient 只约束异步请求的 workspace generation 和 input host identity，平台继续唯一拥有真实 attachment/reconnect/ACK，Rust 继续拥有执行、nonce 和 Shell 历史。Desktop 与 Web 入口各自注册 resolver/backend；Desktop shutdown 由生命周期 join 等待原实例关闭。

扩展环境变量 collection 通过既有能力准入注册与撤销；EnvironmentVariableService 拥有工作区持久化和合并，resolver 在调用原 create 前准备实际 inherited environment。TerminalContributionService 从 ExtensionService 的已验证声明读 profile；全局 extension point registry 只存校验元数据。

Attach to Chat 与原 Chat context picker 捕获 xterm 已解析输出、选择及 Shell 元数据，存入原 draft；只读预览复用 XtermTerminal，通过 DetachedTerminalSnapshotMirror 显示接受时的文字。源实例关闭、重新选择和 draft handoff 不替换已接受内容；预览无 PTY、实例 membership 或 stdin 目的地。screen host 契约只含必要的显示事件/geometry，widget manager 持有 Find/URL hover 的唯一 overlay lifetime。

| Owner                                                      | 职责                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `browser/terminal.contribution.ts`                         | 实例服务、View、编辑器与动作/菜单的注册入口；独立增强由 terminal.all.ts 装载                                |
| `browser/terminalMainContribution.ts`                      | BlockRestore 时订阅宿主 PTY 创建通知，交给实例服务并显示 View                                               |
| `browser/terminal.ts`                                      | contribution 内部屏幕配置服务契约；实例与 profile/resolver 契约归 services/terminal                         |
| `common/terminalConfiguration.ts`                          | 消费中的终端设置 schema、默认值、scope、settings UI 元数据；有效值和持久化属于配置系统                      |
| `browser/terminalConfigurationService.ts`                  | 读取有效屏幕配置及编辑器字体继承，通知保留的 xterm 实时更新                                                 |
| `browser/terminalProfileService.ts`                        | 合并执行端发现、自定义与扩展 profile；默认选择、provider 注册、按需激活和连接/工作区失效                    |
| `browser/terminalProfileResolverService.ts`                | 解析执行端变量、argv/env/cwd、automation/agentHost 配置及图标；真实 executable 由后端确认                   |
| `browser/terminalProfileQuickpick.ts`                      | 命令面板选择/取消与 USER 默认 profile 写入；不拥有 shell 执行定义                                           |
| `browser/terminalService.ts`                               | 窗口实例列表、顺序与活动项；创建实例并维护列表生命周期                                                      |
| `browser/terminalInstance.ts`                              | 每实例身份、关闭/复用、连接状态、宿主 PTY、原进程客户端及唯一 xterm 的生命周期；原始输入绑定与 sendText     |
| `browser/terminalExtensions.ts`                            | 实例贡献注册元数据；实例通过自己的容器装配和释放贡献                                                        |
| `browser/terminalProcessManager.ts`                        | Shell 输入队列、UTF-8 分块、二进制顺序、尺寸合并、输入/尺寸确认、增量读取、双游标、分页排空、解析等待与取消 |
| `browser/terminalView.ts`                                  | 可见性、初始化、标题 toolbar、屏幕 attach/detach 及焦点；屏幕由实例保留                                     |
| `browser/xterm/xtermTerminal.ts`                           | 每实例一份屏幕：ANSI/VT 解析、alternate scroll、主题、选择、输入编码、fit、链接与命令标记                   |
| `browser/terminalTabbedView.ts`                            | 右侧分栏几何与宽度吸附；实例列表的渲染和交互归 TerminalTabList                                              |
| `browser/terminalTabsList.ts`                              | 终端行渲染、状态监听、激活／关闭／拖动、键盘与实例菜单；复用 Ash TabList                                    |
| `browser/terminalContextMenu.ts`                           | 只携带实例身份的动作上下文、菜单转发与异步执行释放                                                          |
| `browser/terminalResizeDebouncer.ts`                       | 屏幕横向重排／隐藏 idle 调度；最终尺寸仍交给原实例与进程管理器                                              |
| `browser/terminalActions.ts`、`terminalMenus.ts`           | 标准命令 ID 的静态注册与菜单；执行时从当前窗口 accessor 取得 View，不保存窗口回调                           |
| `browser/terminalIcon.ts`                                  | Ash 可信 profile 标识的产品图标映射                                                                         |
| `browser/media/terminal.css`、`terminalVoice.css`          | Ash 终端屏幕、Tab、标题与听写样式                                                                           |
| `common/terminalColorRegistry.ts`、`terminalContextKey.ts` | 终端颜色 token、标题动作、Find 焦点与选区上下文；不保存实例或后端资源                                       |
| `terminalContrib/find`                                     | 按实例保留的查找控件、标准命令和无障碍帮助；屏幕负责搜索与高亮                                              |
| `terminalContrib/links`                                    | URL 用户命令，扫描与选择由屏幕实现，真实打开委托 Opener                                                     |
| `terminalContrib/voice`                                    | 听写会话与动作，消费实例输入契约和已有 dictation 服务                                                       |
| `terminalContrib/clipboard`                                | 宿主剪贴板命令、焦点选区快捷键和异步读取失效；输入等待实例 sendText 的确认                                  |

桌面原始输入链路是 xterm 的 onData/onBinary → TerminalInstance 绑定 → `TerminalProcessManager.write`/`processBinary` → `ITerminalProcessService.write` → Renderer protocol client → MessagePort → Main 透明 relay → App Server → `exec-server` → PTY。Tasks 与 DAP runInTerminal 使用创建参数中的进程或 Shell 执行配置；听写和用户文本通过实例 `sendText` 进入同一管理器。输出走相反方向，实例创建并保留唯一 xterm 屏幕；Rust Desktop 的终端网格属于另一个产品，并不作为 Electron 屏幕的后端副本。

Shell 实例从平台契约消费原始字节和前端退出码，不解析生成 DTO 或 base64。`TerminalProcessManager` 拥有轮询与两个读取游标，实例向进程观察者转发 `IProcessDataEvent`，并把显示内容交给唯一屏幕的 `write`。有屏幕时实例同步设置 `writePromise`，只在 xterm write 回调中完成；管理器等待解析后才续读、发布对应命令完成和退出。没有屏幕的 Shell 不制造解析确认，命令状态仍可供 Tasks 使用。实例单独按顺序保存显示数据及退出提示，即使任务观察者已消费过程输出，稍后 attach 仍能显示；隐藏历史最多 1 MiB、4096 个分块，超限先丢弃最旧内容并明确提示截断。已退出进程的输出和命令流均排空分页后才报告退出；未来输出对应的命令事件留在管理器中等待。

宿主提供的输出 PTY 从 `services/terminal/common/embedderTerminalService.ts` 经 `TerminalMainContribution` 接入同一个实例列表。实例先登记、发布再打开 PTY，保留界面订阅前的输出和退出；标题直接跟随宿主改名，后端连接变化不影响宿主 PTY。xterm 禁止输入，语音输入不启动；关闭与 Relaunch 使用宿主的生命周期，不请求 Rust Shell，也不要求打开 Workspace folder。宿主 PTY 无 OS 子进程，PID 使用 `-1`，cwd 为空。

当前已有多实例、输入、主题、Tab、标题动作、Find、URL、语音与文本剪贴板能力。Find 支持解析后的屏幕与回滚内容、大小写／整词／正则、匹配导航、结果读出和自己的无障碍帮助；终端输出专属 Accessible View、帮助与 verbosity 设置已有 accessibility 贡献接入，本轮只验证新增的剪贴板帮助。查找历史、Shell 文件历史、Quick Fix、Sticky Scroll、扩展提供 PTY、编辑区终端与真正的分组分屏也仍待补齐；命令 marker 导航和 nonce 验证的跨重启 Recent Command 历史见下文。不能根据 xterm 可用或上游文件名相同宣称完成这些贡献。

`terminalExtensions.ts` 注册实际实例贡献；实例 attach 创建唯一屏幕后通过自己的 DI 作用域装配贡献，屏幕就绪时调用 `xtermReady`，关闭实例统一释放。`TerminalFindContribution` 只承接实例上下文、控件与命令，`TerminalFindWidget` 持有查询和选项，`XtermTerminal.findNext/findPrevious` 持有按需加载的 SearchAddon、高亮与结果事件。关闭 Find 使等待加载的旧查询失效，不向 PTY 发送搜索输入；切换实例不共享查询、匹配或服务作用域。标准贡献的其他进程／布局 hook 仍待真实消费者，当前不创建空能力。

完整文件对应关系、仅 Ash 文件及实施准入见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。本目录说明现有职责，不授权移动、删除或批量创建上游文件。

## 实例与创建生命周期

Tasks 通过 `ITerminalInstance.reuseTerminal` 在同一个实例与屏幕上替换进程。实例先停止旧读取并等待后端释放，再完整替换启动环境、目录和执行参数；旧读取回复不能写入新进程的屏幕或结束新任务。`IShellLaunchConfig.initialText` 归实例的显示队列拥有，在新进程输出前写入；Tasks 的命令回显使用这个端口，不经过进程观察事件。复用时连同缺省值完整替换初始文案，关闭 echo 不保留上一轮命令。创建期间关闭实例时，close 等待晚到进程的清理。`clearBuffer` 由实例调用自己的屏幕，并清除尚未显示的队列。任务系统仅持有可复用资格与预留状态，实例集合和活动选择仍由 TerminalService 唯一拥有。

Workbench 与 Sessions 核心入口注册所选 `ITerminalProcessService`；共同加载的 Terminal contribution 声明依赖并经容器 `createInstance(TerminalService)` 创建窗口唯一实例服务。缺少进程或 Workspace 注册时，创建立即失败。Terminal View、Tasks、Debug、Testing View 和 voice 消费同一个公开实例契约；共享 services 不导入它。

| 行为       | 当前约定                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建       | 验证 Workspace folder；多根窗口保存选定 `dirId`；后端返回真实 profile、PID 与启动目录 后才公布实例；`onDidCreateInstance` 在启动轮询之前触发，界面可先订阅输出；窗口已释放时关闭晚到的 PTY 并取消创建；创建和 Relaunch 开始读取前查询窗口的当前连接状态 |
| 列表事件   | 创建、释放和移动均触发 `onDidChangeInstances`；事件到达时列表、顺序、标题与活动项已更新，创建的初始连接状态已应用                                                                                                                                       |
| 输入与尺寸 | 文本与二进制共用发送队列，二进制前先发送全部待处理文本批次；UTF-8 单批不超过 60 KiB；尺寸在微任务内合并；write/processBinary/setDimensions 的 Promise 等待 RPC 确认；关闭/退出/断线拒绝未完成操作，恢复后不回放旧输入                                   |
| 读取       | 管理器按输出和命令的独立 sequence 续读；有屏幕时等待真实解析；命令事件按 `afterOutputSequence` 发布，分页未排空时不报告退出；后端输出缺口明确提示截断                                                                                                   |
| 本地断线   | `connectionOwned` 实例进入 `disconnected`，连接重新 ready 不自动创建或恢复 Shell；创建或 Relaunch 返回前已断线时同样适用，不发起读写                                                                                                                    |
| SSH 断线   | `reconnectable` 实例进入 `reconnecting`；连接 ready 后开始续读，首次成功读取才进入 `running`；创建或 Relaunch 返回前已断线时先保持 reconnecting；恢复失败进入 `error`，由用户 Relaunch                                                                  |
| 退出与关闭 | 进程退出保留实例与屏幕；close 立即停止输入和读取，同一实例的并发 close 等待同一后端释放结果，完成后移出实例；直接 dispose 同步移出实例并开始关闭 PTY；窗口不持有已释放实例；隐藏 Panel 保留实例                                                         |
| Relaunch   | 保留 UI 实例身份，创建新 PTY，更新 PID/启动目录并重置两个游标；并发请求合并为一次重启，采用首个请求尺寸；创建期间关闭实例或窗口，关闭晚到的 PTY，close 等待这次清理；创建失败可重新尝试                                                                 |

实例 attach 时通过 DI 创建并加载唯一 xterm，包括已有隐藏实例，避免后台 Tasks 等待显示面板才完成；隐藏实例仍不显示、不抢焦点。detach 只将屏幕移出 DOM，reattach 复用屏幕和输入绑定；关闭实例释放屏幕。没有进程的隐藏面板仍不读取 profile、创建 Shell 或加载 xterm。解析等待在断线或关闭时取消；同一 Shell 恢复时先等原屏幕写入，保留已提交字节的游标；Relaunch 更换管理器，旧解析回调不影响新进程。

解析确认约束 Renderer 的续读，不阻塞 Rust 的 OS PTY drainer；后端 bounded ring 仍可能截断超过历史上限的输出，并通过 outputGap 显式报告。完整服务器 flow control 仍待实现。

公开契约目前承接 Ash 已有行为；与 VS Code 完整 backend、child process、profile/configuration、group 和 editor terminal API 仍有差异。本批完成对应 owner 与实例装配，不能记为整个 Terminal API 已对齐。

本轮迁回八个已确认的 UI 文件，并拆出实例、Tab、菜单与动作 owner；独立的主题、滚动和 profile 图标实现保持原有行为。`XtermTerminal.raw` 暴露已初始化的真实解析器，初始化前与释放后访问会失败。`clearBuffer` 控制屏幕。实例旧 stdin `write` 已退出；`sendText(text, shouldExecute, bracketedPasteMode?)` 归一 CRLF/LF、按需追加一次 Enter，并仅在 Shell 开启模式时包装粘贴。原始键盘、鼠标和终端应答不经过文本归一。管理器 `write`/`processBinary`/`setDimensions` 返回 Promise；这表示 RPC 接受输入或尺寸，不表示命令执行完成。Tasks 等待进程创建与输出/退出，创建失败不发布运行；DAP 确认终端创建后才回复成功。其余完整 VS Code 构造与公开契约、profile 选择参数仍有差异。

`IShellLaunchConfig.waitOnExit` 由实例持有，可为布尔值、文本或退出码回调。任务完成提示只写入显示队列，不产生进程数据或 stdin；普通字符键和 Enter 关闭已退出的等待终端，工作台快捷键继续可用。任务复用完整替换退出策略；后台读取产生的终端应答不能触发关闭。

终端无障碍贡献读取已解析的屏幕和滚动历史，提供随输出更新的只读视图与帮助，关闭后回到终端输入。`accessibility.verbosity.terminal` 控制输入标签中的帮助提示。贡献与屏幕同生命周期，内容提供者由无障碍对话框释放；查找贡献继续拥有终端焦点上下文。

文本剪贴板由 `terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts` 随实例屏幕就绪挂载。复制只读原选区，粘贴调用既有宿主剪贴板服务与 `sendText(text, false, true)`；异步读取期间关闭、断线、退出或切换实例都会作废旧结果。输入不增加 Enter，遵守 child paste mode，并返回进程确认或失败。浏览器原生粘贴仍进入 xterm 原始输入；HTML／资源粘贴、自动复制与多行确认尚未接入。

Browser 列表职责已从 Tabbed View 迁回 `terminalTabsList.ts`，View 仍拥有原屏幕附着与可见性。Shift+F10／鼠标实例菜单使用捕获的数值 instanceId；活动项变更不改变目标，消失的目标在当前窗口命令边界拒绝。原字符串 UI id 保留现有消费者，数值身份从实例编号派生；PID 随 Shell 替换而变化，不能代替实例身份。大 normal 缓冲区的屏幕横向重排经过 `TerminalResizeDebouncer`，focus flush，dispose 取消；PTY 尺寸确认仍由原管理器负责。完整标准列表 hooks、分组分屏、编辑区、其余配置／profile API、状态／hover、其他 xterm Addon 与 backend 仍未完成，完整 browser 路径清单见台账。

配置链已消费字体、字号、字/行间距、两种光标样式、光标闪烁/宽度、回滚与最小对比度。屏幕首次初始化和配置变化都使用有效值；更新保留屏幕及输出，字体变化触发 fit。当前默认值与 VS Code 对应字段一致（macOS 字号 12、其他平台 14、回滚 1000、光标不闪烁）；回滚缩小时由 xterm 丢弃超限旧行。

交互式新建通过执行端 OS 的 `terminal.integrated.defaultProfile.{linux,osx,windows}` 解析可信 profile 名称为 ID；无效名称退回后端默认项。命令面板支持使用 profile 新建和保存默认 profile；工具栏订阅同一列表 owner。Tasks/Debug 与 Agent 的 openTerminal App Tool 通过现有 resolver 选择各自的启动策略；已有实例 Relaunch 保存原 profile。自定义 path 候选、argv、env、cwd 与 automation/agentHost profile 已由 resolver 接入。环境按全局、profile、调用方顺序合并，null 删除继承变量，Windows 按大小写不敏感的键覆盖；变量由原 ConfigurationResolverService 解析，执行端 terminal/profile/resolve 验证实际可执行文件。Relaunch 保存首次启动的不可变配置与图标/颜色。

扩展通过标准 `window.registerTerminalProfileProvider` / `TerminalProfile` 声明并注册配置。原 Extension Host 负责 capability、精确激活、调用取消和注册撤销；`api/browser/mainThreadTerminalService.ts` 将回调交给同一个 profile/实例 owner。普通 shell 进入真实后端 PTY；Pseudoterminal 使用原有有界 handle 流，接收 open/input/resize/read/close，实例关闭移除 provider 的引用。重新启动重新调用 provider 获取新 handle；关闭或宿主撤权不会复用旧 handle。工作区变化使晚到的创建失效并释放资源。

Tasks 的 Shell 执行已接入 resolver：按任务目录的执行端 OS 选择 automationProfile，空配置回到交互式默认 profile；参数引用规则由真实 executable 的 shell 类型决定。环境依次继承执行端基础环境、`terminal.integrated.env.{linux,osx,windows}`、实际所选 profile env、任务 env；全局与 profile 值由原 ConfigurationResolverService 使用执行端环境解析，任务已解析的值保留现有变量语义。Windows 的键覆盖忽略大小写，null 保留删除指令直到执行端应用；Linux/macOS 区分大小写。显式 Shell 与 Process task 也继承全局 env，不选择 automation profile；CustomExecution 保留自己的 PTY owner。已有命令参数时不重复添加 `-c`、`/c` 或 `-Command`。共享／专用终端复用重新读取当前配置，完整替换 executable/argv/env，已移除的全局/profile 键不再留在下一轮启动快照；等待旧 PTY 释放前复制调用方启动数据，屏幕和实例身份仍被保留。

DAP runInTerminal 使用 automationProfile，空配置回到交互式默认 profile。Debug 按实际 executable 判断 POSIX／PowerShell／cmd 引用规则；保留 profile argv、环境和主题 metadata，并在 resolver 解析配置后应用 DAP 的字面量 env/cwd，避免展开适配器传来的变量表达式。创建完成且 stdin 被进程确认后才回复 shellProcessId；Debug session、工作区或执行连接失效时停止启动／输入并释放晚到 PTY。

Agent 的 openTerminal App Tool 在原 AppToolsHost 采用 agentHostProfile，空配置回到交互默认 profile；全局/profile 环境、cwd、argv 和主题 metadata 均由同一 resolver 解析，再交给原 TerminalService。取消、Host 释放、工作区／执行连接变化会使旧启动失效；晚到 PTY 或无法打开 View 的实例由该请求关闭。App Server adapter 继续拥有 request/connection 取消，窗口 Host 继续拥有执行入口与显示，实例和 Rust PTY owner 保持唯一。

参数契约支持 literal argv 数组和仅限 Windows 的原始 CommandLine 字符串。profile、automation、agentHost、扩展 TerminalProfile 与启动配置共用原 resolver；字符串按整体解析变量，保留引用、空值与空格，经本地/SSH adapter 和 App Server/exec-server 到原 ConPTY。数组继续由 PTY 引用，字符串仅追加在正确引用的 executable 后；执行边界拒绝非 Windows、NUL 与超长命令行。内部 exec-server 协议版本为 5，App Server schema 与 TypeScript 由同一生成器更新。

Windows cmd/PowerShell/WSL/Nu task 以完整 CommandLine 创建进程；Windows Bash/Zsh/Fish 的 argv 保持数组，raw prefix 后的完整 Shell command 则按一个 Windows 参数引用。Tasks 的 shellArgs 仍只接受数组，可不指定 executable 而覆盖所选 profile；显式 executable 不注入默认命令标志。复用与 Relaunch 保留字符串和不可变 argv 快照，仍等待旧 PTY 释放并保留原实例、屏幕和环境覆盖 owner。命令 marker 支持 Ctrl/Cmd+Up/Down 导航；Run Recent Command 按 profile 读取应用级机器本地历史，只有 nonce 验证的完成文本可保存，需用户在 Quick Pick 中明确接受后才运行。`terminal.integrated.shellIntegration.history` 控制每个 profile 的保留上限，0 禁用历史；Task 禁止存储时不记录。Shell env/prompt capability、分组/分屏、编辑器终端和剩余 xterm/backend 链路仍待补齐。

Shell integration 沿用执行端 `ShellIntegration` 的注入生命周期与 `TerminalCommandStatusTracker`：按 executable 识别自定义 PowerShell/Bash/Zsh profile，消费 OSC 633 的 A/B/C/D 和转义的 P;Cwd。A/B 不创建执行记录，C 建立命令，D 保留真实退出码或未知状态；PowerShell 按 `$?` 上报 0/1，Bash/Zsh 保留数值状态。命令事件保存开始时的 cwd，当前 cwd 独立附带输出序号，经既有 adapter 传给 TerminalProcessManager，等待原 xterm 解析确认后更新；TerminalContext 使用当前 cwd，未检测到时回到启动目录。复用等待旧 PTY 释放，重建进程管理器并丢弃旧轮次的晚到数据，保留实例与屏幕。

Bash/Zsh 保留用户启动文件与 prompt hooks，Bash 登录配置通过原 rc wrapper 加载；Bash 3.2 已有 DEBUG trap 时保留用户 trap，不强行提供执行边界。PowerShell 保留用户 prompt 与 PSReadLine 多行/读输入行为。显式命令、独立 Task execution 与原始 Windows shell 参数不注入或改写启动参数；Task 输出中的 OSC 不改变 shell 命令状态或 cwd。未知/无效 OSC 保留字节，未终止 OSC 的缓存有上限。cwd 是显示信息，不作为路径授权。

命令文本与完成历史也归原 Rust tracker：OSC 633 E 在执行前或完成前携带转义文本，每个被注入的 PTY 使用新生成的随机 nonce，匹配才标记命令文本可信。缺省、错误和上一轮 nonce 保留不可信文本；cwd 独立校验来源，信任标记不授予执行或路径权限。nonce 只进入原 startup wrapper/PowerShell hook 与执行端 tracker，不作为子进程环境或返回字段。Bash 用新历史条目的文本，忽略输入/关闭 history 时不借用旧条目；Zsh preexec 与 PowerShell readline 使用完整输入，覆盖多行与 Unicode。

原 tracker 从实际 633 消息记录 command/cwd detection、rich detection 和 Task storage opt-out，历史保留最近 256 条完成记录，记录按文本/cwd 的 JSON 编码预算限制为 512 KiB；事件环也采用该预算。P;Task 清空历史与所存文本，独立 Task execution 仍不消费 shell OSC。snapshot 经原 local/SSH adapter 和 xterm commit 发布，Workbench 只保留只读 facade，TerminalContext 将命令、cwd、退出状态和可信标记附到同一份终端上下文快照。连接恢复保留原 PTY 历史且不重复追加；原 xterm 的命令标记按进程身份区分，避免复用时从头计数的命令 ID 覆盖旧标记；复用/重启重建原进程管理器并刷新执行端 nonce，旧读取不能恢复已清空的历史或 capability。当前终端已通过 live marker 提供上一/下一命令导航，并将 nonce 验证的完成命令持久化供显式 Quick Pick 运行；其他 Shell capability 仍待后续消费者闭合。

Send Sequence 由 `terminalContrib/sendSequence` 的单一 contribution 入口注册。`workbench.action.terminal.sendSequence` 接受 `{ text: string }`，或使用 Quick Input 输入支持 `\n`、`\r`、`\xNN` 的序列；参数文本不再做反斜线解码。变量使用实例所属工作区文件夹，由原 ConfigurationResolverService 解析。发送调用原 `sendText(text, false)` 并等待后端确认；不追加执行回车，也不包裹 bracketed paste。提示或解析期间切换活动实例、重连、复用、关闭或更换工作区会使原调用失效。

`terminalGroupService.ts` 现在拥有 panel 组成员，活动组从唯一 TerminalService 派生；`terminalGroup.ts` 使用现有 SplitView 分配组内水平窗格。Split 创建独立 Shell，继承原实例的启动 profile/argv/env 与当前 cwd；当前不拆分扩展自供 PTY。Focus Next/Previous Pane 与 focusAtIndex1–9 使用原实例选择，Unsplit 保留原进程和屏幕。组布局按容器内容尺寸更新字符网格，键盘 sash 使用原 SplitView，移动屏幕不复制输出。关闭一侧后聚焦剩余窗格，最后一个实例关闭才隐藏 panel。完整垂直布局和组持久化仍待补。

`terminalStatusList.ts` 只保存进程错误的 UI 消息，Shell/连接状态仍归原实例与进程管理器；`terminalTooltip.ts` 将 profile、PID、cwd、退出码与当前消息提供给列表。Relaunch 清除旧进程错误。`terminalIcons.ts` 给菜单与列表提供语义图标，仍使用产品 icon registry/主题解析。Search addon 构造由 `xtermAddonImporter.ts` 加载，addon 实例仍归原屏幕；`terminalFontRendering.ts` 消费 fontRendering 设置，在 macOS 切换灰度字体平滑并刷新字形缓存，保留原屏幕和内容。

## 编辑区与元数据

`terminalEditorService.ts` 将同一 TerminalInstance 移入编辑区；`terminalEditor.ts` 只承载原 xterm。target 归原实例，面板组/列表排除编辑区实例。回到面板、编辑器组移动与标签关闭使用原 EditorPart 的生命周期原因：移动保留 PTY，关闭终端标签释放原实例。资源包含实例 incarnation，工作集只保存身份；失效身份显示不可用，不自动启动新 Shell。Clear、Relaunch 和 Kill 能直接操作编辑区实例。

Rename 和 Change Icon 使用现有 Quick Input，目标关闭时取消。原实例保留用户 title/icon，列表与编辑器标签通过原 labels 事件更新，重启保留用户元数据。面板列表宽度由原 SplitView 决定，StorageService 按工作区保存；单实例隐藏和非法存储值不会造成失效布局。

`decorationAddon.ts` 只拥有已提交命令事件的屏幕 marker/decoration；xterm 缓存淘汰标记时立即释放 UI listeners。`markNavigationAddon.ts` 只读取这些 marker，不建立第二份 Shell history；`decorationStyles.ts` 提供中英文 tooltip/ARIA 状态。屏幕样式由 `media/xterm.css` 拥有。`terminal.all.ts` 是 Desktop/Web 共用装载入口，核心与增强各自只注册一次。

当前同路径生产 TS/CSS 为 51，仍缺 38。完整 backend/capability、环境变量集合和同步 InstanceService 未完成；准确清单与契约边界见 [对齐状态](../../../../../docs/terminal-api-alignment-status.md)。

`common/basePty.ts` 提供当前实际消费的 string-output child-process 事件端口；`terminalProcessExtHostProxy.ts` 接原扩展 provider 的 opaque PTY，拥有轮询/输入队列和取消，不创建 Shell 或屏幕。MainThread 继续拥有 profile 注册与 extension incarnation，实际工厂直接创建此代理；旧内嵌 PTY 类已退出。插件响应在代理边界校验，typed 内部 payload 不重复校验；关闭后忽略晚到数据并只发一次释放请求。完整 Rust byte-stream child-process/replay/backend API 仍待补。
