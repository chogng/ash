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
| `terminalContrib`                            | 按实例拥有查找、链接、剪贴板、历史选择、听写和无障碍交互的资源与释放。                              |

Agent 执行、审批与终端呈现的详细边界以 [Platform Terminal 的前后端职责](../src/ash/platform/terminal/README.md#前后端职责)为准。前端的命令标记、环境来源可信度和屏幕文字不授予执行权限。

## 进程接入

新建终端的入口为命令 → `ITerminalService.createTerminal(ICreateTerminalOptions)` → TerminalService 的目录/profile 与位置解析 → TerminalInstanceService。面板只在首次显示且没有实例时发起一次创建；独立终端窗口和分屏不依赖 View 创建方法。

真实 Shell 的输入链路为：用户操作／Tasks／Debug → `TerminalInstance` → `TerminalProcessManager` → `ITerminalProcessService` → Renderer protocol client → App Server → `exec-server` → PTY。Electron 连接经过 Main 的透明 relay，Browser 通过其 Web 连接访问后端；输出沿相反方向返回。

宿主在 `IRendererHost.terminal` 提供进程服务，Workbench 与 Sessions 通过同一个 DI 标识消费。已连接 Web 使用 `AppServerTerminalProcessService`；Desktop 本地与远程使用 `ReconnectableTerminalProcessService`。无后端的 UI 环境通过 `DisconnectedTerminalProcessService` 明确拒绝进程操作。

后端资源由 `terminalId` 与创建时的 `dirId` 共同定位；保留的多根工作区终端继续使用原目录路由。前端实例身份独立于 PID，重启 Shell 可以更换 PID。终端编辑器资源包含实例 incarnation，失效资源显示不可用，不根据旧身份自动启动新 Shell。

宿主输出 PTY 和扩展自供 PTY 经共享服务契约接入同一个窗口实例集合。前者为只读输出，后者按 provider 实际提供的输入与尺寸能力接线；其创建通知和回调生命周期见[宿主服务与快照](../src/ash/workbench/services/terminal/README.md)。

## 启动配置与扩展

`TerminalProfileService` 合并执行端发现、自定义与扩展 Profile；`TerminalProfileResolverService` 解析执行端变量、Shell 参数、cwd、环境和图标，实际可执行文件由后端确认。多根工作区新建终端使用活动文件所属目录，无法确定时由用户选择；Split 继承原实例的目录与启动配置。

交互终端、Tasks／DAP 和 Agent 的打开终端请求分别采用交互、automation 和 agentHost Profile 策略，共用原实例创建链。Relaunch 复用首次启动的配置快照；任务终端复用则按新任务替换启动配置并等待旧 PTY 释放。

启动 schema 由平台唯一注册，屏幕与工作台设置由终端贡献注册，配置值及持久化归配置系统。扩展环境集合由 Workbench 管理生命周期与持久化，平台负责纯解码、快照和合并，resolver 将结果交给 Rust 创建请求。大小写、变量删除、`strictEnv` 和 Shell Integration 环境阶段的规则见 [Platform Terminal](../src/ash/platform/terminal/README.md)。

扩展 Profile 的注册、激活、撤回和取消属于原 Extension Host 链。工作区或 provider 代次失效后，晚到的 PTY 由原关闭端口回收；实例关闭释放 provider 的引用，重启重新取得 handle。

Profile 选择器属于单次命令。工作区或执行连接变化会关闭并退休该选择，目录选择和默认 Profile 写入前也核对其生命周期；同名 Profile 或相同操作系统再次出现不能恢复旧选择。后续命令使用新的选择器。

## 输入与命令

xterm 的文本和原始字节输入经实例进入同一进程输入 owner。`sendText` 负责换行、执行用的 Enter 与 bracketed paste；原始键盘和二进制输入保留原有编码。输入和尺寸操作等待执行端或 provider 确认，关闭会拒绝排队及进行中的操作，迟到回复不能恢复已关闭的输入链。

剪贴板贡献捕获发起实例和输入 generation，异步读取或确认后核对活动项、连接及屏幕；切换回来也不会发送已失效的粘贴。浏览器 paste 在 xterm 处理之前进入同一贡献，经原实例 `sendText` 发送并等待输入确认，不会同时进入 raw onData。没有文本选区时，Ctrl+C 继续发送给 Shell；Interrupt Active Command 通过执行宿主发送 SIGINT。

`terminal.integrated.enableMultiLinePasteWarning` 由 TypeScript 窗口配置解释，沿现有 `settings.json` 的用户／工作区层解析，默认 `auto`。`auto` 在 bracketed paste 模式下放行，其他情况下移除单条命令末尾的换行及空白，对其余多行文本确认；`always` 对 LF、CRLF 和 CR 换行均确认，即使 Shell 启用了 bracketed paste；`never` 关闭确认。对话框仅展示有界开头预览，接受后发送原文；Escape 取消且恢复有效原实例的焦点。

最近命令选择器从终端历史 owner 读取按 Profile 保存的命令，只在用户明确接受后重跑。最近命令和目录选择都绑定原 PID；切换实例、重连、退出、关闭或工作区替换会退休并关闭选择器，切换回来不能恢复旧选择。目录发送等待确认期间失效时也不再抢回焦点。听写文字进入原实例输入链，由用户按 Enter 执行；切换实例、退出或隐藏面板取消录音。

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

命令概览装饰复用同一 marker 生命周期，主题变化更新颜色，失败状态显示在概览尺右侧。检测到命令的标记提供按钮菜单；点击或聚焦后按 Enter／Space／Shift+F10，可复制命令、精确输出或两者、选择从命令输入起点到执行点的文本，以及明确重跑。菜单始终引用 capability 原命令对象；输出读取要求原执行／结束端点均保留，trim 撤销 marker 时关闭菜单并释放回调，不把当前屏幕尾部当作完整输出。

重跑由同实例的输入贡献承接；未受信文本先确认，确认前后校验实例、输入代次、活动项与 command capability 成员身份。关闭、重连、进程替换或切换后不能把迟到确认交给其他实例。Find 搜索本实例已解析的屏幕和 scrollback；可访问输出从同一屏幕读取，关闭辅助视图后恢复原终端焦点。

## 视图、分组与资源导航

隐藏面板保留实例、PTY、屏幕、待提交输入、分屏比例与焦点。面板组由 `TerminalGroupService` 管理成员，`TerminalGroup` 使用横向 SplitView；列表从组模型派生行顺序、连接线与可访问位置描述。标签拖到另一标签之前／之后可加入该组或重排；拖到可见窗格左／右侧使用相同 `moveInstance` 操作，资源只匹配本窗口的存活实例。组内重排将比例与实例一起保留。Join or Reorder Terminals 提供同等键盘选择器，取消、切换实例或关闭后不应用过期结果。

`TerminalEditorService` 将同一个 TerminalInstance 移入或移出编辑区，编辑器 pane 只承载原 xterm。移动不复制屏幕或重建进程；关闭终端编辑器标签通过原编辑器关闭链释放实例。重命名和图标变化由实例保存，标签与编辑器通过原事件更新。

标准终端创建和已有实例的编辑器展示尊重 `preserveFocus`：后台打开不改变活动终端，也不因编辑器选中事件重定向 Send Sequence；实际聚焦终端后才切换输入目的地。实例构造失败时，创建工厂先释放已取得的 PTY，再向调用方返回原错误。扩展 Profile provider 自行创建时的焦点契约及多组承载的关闭确认仍见 TODO。

编辑区 Split 捕获原终端所在组，通过编辑器组服务调用现有 EditorPart 的相邻组操作。新终端的创建同时携带原实例和准确的目标组，继续使用 TerminalService 的 cwd／Profile 解析；原 PTY 与屏幕不变。父实例代次失效时关闭迟到的新进程；创建失败只清理本次仍为空的目标组。Panel 位置与方向切换仍须由布局服务提供契约，不能从窗口宽高推断。

文件链接的点击和键盘选择共用 `TerminalLinkContribution` 与路径解析。解析器只产生候选，贡献使用命令所在行的 cwd、执行宿主的 `IPathService` 与原文件服务确认资源，再通过编辑器服务打开文件和行列位置。已确认的目录必须属于该终端 `dirId` 对应的工作区根，再通过原 Explorer View 和选择服务显示目录并接收焦点；链接不会添加工作区根或自动打开其他窗口。远端资源保留所属目录的 authority；文本位置从真实 buffer cells 换算，处理宽字符与自动换行。状态、工作区或实例失效会撤回尚在路径确认、View 打开阶段的结果，目录选择已经交给 Explorer 后由其原 owner 管理；终端不会在失效后追加焦点操作。

附加终端到 Chat 时捕获已解析输出、选区及 Shell 元数据，交给原 draft。只读预览显示接受时的快照，源终端关闭或再次选择不改写已接受内容；预览没有 PTY 或输入目的地。

## 关闭与恢复

| 生命周期事件                                           | 资源行为                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 隐藏或再次显示面板                                     | 保留原进程和屏幕，仅改变可见性与焦点。                                         |
| 关闭实例或终端编辑器标签                               | 按关闭策略检查真实子进程；取消保留原会话并恢复焦点，确认后释放进程与前端资源。 |
| Desktop 窗口 reload                                    | 协调输入、屏幕与后端租约交接，新 Renderer 附着同一 PTY。                       |
| Web 连接关闭                                           | `connectionOwned` 进程随连接结束。                                             |
| Desktop 连接中断                                       | 同一后端按 30 秒租约保留可重连进程，成功 attach 旋转 token。                   |
| 窗口实际退出、后端重启、租约过期或 runtime replacement | 窗口交接凭据清空或原 attachment 失效，不能据旧 checkpoint 续接原进程。         |

`confirmOnKill` 默认为 `editor`，`confirmOnExit` 默认为 `never`；设置及枚举值由原配置 schema 定义。子进程状态通过 Rust `terminal/processInfo` 查询，OS 无法确定时保守确认，取消关闭不停止进程、输出或待提交输入。

Desktop 的 `enablePersistentSessions` 控制协调 reload。准备阶段等待输入队列与屏幕解析提交，保存输出游标、UTF-8 尾部、终端资源、VT 屏幕、组成员／比例及活动／焦点项。普通工作区存储保存 UI checkpoint，租约 token 通过窗口级内存 SecretStorage 短期交接；准备或其他生命周期 join 失败时撤销交接并恢复同一实例读写。

新 Renderer 按原执行目录与租约 attach 并验证 PID，恢复原字符网格与屏幕，等待布局和工作台恢复后续读，避免临时尺寸改写历史。实际窗口关闭清空内存凭据；扩展自供 PTY 没有恢复协议时阻止不安全的 reload，并反馈原因。

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

2026-10-18 在 Docker Linux ARM64、Bash 和启用 Chromium sandbox 的真实 Electron／App Server 上，6 项定向场景通过：字面路径执行与最近目录、英文／中文选中文本和当前行执行、文件链接鼠标／键盘打开、英文／中文 command 与页面 reload。reload 断言覆盖原 PTY／Shell PID、连续无缺口输出、分屏宽度、未提交输入、焦点、后续 Ctrl+C 与输入及 accessible view。默认编辑器剪贴板快捷键现限定编辑器文本焦点，避免 Linux Ctrl+C 在进入 PTY 前被全局 Copy 消费；菜单／直接命令与用户覆盖继续由原 owner 处理。日志 `.build/todo-linux-terminal-complete.log` 为 6 passed（59.3s），原生剪贴板补充场景为 2 passed。真实 OS 文件拖入、跨机器 SSH、Windows PowerShell 和应用退出后的 revive 不在该结果内。

2026-10-18 本机 macOS Electron／App Server 的文件与目录链接场景通过 1 项（总计 14.4s），验证鼠标打开文件行列及工作区目录、键盘接受带空格路径、Explorer 目录选中与焦点、编辑器标签数量不增加，以及同一个终端实例继续执行命令；日志 `.build/todo-round2-terminal-electron.log`。链接单元测试 21 项通过，覆盖本地与远端资源的原 cwd／authority、目录边界和拒绝访问、关闭或重连时迟到 stat／View 结果、中文选择器与错误；日志 `.build/todo-round2-unit.log`。目录入口复用已有显式路径候选，不搜索普通输出单词，也不添加工作区外目录、搜索型链接或外部 provider；远端测试使用确定性服务，不能代替真实跨机器验收。

目录行为同步写入现有终端无障碍帮助；英文／中文帮助与原输入同步、buffer tracker 共 4 项回归通过，日志 `.build/todo-round2-terminal-accessibility.log`。

测试入口描述可重复检查的行为，不替代特定平台的实机结果。未完成动作与平台验收集中在 [Terminal TODO](../TODO.md#terminal--todo)，可选增强保留在[发展候选（未排期）](../TODO.md#发展候选未排期)。

2026-10-18 在 macOS ARM64 复核 Terminal 全链路与已装载的 terminalContrib，对照本地 VS Code `72e9539ed6b` 的公开契约、生产调用与测试，未执行上游窗口配对。本轮验证如下：

- 29 个终端领域单测文件累计 365 项通过。领域运行中 27 个文件的 209 项通过；另两个文件暴露新增测试的 DI 注册与 disposable 归属问题，修正后分别以原编译入口复验 Profile 60 项、实例服务 96 项通过。日志为 `.build/terminal-alignment-all-units.log`、`.build/terminal-alignment-profile-units.log`、`.build/terminal-alignment-service-units.log`。
- Chromium 的 `terminal.integration.spec.ts` 全部 120 项通过，包含中英文 Profile 选择失效、后台编辑器焦点与输入目的地、Find、链接、历史、剪贴板和无障碍。首次加载失败来自 fixture 缺少链接贡献的视图与 Explorer 依赖，补齐原服务装配后通过；未延长断言。日志 `.build/terminal-alignment-browser-final.log`。
- `pnpm run pretest:smoke:desktop` 的真实后端准备、正常 Desktop 构建与 automation 类型检查通过。实机面板输入／隐藏恢复通过，英文及中文 reload 的原 PID、输出、分屏、待提交输入与焦点断言在一次定向复验中全部通过。首次英文用例因 daemon 清理的身份保护退出 1，记录与剩余调查见 TODO，复验不视为 daemon 缺陷已修。日志 `.build/terminal-alignment-desktop-build.log`、`.build/terminal-alignment-desktop-smoke.log`、`.build/terminal-alignment-desktop-retry.log`。

本轮未修改 Rust，也未重跑 Rust 单测；后端源码审计和本机实机结果不替代 Windows、Linux 或跨机器 SSH 验收。目录集合和样式核对不代替行为通过；尚未闭合的贡献与恢复能力继续按 TODO 的真实前置推进。

```sh
just verify ash-exec-server --lib
just test ash-app-server-runtime --lib terminal
```
