# Terminal API 对齐状态

## 职责边界

Agent loop 全部由 Rust 后端拥有。前端保留 Workbench 交互、屏幕模型和领域客户端，具体边界定义在 [Platform Terminal README](../src/ash/platform/terminal/README.md#前后端职责)。文件清单用来定位职责，不表示公开契约或行为完成率。

用户已确认：六个 `common/autoApprove/` 路径按后端审批 owner 的宿主差异处理；`common/localPtyChannel.ts` 按 Rust PTY transport 的宿主差异处理。这七项不创建前端空壳，也不计为已实现的 TypeScript 文件。审批行为的缺口回到 Rust action-policy / execpolicy / 工具执行链验证；PTY 行为的缺口回到 Rust terminal / utils-pty 验证。前端审批只展示后端请求、收集人类选择并回复，Rust 校验请求仍有效后执行。

三个平台 Browser 适配器沿用既有确认，仅补当前调用方需要的端口和元数据映射；迁移、收敛和删除仍后置。

## 按功能比较与优先级（2026-10-17）

本节比较当前 Ash 工作树与本地 VS Code `1e81fc75bb564738c29771d9b17c72e708a8211c` 的用户可观察能力。依据生产入口、配置消费者、状态 owner 和行为测试判断；同名文件存在不算完成，缺文件也不直接算缺功能。P1 是应先闭合的可靠性或日常工作路径，P2 是下一批效率与交互能力，P3 按实际需求选择。此处未对所有项目重新执行两端相同场景，不能作为完整兼容认证。

### 已有能力，不再计为缺失

| 能力                              | 当前范围与证据                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell / PTY、输入输出、中断与关闭 | 有真实 PTY、原始键盘与 binary 输入、SIGINT、进程关闭。`terminalActions.ts` 的 Interrupt Active Command 已调用 `instance.sendSignal('SIGINT')`。此前 Desktop 场景验证了长命令中断、后续命令执行和关闭分屏后的进程清理。 |
| 多终端、面板分屏与焦点            | 有独立实例、组、窗格切换、取消拆分、分隔线拖动、窗口 resize。此前场景覆盖多窗格运行、中断隔离、关闭后的焦点和存活进程。                                                                                                |
| 隐藏面板再显示                    | 同一窗口存活期间保留 PTY、屏幕输出、待提交输入和分屏宽度，已有 Desktop 验证；不代表窗口重载或应用重启恢复。                                                                                                            |
| 标签和命令状态显示                | 重命名、图标选择、标签排序、分屏图标、组连接线、命令标记和概览尺已有；最近一次英文、中文高对比度场景覆盖了组列表和失败标记。                                                                                           |
| 编辑区终端                        | 有移入编辑区、移回面板和 `TerminalEditorService`；编辑区终端内继续执行 Split 尚未支持。                                                                                                                                |
| Profiles、环境变量与扩展 PTY      | 有发现 / 自定义 / 默认 Profile、cwd / args / env / strictEnv、扩展 Profile provider、环境集合和自定义 PTY；Tasks / Debug 使用既有启动链。这里不宣称所有 VS Code 扩展 API 兼容。                                        |
| 查找、复制粘贴、命令导航和历史    | 有滚动缓冲查找、正则 / 大小写 / 全词、文本复制粘贴、bracketed paste、前后命令导航、持久化最近命令列表。高级交互见下表。                                                                                                |
| Chat 与可访问性                   | 有终端上下文附加到 Chat、可访问输出、帮助、键盘操作和 bell signal；终端内嵌 Chat UI 是另一项能力。                                                                                                                     |
| 文件与行列链接                    | 相对 / 绝对 / 带空格路径的鼠标和键盘打开、原命令 cwd 与行列跳转已接入。英文与中文高对比度 Desktop 场景各 4/4，详见下方文件链接切片；真实 SSH 和 Windows runtime 尚未验收。                                             |
| 端到端输出背压                    | 屏幕消费确认反向限制 PTY drainer，慢消费者不再提前丢弃未确认输出。6 万行字节校验、关闭清理、隔离及 Desktop 突发输出已验证，详见下方输出背压切片。                                                                      |
| 窗口 reload 恢复                  | Desktop 本地与远程共用 reconnectable adapter；协调 reload 保存原进程身份、已提交屏幕、待提交输入、分屏比例和焦点，再 attach 原 PTY。macOS 英文 / 中文均通过命令重载与直接刷新连续两次恢复，详见下方实施切片。          |
| 可取消的关闭保护                  | `confirmOnKill` / `confirmOnExit` 使用真实 OS 子进程状态；取消分屏或窗口关闭不停止进程、输出或输入，恢复原焦点。配置默认值与 VS Code 对应设置一致。                                                                    |

### 真正缺失或只完成一部分的能力

| 优先级          | 用户能力                                             | Ash 当前边界与实际缺口                                                                                                                                                                                                                 | 主要 owner / 依据                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2              | **应用退出后恢复输出、cwd 和布局**                   | 有限 `TerminalRecorder` replay 与命令文本历史不等于完整终端恢复；缺少持久化缓冲、布局和重建 Shell 的入口。这与已完成的保留原进程 reload 语义分开实现和验收。VS Code 的 revive 也会重新创建进程，不保证旧的任意命令跨应用退出继续运行。 | [TerminalRecorder](../src/ash/platform/terminal/common/terminalRecorder.ts)、Rust 终端生命周期、Workbench 终端模型；VS Code `persistentSessionReviveProcess` 配置。                                                                                                     |
| P2              | **把文件 / 文件夹拖入终端输入路径**                  | 当前屏幕没有文件 drop 输入链；标签 drop 只接受本地拖动的终端实例。需要执行宿主对应的路径、quoting 和远端映射。                                                                                                                         | [XtermTerminal](../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts)、[TerminalTabsList](../src/ash/workbench/contrib/terminal/browser/terminalTabsList.ts)、进程输入 owner。                                                                          |
| P2              | **拖动合并分屏、跨组移动和组内重排**                 | 已有单标签排序、内部 `joinInstances` 和取消拆分；标签 drop 仅改全局实例顺序，没有形成组移动、拖入合并和窗格顺序变更。不能把组连接线显示算作这些交互已完成。                                                                            | [TerminalTabsList](../src/ash/workbench/contrib/terminal/browser/terminalTabsList.ts)、[TerminalGroupService](../src/ash/workbench/contrib/terminal/browser/terminalGroupService.ts)、[TerminalGroup](../src/ash/workbench/contrib/terminal/browser/terminalGroup.ts)。 |
| P2              | **分屏方向与编辑区分屏**                             | 面板组目前固定左右排列；缺少随面板位置调整方向或手动切换方向。Split 命令明确跳过编辑区实例，缺少从编辑区终端创建相邻终端的行为。                                                                                                       | [TerminalGroup](../src/ash/workbench/contrib/terminal/browser/terminalGroup.ts)、[Split 命令](../src/ash/workbench/contrib/terminal/browser/terminalActions.ts)、TerminalEditorService。                                                                                |
| P2              | **运行编辑器选区 / 当前文件**                        | `sendText` 已有，Tasks / Debug 启动也已有；未注册 VS Code 对应的 Run Selected Text / Run Active File 用户入口，也未找到等价的编辑器到活动终端行为链。                                                                                  | [终端命令](../src/ash/workbench/contrib/terminal/browser/terminalActions.ts)、编辑器选区与输入 owner。                                                                                                                                                                  |
| P2              | **命令级复制输出、重跑与选区**                       | 命令 markers、状态、前后导航和输出范围已有；装饰当前只有显示 / hover，没有点击菜单里的复制命令、复制该命令输出、重跑、按命令范围选择等操作。普通文本选区复制不受此限制。                                                               | [DecorationAddon](../src/ash/workbench/contrib/terminal/browser/xterm/decorationAddon.ts)、[命令动作](../src/ash/workbench/contrib/terminal/browser/terminalActions.ts)。                                                                                               |
| P2              | **最近目录与 Shell 历史导入**                        | Ash 自己记录的最近命令可选择重跑；缺少 Go To Recent Directory，以及读取 Shell 历史文件合并到终端历史选择器的链路。                                                                                                                     | [history contribution](../src/ash/workbench/contrib/terminalContrib/history/browser/terminal.history.contribution.ts)、cwd capability、宿主文件读取。                                                                                                                   |
| P2              | **多行粘贴确认和鼠标剪贴板偏好**                     | 文本粘贴和 bracketed paste 已有；缺少适用条件下的多行确认、选中即复制、可配置右键复制 / 粘贴等行为。bracketed paste 不能代替确认策略；应覆盖菜单、快捷键和浏览器粘贴入口。                                                             | [Clipboard contribution](../src/ash/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts)、[TerminalInstance.sendText](../src/ash/workbench/contrib/terminal/browser/terminalInstance.ts)。                                           |
| P2              | **Fish 的增强 Shell Integration**                    | Fish 可发现并启动，但当前归为 `ShellKind::Other`，没有自动注入命令生命周期、可信 cwd / env 等增强信息。Bash / Zsh / PowerShell 的集成已经存在。若 Fish 是首发支持范围，应随 P1 基础能力验证。                                          | [Profiles](../crates/exec-server/src/terminal/profiles.rs)、[Shell integration](../crates/exec-server/src/terminal/shell_integration.rs)。                                                                                                                              |
| P2              | **终端 Suggest 补全 UI**                             | 没有命令 / 参数 / 路径候选列表、候选接收和 provider 接入。Shell 自身 Tab 补全仍正常走 PTY，不能把它算作缺失。                                                                                                                          | [产品加载入口](../src/ash/workbench/contrib/terminal/terminal.all.ts)、现有输入 / PromptInputModel；对照 VS Code Suggest 的公开配置与测试。                                                                                                                             |
| P2              | **Sticky Scroll 与命令引导**                         | 有命令边界，缺少滚动时固定当前命令的顶部区域；也没有上游的命令范围引导交互。                                                                                                                                                           | [产品加载入口](../src/ash/workbench/contrib/terminal/terminal.all.ts)、屏幕 markers / viewport owner；对照 VS Code Sticky Scroll 配置。                                                                                                                                 |
| P2              | **失败命令 Quick Fix**                               | 没有根据命令和输出展示修正动作及运行修正命令的链路，相关 provider 也未接入。现有错误标记仅展示状态。                                                                                                                                   | [产品加载入口](../src/ash/workbench/contrib/terminal/terminal.all.ts)、DecorationAddon、后端执行入口；对照 VS Code Quick Fix contribution / builtin actions。                                                                                                           |
| P2 / 按扩展需求 | **终端 provider 扩展面**                             | Profile、环境变量、自定义 PTY 已有；链接、Quick Fix、补全 provider 和 VS Code Shell Execution 事件 API 尚未形成对应公开契约。按 Ash 实际扩展消费者决定范围，不为了兼容声明新增空 API。                                                 | [MainThreadTerminalService](../src/ash/workbench/api/browser/mainThreadTerminalService.ts)、扩展 SDK / Rust 扩展运行时、各能力 owner。                                                                                                                                  |
| P3              | **通知、自动回复、远端本地回显、尺寸提示和独立缩放** | 上游对应贡献尚未加载，也未找到等价功能链。按完成通知、固定响应规则、远端输入延迟或显示需求分别选择；已有 bell signal 不等于命令完成通知。                                                                                              | [产品加载入口](../src/ash/workbench/contrib/terminal/terminal.all.ts)、[Xterm addon 加载](../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts)。                                                                                                       |
| P3 / 先测量     | **渲染与显示增强**                                   | 未接入 GPU renderer、可选 Unicode / grapheme 宽度 addon 和图片协议 addon。现有中文输入、字符显示不能因此判为缺失；是否增加这些机制取决于真实字符兼容用例和性能测量。                                                                   | [XtermTerminal](../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts)、[XtermAddonImporter](../src/ash/workbench/contrib/terminal/browser/xterm/xtermAddonImporter.ts)。                                                                                |
| P3 / 产品选择   | **终端内嵌 Chat**                                    | 附加终端到现有 Chat 已有；缺少直接覆盖在终端中的 inline Chat 交互。是否增加独立入口应由使用场景决定，不能把 Rust 拥有的 Agent 执行、审批和工具调度再搬回前端。                                                                         | [TerminalTabsChatEntry](../src/ash/workbench/contrib/terminal/browser/terminalTabsChatEntry.ts)、现有 Chat 与后端领域服务。                                                                                                                                             |

### 建议实施顺序与验收

1. **保留已闭合的 P1 生命周期回归。** reload 后原 shell / 子进程 PID、连续输出、组布局和焦点仍正确；关闭保护可取消且不破坏原会话，现已纳入中英文 Desktop 烟雾测试。应用彻底退出后的恢复另测缓冲 / cwd / 布局与新进程，不承诺旧命令续跑。
2. **保留已闭合的导航与背压回归。** 文件与行列链接、慢消费者和突发输出已有本批验收。后续补真实 SSH、其他执行平台和更广泛的内存 / 吞吐测量，继续区分产品 scrollback 淘汰与传输 gap。
3. **再补 P2 高频交互。** 文件拖入、拖动分组、方向、编辑器选区执行、按命令复制输出和历史目录；每次移动都验证进程身份、待提交输入、选区和焦点。Fish 若在目标支持范围内先补其集成，避免后续能力只在部分 Shell 生效。
4. **最后扩展效率 UI。** Suggest、Sticky Scroll、Quick Fix 复用既有命令状态和屏幕边界；P3 按测量与用户需求选取，不以抹平目录差异为目标。

本批最新回归：关闭 / reload 相关前端定向单测 136/136、Rust exec-server 库测试 82/82、app-server-protocol 库测试 148/148、终端 Desktop 烟雾 15/15。此前文件链接 / xterm / 原服务单测 101/101、终端 URL / 中文打开规则 1/1、文件链接英文和中文高对比度场景各 4/4 的证据继续保留。此前分屏 / resize / 关闭 / 隐藏恢复的证据继续保留。这些只证明覆盖到的 Ash 行为，不是全库、全平台或完整 VS Code 兼容认证。真实 SSH、Windows / Linux runtime、PowerShell / Fish 的运行覆盖仍有缺口，不能直接据此宣称对应平台不能启动终端。

### 关闭保护与窗口 reload 实施切片（2026-10-17）

关闭链：标题栏 / 标签 / 命令 / 编辑区关闭 → `safeDisposeTerminal` 或标准 editor close handler → Rust `terminal/processInfo.hasChildProcesses` → 原 DialogService。OS 无法确定子进程状态时保守确认，取消不停止原会话；窗口生命周期取消同时恢复原输入焦点。`terminal.integrated.confirmOnKill` 默认为 `editor`，可设 `never` / `editor` / `panel` / `always`；`confirmOnExit` 默认为 `never`，可设 `never` / `always` / `hasChildProcesses`。两项沿用窗口配置作用域；面板关闭保护需设为 `panel` 或 `always`。

Desktop `enablePersistentSessions` 默认开启。标准 Reload Window 命令和直接刷新都完成原生命周期握手后才导航；`beforeunload` 同步阻止未经协调的刷新。准备阶段等待输入队列和屏幕解析提交，保存输出游标、增量 UTF-8 尾部、原资源身份、xterm SerializeAddon 的 VT 屏幕、组成员 / 比例和活动 / 焦点项。普通工作区存储仅保存 UI checkpoint，租约 token 单独通过窗口级内存 SecretStorage 交接，实际窗口关闭即清空。所有 join 成功后才标记原客户端交接；准备或其他 join 失败则清除 checkpoint 并恢复同一实例读写。

新 Renderer 先按原执行目录和租约 attach 并验证 PID，再按原字符网格恢复屏幕；等待组布局与工作台恢复后才续读，避免临时单窗格宽度改写历史。隐藏面板也恢复原屏幕，保存焦点的可见窗格才重新取得输入焦点。成功 attach 旋转 token，连接断开后的原进程保留受同一后端 30 秒租约限制。应用彻底退出、后端重启和租约过期后的原进程续跑不在此范围；扩展自供 PTY 尚无恢复协议，启用持久会话时会阻止不安全的 reload 并报告原因。

macOS Desktop 烟雾覆盖英文与简体中文：取消分屏关闭、取消窗口关闭；两个长命令与第三窗格待提交输入；拖动后的三窗格宽度；连续命令重载和直接刷新；原 shell / 子进程 PID 不变，全部编号输出无缺口 / 重复；恢复后的 Ctrl+C、后续命令、可访问输出与焦点，以及最终关闭清理。完整终端集 15/15 通过，最终英文 / 中文关闭与 reload 专项 4/4，已有文件草稿的两次 reload 与显式保存回归 1/1。前端定向单测 136/136、exec-server 82/82、app-server-protocol 148/148；中文语言包与构建通过。当前未把这组 macOS 结果替代真实 SSH、Windows / Linux 或应用退出后 revive 的验收。

### 文件链接实施切片（2026-10-17）

生产链：终端输出中的路径点击 / 打开检测到的链接命令 → `TerminalLinkContribution` → `terminalLinkParsing.detectLinks` → 原命令行 cwd 与 `IPathService` / `IFileService` → `IEditorService.openEditor` 的资源和 selection。xterm 继续拥有 buffer / cells / markers，贡献只借用它们，不创建第二份屏幕或进程状态。

新增生产文件只有上游同路径的 `terminalContrib/links/browser/terminalLinkContribution.ts` 和 `terminalLinkParsing.ts`，都有上述生产调用方；原 URL provider、悬停和选择器从 `XtermTerminal` 迁入单一实例贡献，旧屏幕 / View 的链接端口退出。现有链接注册入口、终端配置说明、可访问性帮助、中文翻译和定向测试同批更新。文件服务决定可访问性和实际文件身份；终端路径解析不执行命令、读取 Shell 代码或绕过原文件服务。

此切片覆盖文件与位置导航；目录打开、工作区搜索型链接、外部 provider 和完整链接配置仍属于后续能力。真实 SSH 连接与 Windows runtime 仍需各自的验收环境，不能用 URI / 路径单测替代。

验证：完成全量测试编译后，文件链接、xterm 和原终端服务四个文件的定向单测 **101/101**。覆盖真实 xterm buffer 的宽字符 / 换行边界、引号位置规范化、执行宿主家目录、远端 authority、Windows 盘符、失效文件、异步关闭 / 重连，以及原输入确认、解析等待和实例生命周期。前端与自动化的全量类型检查通过。

真实 Desktop 场景：英文 [report](../.build/ash-playwright-mcp/evidence/terminal-file-links-2026-10-17T18-06-53-688Z/report.html) 与中文高对比度 [report](../.build/ash-playwright-mcp/evidence/terminal-file-links-zh-2026-10-17T18-07-54-483Z/report.html) 各 **4/4**。截图已目视检查，均为独立合成工作区；保留原始 WebM 和 trace。当前缺少 ffmpeg / ffprobe，未生成字幕视频，也未独立探测视频编码与时长。

## 输出背压实施切片（2026-10-17）

唯一执行 owner 仍是 Rust `exec-server`，前端 `TerminalProcessManager` 仍拥有解析等待与消费游标。下一次读取的 `afterSequence` 确认先前屏幕写入已完成；返回一页输出本身不算确认，回读旧游标不能撤回确认。没有新增协议 method、传输 DTO 或另一份屏幕 / 进程状态。

未确认数据达到 512 KiB 或 8192 块时，Rust drainer 异步等待确认，再通过原有有界 PTY channel 反向限制生产速度。最近 replay ring 保持约 1 MiB / 16384 块的上限；已确认的旧历史仍可被淘汰并报告 `outputGap`。每个 session 拥有其 drainer 的取消句柄，显式关闭、连接清理、全局关闭、租约过期和授权撤销都会取消等待，不占用其他终端的异步 worker。

验证：原实现的 6 万行 / 4.44 MB 慢消费者测试复现 `unconsumed terminal output was evicted`；修复后长度与 SHA-256 一致。`just verify ash-exec-server --lib` 的 check、test、rust-warnings 全部通过；Rust 库 **81/81**，新增场景验证暂停期间其他终端可用、原 PID 重新附着、确认后恢复、SIGINT，以及五条关闭路径中的进程退出与 drainer 释放。Desktop 烟雾测试 **11/11** 通过，包含 2 万行 / 1.56 MB 突发输出、800 ms 屏幕阻塞、全部行的内容和顺序、焦点恢复及后续命令。早期脚本的输出等待和断言成本问题已修正，未降低内容校验范围。

窗口 reload 恢复和有子进程时的可取消关闭保护由下方独立切片闭合；输出背压继续为冻结屏幕后等待续接的原 PTY 提供有界流控。

## Platform Terminal 文件清单与接线

只读参照 `../vscode/src/vs/platform/terminal`。生产 TS/CSS 排除 test：双方同路径 **25**、仅 Ash **3**、仅 VS Code **21**；Common 为 **25 / 32**，七个差异路径均已有上述归属决定。2026-10-17 对照 VS Code `1e81fc75bb564738c29771d9b17c72e708a8211c`，Workbench Terminal 为双方同路径 **89**、缺失 **1**、仅 Ash **0**；缺失项是 `electron-browser/terminalInstallActions.ts`，与命令概览标记和分屏组列表无关。这些数量只说明文件落位。

### 命令概览标记与分屏组列表

截图中的概览尺和分屏连接线所需的生产文件均已存在，无需新增同名文件。缺口位于已有 owner 的行为接线：

| 行为                 | 已有文件（相对 `src/ash/workbench/contrib/terminal/`）                                                                     | 接线                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 右侧命令状态概览     | `browser/xterm/decorationAddon.ts`、`browser/xterm/xtermTerminal.ts`、`common/terminalColorRegistry.ts`                    | 原 screen marker 同时注册概览装饰；屏幕启用概览尺，颜色跟随命令状态和主题，失败标记位于右侧。标记裁剪和释放仍由原生命周期拥有。 |
| 分屏组连接线与连续行 | `browser/terminalTabsList.ts`、`browser/terminalGroupService.ts`、`browser/terminalGroup.ts`、`browser/media/terminal.css` | 列表消费已有组成员和窗格顺序，显示组首、中间、末尾连接线；取消拆分和关闭后从模型重新派生，单实例隐藏连接线。                    |
| 分组可访问性         | `browser/terminalTabsList.ts`、`../terminalContrib/accessibility/browser/terminalAccessibilityHelp.ts`                     | 保留 TabList 的键盘和选择语义，装饰连接线不参与读屏，行描述提供组号和组内位置；帮助与中文翻译同步。                             |

文件链接实施前，扩展到整个相关目录后的生产 TS/CSS 路径缺失数为：`workbench/contrib/terminal` **1**、`workbench/contrib/terminalContrib` **154**、`workbench/services/terminal` **0**、`platform/terminal` **21**。后者包含已确认由 Rust 拥有的 PTY 和审批职责；`terminalContrib` 还包含终端 Chat、Agent 工具、Sticky Scroll、Suggest 等独立能力。这份路径差异不能作为批量新增前端文件的实施清单。

| 平台相对路径                                                       | 文件关系         | 当前职责、接线或缺口                                                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/appServerTerminalProcessService.ts`                       | 仅 Ash（已确认） | 已确认 Ash 专属；本地 Electron/已连接 Web 通过 Renderer protocol client 调用 Rust PTY。                                                                                                  |
| `browser/disconnectedTerminalProcessService.ts`                    | 仅 Ash（已确认） | 已确认 Ash 专属；无 App Server 宿主时明确拒绝操作。                                                                                                                                      |
| `browser/reconnectableTerminalProcessService.ts`                   | 仅 Ash（已确认） | 已确认 Ash 专属；Desktop 本地 / 远程 Renderer 的 lease/token/generation owner；协调 reload 短期交接租约；Main 提供通用窗口内存 SecretStorage、relay 与 runtime replacement 通知。        |
| `common/autoApprove/autoApproveParseSafety.ts`                     | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/cmdDelayedExpansion.ts`                        | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/gitAutoApproveRules.ts`                        | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/powershellAutoApproveRules.ts`                 | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/sedFileWriteParser.ts`                         | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/sortAutoApproveRules.ts`                       | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/capabilities/bufferMarkCapability.ts`                      | 双方都有         | DecorationAddon 登记原 screen markers；创建、借用、替换、trim 与释放共用唯一模型。                                                                                                       |
| `common/capabilities/capabilities.ts`                              | 双方都有         | 进程与屏幕 capability 的共同契约；命令执行与来源可信度来自 Rust，markers/input/output range 由 screen 拥有。                                                                             |
| `common/capabilities/commandDetection/promptInputModel.ts`         | 双方都有         | 解析后的 cells/cursor 输入模型：Unicode、ghost、右提示、续行、interrupt 和序列化；无键盘编辑模拟或第二套 parser。                                                                        |
| `common/capabilities/commandDetection/terminalCommand.ts`          | 双方都有         | 屏幕命令/partial command：真实 markers、时间/ID、输出范围与匹配、持久化可序列化坐标；不替代 Rust history。                                                                               |
| `common/capabilities/commandDetectionCapability.ts`                | 双方都有         | 屏幕命令周期、当前输入/已提交执行状态、marker lifetimes、clear/gap/reuse 与 serialize/deserialize；backend 状态仍在原 source。                                                           |
| `common/capabilities/cwdDetectionCapability.ts`                    | 双方都有         | 已提交 cwd/trust/访问目录集合；原 command source 更新，Rust 仍拥有实际 cwd 与 nonce 判定。                                                                                               |
| `common/capabilities/naiveCwdDetectionCapability.ts`               | 双方都有         | Split 在无 shell cwd 时查询真实 processInfo；模型释放后丢弃迟到更新。                                                                                                                    |
| `common/capabilities/partialCommandDetectionCapability.ts`         | 双方都有         | xterm 普通 buffer Enter 的回退导航 marker；erase/trim/屏幕释放退订，不猜测命令文本或状态。                                                                                               |
| `common/capabilities/promptTypeDetectionCapability.ts`             | 双方都有         | Rust PromptType 经 output sequence commit 发布；仅显示身份；screen prompt input 由独立 PromptInputModel 消费实际 cells/cursor。                                                          |
| `common/capabilities/shellEnvDetectionCapability.ts`               | 双方都有         | 原子 env 事务与累计 nonce 信任；未结束不发布，abort 撤回；Send Sequence 消费已提交且可信快照。                                                                                           |
| `common/capabilities/terminalCapabilityStore.ts`                   | 双方都有         | 可变 store、专用事件与 multiplexer 已接 process/screen，lease 与优先级覆盖测试通过。                                                                                                     |
| `common/environmentVariable.ts`                                    | 双方都有         | 标准 variable/scope/description/diff/apply 契约已接；process-creation / shell-integration phase options 已贯穿 SDK、resolver 与 Rust startup wrapper。                                   |
| `common/environmentVariableCollection.ts`                          | 双方都有         | 启动时 immutable snapshot、scope 优先级、diff 和原子 apply，执行宿主大小写由 constructor 确定。                                                                                          |
| `common/environmentVariableShared.ts`                              | 双方都有         | 扩展/持久化唯一解码与标准序列化；旧快照规范化、opaque scope key 与 URI 边界校验。                                                                                                        |
| `common/localPtyChannel.ts`                                        | 仅 VS Code       | 已确认宿主差异：Renderer protocol client → Rust terminal dispatch → PTY；不建立 Node IPC channel。                                                                                       |
| `common/requestStore.ts`                                           | 双方都有         | 原 extension profile bridge 的 callback 配对、超时、同步回复和释放；不共享或复制 transport request IDs。                                                                                 |
| `common/terminal.ts`                                               | 双方都有         | 部分契约；实际服务由 Renderer host 提供，Workbench/Sessions 注册。child process 输入按真实 capability 接线；SIGINT 与消费确认驱动的服务器输出背压已接入；通用属性和持久恢复未完整接入。  |
| `common/terminalDataBuffering.ts`                                  | 双方都有         | 扩展 PTY 的文本合并与 drain；Shell 输出仍由 Rust ring + 原 ProcessManager 分页/解析等待。                                                                                                |
| `common/terminalEnvironment.ts`                                    | 双方都有         | Tasks/Debug literal shell path quoting 与 resolver sanitizeCwd；collapseTildePath 仍未接真实调用；strictEnv 已贯穿真实 Rust spawn。                                                      |
| `common/terminalLogService.ts`                                     | 双方都有         | 终端日志 scope、当前 Workspace trace 标签、level/event 和原持久化 flush；Root 在 Workbench/Sessions 注册真实 logger factory。                                                            |
| `common/terminalPlatformConfiguration.ts`                          | 双方都有         | 通用 launch schema 唯一注册，原 Workbench 入口调用；保留原配置键、默认与校验。                                                                                                           |
| `common/terminalProcess.ts`                                        | 双方都有         | 真实 display replay 消费 ReplayEntry；完整 process details/config/layout 仍待接线。                                                                                                      |
| `common/terminalProfiles.ts`                                       | 双方都有         | 动态 schema enums、args 比较和 ThemeIcon/URI icon 比较供 ProfileService 消费。                                                                                                           |
| `common/terminalRecorder.ts`                                       | 双方都有         | 有限 screen display replay，保存 geometry、文本与 ordered metadata；不等同服务端持久恢复。                                                                                               |
| `common/terminalStrings.ts`                                        | 双方都有         | Tasks 启动提示消费 ANSI formatMessageForTerminal，保留 NLS 文本与正确换行。                                                                                                              |
| `common/xterm/shellIntegrationAddon.ts`                            | 双方都有         | 消费已提交的 Rust shell boundaries 并登记 screen command/env/mark 模型；无 TS OSC parser，nonce 与权威 history 留 Rust。                                                                 |
| `electron-main/electronPtyHostStarter.ts`                          | 仅 VS Code       | 不启动 Electron PTY host；Desktop 通过既有连接层获取 Rust App Server。                                                                                                                   |
| `node/childProcessMonitor.ts`                                      | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/heartbeatService.ts`                                         | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/nodePtyHostStarter.ts`                                       | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHost.ts`                                                  | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHostMain.ts`                                              | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHostService.ts`                                           | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyService.ts`                                               | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalContrib/autoReplies/autoRepliesContribController.ts` | 仅 VS Code       | 未接入自动回复场景；当前无前端生产调用方。                                                                                                                                               |
| `node/terminalContrib/autoReplies/terminalAutoResponder.ts`        | 仅 VS Code       | 未接入自动回复场景；当前无前端生产调用方。                                                                                                                                               |
| `node/terminalEnvironment.ts`                                      | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalProcess.ts`                                          | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalProfiles.ts`                                         | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/windowsShellHelper.ts`                                       | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |

## Common 已接通的行为

- 环境集合：扩展 SDK scoped view / options / descriptions → 平台唯一边界解码 → Workbench 集合持久化与快照 → scope/diff/原子 apply → ProfileResolver → Rust spawn。process-creation mutations 在启动前应用；shell-integration mutations 经标准 `VSCODE_ENV_REPLACE/PREPEND/APPEND` metadata 交给 Rust，在用户 RC 后按字面值应用，不执行插值或 eval。`strictEnv` 只采用显式字面环境，Rust 不解释该模式中的 metadata 字段。
- Profiles 与配置：ProfileService 消费 args/icon 比较，动态 schema 消费 profile enums；平台唯一注册 launch schema。未知持久化 profile 保留现有 fallback。
- 输出与屏幕：Rust 输出和 typed Shell boundaries 共享 sequence；适配器保留 bytes，ProcessManager 唯一增量解码并等待 xterm write commit。有限 TerminalRecorder 保存 geometry 与 metadata 顺序，不替代服务端输出保留或持久恢复。
- 屏幕能力：ShellIntegrationAddon 消费已提交事件；CommandDetection / PromptInputModel / TerminalCommand 拥有 markers、输入、宽字符、ghost、右提示、续行和输出范围。gap、trim、clear、reuse 与 storage-disabled 撤回相应屏幕状态。Rust 继续拥有 OSC parser、nonce 判定、执行状态与权威 history。
- cwd / PromptType / env：cwd 查询回到原 `terminal/processInfo`；PromptType 与实际 Shell 类型由 Rust producer 发布。Shell env 使用完整或增量事务，来源可信度来自 Rust；Send Sequence 消费已提交且可信的 env，否则使用原执行宿主环境。来源可信不授予执行权限。
- 客户端输入：`ITerminalChildProcess.processBinary` 由真实输入 owner 消费；text-only/output-only provider 不声明该能力。扩展 PTY 输入和 resize 等待原 provider 确认，失败传回原调用方；关闭拒绝排队及进行中的输入，迟到回复不发布输出，正常确认可以同时报告退出。cwd 查询在关闭或执行宿主替换后撤回结果。
- 日志与请求：TerminalLogService 使用 host logger scope、level/event 与真实 flush；RequestStore 关联 extension profile 的领域 callback/deadline，不复制协议 pending map。超时或撤回取消 provider，迟到 PTY 经原关闭端口回收。
- Tasks / Debug：共用原 Rust 进程启动、literal shell path quoting 与配置环境；Tasks 消费标准 ANSI 提示格式。客户端 PTY API 和 provider 对象留在其原 owner，Agent 工具调度不进入前端。

## 待接入契约

- 完整通用 process property、child-process/backend port 需按实际消费者补齐。`terminal/sendSignal` 已有 Interrupt Active Command → `instance.sendSignal('SIGINT')` → 本地 / 远程适配器 → Rust 的生产调用链；其他信号选择或通用属性仍按实际消费者补齐。
- 同一 Desktop 窗口 reload 已接入原 PTY attach、VT 屏幕与布局恢复，本地 / 远程共用 30 秒租约。跨窗口转移、应用退出后的 revive 仍需独立实现；Web connection-owned 生命周期保持原约定。
- 尚无消费者的通用 layout/process details、自动回复和其他公开端口不预建模块。后续新增消费者时先确认唯一 owner 与可观察结果，再补对应契约。

## 已执行的迁移与验证

平台环境合并算法已回到 `common/environmentVariableCollection.ts`；上游存在的 Workbench `common/terminalEnvironment.ts` 保留，继续拥有启动 override 解析。已确认的重连测试从 `test/electron-main/reconnectableTerminalMainService.test.ts` 迁至 `test/browser/reconnectableTerminalProcessService.test.ts`，旧测试路径退出。

本轮 macOS 验证：正常 `pnpm test:unit` 选择 TerminalService / TerminalBackend / TerminalProcessExtHostProxy / TerminalConfigurationService 四文件，**137 项通过**；Common / Renderer 类型检查通过。正常准备入口通过，中文语言包生成无缺译。

正常浏览器入口的全 fixture 类型检查已通过：diagnostic code fixture 提取领域标记的标量 code，SyntaxToken / folding / symbol / diagnostic fixture 使用原 SyntaxRange 的零基坐标。相关 Chromium **6 场景通过**，覆盖英文/中文诊断编辑、诊断日志、Rust syntax 与 symbol navigation、主题诊断颜色。原终端 Chromium **3 场景通过**：粘贴与原始键盘输入、重新附着只订阅一次、鼠标原始高字节。受影响 TS formatter、文档/NLS JSON Prettier 和 diff whitespace 检查通过。

上述 Common 迁移批次未修改 Rust、协议、平台 Browser adapters 或视觉样式。后续关闭 / reload 切片的 Rust、协议与 macOS Electron 验证见前文；真实 SSH、Windows/Linux PTY 和 PowerShell runtime 尚未验收。
