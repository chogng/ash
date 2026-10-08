# Terminal API 对齐状态

## Find 本批准入

用户在终端执行 Find → 当前窗口命令与 `ITerminalInstance.getContribution` → `TerminalFindContribution` / `TerminalFindWidget` → 该实例唯一 `XtermTerminal` 的 SearchAddon → 匹配选区、高亮、结果数与焦点恢复 → 浏览器真实输入断言和 Web / Electron 产品场景。实例拥有贡献，屏幕拥有搜索插件，Find 控件拥有查询与选项；不复制上游私有结构、DOM 或 CSS。

当前行为：Find 搜索解析后的屏幕和回滚内容，支持大小写、整词、正则、跨屏幕换行匹配、上下一个与结果数读出。无效正则不执行搜索；查询期间到达的新输出更新匹配。Ctrl/Command+F 只在终端或 Find 焦点生效，搜索文字不进入 stdin；Escape 清除匹配并恢复终端焦点。切换实例、隐藏面板保留各自查询和选项；关闭实例先释放贡献，再移除屏幕，取消首次加载插件时尚未生效的查询。Find 使用已有 `accessibility.verbosity.find` 与独立的 Alt+F1 帮助，中文文案已接入；这不代表终端输出 Accessible View 与帮助已经补齐。

允许路径：双方同路径的 `terminal/browser/{terminal.ts,terminalInstance.ts,terminal.contribution.ts,xterm/xtermTerminal.ts}`、`terminal/common/terminalContextKey.ts` 与平台 `accessibility/browser/accessibleView.ts` 只补贡献挂载、搜索端口、焦点上下文和帮助标识。上游同路径缺失文件 `terminal/browser/terminalExtensions.ts`、`terminalContrib/find/{common/terminal.find.ts,browser/terminal.find.contribution.ts,browser/terminalFindWidget.ts,browser/terminalFindAccessibilityHelp.ts,browser/media/terminalFind.css}` 承接实际调用链。注册上下文只传当前实例，不预建尚无消费者的进程／布局管理器。

配套允许路径：`package.json` / `pnpm-lock.yaml` 仅增加与 xterm 6 配套的 SearchAddon；`localization/zh-CN/workbench.json` 增加可见文案；`test/integration/browser/{terminal.integration.ts,terminal.integration.spec.ts,chatInput.integration.ts}`、`terminal/test/browser/terminalTabsLayout.test.ts`、`services/tasks/test/browser/taskService.test.ts` 同步真实链验证和实例 fixtures；`test/smoke/areas/windows/terminal.spec.ts` 验证真实 PTY 查找、实例隔离、关闭释放。本文与两个 Terminal README 同步职责和结果。未列路径只读；旧迁移和用户改动已保存于本批基线之外，不回退。

本批验证：正常 `pnpm test:unit` 执行 Terminal 实例／Tabs、Tasks、Debug launcher 与两项架构检查，共 82 项通过；Chromium Terminal 全量 35 项通过。正常 `test:smoke:desktop` 与 `test:smoke:browser:full` 均完成构建与准备，Terminal / Tasks / Debug 的真实 App Server 场景各 7 项通过。`typecheck:renderer` 通过，17 个触及 TS 文件 formatter 通过，新 Find CSS 的 stylelint 通过，本批本地化缺词为零。

验证修复了两个生命周期问题：新屏幕的早到焦点必须在贡献就绪时同步；实例关闭必须先移除贡献监听，再释放屏幕，避免 `focusout` 访问已释放的渲染器。另修正 SearchAddon 在同一查询改变选项时沿用旧匹配缓存的问题。四种主题、中文标签／帮助、原始 stdin 不接收 Find 按键、Tab／Escape、回滚区、跨屏幕换行、输出更新与首次搜索尚在加载时关闭均由真实浏览器状态断言覆盖。测试主题只绑定新增 Find fixture，避免改变旧 pane fixture 的几何基线。

以上运行环境为 macOS；未验证 Windows/Linux、真实 SSH 或实际 VoiceOver 读出。本批不改 Rust／生成协议，不新增第二个进程后端，不删除文件。Find 的查询历史与工作区搜索、完整标准贡献 hooks、终端输出专属无障碍贡献、分组分屏和 Agent 会话接管仍未完成。

终端基座的文件归属与 DI 接线已迁移：平台契约位于 `platform/terminal/common/terminal.ts`，实例契约与实例管理位于 `workbench/contrib/terminal/browser/terminal.ts`、`terminalService.ts`。Shell 的 `terminalProcessManager.ts` 已接管输入队列、尺寸合并、读取游标、命令排序、分页排空与 xterm 解析等待；实例生命周期迁入 `terminalInstance.ts`，它创建并保留唯一 xterm、绑定原始输入；程序消费者使用 `sendText`，管理器的输入和尺寸请求等待后端确认，取消不回放旧输入。屏幕与 Tab 分别迁入 `xterm/xtermTerminal.ts` 和 `terminalTabbedView.ts`。Workbench 与 Sessions 注册所选进程能力，由共同的 Terminal contribution 创建窗口实例服务。SSH 宿主直接选择完整适配器；本地和 SSH 的字节、退出码转换已收回协议边界。完整 VS Code Terminal API、SSH backend 契约及 terminalContrib 尚未完成。

## 职责与调用链

| Owner                                                                     | 当前职责与状态                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [platform/terminal](../src/ash/platform/terminal/README.md)               | 前端进程契约与 DI 标识；现有 Rust 协议适配、SSH 租约管理继续接入同一后端                                        |
| [contrib/terminal](../src/ash/workbench/contrib/terminal/README.md)       | 服务拥有实例集合与活动项；实例拥有连接/生命周期；管理器拥有输入/尺寸/读取；View、Tab 与 xterm 各自拥有 UI       |
| [services/terminal](../src/ash/workbench/services/terminal/README.md)     | 宿主输出 PTY 创建通知与生命周期已接入 Web API 和 Terminal contribution；不保存 Shell 实例服务                   |
| `contrib/tasks/browser/taskService.ts`                                    | 任务发现、执行与终端命令状态；稳定依赖经构造 DI 注入，注册仍由 Code 模式选择                                    |
| `contrib/debug/browser/debugService.ts`                                   | Debug 执行编排与 DAP `runInTerminal`；稳定依赖经构造 DI 注入，工厂源仍指向同一个共享 registry                   |
| `services/tasks/common/taskService.ts`                                    | 共享任务契约只公开 UI `terminalId`；Tasks/Testing View 自行定位当前终端实例，不向共享契约引入 contribution 类型 |
| [terminalContrib](../src/ash/workbench/contrib/terminalContrib/README.md) | 现有 links、voice 的部分能力；本批只迁移实例契约 import，未添加其他贡献                                         |
| `crates/app-server-protocol`                                              | `terminal/*` 请求、结果、错误与生成 decoder；本批未修改协议                                                     |
| `crates/app-server/src/server/terminal_operations.rs`                     | 解码、连接身份、目录授权路由与 DTO 转换                                                                         |
| `crates/exec-server/src/terminal.rs`                                      | 真实 PTY session、可信 profile、授权工作目录、输出 ring、命令状态与 30 秒重连租约                               |
| `crates/utils/pty`                                                        | 操作系统 PTY/ConPTY、原始字节、尺寸、进程终止与句柄释放                                                         |

用户创建终端 / Tasks 或 Debug 请求终端 → `ITerminalService` → 唯一 `TerminalService` → 容器注入的 `ITerminalProcessService` → 当前 Rust 协议适配器 → `terminal/create|read|write|writeBinary|resize|close` → PTY。定向测试观察实例创建、字节输出、命令状态、输入、尺寸与关闭；浏览器测试还通过真实 contribution 注册入口验证两个窗口作用域的独立性及缺失依赖。

本地 Electron 与已连接 Web 由 `platform/agentHost/browser/webRendererApi.ts` 选择普通适配器。SSH Electron 由 `platform/native/electron-browser/rendererApi.ts` 直接选择完整重连适配器，不再拼接普通服务与租约管理的方法。两个适配器共享一个读取结果转换入口，生成 DTO 的 base64 与 nullable 退出码不进入实例服务。Main 只建立连接并透明转发 frame；token 保存在 Renderer，runtime replacement 通知使旧租约退出。xterm 只拥有屏幕，不成为 PTY 进程 owner；后端 ring 与前端 scrollback 用途不同。

本地断线进入 `disconnected`，连接恢复不自动创建 Shell。SSH `reconnectable` 实例首次续读成功后才从 `reconnecting` 回到 `running`。后端重启、租约过期或换代不能恢复原进程，需 Relaunch；输入不重放。隐藏 Panel 保留实例，进程退出保留屏幕，显式关闭释放后端资源。

## 已批准并退出的旧入口

用户于本批明确回复“同意”下面九个准确路径的退出。路径相对 `src/ash`，对应调用方与测试已同批迁移，旧文件不存在、旧模块 import 为零；文件均由 Git 跟踪，可恢复。

| 旧路径                                                             | 当前落位                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `platform/terminal/common/terminalProcessService.ts`               | `platform/terminal/common/terminal.ts`                                                  |
| `workbench/services/terminal/common/terminal.ts`                   | `workbench/contrib/terminal/browser/terminal.ts`                                        |
| `workbench/services/terminal/browser/terminalService.ts`           | `workbench/contrib/terminal/browser/terminalService.ts`                                 |
| `workbench/services/terminal/test/browser/terminalService.test.ts` | `workbench/contrib/terminal/test/browser/terminalService.test.ts`                       |
| `workbench/services/tasks/browser/taskService.ts`                  | `workbench/contrib/tasks/browser/taskService.ts`                                        |
| `workbench/services/tasks/browser/taskServiceRegistration.ts`      | 合入上述实例实现的 Code 服务注册；UI contribution 不注册该服务                          |
| `workbench/services/debug/browser/debugService.ts`                 | `workbench/contrib/debug/browser/debugService.ts`                                       |
| `workbench/services/debug/browser/debugTerminalLauncher.ts`        | 合入上述执行实现；`runInTerminal` 测试从 DAP 反向请求入口验证，没有保留测试专用生产导出 |
| `workbench/services/debug/browser/debugServiceRegistration.ts`     | 合入上述实例实现的服务注册，由 `debug.contribution.ts` 加载，窗口容器创建和释放实例     |

用户随后要求删除 `code/browser/workbench/codeWorkbenchServices.ts` 并按 VS Code 的职责组织装载：该文件在 VS Code 无同路径对应，只汇总五项注册，没有状态或独立生命周期。其唯一生产调用方已迁移，文件由 Git 跟踪，可恢复。Extension Host、Codebase Symbols 由 `workbench.common.main.ts` 加载；Tasks 由 Web、Desktop 入口选择；Debug、Testing 由各自的功能 contribution 加载服务注册，窗口容器仍按依赖安装。未新增替代汇总文件。

用户进一步确认删除 `code/browser/workbench/modes/code.ts`、`code/browser/workbench/modes/code.contribution.ts`、`code/electron-browser/workbench/modes/code.ts`。三者在 VS Code 无同路径对应，职责已回到现有入口，生产模块引用为零，均可通过 Git 恢复。共同装配回到 `workbench.common.main.ts`，两端 `code/*/workbench/workbench.ts` 在本地化完成后加载 Workbench 和 Sessions 贡献，再直接调用启动函数；单项 `modeLoaders` 已退出。

调用方包括两个 Workbench 创建入口、Code 服务装载、Renderer host/适配器类型、Terminal View/Widget/标题动作/profile 图标、Tasks View、Testing View、voice、对应单测及浏览器 fixtures。共享 Task、Debug、Testing 和 Extension Host 契约没有反向导入 Terminal contribution。标准缺失服务在创建时失败；Debug 宿主明确不提供 DAP 时仍可装配配置服务，启动 Debug 前报告不可用，不创建另一套执行实现。

## 目录调查（2026-10-07，迁移后）

比较 `src/ash` 与只读 `../vscode/src/vs` 的生产 `.ts`、`.css`，排除 `test` 目录及 `.test.ts`。只表示文件路径，不表示完整行为完成率。

| 目录                                | Ash | VS Code | 双方都有 | 仅 Ash | 仅 VS Code |
| ----------------------------------- | --: | ------: | -------: | -----: | ---------: |
| `platform/terminal`                 |   4 |      46 |        1 |      3 |         45 |
| `workbench/services/terminal`       |   1 |       1 |        1 |      0 |          0 |
| `workbench/contrib/terminal`        |  17 |      89 |       17 |      0 |         72 |
| `workbench/contrib/terminalContrib` |   3 |     170 |        3 |      0 |        167 |

新增同路径 owner 承接已有 Ash 调用契约。公开名称与参数仍有差异：平台继续使用进程 ID、分页读取和命令游标；进程管理器已接入 Shell 输出事件与解析等待；完整事件型 child process/backend、process manager 的其他公开能力、profile/configuration、分组、编辑区终端和扩展自供 PTY 尚未对齐。本批不把文件迁移或 DI 标识计为完整公开 API 对齐。

## 后续归属与能力

### 第二批准入：Rust 协议边界与 SSH 装配

用户确认“看看有没有对应 vscode 的职责文件，没有就保留”。上游 `platform/terminal/common/terminal.ts` 的 `ITerminalBackend`、`ITerminalChildProcess` 以及 `contrib/terminal/browser/terminalProcessManager.ts` 承担通用 backend、进程事件和实例进程管理；没有 Rust `terminal/*` DTO 转换、bearer token 旋转或无后端 Ash 宿主的同职责文件。三处现有适配器保留这些专属职责，不把它们记为上游 backend 已对齐。

本批行为链：用户创建和输入终端 → 已有 `TerminalService` → `ITerminalProcessService` → 所选本地或 SSH 适配器 → 同一 Renderer protocol client → Rust PTY；返回原始字节、前端退出码和命令状态。SSH 适配器直接实现完整现有进程服务契约，宿主不再手工拼接普通服务与重连服务。协议解码只有一个转换入口；token 与连接代次仍只由 SSH 适配器拥有。实例继续拥有当前读取游标、输入队列和屏幕事件，本批不声称已完成事件型 child process。

| 准确路径（相对 `src`，文档除外）                                                                                                                                                                      | 文件关系 / 本批动作                                                                                          | 验证                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `src/ash/platform/terminal/common/terminal.ts`                                                                                                                                                        | 双方都有；输出改为字节，退出码采用前端 `undefined`，不新增协议端口                                           | 平台到实例的字节与命令顺序                         |
| `src/ash/platform/terminal/browser/appServerTerminalProcessService.ts`                                                                                                                                | 已确认保留；转换生成读取结果，不向消费者暴露 base64 和 nullable 退出码                                       | 真实 protocol client 与 Web host 创建入口          |
| `src/ash/platform/terminal/browser/reconnectableTerminalProcessService.ts`                                                                                                                            | 已确认保留；公开参数改用前端契约，完整提供 profile、连接状态与读取转换，保留 token/attach owner              | 同一服务对象的读写、连接代次、token 旋转与租约退出 |
| `src/ash/platform/native/electron-browser/rendererApi.ts`                                                                                                                                             | Ash 产品宿主；直接选择 SSH 适配器，退出手工终端对象拼接，不更改连接创建                                      | Renderer 编译；实际 Electron 入口在生产构建后验证  |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                                                                                                                                       | 双方都有；消费已解码字节和前端退出码，保留当前轮询与实例状态                                                 | 既有实例生命周期、命令与输出顺序测试               |
| `src/ash/platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts`                                                                                                               | 保留测试路径；同步创建参数并验证完整进程契约，不迁移文件                                                     | 定向单测                                           |
| `src/ash/platform/agentHost/test/browser/webRendererApi.test.ts`                                                                                                                                      | 现有 host 行为测试；新增从真实装配入口观察终端 DTO 转换；既有反向请求 fixture 同步生成契约要求的 Thread 身份 | 定向单测                                           |
| `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`                                                                                                                             | 双方都有；同步前端字节和退出码 fixtures                                                                      | 定向单测                                           |
| `test/integration/browser/terminal.integration.ts`                                                                                                                                                    | 既有浏览器 fixture；同步前端进程结果，不改界面                                                               | Terminal / Testing Playwright                      |
| `docs/terminal-api-alignment-status.md`、`src/ash/platform/terminal/README.md`、`src/ash/workbench/contrib/terminal/README.md`、仓库 `docs/ash-desktop-architecture.md`、`docs/remote-development.md` | 更新决定、实际装配边界与验证状态                                                                             | 文档链接与 diff 检查                               |

`disconnectedTerminalProcessService.ts` 的拒绝操作与现有契约兼容，本批无需改写。没有文件移动或删除；其余八处 UI 载体与旧重连测试路径仍未取得退出决定。

下表仍没有上游同路径，不在本批移动/删除范围。前三处保留专属协议职责；其余载体须沿实际 UI 行为继续核对，不能因为 Rust 已经提供执行能力就长期保留通用职责的错位文件。

| 路径（相对 `src/ash`）                                                  | 尚待处理                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `platform/terminal/browser/appServerTerminalProcessService.ts`          | 已确认保留 Rust 协议转换职责；不是上游通用 backend 的替代 owner                                        |
| `platform/terminal/browser/reconnectableTerminalProcessService.ts`      | 已确认保留 Renderer SSH bearer 租约与连接代次职责                                                      |
| `platform/terminal/browser/disconnectedTerminalProcessService.ts`       | 已确认保留无后端 Ash 宿主的明确拒绝行为                                                                |
| `workbench/contrib/terminal/browser/instance/alternateScroll.ts`        | 随真实 xterm 滚动入口核对归属                                                                          |
| `workbench/contrib/terminal/browser/instance/terminalInstanceWidget.ts` | 对应 `browser/terminalInstance.ts` 与 `browser/xterm/xtermTerminal.ts`；仍需核对公开对象和屏幕生命周期 |
| `workbench/contrib/terminal/browser/instance/terminalTheme.ts`          | 随真实主题转换切片处理                                                                                 |
| `workbench/contrib/terminal/browser/view/media/terminal.css`            | 核对本地 DOM、样式 owner 与上游 `browser/media/terminal.css`                                           |
| `workbench/contrib/terminal/browser/view/terminalProfileIcon.ts`        | 随 profile 选择入口处理                                                                                |
| `workbench/contrib/terminal/browser/view/terminalTabsLayout.ts`         | 随分组与布局入口处理                                                                                   |
| `workbench/contrib/terminal/browser/view/terminalTitleActions.ts`       | 随真实命令和菜单入口处理                                                                               |
| `workbench/contrib/terminalContrib/voice/browser/terminalVoice.css`     | 随语音界面样式职责处理                                                                                 |

重连测试旧路径 `platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts` 实际测试 Renderer 租约管理；本批没有取得它的准确退出确认，保留原测试路径与覆盖。

Terminal 输出专属无障碍帮助、输出 Accessible View、terminal verbosity、历史、Quick Fix、Sticky Scroll、Suggest、剪贴板、完整 links provider、分屏和持久化仍未接通。Find 的当前行为与独立帮助见本文开头；查找历史和工作区搜索仍待补。Node PTY Host 的执行职责由 Rust 后端承担，不能创建第二套执行后端；没有真实消费者的扩展 PTY 能力不创建空实现。

标准 `ITerminalChildProcess` 还要求完整属性查询/更新、signal、binary input、数据确认等真实操作。第五批已经补齐创建/attach 的真实 pid 与启动 cwd、当前进程目录和尺寸查询、原始字节输入，以及 Unix 前台进程组中断。当前目录查询在 macOS/Linux 可用；其他平台返回 `null`，不以启动目录代替。Windows 的显式进程中断返回结构化 `TerminalUnsupported`，不注入伪装成信号的输入。通用属性集合、解析后数据确认、进程列表和跨窗口 detach/恢复仍未完成；不能给这些标准方法填空实现。现有 30 秒连接租约也不等同于上游 backend 的持久化。

### 第三批准入：窗口与实例释放

本批闭合已有调用链：Terminal View 的 Close / Relaunch、任务与调试消费者、窗口容器释放 → `ITerminalService` / `ITerminalInstance` → 现有 `terminalService.ts` → 平台进程服务 → PTY 创建与关闭。上游公开实例契约支持释放，生产服务通过实例释放事件移出实例；本地仍由同一个窗口服务拥有实例顺序与活动项，屏幕、输入尺寸和 DOM owner 不变。

当前缺陷是异步创建晚于窗口释放、重启晚于实例关闭、并发重启重复创建，以及已关闭实例仍登记在窗口的释放集合内。独立实现采用按实例 ID 管理的可释放集合；close 立即停止输入和读取，等待后端完成后撤销实例持有；同步 dispose 立即撤销持有并开始关闭。并发 close 共享后端结果，同一重启只允许一次创建，晚到的创建结果必须关闭后才结束操作。测试通过真实 DI 服务入口观察创建、关闭请求、列表、事件与输出，不比较私有成员。

准确写入范围仅为 `src/ash/workbench/contrib/terminal/browser/terminalService.ts`、同目录的 `../test/browser/terminalService.test.ts`、`src/ash/workbench/contrib/terminal/README.md`、本台账及仓库 `docs/ash-desktop-architecture.md`。没有新增、移动或删除文件，也不修改平台适配器和 Rust 协议。标准 process manager 所需的 pid/cwd、属性、signal、binary input 等下层能力仍未闭合，不创建部分服务外壳。

### 第四批准入：列表事件与创建后的连接状态

本批行为链是已有 Terminal View / voice 订阅 `onDidChangeInstances`，以及 View、Tasks、Debug 发起创建或 Relaunch → `ITerminalService` → `TerminalService` 的列表与连接状态 → 实例列表事件、断线状态、是否读取或发送输入。标准同路径服务与实例宿主公开列表变化事件，上游 View 依赖该事件更新内容；本地只在移动时触发，创建和关闭遗漏。平台连接事件也可能先于异步创建结果到达，当前实例却仍以 running 启动读取。

连接状态仍由窗口 `TerminalService` 唯一拥有。实例开始读取时查询该 owner 的当前状态，创建与重启走同一个检查：本地断线进入 disconnected，不自动恢复；SSH 进入 reconnecting，在 ready 后续读成功才恢复 running。实例不新增连接快照、协议请求或重连 owner。列表变化在列表、标题、活动项和初始状态完成更新后通知，不改变创建事件先于输出订阅的约定。屏幕、DOM、焦点与尺寸 owner 不变。

| 本批准入的准确路径                                                                         | 文件关系 / 动作                                                                  | 验证                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                            | 双方都有；补齐创建与释放的列表通知；创建和 Relaunch 开始读取前检查唯一连接 owner | DI 服务入口的事件快照、延迟创建与连接变化、无多余读写 |
| `src/ash/workbench/contrib/terminal/browser/terminal.ts`                                   | 双方都有；注释说明现有列表事件的触发与状态约定，不新增公开端口                   | 契约编译与服务测试                                    |
| `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`                  | 双方都有；在已有生命周期 suite 增加回归测试，复用可控创建与读取边界              | 正常单测入口和 disposable tracker                     |
| `src/ash/workbench/contrib/terminal/README.md`、本台账、`docs/ash-desktop-architecture.md` | 已有职责文档；同步列表通知与晚到创建的连接语义                                   | 文档链接和 diff 检查                                  |

重新准入：从列表事件和连接状态继续向真实命令消费者追踪，发现 Tasks / DAP 在创建返回后不检查实例状态便写入命令，可能错报启动并一直等待。这是本切片的必要调用方闭合，因此增加以下准确路径：`src/ash/workbench/contrib/tasks/browser/taskService.ts`、`src/ash/workbench/contrib/debug/browser/debugService.ts`（双方都有；写入前检查终端 running，失败时关闭自己创建的实例，不发布 TaskRun / DAP success）；既有 `src/ash/workbench/services/tasks/test/browser/taskService.test.ts`、`src/ash/workbench/services/debug/test/browser/debugTerminalLauncher.test.ts`（保留已确认测试归属；从真实 DI 服务和 DAP reverse request 链路观察未发送命令、未启动任务与关闭）；`src/ash/workbench/services/tasks/README.md`、`src/ash/workbench/services/debug/README.md`（更新失败语义）；`localization/zh-CN/workbench.json`（已有词条 owner；新增错误接入 NLS 并验证中文）。实现不等待恢复后重放命令，用户可以重新运行。

词条更新由现有 `localization:generate` 生成 `src/ash/workbench/services/localization/common/localizationCatalogs.ts`，该已有生成文件也列入准确范围，只允许生成器写入。

其余路径只读。本批没有新增、移动、删除文件，不修改 UI 载体、平台适配器和 Rust 协议；完整 child process/backend 的下层能力缺口不变。

### 第五批准入：Rust 进程信息与真实控制

用户授权先补 Rust PTY 基座。当前行为链：Terminal 创建/Relaunch 与 xterm 输入 → 已有 TerminalService / 平台进程服务 → Renderer protocol client → App Server terminal dispatch → exec-server TerminalService → utils-pty。DAP reverse request 是 shell PID 的实际消费者；xterm `onBinary` 是原始输入的实际入口。进程信息由 Rust 返回，前端不从 Workspace 猜测；窗口仍拥有实例、标题和屏幕。

本批独立实现先闭合创建/attach 的实际 PID 与启动目录、进程属性查询（当前目录与尺寸）、有界原始输入和已有中断信号的协议出口。属性尺寸由实际 resize 更新；不增加无效通用属性写入。当前目录只返回实际查询结果，平台不支持时明确报告，不把启动目录当作当前目录。数据确认需要连接 xterm 的解析完成回调；当前字节事件只说明已交给前端，不能提前当作解析确认。跨窗口恢复还需要实例恢复身份、进程列表、屏幕重播与明确 detach/attach；当前生产实例在窗口释放时关闭 PTY、SSH adapter 的 token 也只在内存中。上述消费者与生命周期尚未闭合，本批不增加无调用方的 ACK 或持久化端口，不把 bounded ring 或 30 秒租约称为完整标准能力。

准确写入清单保存在本批基线 `.build/desktop/terminal-rust-baseline/paths.txt`：Rust 现有 utils-pty process/pty/pipe 与测试、exec-server 终端 DTO/实现/测试、App Server 协议 terminal/registry/error/schema fixtures、terminal dispatch/server dispatch/server tests；前端已有平台 terminal 契约与两个协议适配器、Terminal 契约/实例服务/xterm widget、DAP reverse request 与相关 fixtures；既有职责文档。平台与 Terminal/Debug 服务的同路径 owner 为双方都有；三个协议适配器继续按用户确认保留 Ash 专属职责；widget 本批仅接入原始输入，不移动、删除或重写屏幕 owner。生成目录 `crates/app-server-protocol/schema/` 与 `src/ash/platform/agentHost/common/generated/` 仅由现有生成器更新。其余路径只读。

定向验证从 Rust 公共服务和 App Server typed dispatch 观察真实 PID、目录变化、resize、字节、信号、错误连接拒绝与关闭；从前端真实装配观察 PID 传播、DAP 回复和文本/二进制输入顺序；通过正常构建、生成物检查以及 Playwright Terminal/Tasks/Debug 产品场景验证没有退化。保留全部既有工作区变化，不新建执行后端或标准 child process 空壳。

| 第五批能力             | 唯一 owner 与当前结果                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建/attach ready      | utils-pty 在 child 交给回收任务前捕获 OS PID；exec-server 保存启动时实际使用的规范目录；attach 返回同一身份。前端实例公开 processId/initialCwd，Relaunch 才更新；DAP `runInTerminal` 成功回复携带 `shellProcessId`。                                                       |
| `terminal/processInfo` | exec-server 检查 connection 和目录授权后查询 root shell 的实际 cwd，返回启动信息和最后一次成功应用的字符尺寸；resize/attach 成功后才更新尺寸。macOS/Linux 查询目录，其他平台和已退出进程返回 null。此出口是 Rust 公开进程契约，尚未接入前端完整属性集合。                  |
| `terminal/writeBinary` | App Server 检查 base64 编码上限并解码；exec-server 检查 64 KiB 原始字节上限与所有权；走与文本相同的有界 writer channel，不进行 UTF-8 转换或 command-status 文本推断。xterm onBinary 已沿两个 Renderer adapter 接入；实例按同一队列发送所有先前文本批次、二进制、随后文本。 |
| `terminal/sendSignal`  | exec-server 校验所有权及授权，再委托 utils-pty。Unix PTY 从 tcgetpgrp 找到前台 job，发送 SIGINT；pipe 保留原进程组语义，hard close 保留原 kill-tree 行为。Windows 显式报告不支持。尚未把这个 Rust 出口扩成无当前调用方的前端通用 signal facade。                           |
| 关闭与断线             | 沿用现有 connectionOwned / reconnectable 身份、token 旋转、租约过期及授权撤销清理；不改变 Main/Renderer 的连接拓扑，不重放输入。                                                                                                                                           |

### 第六批：宿主输出 PTY 基座

用户要求补齐基座文件，范围包含建立缺失的 Web 宿主创建入口及其下层契约。生产链路是 `IWebWorkbench.window.createTerminal` → `IEmbedderTerminalService.createTerminal` → `TerminalMainContribution` → `ITerminalService.createTerminal` → 宿主 PTY 打开、输出、改名、退出与释放 → 现有 Terminal View/xterm。服务拥有 contribution 就绪前的创建请求，实例拥有接入后的进程和早到事件；窗口仍只有一个实例列表和一份屏幕。

| 准确路径（相对 `src`）                                                                                      | 关系与本批动作                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/ash/platform/terminal/common/terminal.ts`                                                              | 双方都有；补宿主输出所需的 launch config、进程事件、标题属性和启动/关闭契约                        |
| `src/ash/workbench/services/terminal/common/embedderTerminalService.ts`                                     | 仅 VS Code，原路径新增；宿主 PTY 契约、窗口级创建通知、启动请求队列与进程释放                      |
| `src/ash/workbench/contrib/terminal/browser/terminalMainContribution.ts`                                    | 仅 VS Code，原路径新增；订阅创建通知、接入现有实例服务并显示 View                                  |
| `src/ash/workbench/contrib/terminal/browser/terminal.contribution.ts`                                       | 双方都有；BlockStartup 注册宿主接入 contribution                                                   |
| `src/ash/workbench/contrib/terminal/browser/terminal.ts`                                                    | 双方都有；创建选项区分 Shell profile 与自供 PTY，实例公开只读能力                                  |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                                             | 双方都有；现有实例 owner 接入宿主事件、保留界面订阅前的输出与退出、处理关闭和 Relaunch             |
| `src/ash/workbench/browser/web.api.ts`、`src/ash/workbench/browser/workbench.ts`                            | 双方都有；Web 返回接口与窗口实现提供 `window.createTerminal`                                       |
| `src/ash/workbench/contrib/terminal/browser/terminalView.ts`                                                | 双方都有；无 folder 的宿主输出终端不显示 Shell 的打开目录提示                                      |
| `src/ash/workbench/contrib/terminal/browser/instance/terminalInstanceWidget.ts`                             | 已记录的 Ash 屏幕 owner，本批只按实例只读能力禁止 xterm 输入，不移动或改写 DOM/CSS                 |
| `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts`                                  | 双方都有；只读宿主实例不启动语音输入                                                               |
| `src/ash/workbench/services/terminal/test/common/embedderTerminalService.test.ts`                           | 宿主链路回归测试；从真实 DI 服务和 contribution 观察创建、输出、退出、改名、跨窗口隔离、失败与释放 |
| `test/integration/browser/terminal.integration.ts`、`test/integration/browser/terminal.integration.spec.ts` | 现有 Playwright 入口增加宿主 PTY，验证生产注册、真实 xterm 的早到输出、只读、焦点与清理            |

同步现有 `src/ash/platform/terminal/README.md`、`src/ash/workbench/services/terminal/README.md`、`src/ash/workbench/contrib/terminal/README.md`、本台账及仓库 `docs/ash-desktop-architecture.md`。没有删除、移动文件，没有修改 Rust 协议或生成 DTO，没有新增执行后端或屏幕 owner。

宿主契约与上游同样只提供 open/close、输出和可选退出/改名，不提供输入、signal 或尺寸回调。已退出实例保留屏幕，退出码 0 原样保留；宿主 PID 为 -1、cwd 为空，不能用来代替真实 Shell 身份。平台新增的 `ITerminalChildProcess` 当前仅覆盖此输出链的事件和生命周期，公开成员仍是完整上游契约的子集；完整 Shell child process/backend、属性与解析后 ACK 尚未完成。本批没有通过空方法制造这些能力。

第六批验证：新增回归先复现了宿主同步输出与退出在界面订阅前丢失的问题，修复后通过真实 DI 与 contribution 观察早到事件。正常 `test:unit` 入口的 Embedder、Terminal、Tasks、DAP terminal 和服务装配五个文件共 46 项通过，runner 自测 4 项通过；新增的 8 项 Embedder 用例启用 disposable tracker。Chromium Terminal Playwright 19 项通过，其中新增 2 项验证真实 xterm 的只读宿主输出、焦点与释放；既有中文动作、文本/二进制输入和语音场景保持通过。生产 `pnpm build`、automation 编译、`prepare:backend` 与真实 Electron + App Server Terminal 3 项通过。后端构建无 warning；stylelint 为 0 错误、1 条未修改 Sessions CSS 的建议，Playwright 有既有颜色环境提示。未修改 Rust 或协议，未运行 Rust 单测；未验证 Windows/Linux 和真实 SSH transport 的产品场景。

### 第七批准入：Shell 输出管理与解析确认

用户继续要求补基座。生产链路：Terminal View/Tasks 创建 Shell → TerminalService 公布实例 → 新增同路径 TerminalProcessManager 增量读取 → 实例输出事件 → 现有 TerminalInstanceWidget 的 xterm write 回调 → 解析 promise → 下一批读取及命令完成/退出。进程管理器唯一拥有读取游标、尚未发出的命令事件与读取取消；实例仍拥有成员身份、输入、连接状态和创建/关闭，widget 仍拥有屏幕。实现来自 Ash 的字节 DTO、双游标和窗口生命周期，不复制上游进程后端或屏幕实现。

准确范围：`src/ash/platform/terminal/common/terminal.ts`（双方都有，增加 data/trackCommit/writePromise 事件，data 保留 Ash 原始字节）；`src/ash/workbench/contrib/terminal/browser/terminalProcessManager.ts`（仅 VS Code，原路径补读取、分页排空、事件排序、解析等待与取消）；同目录 `terminalService.ts`、`terminal.ts`（双方都有，迁移读取 owner 与输出事件消费者）；已确认屏幕 owner `browser/instance/terminalInstanceWidget.ts`（仅接解析完成回调，无 DOM/CSS/交互调整）；既有 `test/browser/terminalService.test.ts`、`workbench/services/terminal/test/common/embedderTerminalService.test.ts`、`test/integration/browser/terminal.integration.ts` 及 `.spec.ts`（同步事件与真实入口回归）；三个 Terminal README、本台账和 `docs/ash-desktop-architecture.md`（同步职责与限制）。其余文件只读，无删除或移动。

验证须观察慢解析期间停止续读、完成状态/退出在最后字节解析之后、已退出进程超过一页仍读取尾部、未来输出对应的命令事件不提前发出、关闭/断线取消等待且旧回调不污染新进程、真实 xterm 分块 UTF-8 与早到数据。已有 Shell 首次输出加载解析器，隐藏实例也能完成后台任务，不显示面板或改变焦点；没有进程的隐藏面板仍保持延迟加载。Rust bounded ring 继续拥有后端历史上限；本批解析确认约束 Renderer 读取，不增加虚假的服务器 ACK，也不声称阻塞 OS PTY 读取。完整 Shell child process 属性与跨窗口恢复仍待补。

第七批验证：正常单测入口的 Terminal、Embedder、Tasks、DAP terminal 与服务装配五个文件共 53 项通过，runner 自测 4 项通过。新增 7 项实例回归均启用 disposable tracker，覆盖解析完成/失败、分页尾部、未来命令、关闭、同一 Shell 恢复及旧回调与替换进程隔离。既有重连测试改为等待初始命令事件已消费，避免用“请求已发出”推断游标已更新，仍断言两次恢复的精确游标。

Chromium Terminal Playwright 22 项通过，新增 3 项经过生产服务注册与真实 xterm，覆盖加载期间停止续读、分块中文/emoji、完成与退出、关闭取消和隐藏解析不抢焦点。生产 `pnpm build`、`typecheck:renderer`、automation 编译通过；当前产物的真实 Electron + App Server Terminal 3 项通过。构建无 warning/error；stylelint 为 0 错误、1 条未修改 Sessions CSS 的建议，Playwright 保留既有颜色环境提示。目录审计仅增加上游同路径进程管理器，旧实例读取 owner 已退出；46 个文档相对目标及 `git diff --check` 通过。未修改 Rust 或生成协议，未运行 Rust 单测；Windows/Linux 和真实 SSH transport 产品场景未验证。

### 当前批准批：实例、屏幕与终端界面职责（2026-10-07）

用户明确选择“迁回对应职责文件”，批准八处旧 UI 文件退出；保留 Ash 的实现、DOM、样式与 Rust 适配器。输入、尺寸请求和取消首先迁至 `TerminalProcessManager`，实例负责进程身份与连接状态，服务负责实例集合。此切片的既有 33 项实例单测通过后，开始屏幕迁移；屏幕迁移的 26 项 Chromium 场景通过后，再迁移 Tab 与命令。不能把同路径落位计为完整 VS Code API 或功能对齐。

| 准确路径（相对 `src/ash/workbench/contrib/terminal/`）                                                         | 关系与本批职责 / 生产调用方 / 验证                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/terminalProcessManager.ts`、`browser/terminalService.ts`                                              | 双方都有；现有服务→实例→管理器→PTY，将输入队列、UTF-8 分块、二进制顺序、尺寸合并和停止后的丢弃收敛到管理器；实例生命周期单测                                                     |
| `browser/terminalInstance.ts`                                                                                  | 仅 VS Code；从服务迁回实例身份、创建/关闭、连接状态及输出事件；服务创建它，实例单测及真实 PTY smoke                                                                              |
| `browser/xterm/xtermTerminal.ts`                                                                               | 仅 VS Code；View→屏幕，将 widget、主题转换与 alternate scroll 迁入唯一屏幕 owner；保留独立算法及既有 Ash helper 契约，原有测试改 import，Chromium 验证真实解析和输入             |
| `browser/terminalTabbedView.ts`                                                                                | 仅 VS Code；View→Tab/分栏，迁入现有列表渲染、选择、拖动与尺寸状态；实例集合仍由服务拥有；分栏单测及 Chromium Tab 行为                                                            |
| `browser/terminalIcon.ts`                                                                                      | 仅 VS Code；Tab/标题→profile 图标，迁回既有可信 profile 映射；保持 Ash profile 契约，未声称完成上游 profile 服务                                                                 |
| `browser/terminalView.ts`                                                                                      | 双方都有；迁移屏幕/Tab 依赖，将既有标题 UI 归入 View，保留可见性、初始化、焦点和失败状态；浏览器及 Electron                                                                      |
| `browser/terminalActions.ts`、`browser/terminalMenus.ts`、`common/terminalContextKey.ts`、`common/terminal.ts` | 前三者仅 VS Code、后者双方都有；标题按钮→窗口 CommandService→当前窗口 View，命令定义与菜单静态注册，View 只拥有 toolbar/context；迁移真实使用的标准命令 ID，验证多窗口及标题动作 |
| `browser/terminal.contribution.ts`                                                                             | 双方都有；只加载动作/菜单，退出其 Focus 命令实现，不改变服务或 View 装配                                                                                                         |
| `browser/media/terminal.css`、`browser/media/terminalVoice.css`                                                | 仅 VS Code；原有 Ash 样式原样迁回屏幕 owner，View/voice 加载；计算样式、主题和焦点的浏览器验证                                                                                   |

批准的准确旧路径为 `browser/instance/alternateScroll.ts`、`browser/instance/terminalInstanceWidget.ts`、`browser/instance/terminalTheme.ts`、`browser/view/media/terminal.css`、`browser/view/terminalProfileIcon.ts`、`browser/view/terminalTabsLayout.ts`、`browser/view/terminalTitleActions.ts`，以及 `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.css`。旧文件均由 Git 跟踪；同批迁移全部生产与测试引用，不保留另一套实现。

必要调用方/验证范围为 `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts`、`src/ash/workbench/contrib/chat/browser/attachments/chatAttachmentWidgets.ts`，既有 Terminal 四个 UI 单测和 `terminalService.test.ts`，`test/integration/browser/terminal.integration.ts`、`.spec.ts`、`chatInput.integration.ts`、`test/architecture/ui-styling-ownership.test.ts`，Terminal 与 terminalContrib README、`docs/ash-desktop-architecture.md` 与本台账；`localization/zh-CN/workbench.json` 同步迁移 Tab 标签与命令失败提示。浏览器编译另需在 `test/integration/browser/files.integration.ts` 的离线 API fixture 补现有必填 `connectionGeneration`；不改文件夹产品实现。实际 Electron trace 另证明 `test/automation/terminal.ts` 与 `test/smoke/areas/windows/terminal.spec.ts` 使用了旧 Panel 标签；同步为现有生产按钮的 “Toggle Panel Visibility” 与 “Close Panel”，保留所有执行、焦点和输出断言。其他来源不明的 Rust 与脚本变化保留，不属于本批。

实现依照 Ash 当前生命周期：屏幕保留延迟加载与隐藏解析；Tab 组件只订阅服务状态，释放时取消订阅；命令从调用窗口的 accessor 取 View，不保存某个窗口的回调。完整 child process/backend、group、profile/configuration、编辑区终端、服务器 ACK 与 Agent 会话接管仍待后续闭合。

本批准入后的验证：新增创建回调输入回归先失败，管理器改为在实例公布前就绪后，正常单测入口的 11 个受影响文件共 81 项通过，runner 自测 5 项通过。新增回归启用 disposable tracker，覆盖读取启动前的文本与尺寸请求；既有用例继续覆盖断线丢弃、二进制顺序和 UTF-8 边界。Chromium Terminal 29 项通过，新增三项验证实际 View 的窗口命令路由与释放、四种 xterm 主题的参数及计算样式、child 控制和保存/恢复 alternate scroll。真实 Electron 与 Web + App Server 的 Terminal 三项各自通过，覆盖 Shell 输入执行、焦点与隐藏/恢复、多实例输出隔离、实际工作目录写盘和退出后 Relaunch。

Desktop 正常构建、完整 Web 构建和 automation 编译通过，Renderer 类型检查通过。两份 CSS 与 Git 中迁移前的内容逐字相同；定向 stylelint 为 0 错误，保留原有终端状态字号的 1 条设计建议。全仓 stylelint 当前被本批未修改的 `contrib/trace/browser/agentTraceEditor.css` 六个未知变量阻塞，未放宽规则或修改该界面。Playwright 保留既有 NO_COLOR/FORCE_COLOR 环境提示。旧生产/测试 import 为零，仅 Ash 的生产文件目前剩已确认保留的三处平台 Rust 适配器；目录数量只描述落位，不表示功能完成率。Rust 后端为端到端测试完成构建，本批未编辑 Rust 实现或协议，未运行 Rust 单测，也未验证 Windows/Linux 或真实 SSH transport。

## 验证

受影响测试使用真实 DI 创建入口。平台重连覆盖 connection generation 与 token 旋转；实例测试覆盖空窗口、字节/命令顺序、输入、尺寸、关闭、本地断线、SSH 续读及 Relaunch；Tasks/Debug 覆盖缺失依赖、任务状态、compound 与 DAP 反向终端请求；分层检查覆盖共享服务不依赖 contribution。

第一批的完整单测编译和生产 Renderer 检查曾受到 Chat/ToolActivity 类型差异阻塞，使用继承 `tsconfig.test.json` 的定向配置编译后，同一 runner 的 9 个文件共 64 项通过。生产打包当时另被生成 decoder 的 501,969 字节 chunk 拦住（门槛 500,000）。这些是第一批的历史验证限制；第二批当前工作树的 Renderer 检查和正常 `pnpm build` 已通过，没有修改 Chat、协议生成器或放宽构建门槛。

第二批从正常单测入口编译全量测试；首次执行的 10 个受影响文件有一项既有 Web host 请求 fixture 未携带生成协议要求的 Thread 身份，decoder 拒绝请求，handler 没有执行。fixture 已同步并使用生成参数类型约束，独立重跑该文件的 27 项全部通过。最终从正常 `test:unit` 入口重跑 10 个受影响文件共 92 项，全部通过；runner 自测 4 项也通过。没有跳过测试或放宽 decoder。

第二批 `pnpm test:browser:integration terminal.integration.spec.ts testing.integration.spec.ts --project=chromium` 完整测试编译、浏览器构建及 20 项 Playwright 场景通过；含中文动作、焦点、隐藏/恢复、首次输入、语音以及真实 contribution 的双作用域装配。`prepare:backend` 成功编译并选中当前产品 runtime，automation TypeScript 编译通过；当前生产产物运行 `smoketest-no-compile test/smoke/areas/windows/terminal.spec.ts --max-failures=1`，3 项真实 Electron + App Server PTY 场景通过：Panel 焦点与隐藏/恢复、实际输入执行、多实例输出隔离、工作目录写盘、关闭及退出后 Relaunch。Electron UI 的启动与恢复标记场景另有 1 项通过。真实 SSH transport 的产品场景尚未运行，租约、token 旋转、读取与连接事件由 Renderer 平台测试覆盖。

`stylelint` 为 0 错误，1 条未修改 Sessions CSS 的设计建议；Playwright 的 NO_COLOR/FORCE_COLOR 环境提示不涉及本批实现。职责文档相对链接、旧模块引用与 `git diff --check` 均通过；仅 Ash 生产文件仍为原有 11 处，本批没有新增或删除生产文件。未修改 Rust 实现或协议，也未运行 Rust 单测；后端编译仅用于当前产品端到端验证。

第三批先运行新回归测试复现故障：窗口容器释放后的创建抛出 `DisposableStore is already disposed`，同一测试的泄漏检查发现 7 个未释放对象。修复后从正常 `test:unit` 入口运行 Terminal、Tasks、Debug、DAP reverse request、Testing 五个文件共 37 项全部通过；Terminal 最终定向复核 18 项全部通过，其中新增的 10 项生命周期测试逐项启用 disposable tracker。覆盖关闭等待、关闭失败、直接 dispose、并发重启、重启失败后重试、两种关闭时点、窗口释放和多根工作区的原始绑定清理；runner 自测 4 项也通过。

第三批最终生产 `pnpm build`、automation TypeScript 编译通过；构建日志未出现 warning/error。Terminal / Testing 的 Chromium Playwright 20 项通过；当前生产构建运行 Electron + App Server PTY 的 `terminal.spec.ts` 3 项通过，覆盖输入执行、隐藏/恢复、输出隔离、工作目录、关闭和退出后 Relaunch。stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有既有颜色环境提示；职责文档链接、目录对应关系和旧生产引用检查通过。未修改 Rust 或平台协议，也没有新建、移动、删除文件；目录文件统计与第二批相同。真实 SSH transport 的产品场景仍未运行。

第四批先运行 5 项新测试，全部复现列表事件遗漏与异步创建/重启覆盖断线状态；修复后的 Terminal 文件 23 项全部通过。Tasks / DAP 新增 4 项从真实服务装配入口执行的失败场景，覆盖 connectionOwned 与 reconnectable，并使用生成的英文/中文 catalog 核对错误。首次消费者检查中这 4 项的首项行为断言通过，但通用 Workbench 测试装配器引入的无关语言注册与资源触发泄漏检查；场景改为只装配所需依赖，保留 tracker，随后 Tasks / DAP 两文件共 10 项全部通过。其余 Debug / Testing 两文件 13 项通过；五个受影响文件累计 46 项通过，runner 自测 4 项也通过。

第四批正常前置检查一度被工作区中已失去源声明的 `workbench.editor.tabStyle.title` 中文词条阻塞；同一 `tsconfig.test.json` 的直接编译通过。当前工作区的词条已恢复一致，最终正常 `test:unit` 前置编译、`localization:check` 和生产 `pnpm build` 均通过。没有修改该 Editor 词条或其 owner。automation 全量检查曾有两处 `explorer-tree.spec.ts` 引用已移除的 `workbenchMode`；最终全量检查及继承同一编译选项的三个受影响场景检查均通过，没有修改 Explorer 测试或相关产品入口。

第四批 Terminal / Testing / Debug 的 Chromium Playwright 22 项通过；当前生产构建的 Electron + App Server Terminal / Tasks / Debug 6 项通过，覆盖真实 PTY 输入、工作目录、实例隔离、关闭、Relaunch、任务发现不执行、显式运行/重跑/取消，以及 DAP 调试交互。构建日志没有 warning/error；stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有颜色环境提示。职责文档链接与 diff 检查通过；Terminal 四个目录的文件统计不变。没有修改 Rust、协议或平台适配器，未运行 Rust 单测，未新建/移动/删除生产文件。真实 SSH transport 的产品场景仍未运行，不能据此声称完整 backend、child process 或 process manager 已对齐。

第五批 Rust 定向检查已在 macOS 完成：utils-pty 的 `just verify` 29 项、exec-server-protocol 的 `just verify` 6 项、App Server protocol 的 `just verify` 88 项单测及 1 项生成物一致性检查通过；exec-server 使用 `--no-default-features --profile ci-test` 的 check、19 项受影响终端测试及 warning gate 通过。App Server 的 check、12 项受影响终端测试及 warning gate 通过。首次原始输入测试误把 macOS `od` 的列间空格当作字节内容，改为断言整行的三个精确十六进制 token；首次 RPC 所有权 fixture 缺少 JSON-RPC 版本、随后重复使用 request ID，修正请求后只重跑失败的 owning test。未修改协议校验规则或削弱所有权断言。全部受影响 Rust 包最终 warning gate 均通过。

第五批正常单测前置编译通过；Web protocol host、SSH adapter、Terminal、DAP reverse request、Tasks 五个文件累计 67 项通过。三个新 Terminal 测试保留 disposable tracker，修正 fixture 的 WorkspaceContextService 归属后，Terminal 文件独立重跑 26 项通过。生成器 `just generate-protocol`、生成 TypeScript strict 检查 `typecheck:protocol`、生产 `pnpm build`、automation 编译及最终 `prepare:backend` 通过，最终正常后端构建无 warning。Chromium Terminal / Testing / Debug 的 23 项 Playwright 场景通过，包含 xterm 实际鼠标报告的高位字节；真实 Electron + App Server Terminal / Tasks / Debug 的 6 项通过。Rust 定向格式检查与 `git diff --check` 通过。

第五批未执行 Windows/Linux 构建和测试，也未运行真实 SSH transport 的产品场景；不能把 macOS 结果当作这些平台的验证。Windows 的显式 signal 不支持、cwd 查询返回 null，已在契约和平台条件测试中记录。解析后输出确认、完整属性集合和跨窗口进程恢复尚未完成；本批没有宣称完整标准 child process/backend/process manager 对齐。

### 固定产品入口

用户确认退出剩余模式注册表及其调用链。已删除 `workbench/common/workbenchMode.ts`、`workbench/common/workbenchModeMigration.ts` 与专属注册表测试；模式目录和服务聚合入口已在前一批退出。产品标题和固定 Sessions 页面由 `code/common/application.ts` 提供，两端入口只向 Workbench 传入标题，Sessions profile 仅描述页面身份与返回路径。用户进一步确认清除存储的产品维度：启动参数、IPC 与正常读写不再使用 `applicationId`；存储 owner 单向迁移旧 Code/Academic 数据，冲突沿用 Code 值并保留原始备份。构建、窗口创建与恢复不选择模式；旧设置与链接不参与启动，旧窗口记录由现有窗口状态 owner 去掉模式字段，真实 Academic 存储迁移保留在存储 owner。

### Code 启动目录与职责收敛

审计 `src/ash/code` 原有 17 个文件：与本机 VS Code 源码同路径的文件为 7 个，Ash 独有文件为 10 个。上游独有的 20 个文件包含 CLI、bootstrap 和测试；Ash 使用 Rust CLI 与 Vite 构建，缺少这些文件不能单独证明能力遗漏，也不应以空实现补齐目录。

下表覆盖原有全部 17 个文件，路径相对 `src/ash/code/`：

| 文件                                                                               | 最终职责与处理                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/application.ts`、`common/codeSessionsProfile.ts`                           | 保留产品常量和唯一的 Sessions profile；构建向 Desktop bootstrap 提供 metadata，Sessions 不反向导入 Code。                                                                                                                                                                                            |
| `electron-main/main.ts`、`electron-main/app.ts`                                    | 保留应用启动与产品装配；Main 的 renderer 检查和加载入口迁移到新 Sessions URL。                                                                                                                                                                                                                       |
| `electron-utility/sharedProcess/sharedProcessMain.ts`                              | 保留 shared-process 启动入口。                                                                                                                                                                                                                                                                       |
| `electron-browser/workbench/workbench.ts`、`workbench.html`                        | 保留 Desktop Workbench 入口。                                                                                                                                                                                                                                                                        |
| `browser/workbench/workbench.ts`、`workbench.html`                                 | 保留 Web Workbench 入口。                                                                                                                                                                                                                                                                            |
| `browser/sessions/sessions-code.ts`、`sessions-code.html`                          | 用户确认后删除两个旧文件；Web 应用入口迁移到 `src/ash/sessions/sessions.web.main.internal.ts`，由 `sessions.web.main.ts` 加载贡献、`browser/web.factory.ts` 提供 `create(container, profile)`。Vite host 生成 `/browser/sessions/sessions.html`；保留 Web Agents 能力，并迁移生产 URL 与测试调用方。 |
| `electron-browser/remote-runtime-install/remoteRuntimeInstall.ts`、`.html`、`.css` | 保留远程运行包安装窗口的产品入口和展示资源，执行与连接仍属于 Remote platform。                                                                                                                                                                                                                       |
| `electron-browser/sessions/sessions-code.ts`、`sessions-code.html`                 | 用户确认后迁移到 `src/ash/sessions/electron-browser/sessions.ts`、`sessions.html`；两个旧文件删除，目标与上游同路径，HTML、构建、Main、automation 与 smoke 消费者同批迁移。                                                                                                                          |
| `test/electron-main/workspaceLaunchArguments.test.ts`                              | 保留启动参数装配的回归测试。                                                                                                                                                                                                                                                                         |

`app.ts` 退出三个执行 owner：Shell 安装算法由现有 `platform/native/electron-main/nativeHostMainService.ts` 承接；本地/SSH Workspace 连接替换与失败回滚由 `platform/workspaces/electron-main/appServerWorkspaceTransition.ts` 承接；待交接队列、一次性确认和 reload/crash/close 中断由 `platform/windows/electron-main/windowsMainService.ts` 随接收窗口释放。共享交接 IPC 契约归 `platform/window/common/window.ts`，Sessions 保留返回 Workbench 的产品动作和草稿消费。

构建仍以 Code 为 Vite root，Workbench URL 保持稳定；现有 `workbenchEntryPlugin` 将 Desktop URL 挂载到 Sessions 的真实 HTML 与 TS 源码，正式打包输出 `sessions/electron-browser/sessions.html`。Web 产品 HTML 改由构建 host 生成，调用 Sessions 自己的公开入口；两个旧 Web 文件和两个旧 Desktop 文件均不再参与生产构建或加载。没有复制上游实现或增加缺乏调用方的层。

本批 Windows 验证：正常单测入口 9 个文件共 80 项通过，runner 自测 5 项通过；Vite 的实际开发服务/打包与配置测试 5 项通过。Desktop Main/Renderer、Web 构建、Renderer/build-tools/automation 类型检查通过；22 个受影响 TS 文件格式检查及定向 diff 检查通过。最初 HTML mount 的全模块 load hook 引入构建性能提示，改为精确输入过滤后重新打包，提示已消失。

初次真实 Playwright 验证中，Electron 草稿交接/占用拒绝、关闭 Workbench 后 Sessions 独立使用与返回重开、两个打包缺页启动场景共 4 项通过；Web 的 Sessions 打开、菜单及返回 Workbench 1 项通过。较长的 Desktop 打开/返回场景完成新路径加载、IPC、重载与窗口重开后，在末尾的尺寸恢复断言失败：预期 1002×702，实际 1003×703，位置一致。该轮没有放宽断言，也没有修改窗口尺寸实现，因此当时未报告该完整场景通过。交接 smoke 的陈旧双草稿期望已按当前 Chat/Code 共用 Session 草稿的行为同步，仍保留初次转移、占用拒绝与源/目标内容断言。Playwright 保留 NO_COLOR/FORCE_COLOR 环境提示；macOS Shell 实际安装与真实 SSH transport 未在此 Windows 环境验证。

初次全仓 stylelint 另有 3 个未知变量错误，位于当时未修改的 `sessions/browser/parts/sidebar/media/sessionsList.css`（`--ash-font-size-label1`、`--ash-font-weight-semi-bold`）和 `sessions/contrib/appTools/browser/media/appToolsHost.css`（`--ash-font-size-heading3`）；入口迁移当时没有 CSS 改动，也没有放宽 lint 规则。

用户随后要求修复这两项问题。真实 Electron 在 Windows 125% 缩放下复现：请求 1002×702 与 1001×701 都返回 1003×703，单次补偿停留在取整区间；继续累积补偿到请求 1000×700 后，返回保存的 1002×702。`CodeWindow` 现在在窗口状态跟踪前最多执行 4 次尺寸读回与累积补偿，达到目标即停止，非正请求立即退出，避免 OS 尺寸约束导致无界重试。现有 Electron 场景增加连续三次关闭/重开，仍逐次严格比较完整矩形；调查用的全局 hook 已移除。

三个 CSS 引用已回到已注册的 `--ash-fontSize-label1`、`--ash-fontWeight-semiBold` 与 `--ash-fontSize-heading3`；没有新增变量或放宽 lint。App Tools 的现有浏览器集成 fixture 接入实际主题绑定，覆盖分组标题与装饰粒子的计算样式、四种主题、键盘焦点、减少动态效果和释放，6 项 Playwright 全部通过。窗口定向单测 76 项与 runner 自测 5 项通过；正常 Desktop 构建、automation 编译通过，真实 Electron 的草稿交接和包含连续三次重开的完整打开/返回场景 2 项通过。stylelint 检查 258 个 CSS 文件，0 错误、0 设计建议。构建曾提示 Vite CSS 插件耗时占比较高，Playwright 仍有颜色环境提示；没有类型或打包错误。

### 输入确认与取消批准入（2026-10-07）

用户输入/听写、运行 Task、DAP runInTerminal → XtermTerminal/voice/TaskService/DebugService → 现有实例输入端口 → TerminalProcessManager → 平台 write/resize RPC → 后端确认或失败 → 调用者 Promise 与 Task/DAP 状态。管理器唯一拥有批次、尺寸合并、操作确认和取消；实例保留连接与进程生命周期。先闭合下层返回值与失败语义，再迁移实例 sendText 与原始键盘端口，不能把现有实例 write 的 stdin 语义计为对齐。

本批准确路径均已在 Ash 存在：terminal/browser 的 terminalProcessManager.ts、terminalInstance.ts、terminal.ts、xterm/xtermTerminal.ts（双方都有；仅输入/尺寸 Promise、关闭/恢复隔离与输入错误处理）；terminalContrib/voice/browser/terminalVoice.ts、contrib/tasks/browser/taskService.ts、contrib/debug/browser/debugService.ts（既有生产消费者；等待或处理确认，发送失败关闭资源并结束运行）；terminal/test/browser/terminalService.test.ts、services/tasks/test/browser/taskService.test.ts、services/debug/test/browser/debugTerminalLauncher.test.ts（行为回归）；test/integration/browser/terminal.integration.ts、terminal.integration.spec.ts、chatInput.integration.ts（消费契约同步及真实输入）；terminal/README.md 与本台账（职责与验证）。不新建/移动/删除文件，不修改 Rust、生成协议或 CSS，其他工作树改动保持原样。

验证目标：文本合并与 UTF-8 拆批保序；文本、二进制与尺寸调用等待真实 RPC 确认；关闭、退出、断线立即取消待发送和进行中的确认；旧连接迟到结果不污染恢复后的状态；Task 启动调用等待发送完成且失败不保留运行项，DAP 不在写入未确认时返回成功；Web/Electron 的键盘、隐藏、退出和 Relaunch 保持通过。

测试消费者追加准入：`src/ash/workbench/contrib/terminal/test/browser/terminalTabsLayout.test.ts` 只同步既有 fake 实例的 Promise 输入签名，不修改布局断言。

### sendText 与原始键盘责任批准入（2026-10-07）

下层确认批已通过 Terminal/Tab 单测与 Task/DAP 的确认、拒绝、取消入口测试，Chromium 29 项通过。下一链路：View.attachToElement → 实例唯一创建并拥有 XtermTerminal → 原始 onData/onBinary → 实例当前进程管理器；Tasks、Debug、voice → 实例 sendText → 换行/执行语义 → 同一输入队列。sendText 使用上游公开签名与注释，并由上游 voice/sendSequence/执行工具调用行为确定文本与控制字符场景；只读取最小 sendText 片段确认 CRLF/LF 归一及 bracketed-paste 行为。Ash 自行实现，原始键盘流不进入文本归一端口。

准确范围为前一批的实例、契约、屏幕、生产消费者与测试 fixture，加 `src/ash/workbench/contrib/terminal/browser/terminalView.ts`（双方都有；局部移交屏幕创建/释放给实例，View 只 attach/detach 与呈现）。公开 xterm、xtermReadyPromise、attachToElement、detachFromElement 都有上游对应且被 View 的真实调用链使用。保留屏幕构造的 Ash 子集与既有布局/CSS；没有新增专属公开端口。移除旧实例 stdin write，消费者同批转 sendText，原始输入绑定迁至实例。实例关闭释放唯一屏幕，View 释放只 detach，后续 View 可重附原屏幕保留输出。

验证新增：sendText 的执行/非执行/CRLF/不重复 Enter、bracketed-paste 只在 child 已启用时包装；键盘 Ctrl+J 字节不归一，原始鼠标不改编码；屏幕重新附着不丢输出、不重复发送输入；窗口与实例释放仍取消未完成加载/输入。

文档追加准入：`docs/ash-desktop-architecture.md` 仅同步 Terminal 章节的屏幕生命周期、输入调用链与确认语义，保护该文档其余已存在改动。

构建失败追加准入：`test/automation/tsconfig.json` 仅将仓库已有 `src/typings/css.d.ts` 纳入 include。实例公开 xterm 类型使 automation 的类型图到达屏幕动态 CSS import；正常 Renderer 构建成功后 automation 的 tsc 报 TS2307，须使用测试/Renderer 已有 CSS 声明，不新增宽泛类型或更改编译规则。

文案追加准入：`localization/zh-CN/workbench.json` 仅补 Task 输入发送失败及清理失败两条消息。Output 是用户可见入口，新的失败日志必须使用现有 localize 并覆盖中文；不改已有其他词条。

本轮输入确认与 sendText 的当前结果：旧实例 stdin write 已移除，所有生产消费者与 fixture 已同步。程序输入使用标准 sendText 签名；原始键盘/鼠标及终端应答由实例直连唯一管理器，不做换行转换。管理器文本拆批、二进制顺序与合并尺寸返回实际 RPC 确认；断线、关闭、退出取消待发送和进行中的等待，重连不被旧 transport 的未完成写入阻塞，旧结果不污染状态。实例拥有唯一屏幕与输入监听，View detach 不销毁输出；重新 attach 不重复绑定。

生命周期复查继续限定在实例 dispose 与上述真实实例测试：TaskRun 会保留已结束实例的 metadata，因此实例关闭后清空 screen 和已解析为屏幕的 readiness promise 引用，再由原 disposable owner 释放资源；避免记录继续保留大段缓冲区。真实实例关闭测试同时断言公开 xterm 已为空，没有新增测试专用生产 helper。

本轮新增 15 项单测回归，正常入口的 11 个文件共 96 项通过，runner 自测 5 项通过；新增中文失败日志与清理失败保留原始错误后，Task 文件 9 项独立重跑通过。Chromium Terminal 31 项通过，新增真实实例的 startup DA 应答、Ctrl+J、程序粘贴和屏幕重新附着；既有鼠标场景随后改为真实 TerminalInstance→进程适配器入口，高位二进制字节用例单独通过。最后补充释放屏幕引用后，25 项实例生命周期单测和真实实例关闭/重新附着场景独立重跑通过。完整 Renderer 与 automation 类型检查、15 个文件的格式检查和职责文档 37 个相对目标通过。Desktop 与完整 Web 正常构建通过；最新产物的 Electron、Web + App Server Terminal/Tasks/Debug 各 6 项通过。后端构建没有 warning，Playwright 保留既有 NO_COLOR/FORCE_COLOR 提示。

首次新增消费者 fixture 漏了 read 结果的 terminalId/commandEventGap，完整测试编译指出后已补齐；screen-only fixture 过早初始化破坏其延迟加载断言，已恢复 fixture 的显式初始化边界，真实实例由生产服务装配测试覆盖。automation 类型图到达动态 CSS import 后出现 TS2307，已纳入仓库现有 CSS 声明，编译及正常产品场景通过；没有绕过类型检查。

该输入批次没有修改 Rust、生成协议、CSS 或新增/移动/删除文件。后端为产品测试完成构建，未运行 Rust 单测；运行验证为 macOS，未验证 Windows/Linux 与真实 SSH transport。服务器输出 ACK/背压、完整 child process/backend、profile/configuration、编辑区终端、真正分组分屏、终端输出无障碍等 terminalContrib 与 Agent 会话接管仍待后续闭合；Find 的后续进展见本文开头。
