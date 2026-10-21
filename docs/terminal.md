# Terminal：职责与运行契约

本文描述 Electron Desktop 与 Browser Workbench 集成终端的状态归属、调用链和生命周期。各层的模块职责见 [Platform Terminal](../src/ash/platform/terminal/README.md)、[宿主服务与快照](../src/ash/workbench/services/terminal/README.md)、[Workbench 实现](../src/ash/workbench/contrib/terminal/README.md) 与[独立贡献](../src/ash/workbench/contrib/terminalContrib/README.md)。

## 状态与职责

| Owner                                        | 拥有的状态与操作                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Rust `exec-server`／`utils-pty`              | 真实 PTY、进程环境、输入与信号、退出、输出保留、重连租约，以及 Shell 命令、cwd 和来源可信度的判定。 |
| Rust `app-server`                            | 协议校验与分发、执行目录授权、连接与终端资源的路由。                                                |
| Electron Main                                | App Server 连接获取、透明 relay、运行时更换通知和窗口级内存 SecretStorage。                         |
| `platform/terminal`                          | 前端进程契约与协议适配、原始字节转换、连接代次和租约交接。生成 DTO 终止于适配边界。                 |
| `TerminalService`／`TerminalInstanceService` | 窗口实例集合、创建意图与目录/profile 解析、位置选择和失败回收；实例工厂拥有不可变启动参数。         |
| `TerminalInstance`／`TerminalProcessManager` | 每实例身份与生命周期、输入队列、读取游标、增量 UTF-8 解码、输入与尺寸确认、屏幕解析等待和取消。     |
| `XtermTerminal` 与屏幕能力模型               | 每实例唯一的 ANSI／VT 屏幕、cells／cursor、选区、搜索、markers、装饰及已提交 Shell 元数据的显示。   |
| `TerminalViewPane`／组与编辑器服务           | 面板可见性、组成员和几何、标签、焦点、屏幕附着，以及同一实例在面板与编辑区之间的移动。              |
| `terminalContrib`                            | 查找、链接、剪贴板、历史、建议、Quick Fix、Sticky Scroll、听写和无障碍交互的资源与释放。            |

Agent 执行、审批与终端呈现的详细边界以 [Platform Terminal 的前后端职责](../src/ash/platform/terminal/README.md#前后端职责)为准。前端的命令标记、环境来源可信度和屏幕文字不授予执行权限。

## 进程接入

新建终端的入口为命令 → `ITerminalService.createTerminal(ICreateTerminalOptions)` → TerminalService 的目录/profile 与位置解析 → TerminalInstanceService。面板只在首次显示且没有实例时发起一次创建；独立终端窗口和分屏不依赖 View 创建方法。

真实 Shell 的输入链路为：用户操作／Tasks／Debug → `TerminalInstance` → `TerminalProcessManager` → `ITerminalProcessService` → Renderer protocol client → App Server → `exec-server` → PTY。Electron 连接经过 Main 的透明 relay，Browser 通过其 Web 连接访问后端；输出沿相反方向返回。

宿主在 `IRendererHost.terminal` 提供进程服务，Workbench 与 Sessions 通过同一个 DI 标识消费。已连接 Web 使用 `AppServerTerminalProcessService`；Desktop 本地与远程使用 `ReconnectableTerminalProcessService`。无后端的 UI 环境通过 `DisconnectedTerminalProcessService` 明确拒绝进程操作。

后端资源由 `terminalId` 与创建时的 `dirId` 共同定位；保留的多根工作区终端继续使用原目录路由。前端实例身份独立于 PID，重启 Shell 可以更换 PID。终端编辑器资源包含实例 incarnation，失效资源显示不可用，不根据旧身份自动启动新 Shell。

宿主输出 PTY 和扩展自供 PTY 经共享服务契约接入同一个窗口实例集合。前者为只读输出，后者按 provider 实际提供的输入与尺寸能力接线；其创建通知和回调生命周期见[宿主服务与快照](../src/ash/workbench/services/terminal/README.md)。

## 启动配置与扩展

`TerminalProfileService` 合并执行端发现、自定义与扩展 Profile；`TerminalProfileResolverService` 解析执行端变量、Shell 参数、cwd、环境和图标，实际可执行文件由后端确认。多根工作区新建终端使用活动文件所属目录，无法确定时由用户选择；Split 继承原实例的目录与启动配置。

扩展 Profile 使用标准 `contributes.terminal.profiles` 声明。旧 `contributes.terminalProfiles` 仅在读取边界转换为同一声明；同时提供两种 Profile 声明会被拒绝。静态菜单声明与动态工厂注册分别管理，撤销工厂后不能再调用它，但不会关闭已创建的自供 PTY。

自供 PTY 的读写绑定独立的内部 `terminalPty` 注册及原 activation／incarnation。工厂只接收创建操作，终端只通过返回的资源注册执行 open、read、input、resize 和 close；Relaunch 必须从仍有效的原工厂申请新资源。创建结果在后台调用会话中保留有界交接租约，首次成功派发资源 IO 才接管；未读取、读取后取消、超期或连接退出均释放未接管资源。前端拒绝显示元数据或收到迟到结果也释放对应资源。关闭始终受原运行实例 fence 约束，不向替代进程重放。

交互终端、Tasks／DAP 和 Agent 的打开终端请求分别采用交互、automation 和 agentHost Profile 策略，共用原实例创建链。交互终端的 Relaunch 从原始启动意图重新解析当前配置及扩展环境；任务终端复用则按新任务替换启动配置并等待旧 PTY 释放。现有 PTY 的重新附着不重新解析或修改进程环境。

启动 schema 由平台唯一注册，屏幕与工作台设置由终端贡献注册，配置值及持久化归配置系统。扩展环境集合由 Workbench 管理生命周期与持久化，平台负责纯解码、快照和合并，resolver 将结果交给 Rust 创建请求。大小写、变量删除、`strictEnv` 和 Shell Integration 环境阶段的规则见 [Platform Terminal](../src/ash/platform/terminal/README.md)。

扩展 Profile 的注册、激活、撤回和取消属于原 Extension Host 链。工作区或 provider 代次失效后，晚到的 PTY 由原关闭端口回收；实例关闭释放 provider 的引用，重启重新取得 handle。

Profile 选择器属于单次命令。工作区或执行连接变化会关闭并退休该选择，目录选择和默认 Profile 写入前也核对其生命周期；同名 Profile 或相同操作系统再次出现不能恢复旧选择。后续命令使用新的选择器。

## 输入与命令

TerminalInstance 在创建贡献前建立实例自己的 context-key／DI 作用域，拥有终端焦点及 alternate-buffer 状态。Find、剪贴板和其他贡献继承同一个作用域；快捷键路由不依赖贡献的加载顺序，Find 控件只管理自己的查找焦点与可见性。

标准 Scroll Up／Down 按行或页操作原 xterm 的 retained buffer，Scroll to Top／Bottom 到达两端；已退出和只读终端也可使用，不发送进程输入。滚动快捷键仅在聚焦终端的 normal buffer 生效，alternate buffer 中的按键继续交给终端应用。Select All 选择屏幕与 scrollback，Escape 可清除选区；Find 打开时保留自己的 Escape 行为。macOS 使用 Cmd+A，Linux／Windows 不覆盖 Shell 的 Ctrl+A。

xterm 的文本和原始字节输入经实例进入同一进程输入 owner。`sendText` 负责换行、执行用的 Enter 与 bracketed paste；原始键盘和二进制输入保留原有编码。输入和尺寸操作等待执行端或 provider 确认，关闭会拒绝排队及进行中的操作，迟到回复不能恢复已关闭的输入链。

Cursor Undo 的 Ctrl/Cmd+U 快捷键仅在编辑器文本持有焦点时匹配。Linux 终端中的 Ctrl+U 继续到达 Shell，由 Shell 清除当前输入行；显式的编辑器命令仍保留原光标撤销行为。

剪贴板贡献捕获发起实例和输入 generation，异步读取或确认后核对活动项、连接及屏幕；切换回来也不会发送已失效的粘贴。浏览器 paste 在 xterm 处理之前进入同一贡献，经原实例 `sendText` 发送并等待输入确认，不会同时进入 raw onData。没有文本选区时，Ctrl+C 继续发送给 Shell；Send Signal 通过执行宿主发送 SIGINT、SIGTERM、SIGKILL 或 SIGHUP，POSIX 目标为当前前台进程组。无参打开选择器，显式 `{ signal }` 参数直接发送；取消、切换终端或断线后撤回选择。Shell 本身处于前台时，终止信号也可能结束 Shell；不支持的执行端明确报错。

`copyOnSelection` 只在终端本身持有焦点时自动复制选区，Find 的匹配选择不覆盖剪贴板。`rightClickBehavior` 支持复制后清除选区／粘贴、仅粘贴、选词、默认菜单和不操作；Shift 保留菜单入口。剪贴板失败不清除选区，鼠标粘贴在焦点离开后也会失效。

终端实例菜单中的 Copy／Paste 捕获该菜单对应的实例。复制读取该实例的原选区；粘贴显式激活该实例后进入同一个异步输入检查。菜单打开后活动终端变化不会把操作交给另一实例，已关闭的目标明确拒绝。

`terminal.integrated.enableMultiLinePasteWarning` 由 TypeScript 窗口配置解释，沿现有 `settings.json` 的用户／工作区层解析，默认 `auto`。`auto` 在 bracketed paste 模式下放行，其他情况下移除单条命令末尾的换行及空白，对其余多行文本确认；`always` 对 LF、CRLF 和 CR 换行均确认，即使 Shell 启用了 bracketed paste；`never` 关闭确认。对话框仅展示有界开头预览，接受后发送原文；Escape 取消且恢复有效原实例的焦点。

最近命令选择器从终端历史 owner 读取按 Profile 保存的命令，只在用户明确接受后重跑。最近命令和目录选择都绑定原 PID；切换实例、重连、退出、关闭或工作区替换会退休并关闭选择器，切换回来不能恢复旧选择。目录发送等待确认期间失效时也不再抢回焦点。听写文字进入原实例输入链，由用户按 Enter 执行；切换实例、退出或隐藏面板取消录音。

Ctrl+Space／Trigger Suggest 合并同 Profile 可信历史、已确认 Bash／Zsh 同授权根下的目录项与 Extension Host 的 completion provider。内置历史和路径只追加单行提示符末尾；扩展可指定提示符内替换范围与触发字符。接受不发送 Enter，Tab 继续由 Shell 处理；输入、光标、cwd、能力、实例、provider 或工作区变化撤回旧选择。

Ctrl/Cmd+.／Show Terminal Quick Fixes 在空 Shell prompt 展示最新命令的内置 Git 修正和扩展 selector 匹配结果。内置修正仍仅插入经过检查的建议；扩展按其动作类型插入／执行命令、打开 URI 或执行扩展注册命令。扩展 outputMatcher 从原 command 提取准确的 anchor／offset／length 窗口，跨宿主仅传有界文本。清屏、输出范围失效、新命令、输入或宿主代次变化取消请求。

Auto Replies 规则通过原进程 service 安装到 exec-server PTY 输出 drainer，创建时原子安装，跨字节块精确匹配，每条规则每秒最多发送一次，detach、连接关闭、退出均清空规则。Local Echo 默认关闭；启用后仅在已检测的 shell prompt 投影可打印输入，保留原输出流与输入 owner，不修改已解析 buffer。原始输出确认预测，控制或不匹配输出清除预测；Enter 后停止直到下个 prompt。

OSC 99 经原 parser 进入通知中心，通知按钮及 query／alive／activation 回写绑定原实例。禁用设置或关闭实例会撤销该实例的待处理通知。Developer 写入只改显示，录制沿原输入／输出与 TerminalRecorder 生成有界记录。完整功能及宿主边界见 [Terminal 可选贡献](../src/ash/workbench/contrib/terminalContrib/README.md)。

### 运行编辑器选区

`workbench.action.terminal.runSelectedText` 在异步目录／Profile 选择前捕获活动代码编辑器的文本。有选区时发送选中内容；没有选区时发送去掉首尾空白的当前行。没有模型或当前行为空时不创建 Shell。

可输入的活动终端直接复用；只读或已退出的终端保留，并按原创建流程取得新终端。面板初始化与命令等待同一个创建 Promise，发送前核对具体实例的窗口成员、活动身份和运行状态。重连中的终端不接收本命令，也不自动再开 Shell。

文本经 `sendText(text, true, true)` 输入；该命令不承担运行当前文件所需的路径转换。面板显示保留代码编辑器焦点与选区；已有编辑区终端经 `TerminalEditorService` 用 `preserveFocus` 展示，保留其原位置。

### 路径与最近目录

`workbench.action.terminal.runActiveFile` 捕获活动文件 URI，经原终端实例的 `sendPath` 执行磁盘上的文件，不自动保存编辑器。`terminal/create` 与重新 attach 的 ready 数据保留执行端确认的交互式 Shell 类型；Task 的任意程序和一次性 Shell 命令不取得该能力。当前支持 Bash、Zsh 和 PowerShell，未知 Shell 和 Windows Bash 的路径转换明确拒绝。

`sendPath` 复用 PathService 解析执行宿主路径，要求资源与实例目录具有相同 scheme／Remote authority，拒绝虚拟资源、查询或 fragment、相对路径和控制字符。POSIX 引用保留文件名中的空格、单引号和命令语法字符；PowerShell 使用字面量单引号，执行文件时添加调用运算符。关闭、重连、复用或替换目录会退休尚未完成的路径转换。

将文件、目录或编辑器标签拖到屏幕只插入第一个资源的引用路径，不追加 Enter；没有宿主路径的浏览器 File 不会上传或变成猜测路径。实例继续拥有同一屏幕、输入和释放流程。

`workbench.action.terminal.goToRecentDirectory` 使用原历史 owner 和已提交的 CwdDetection 能力，按工作区与执行宿主保存有界目录历史。输出中的每个 cwd 边界按屏幕提交序列发布，最终快照不再抹掉两次读取之间经过的目录。选择器支持方向键、Enter 与 Escape，后续历史更新会进入已打开的列表；切换实例、连接状态或目录根时取消。Bash／Zsh 使用引用后的 `cd --`，PowerShell 使用 `Set-Location -LiteralPath`。历史上限为零或 Shell 禁用历史时不保存新目录；清除以前的会话历史记录同时清理目录。

## 输出与命令状态

Rust 输出字节与 typed Shell boundaries 共享顺序信息。协议适配层保留原始字节，`TerminalProcessManager` 唯一拥有增量 UTF-8 解码和读取游标；有屏幕时等待 xterm write callback，再发布相应命令事件和退出。没有屏幕的 Shell 不制造屏幕解析确认，稍后附着使用实例保留的有限显示回放。

`afterSequence` 确认此前屏幕写入已经解析完成，收到一页输出本身不构成确认。未确认输出达到 512 KiB 或 8192 块时，Rust drainer 等待消费确认，并通过有界 PTY channel 限制生产速度。最近 replay ring 约为 1 MiB／16384 块；旧历史淘汰由 `outputGap` 显式报告。关闭、连接清理、租约过期和授权撤销均取消相应 drainer 的等待。

ShellIntegrationAddon 消费已提交事件；`CwdDetectionCapability` 持有已提交 cwd，命令能力模型关联屏幕 markers、输入和输出范围。gap、trim、clear、reuse 与禁止历史存储会撤回相应显示状态。实际 Shell 状态、nonce 和权威历史继续归 Rust；PartialCommandDetection 的回退 marker 只用于导航，不猜测命令文本或退出状态。

命令概览装饰复用同一 marker 生命周期，主题变化更新颜色，失败状态显示在概览尺右侧。`terminal.integrated.shellIntegration.decorationsEnabled` 默认为 `both`，也可选择 `gutter`、`overviewRuler` 或 `never`；切换显示模式保留原导航 marker。检测到命令的标记提供按钮菜单；点击或聚焦后按 Enter／Space／Shift+F10，可复制命令、精确输出或两者、选择从命令输入起点到执行点的文本，以及明确重跑。菜单始终引用 capability 原命令对象；输出读取要求原执行／结束端点均保留，trim 撤销 marker 时关闭菜单并释放回调，不把当前屏幕尾部当作完整输出。

重跑由同实例的输入贡献承接；未受信文本先确认，确认前后校验实例、输入代次、活动项与 command capability 成员身份。关闭、重连、进程替换或切换后不能把迟到确认交给其他实例。Find 搜索本实例已解析的屏幕和 scrollback；可访问输出从同一屏幕读取，关闭辅助视图后恢复原终端焦点。

Sticky Scroll 由原 CommandDetection markers 和 xterm buffer 投影命令标题，不保存第二份命令历史。命令滚出视口后保留顶部标题，最多显示配置行数且不超过视口的 40%；鼠标、Enter 或 Space 回到原命令，Escape 恢复输入。标题上的滚动交回 xterm 原 viewport，沿用其小数滚动量累积、灵敏度和鼠标协议。alternate buffer、trim、清屏和命令范围失效撤回标题；主题和 resize 使用原屏幕的颜色、字体与几何。

终端建议共用原历史、工作区文件服务和获准的扩展 completion provider。`terminal.integrated.suggest.enabled` 默认开启；Ctrl+Space 保留显式选择入口。`quickSuggestions` 的 `commands`、`arguments` 默认为 `on`，`unknown` 默认为 `off`；已确认的普通输入在光标附近显示列表，焦点留在终端。`suggestOnTriggerCharacters` 独立控制扩展触发字符，默认关闭。方向键选择，Enter 仅插入候选、不会执行命令，Tab 仍交给 Shell；输入、切换、关闭、provider 撤回及迟到结果不会重新打开旧列表。IME 组合输入不触发建议。路径建议仅处理当前工作区、已知 POSIX Shell 的普通 token，复杂引用与扩展语法交给 Shell。

悬停命令及输出的导引线使用 `terminal.integrated.shellIntegration.showCommandGuide`，位于原命令边栏内，与首个文字单元保持间距。输入语法颜色由 Shell 及其原有插件输出 ANSI 属性，终端保留这些属性；建议列表和命令装饰不替 Shell 解析输入，也不自动安装或重写用户的高亮插件配置。

## 视图、分组与资源导航

隐藏面板保留实例、PTY、屏幕、待提交输入、分屏比例与焦点。面板组由 `TerminalGroupService` 管理成员，`TerminalGroup` 按窗口布局服务的真实 Panel 位置分屏：顶部／底部横向排列，左侧／右侧纵向排列；移动面板保留相对尺寸和焦点。列表从组模型派生行顺序、连接线与可访问位置描述。标签拖到另一标签之前／之后可加入该组或重排；拖到可见窗格沿分屏轴的前／后半部使用相同 `moveInstance` 操作，资源只匹配本窗口的存活实例。组内重排将比例与实例一起保留。Join or Reorder Terminals 提供同等键盘选择器，取消、切换实例或关闭后不应用过期结果。

`TerminalEditorService` 将同一个 TerminalInstance 移入或移出编辑区，编辑器 pane 只承载原 xterm。移动不复制屏幕或重建进程；同一终端可由多个编辑器组承载；关闭单个宿主保留原进程，最后一个宿主关闭后才释放实例。批量关闭先按准确关闭集合完成确认，取消不提前关闭任何进程。重命名和图标变化由实例保存，标签与编辑器通过原事件更新。

标准终端创建和已有实例的编辑器展示尊重 `preserveFocus`：后台打开不改变活动终端，也不因编辑器选中事件重定向 Send Sequence；实际聚焦终端后才切换输入目的地。实例构造失败时，创建工厂先释放已取得的 PTY，再向调用方返回原错误。扩展 Profile 的位置和后台创建意图从调用方经 provider 与 MainThread 传入实际创建入口；期间用户主动切换输入目标时，不恢复过期的活动项。

编辑区 Split 捕获原终端所在组，通过编辑器组服务调用现有 EditorPart 的相邻组操作。新终端的创建同时携带原实例和准确的目标组，继续使用 TerminalService 的 cwd／Profile 解析；原 PTY 与屏幕不变。父实例代次失效时关闭迟到的新进程；创建失败只清理本次仍为空的目标组。Panel 四方向命令由 Workbench 布局服务移动真实 Grid；位置按工作区保存，横向高度与纵向宽度分别保存。方向和尺寸变化保留分屏比例、屏幕、焦点与 PTY。

文件链接的点击和键盘选择共用 `TerminalLinkContribution` 与路径解析。解析器只产生候选，贡献使用命令所在行的 cwd、执行宿主的 `IPathService` 与原文件服务确认资源，再通过编辑器服务打开文件和行列位置。属于该终端 `dirId` 对应工作区根的目录通过原 Explorer View 和选择服务显示并接收焦点；确认存在的本地 `file` 目录位于根外时，经原 `IHostService.openWindow` 请求新窗口。Browser 不支持新窗口及 Remote authority 尚无对应宿主入口时明确不可用，不能把远端目录当成本地路径或暗中添加工作区根。远端资源保留所属目录的 authority；文本位置从真实 buffer cells 换算，处理宽字符与自动换行。状态、工作区或实例失效会撤回尚在路径确认、View 打开阶段的结果，目录选择已经交给 Explorer 后由其原 owner 管理；终端不会在失效后追加焦点操作。

`terminal.integrated.enableFileLinks` 控制内置文件检测，`wordSeparators` 同时作用于文本链接分词和 xterm 选词。相对路径未直接命中时，只在实例授权根内搜索：唯一结果直接定位，多个结果要求再次选择。选择器先显示内置链接，外部 provider 按最多四个请求增量填入，取消或卸载后停止调度。

扩展 `window.registerTerminalLinkProvider` 沿已有独立宿主注册和调用链接入窗口唯一 `ITerminalLinkProviderService`。包须获准声明 `terminalLinkProvider`；首次到达终端按 `onTerminal` 懒激活。提供者接收行文本、取消令牌及原终端的名称／PID 快照身份，返回经范围校验的链接；用户激活才调用原扩展对象。缓存有界，选择器保留项的句柄被淘汰时按原行重新解析；重命名／重启刷新快照，工作区、进程或扩展代次失效撤回旧调用。Completion／Quick Fix 使用同一 Extension Host 的独立 capability admission、注册及取消链，具体行为见 [Terminal 可选贡献](../src/ash/workbench/contrib/terminalContrib/README.md#功能与调用链)。Shell Execution 扩展事件按其原能力契约提供。

附加终端到 Chat 时捕获已解析输出、选区及 Shell 元数据，交给原 draft。Terminal: Ask Chat 还允许输入问题，并将问题与输出快照一起追加到同一个 Chat 草稿，不自动提交；选择期间切换终端或会话取消交付。追加只编辑草稿末尾，保留富文本引用的快照元数据和撤销边界。只读预览显示接受时的快照，源终端关闭或再次选择不改写已接受内容；预览没有 PTY 或输入目的地。

## 关闭与恢复

| 生命周期事件                                           | 资源行为                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 隐藏或再次显示面板                                     | 保留原进程和屏幕，仅改变可见性与焦点。                                         |
| 关闭实例或最后一个终端编辑器宿主                       | 按关闭策略检查真实子进程；取消保留原会话并恢复焦点，确认后释放进程与前端资源。 |
| Desktop 窗口 reload                                    | 协调输入、屏幕与后端租约交接，新 Renderer 附着同一 PTY。                       |
| Web 连接关闭                                           | `connectionOwned` 进程随连接结束。                                             |
| Desktop 连接中断                                       | 同一后端按 30 秒租约保留可重连进程，成功 attach 旋转 token。                   |
| 窗口实际退出、后端重启、租约过期或 runtime replacement | 窗口交接凭据清空或原 attachment 失效，不能据旧 checkpoint 续接原进程。         |

`confirmOnKill` 默认为 `editor`，`confirmOnExit` 默认为 `never`；设置及枚举值由原配置 schema 定义。子进程状态通过 Rust `terminal/processInfo` 查询，OS 无法确定时保守确认，取消关闭不停止进程、输出或待提交输入。

Desktop 的 `enablePersistentSessions` 控制协调 reload 和退出恢复。准备阶段等待输入队列与屏幕解析提交，保存输出游标、UTF-8 尾部、终端资源、VT 屏幕、组成员／比例及活动／焦点项。普通工作区存储保存 UI checkpoint，租约 token 通过窗口级内存 SecretStorage 短期交接；准备或其他生命周期 join 失败时撤销交接并恢复同一实例读写。 恢复屏幕等首次可见布局再打开渲染器；保存的焦点请求保留到这一步，期间用户移至其他控件时取消，避免启动时面板仍为零尺寸而丢失焦点或随后抢回焦点。

新 Renderer 按原执行目录与租约 attach 并验证 PID，恢复原字符网格与屏幕，等待布局和工作台恢复后续读，避免临时尺寸改写历史。实际窗口关闭清空内存凭据；扩展自供 PTY 没有恢复协议时阻止不安全的 reload，并反馈原因。

`workbench.action.terminal.moveIntoNewWindow` 将捕获的终端移至同工作区和执行宿主的新窗口，也可指定已有窗口 ID。源端暂停输入与读取后，Rust 原子 detach 撤销源访问并旋转租约；Main 仅在内存中向指定真实窗口交付屏幕与凭据。目标校验、attach 原 PID 并建立可用屏幕后确认，源端再移除宿主。失败时返回当前有效租约，让源端恢复同一实例；凭据不进入窗口 URL 或持久存储。

`terminal.integrated.persistentSessionReviveProcess` 默认为 `onExit`，也支持 `onExitAndWindowClose` 与 `never`。符合策略的退出先持久保存交互式终端输出、当前 cwd、原始启动意图和布局，再关闭原进程。快照不保存已合并的窗口临时环境；恢复时保留原启动 Profile 的命令、参数和环境覆盖，重新应用当前设置及环境集合，避免沿用旧窗口身份或重复修改 PATH。重新启动按原执行目录建立新 Shell，恢复屏幕、分组比例与活动项；不重跑任务或先前执行的命令，不续接旧 PID。扩展自供 PTY 不参加这种恢复。同工作区的多个原生窗口通过持久窗口身份使用不同 checkpoint；窗口会话恢复按身份重开，关闭后重新打开的工作区只领取未占用的恢复记录，避免相互覆盖和重复启动。

本地自动验证覆盖 Chromium 的实际屏幕、键鼠、选区和焦点，以及真实 Node 扩展宿主；跨机器 SSH 终端和 Linux Desktop 的真实 OS 文件拖入尚缺真实环境验证。

## 验证入口

| 契约                         | 主要测试入口                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行选区、实例输入与生命周期 | [terminalActions.test.ts](../src/ash/workbench/contrib/terminal/test/browser/terminalActions.test.ts)、[terminalService.test.ts](../src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts)                                                               |
| Profile、环境与扩展创建      | [terminalConfigurationService.test.ts](../src/ash/workbench/contrib/terminal/test/browser/terminalConfigurationService.test.ts)                                                                                                                                            |
| 屏幕、解析等待与命令装饰     | [xtermTerminal.test.ts](../src/ash/workbench/contrib/terminal/test/browser/xterm/xtermTerminal.test.ts)、[decorationAddon.test.ts](../src/ash/workbench/contrib/terminal/test/browser/xterm/decorationAddon.test.ts)                                                       |
| 文件链接与异步打开           | [terminalLinkContribution.test.ts](../src/ash/workbench/contrib/terminalContrib/links/test/browser/terminalLinkContribution.test.ts)                                                                                                                                       |
| 连接代次、租约与 reload      | [reconnectableTerminalProcessService.test.ts](../src/ash/platform/terminal/test/browser/reconnectableTerminalProcessService.test.ts)、[terminalNativeContribution.test.ts](../src/ash/workbench/contrib/terminal/test/electron-browser/terminalNativeContribution.test.ts) |
| 真实 Workbench、PTY 与焦点   | [terminal.spec.ts](../test/smoke/areas/windows/terminal.spec.ts)                                                                                                                                                                                                           |
| 执行端进程、输出与释放       | [exec-server 终端实现及相邻测试](../crates/exec-server/src/terminal.rs)                                                                                                                                                                                                    |

```sh
pnpm test:unit --runGlob '**/terminal*/**/*.test.js'
pnpm test:browser:integration terminal.integration.spec.ts --project=chromium
pnpm run smoketest test/smoke/areas/windows/terminal.spec.ts
just verify ash-exec-server
just test ash-app-server-runtime --lib terminal
```
