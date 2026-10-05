# Terminal API 对齐状态

终端基座的文件归属与 DI 接线已迁移：平台契约位于 `platform/terminal/common/terminal.ts`，实例契约与实例管理位于 `workbench/contrib/terminal/browser/terminal.ts`、`terminalService.ts`。Workbench 与 Sessions 注册所选进程能力，由共同的 Terminal contribution 创建窗口实例服务。SSH 宿主直接选择完整适配器；本地和 SSH 的字节、退出码转换已收回协议边界。完整 VS Code Terminal API、SSH backend 契约及 terminalContrib 尚未完成。

## 职责与调用链

| Owner | 当前职责与状态 |
| --- | --- |
| [platform/terminal](../src/ash/platform/terminal/README.md) | 前端进程契约与 DI 标识；现有 Rust 协议适配、SSH 租约管理继续接入同一后端 |
| [contrib/terminal](../src/ash/workbench/contrib/terminal/README.md) | 唯一实例集合、活动项、输入队列、输出与命令游标；View 和 xterm 拥有屏幕、焦点、主题及布局 |
| [services/terminal](../src/ash/workbench/services/terminal/README.md) | 不再保存 Shell 实例服务；上游 embedder PTY 职责没有当前消费者，未创建占位实现 |
| `contrib/tasks/browser/taskService.ts` | 任务发现、执行与终端命令状态；稳定依赖经构造 DI 注入，注册仍由 Code 模式选择 |
| `contrib/debug/browser/debugService.ts` | Debug 执行编排与 DAP `runInTerminal`；稳定依赖经构造 DI 注入，工厂源仍指向同一个共享 registry |
| `services/tasks/common/taskService.ts` | 共享任务契约只公开 UI `terminalId`；Tasks/Testing View 自行定位当前终端实例，不向共享契约引入 contribution 类型 |
| [terminalContrib](../src/ash/workbench/contrib/terminalContrib/README.md) | 现有 links、voice 的部分能力；本批只迁移实例契约 import，未添加其他贡献 |
| `ash-rs/app-server-protocol` | `terminal/*` 请求、结果、错误与生成 decoder；本批未修改协议 |
| `ash-rs/app-server/src/server/terminal_operations.rs` | 解码、连接身份、目录授权路由与 DTO 转换 |
| `ash-rs/exec-server/src/terminal.rs` | 真实 PTY session、可信 profile、授权工作目录、输出 ring、命令状态与 30 秒重连租约 |
| `ash-rs/utils/pty` | 操作系统 PTY/ConPTY、原始字节、尺寸、进程终止与句柄释放 |

用户创建终端 / Tasks 或 Debug 请求终端 → `ITerminalService` → 唯一 `TerminalService` → 容器注入的 `ITerminalProcessService` → 当前 Rust 协议适配器 → `terminal/create|read|write|writeBinary|resize|close` → PTY。定向测试观察实例创建、字节输出、命令状态、输入、尺寸与关闭；浏览器测试还通过真实 contribution 注册入口验证两个窗口作用域的独立性及缺失依赖。

本地 Electron 与已连接 Web 由 `platform/app-server/browser/webRendererApi.ts` 选择普通适配器。SSH Electron 由 `platform/native/electron-browser/rendererApi.ts` 直接选择完整重连适配器，不再拼接普通服务与租约管理的方法。两个适配器共享一个读取结果转换入口，生成 DTO 的 base64 与 nullable 退出码不进入实例服务。Main 只建立连接并透明转发 frame；token 保存在 Renderer，runtime replacement 通知使旧租约退出。xterm 只拥有屏幕，不成为 PTY 进程 owner；后端 ring 与前端 scrollback 用途不同。

本地断线进入 `disconnected`，连接恢复不自动创建 Shell。SSH `reconnectable` 实例首次续读成功后才从 `reconnecting` 回到 `running`。后端重启、租约过期或换代不能恢复原进程，需 Relaunch；输入不重放。隐藏 Panel 保留实例，进程退出保留屏幕，显式关闭释放后端资源。

## 已批准并退出的旧入口

用户于本批明确回复“同意”下面九个准确路径的退出。路径相对 `app-ts/src/ash`，对应调用方与测试已同批迁移，旧文件不存在、旧模块 import 为零；文件均由 Git 跟踪，可恢复。

| 旧路径 | 当前落位 |
| --- | --- |
| `platform/terminal/common/terminalProcessService.ts` | `platform/terminal/common/terminal.ts` |
| `workbench/services/terminal/common/terminal.ts` | `workbench/contrib/terminal/browser/terminal.ts` |
| `workbench/services/terminal/browser/terminalService.ts` | `workbench/contrib/terminal/browser/terminalService.ts` |
| `workbench/services/terminal/test/browser/terminalService.test.ts` | `workbench/contrib/terminal/test/browser/terminalService.test.ts` |
| `workbench/services/tasks/browser/taskService.ts` | `workbench/contrib/tasks/browser/taskService.ts` |
| `workbench/services/tasks/browser/taskServiceRegistration.ts` | 合入上述实例实现的 Code 服务注册；UI contribution 不注册该服务 |
| `workbench/services/debug/browser/debugService.ts` | `workbench/contrib/debug/browser/debugService.ts` |
| `workbench/services/debug/browser/debugTerminalLauncher.ts` | 合入上述执行实现；`runInTerminal` 测试从 DAP 反向请求入口验证，没有保留测试专用生产导出 |
| `workbench/services/debug/browser/debugServiceRegistration.ts` | 合入上述实例实现的服务注册，由 `debug.contribution.ts` 加载，窗口容器创建和释放实例 |

用户随后要求删除 `code/browser/workbench/codeWorkbenchServices.ts` 并按 VS Code 的职责组织装载：该文件在 VS Code 无同路径对应，只汇总五项注册，没有状态或独立生命周期。其唯一生产调用方已迁移，文件由 Git 跟踪，可恢复。Extension Host、Codebase Symbols 由 `workbench.common.main.ts` 加载；Tasks 由 Web、Desktop 入口选择；Debug、Testing 由各自的功能 contribution 加载服务注册，窗口容器仍按依赖安装。未新增替代汇总文件。

用户进一步确认删除 `code/browser/workbench/modes/code.ts`、`code/browser/workbench/modes/code.contribution.ts`、`code/electron-browser/workbench/modes/code.ts`。三者在 VS Code 无同路径对应，职责已回到现有入口，生产模块引用为零，均可通过 Git 恢复。共同装配回到 `workbench.common.main.ts`，两端 `code/*/workbench/workbench.ts` 在本地化完成后加载 Workbench 和 Sessions 贡献，再直接调用启动函数；单项 `modeLoaders` 已退出。

调用方包括两个 Workbench 创建入口、Code 服务装载、Renderer host/适配器类型、Terminal View/Widget/标题动作/profile 图标、Tasks View、Testing View、voice、对应单测及浏览器 fixtures。共享 Task、Debug、Testing 和 Extension Host 契约没有反向导入 Terminal contribution。标准缺失服务在创建时失败；Debug 宿主明确不提供 DAP 时仍可装配配置服务，启动 Debug 前报告不可用，不创建另一套执行实现。

## 目录调查（2026-10-04，迁移后）

比较 `app-ts/src/ash` 与只读 `../vscode/src/vs` 的生产 `.ts`、`.css`，排除 `test` 目录及 `.test.ts`。只表示文件路径，不表示完整行为完成率。

| 目录 | Ash | VS Code | 双方都有 | 仅 Ash | 仅 VS Code |
| --- | ---: | ---: | ---: | ---: | ---: |
| `platform/terminal` | 4 | 46 | 1 | 3 | 45 |
| `workbench/services/terminal` | 0 | 1 | 0 | 0 | 1 |
| `workbench/contrib/terminal` | 13 | 89 | 6 | 7 | 83 |
| `workbench/contrib/terminalContrib` | 4 | 170 | 3 | 1 | 167 |

新增同路径 owner 承接已有 Ash 调用契约。公开名称与参数仍有差异：平台继续使用进程 ID、分页读取和命令游标；完整事件型 child process/backend、process manager、profile/configuration、分组、编辑区终端和扩展自供 PTY 尚未对齐。本批不把文件迁移或 DI 标识计为完整公开 API 对齐。

## 后续归属与能力

### 第二批准入：Rust 协议边界与 SSH 装配

用户确认“看看有没有对应 vscode 的职责文件，没有就保留”。上游 `platform/terminal/common/terminal.ts` 的 `ITerminalBackend`、`ITerminalChildProcess` 以及 `contrib/terminal/browser/terminalProcessManager.ts` 承担通用 backend、进程事件和实例进程管理；没有 Rust `terminal/*` DTO 转换、bearer token 旋转或无后端 Ash 宿主的同职责文件。三处现有适配器保留这些专属职责，不把它们记为上游 backend 已对齐。

本批行为链：用户创建和输入终端 → 已有 `TerminalService` → `ITerminalProcessService` → 所选本地或 SSH 适配器 → 同一 Renderer protocol client → Rust PTY；返回原始字节、前端退出码和命令状态。SSH 适配器直接实现完整现有进程服务契约，宿主不再手工拼接普通服务与重连服务。协议解码只有一个转换入口；token 与连接代次仍只由 SSH 适配器拥有。实例继续拥有当前读取游标、输入队列和屏幕事件，本批不声称已完成事件型 child process。

| 准确路径（相对 `app-ts`，文档除外） | 文件关系 / 本批动作 | 验证 |
| --- | --- | --- |
| `src/ash/platform/terminal/common/terminal.ts` | 双方都有；输出改为字节，退出码采用前端 `undefined`，不新增协议端口 | 平台到实例的字节与命令顺序 |
| `src/ash/platform/terminal/browser/appServerTerminalProcessService.ts` | 已确认保留；转换生成读取结果，不向消费者暴露 base64 和 nullable 退出码 | 真实 protocol client 与 Web host 创建入口 |
| `src/ash/platform/terminal/browser/reconnectableTerminalProcessService.ts` | 已确认保留；公开参数改用前端契约，完整提供 profile、连接状态与读取转换，保留 token/attach owner | 同一服务对象的读写、连接代次、token 旋转与租约退出 |
| `src/ash/platform/native/electron-browser/rendererApi.ts` | Ash 产品宿主；直接选择 SSH 适配器，退出手工终端对象拼接，不更改连接创建 | Renderer 编译；实际 Electron 入口在生产构建后验证 |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts` | 双方都有；消费已解码字节和前端退出码，保留当前轮询与实例状态 | 既有实例生命周期、命令与输出顺序测试 |
| `src/ash/platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts` | 保留测试路径；同步创建参数并验证完整进程契约，不迁移文件 | 定向单测 |
| `src/ash/platform/app-server/test/browser/webRendererApi.test.ts` | 现有 host 行为测试；新增从真实装配入口观察终端 DTO 转换；既有反向请求 fixture 同步生成契约要求的 Thread 身份 | 定向单测 |
| `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts` | 双方都有；同步前端字节和退出码 fixtures | 定向单测 |
| `test/integration/browser/terminal.integration.ts` | 既有浏览器 fixture；同步前端进程结果，不改界面 | Terminal / Testing Playwright |
| `docs/terminal-api-alignment-status.md`、`src/ash/platform/terminal/README.md`、`src/ash/workbench/contrib/terminal/README.md`、仓库 `docs/ash-desktop-architecture.md`、`docs/remote-development.md` | 更新决定、实际装配边界与验证状态 | 文档链接与 diff 检查 |

`disconnectedTerminalProcessService.ts` 的拒绝操作与现有契约兼容，本批无需改写。没有文件移动或删除；其余八处 UI 载体与旧重连测试路径仍未取得退出决定。

下表仍没有上游同路径，不在本批移动/删除范围。前三处保留专属协议职责；其余载体须沿实际 UI 行为继续核对，不能因为 Rust 已经提供执行能力就长期保留通用职责的错位文件。

| 路径（相对 `app-ts/src/ash`） | 尚待处理 |
| --- | --- |
| `platform/terminal/browser/appServerTerminalProcessService.ts` | 已确认保留 Rust 协议转换职责；不是上游通用 backend 的替代 owner |
| `platform/terminal/browser/reconnectableTerminalProcessService.ts` | 已确认保留 Renderer SSH bearer 租约与连接代次职责 |
| `platform/terminal/browser/disconnectedTerminalProcessService.ts` | 已确认保留无后端 Ash 宿主的明确拒绝行为 |
| `workbench/contrib/terminal/browser/instance/alternateScroll.ts` | 随真实 xterm 滚动入口核对归属 |
| `workbench/contrib/terminal/browser/instance/terminalInstanceWidget.ts` | 对应 `browser/terminalInstance.ts` 与 `browser/xterm/xtermTerminal.ts`；仍需核对公开对象和屏幕生命周期 |
| `workbench/contrib/terminal/browser/instance/terminalTheme.ts` | 随真实主题转换切片处理 |
| `workbench/contrib/terminal/browser/view/media/terminal.css` | 核对本地 DOM、样式 owner 与上游 `browser/media/terminal.css` |
| `workbench/contrib/terminal/browser/view/terminalProfileIcon.ts` | 随 profile 选择入口处理 |
| `workbench/contrib/terminal/browser/view/terminalTabsLayout.ts` | 随分组与布局入口处理 |
| `workbench/contrib/terminal/browser/view/terminalTitleActions.ts` | 随真实命令和菜单入口处理 |
| `workbench/contrib/terminalContrib/voice/browser/terminalVoice.css` | 随语音界面样式职责处理 |

重连测试旧路径 `platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts` 实际测试 Renderer 租约管理；本批没有取得它的准确退出确认，保留原测试路径与覆盖。

Terminal 专属无障碍帮助、输出 Accessible View、verbosity、Find、历史、Quick Fix、Sticky Scroll、Suggest、剪贴板、完整 links provider、分屏和持久化仍未接通。Node PTY Host 的执行职责由 Rust 后端承担，不能创建第二套执行后端；无当前调用方的 embedder、扩展 PTY 或贡献 API 不创建空实现。

标准 `ITerminalChildProcess` 还要求完整属性查询/更新、signal、binary input、数据确认等真实操作。第五批已经补齐创建/attach 的真实 pid 与启动 cwd、当前进程目录和尺寸查询、原始字节输入，以及 Unix 前台进程组中断。当前目录查询在 macOS/Linux 可用；其他平台返回 `null`，不以启动目录代替。Windows 的显式进程中断返回结构化 `TerminalUnsupported`，不注入伪装成信号的输入。通用属性集合、解析后数据确认、进程列表和跨窗口 detach/恢复仍未完成；不能给这些标准方法填空实现。现有 30 秒连接租约也不等同于上游 backend 的持久化。

### 第三批准入：窗口与实例释放

本批闭合已有调用链：Terminal View 的 Close / Relaunch、任务与调试消费者、窗口容器释放 → `ITerminalService` / `ITerminalInstance` → 现有 `terminalService.ts` → 平台进程服务 → PTY 创建与关闭。上游公开实例契约支持释放，生产服务通过实例释放事件移出实例；本地仍由同一个窗口服务拥有实例顺序与活动项，屏幕、输入尺寸和 DOM owner 不变。

当前缺陷是异步创建晚于窗口释放、重启晚于实例关闭、并发重启重复创建，以及已关闭实例仍登记在窗口的释放集合内。独立实现采用按实例 ID 管理的可释放集合；close 立即停止输入和读取，等待后端完成后撤销实例持有；同步 dispose 立即撤销持有并开始关闭。并发 close 共享后端结果，同一重启只允许一次创建，晚到的创建结果必须关闭后才结束操作。测试通过真实 DI 服务入口观察创建、关闭请求、列表、事件与输出，不比较私有成员。

准确写入范围仅为 `app-ts/src/ash/workbench/contrib/terminal/browser/terminalService.ts`、同目录的 `../test/browser/terminalService.test.ts`、`app-ts/src/ash/workbench/contrib/terminal/README.md`、本台账及仓库 `docs/ash-desktop-architecture.md`。没有新增、移动或删除文件，也不修改平台适配器和 Rust 协议。标准 process manager 所需的 pid/cwd、属性、signal、binary input 等下层能力仍未闭合，不创建部分服务外壳。

### 第四批准入：列表事件与创建后的连接状态

本批行为链是已有 Terminal View / voice 订阅 `onDidChangeInstances`，以及 View、Tasks、Debug 发起创建或 Relaunch → `ITerminalService` → `TerminalService` 的列表与连接状态 → 实例列表事件、断线状态、是否读取或发送输入。标准同路径服务与实例宿主公开列表变化事件，上游 View 依赖该事件更新内容；本地只在移动时触发，创建和关闭遗漏。平台连接事件也可能先于异步创建结果到达，当前实例却仍以 running 启动读取。

连接状态仍由窗口 `TerminalService` 唯一拥有。实例开始读取时查询该 owner 的当前状态，创建与重启走同一个检查：本地断线进入 disconnected，不自动恢复；SSH 进入 reconnecting，在 ready 后续读成功才恢复 running。实例不新增连接快照、协议请求或重连 owner。列表变化在列表、标题、活动项和初始状态完成更新后通知，不改变创建事件先于输出订阅的约定。屏幕、DOM、焦点与尺寸 owner 不变。

| 本批准入的准确路径 | 文件关系 / 动作 | 验证 |
| --- | --- | --- |
| `app-ts/src/ash/workbench/contrib/terminal/browser/terminalService.ts` | 双方都有；补齐创建与释放的列表通知；创建和 Relaunch 开始读取前检查唯一连接 owner | DI 服务入口的事件快照、延迟创建与连接变化、无多余读写 |
| `app-ts/src/ash/workbench/contrib/terminal/browser/terminal.ts` | 双方都有；注释说明现有列表事件的触发与状态约定，不新增公开端口 | 契约编译与服务测试 |
| `app-ts/src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts` | 双方都有；在已有生命周期 suite 增加回归测试，复用可控创建与读取边界 | 正常单测入口和 disposable tracker |
| `app-ts/src/ash/workbench/contrib/terminal/README.md`、本台账、`docs/ash-desktop-architecture.md` | 已有职责文档；同步列表通知与晚到创建的连接语义 | 文档链接和 diff 检查 |

重新准入：从列表事件和连接状态继续向真实命令消费者追踪，发现 Tasks / DAP 在创建返回后不检查实例状态便写入命令，可能错报启动并一直等待。这是本切片的必要调用方闭合，因此增加以下准确路径：`app-ts/src/ash/workbench/contrib/tasks/browser/taskService.ts`、`app-ts/src/ash/workbench/contrib/debug/browser/debugService.ts`（双方都有；写入前检查终端 running，失败时关闭自己创建的实例，不发布 TaskRun / DAP success）；既有 `app-ts/src/ash/workbench/services/tasks/test/browser/taskService.test.ts`、`app-ts/src/ash/workbench/services/debug/test/browser/debugTerminalLauncher.test.ts`（保留已确认测试归属；从真实 DI 服务和 DAP reverse request 链路观察未发送命令、未启动任务与关闭）；`app-ts/src/ash/workbench/services/tasks/README.md`、`app-ts/src/ash/workbench/services/debug/README.md`（更新失败语义）；`app-ts/localization/zh-CN/workbench.json`（已有词条 owner；新增错误接入 NLS 并验证中文）。实现不等待恢复后重放命令，用户可以重新运行。

词条更新由现有 `localization:generate` 生成 `app-ts/src/ash/workbench/services/localization/common/localizationCatalogs.ts`，该已有生成文件也列入准确范围，只允许生成器写入。

其余路径只读。本批没有新增、移动、删除文件，不修改 UI 载体、平台适配器和 Rust 协议；完整 child process/backend 的下层能力缺口不变。

### 第五批准入：Rust 进程信息与真实控制

用户授权先补 Rust PTY 基座。当前行为链：Terminal 创建/Relaunch 与 xterm 输入 → 已有 TerminalService / 平台进程服务 → Renderer protocol client → App Server terminal dispatch → exec-server TerminalService → utils-pty。DAP reverse request 是 shell PID 的实际消费者；xterm `onBinary` 是原始输入的实际入口。进程信息由 Rust 返回，前端不从 Workspace 猜测；窗口仍拥有实例、标题和屏幕。

本批独立实现先闭合创建/attach 的实际 PID 与启动目录、进程属性查询（当前目录与尺寸）、有界原始输入和已有中断信号的协议出口。属性尺寸由实际 resize 更新；不增加无效通用属性写入。当前目录只返回实际查询结果，平台不支持时明确报告，不把启动目录当作当前目录。数据确认需要连接 xterm 的解析完成回调；当前字节事件只说明已交给前端，不能提前当作解析确认。跨窗口恢复还需要实例恢复身份、进程列表、屏幕重播与明确 detach/attach；当前生产实例在窗口释放时关闭 PTY、SSH adapter 的 token 也只在内存中。上述消费者与生命周期尚未闭合，本批不增加无调用方的 ACK 或持久化端口，不把 bounded ring 或 30 秒租约称为完整标准能力。

准确写入清单保存在本批基线 `.build/app-ts/terminal-rust-baseline/paths.txt`：Rust 现有 utils-pty process/pty/pipe 与测试、exec-server 终端 DTO/实现/测试、App Server 协议 terminal/registry/error/schema fixtures、terminal dispatch/server dispatch/server tests；前端已有平台 terminal 契约与两个协议适配器、Terminal 契约/实例服务/xterm widget、DAP reverse request 与相关 fixtures；既有职责文档。平台与 Terminal/Debug 服务的同路径 owner 为双方都有；三个协议适配器继续按用户确认保留 Ash 专属职责；widget 本批仅接入原始输入，不移动、删除或重写屏幕 owner。生成目录 `ash-rs/app-server-protocol/schema/` 与 `app-ts/src/ash/platform/app-server/common/generated/` 仅由现有生成器更新。其余路径只读。

定向验证从 Rust 公共服务和 App Server typed dispatch 观察真实 PID、目录变化、resize、字节、信号、错误连接拒绝与关闭；从前端真实装配观察 PID 传播、DAP 回复和文本/二进制输入顺序；通过正常构建、生成物检查以及 Playwright Terminal/Tasks/Debug 产品场景验证没有退化。保留全部既有工作区变化，不新建执行后端或标准 child process 空壳。

| 第五批能力 | 唯一 owner 与当前结果 |
| --- | --- |
| 创建/attach ready | utils-pty 在 child 交给回收任务前捕获 OS PID；exec-server 保存启动时实际使用的规范目录；attach 返回同一身份。前端实例公开 processId/initialCwd，Relaunch 才更新；DAP `runInTerminal` 成功回复携带 `shellProcessId`。 |
| `terminal/processInfo` | exec-server 检查 connection 和目录授权后查询 root shell 的实际 cwd，返回启动信息和最后一次成功应用的字符尺寸；resize/attach 成功后才更新尺寸。macOS/Linux 查询目录，其他平台和已退出进程返回 null。此出口是 Rust 公开进程契约，尚未接入前端完整属性集合。 |
| `terminal/writeBinary` | App Server 检查 base64 编码上限并解码；exec-server 检查 64 KiB 原始字节上限与所有权；走与文本相同的有界 writer channel，不进行 UTF-8 转换或 command-status 文本推断。xterm onBinary 已沿两个 Renderer adapter 接入；实例按同一队列发送所有先前文本批次、二进制、随后文本。 |
| `terminal/sendSignal` | exec-server 校验所有权及授权，再委托 utils-pty。Unix PTY 从 tcgetpgrp 找到前台 job，发送 SIGINT；pipe 保留原进程组语义，hard close 保留原 kill-tree 行为。Windows 显式报告不支持。尚未把这个 Rust 出口扩成无当前调用方的前端通用 signal facade。 |
| 关闭与断线 | 沿用现有 connectionOwned / reconnectable 身份、token 旋转、租约过期及授权撤销清理；不改变 Main/Renderer 的连接拓扑，不重放输入。 |

## 验证

受影响测试使用真实 DI 创建入口。平台重连覆盖 connection generation 与 token 旋转；实例测试覆盖空窗口、字节/命令顺序、输入、尺寸、关闭、本地断线、SSH 续读及 Relaunch；Tasks/Debug 覆盖缺失依赖、任务状态、compound 与 DAP 反向终端请求；分层检查覆盖共享服务不依赖 contribution。

第一批的完整单测编译和生产 Renderer 检查曾受到 Chat/ToolActivity 类型差异阻塞，使用继承 `tsconfig.test.json` 的定向配置编译后，同一 runner 的 9 个文件共 64 项通过。生产打包当时另被生成 decoder 的 501,969 字节 chunk 拦住（门槛 500,000）。这些是第一批的历史验证限制；第二批当前工作树的 Renderer 检查和正常 `pnpm --dir app-ts build` 已通过，没有修改 Chat、协议生成器或放宽构建门槛。

第二批从正常单测入口编译全量测试；首次执行的 10 个受影响文件有一项既有 Web host 请求 fixture 未携带生成协议要求的 Thread 身份，decoder 拒绝请求，handler 没有执行。fixture 已同步并使用生成参数类型约束，独立重跑该文件的 27 项全部通过。最终从正常 `test:unit` 入口重跑 10 个受影响文件共 92 项，全部通过；runner 自测 4 项也通过。没有跳过测试或放宽 decoder。

第二批 `pnpm --dir app-ts test:browser:integration terminal.integration.spec.ts testing.integration.spec.ts --project=chromium` 完整测试编译、浏览器构建及 20 项 Playwright 场景通过；含中文动作、焦点、隐藏/恢复、首次输入、语音以及真实 contribution 的双作用域装配。`prepare:backend` 成功编译并选中当前产品 runtime，automation TypeScript 编译通过；当前生产产物运行 `smoketest-no-compile test/smoke/areas/windows/terminal.spec.ts --max-failures=1`，3 项真实 Electron + App Server PTY 场景通过：Panel 焦点与隐藏/恢复、实际输入执行、多实例输出隔离、工作目录写盘、关闭及退出后 Relaunch。Electron UI 的启动与恢复标记场景另有 1 项通过。真实 SSH transport 的产品场景尚未运行，租约、token 旋转、读取与连接事件由 Renderer 平台测试覆盖。

`stylelint` 为 0 错误，1 条未修改 Sessions CSS 的设计建议；Playwright 的 NO_COLOR/FORCE_COLOR 环境提示不涉及本批实现。职责文档相对链接、旧模块引用与 `git diff --check` 均通过；仅 Ash 生产文件仍为原有 11 处，本批没有新增或删除生产文件。未修改 Rust 实现或协议，也未运行 Rust 单测；后端编译仅用于当前产品端到端验证。

第三批先运行新回归测试复现故障：窗口容器释放后的创建抛出 `DisposableStore is already disposed`，同一测试的泄漏检查发现 7 个未释放对象。修复后从正常 `test:unit` 入口运行 Terminal、Tasks、Debug、DAP reverse request、Testing 五个文件共 37 项全部通过；Terminal 最终定向复核 18 项全部通过，其中新增的 10 项生命周期测试逐项启用 disposable tracker。覆盖关闭等待、关闭失败、直接 dispose、并发重启、重启失败后重试、两种关闭时点、窗口释放和多根工作区的原始绑定清理；runner 自测 4 项也通过。

第三批最终生产 `pnpm --dir app-ts build`、automation TypeScript 编译通过；构建日志未出现 warning/error。Terminal / Testing 的 Chromium Playwright 20 项通过；当前生产构建运行 Electron + App Server PTY 的 `terminal.spec.ts` 3 项通过，覆盖输入执行、隐藏/恢复、输出隔离、工作目录、关闭和退出后 Relaunch。stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有既有颜色环境提示；职责文档链接、目录对应关系和旧生产引用检查通过。未修改 Rust 或平台协议，也没有新建、移动、删除文件；目录文件统计与第二批相同。真实 SSH transport 的产品场景仍未运行。

第四批先运行 5 项新测试，全部复现列表事件遗漏与异步创建/重启覆盖断线状态；修复后的 Terminal 文件 23 项全部通过。Tasks / DAP 新增 4 项从真实服务装配入口执行的失败场景，覆盖 connectionOwned 与 reconnectable，并使用生成的英文/中文 catalog 核对错误。首次消费者检查中这 4 项的首项行为断言通过，但通用 Workbench 测试装配器引入的无关语言注册与资源触发泄漏检查；场景改为只装配所需依赖，保留 tracker，随后 Tasks / DAP 两文件共 10 项全部通过。其余 Debug / Testing 两文件 13 项通过；五个受影响文件累计 46 项通过，runner 自测 4 项也通过。

第四批正常前置检查一度被工作区中已失去源声明的 `workbench.editor.tabStyle.title` 中文词条阻塞；同一 `tsconfig.test.json` 的直接编译通过。当前工作区的词条已恢复一致，最终正常 `test:unit` 前置编译、`localization:check` 和生产 `pnpm --dir app-ts build` 均通过。没有修改该 Editor 词条或其 owner。automation 全量检查曾有两处 `explorer-tree.spec.ts` 引用已移除的 `workbenchMode`；最终全量检查及继承同一编译选项的三个受影响场景检查均通过，没有修改 Explorer 测试或相关产品入口。

第四批 Terminal / Testing / Debug 的 Chromium Playwright 22 项通过；当前生产构建的 Electron + App Server Terminal / Tasks / Debug 6 项通过，覆盖真实 PTY 输入、工作目录、实例隔离、关闭、Relaunch、任务发现不执行、显式运行/重跑/取消，以及 DAP 调试交互。构建日志没有 warning/error；stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有颜色环境提示。职责文档链接与 diff 检查通过；Terminal 四个目录的文件统计不变。没有修改 Rust、协议或平台适配器，未运行 Rust 单测，未新建/移动/删除生产文件。真实 SSH transport 的产品场景仍未运行，不能据此声称完整 backend、child process 或 process manager 已对齐。

第五批 Rust 定向检查已在 macOS 完成：utils-pty 的 `just verify` 29 项、exec-server-protocol 的 `just verify` 6 项、App Server protocol 的 `just verify` 88 项单测及 1 项生成物一致性检查通过；exec-server 使用 `--no-default-features --profile ci-test` 的 check、19 项受影响终端测试及 warning gate 通过。App Server 的 check、12 项受影响终端测试及 warning gate 通过。首次原始输入测试误把 macOS `od` 的列间空格当作字节内容，改为断言整行的三个精确十六进制 token；首次 RPC 所有权 fixture 缺少 JSON-RPC 版本、随后重复使用 request ID，修正请求后只重跑失败的 owning test。未修改协议校验规则或削弱所有权断言。全部受影响 Rust 包最终 warning gate 均通过。

第五批正常单测前置编译通过；Web protocol host、SSH adapter、Terminal、DAP reverse request、Tasks 五个文件累计 67 项通过。三个新 Terminal 测试保留 disposable tracker，修正 fixture 的 WorkspaceContextService 归属后，Terminal 文件独立重跑 26 项通过。生成器 `just generate-protocol`、生成 TypeScript strict 检查 `typecheck:protocol`、生产 `pnpm --dir app-ts build`、automation 编译及最终 `prepare:backend` 通过，最终正常后端构建无 warning。Chromium Terminal / Testing / Debug 的 23 项 Playwright 场景通过，包含 xterm 实际鼠标报告的高位字节；真实 Electron + App Server Terminal / Tasks / Debug 的 6 项通过。Rust 定向格式检查与 `git diff --check` 通过。

第五批未执行 Windows/Linux 构建和测试，也未运行真实 SSH transport 的产品场景；不能把 macOS 结果当作这些平台的验证。Windows 的显式 signal 不支持、cwd 查询返回 null，已在契约和平台条件测试中记录。解析后输出确认、完整属性集合和跨窗口进程恢复尚未完成；本批没有宣称完整标准 child process/backend/process manager 对齐。

### 固定产品入口

用户确认退出剩余模式注册表及其调用链。已删除 `workbench/common/workbenchMode.ts`、`workbench/common/workbenchModeMigration.ts` 与专属注册表测试；模式目录和服务聚合入口已在前一批退出。产品标题和固定 Sessions 页面由 `code/common/application.ts` 提供，两端入口只向 Workbench 传入标题，Sessions profile 仅描述页面身份与返回路径。用户进一步确认清除存储的产品维度：启动参数、IPC 与正常读写不再使用 `applicationId`；存储 owner 单向迁移旧 Code/Academic 数据，冲突沿用 Code 值并保留原始备份。构建、窗口创建与恢复不选择模式；旧设置与链接不参与启动，旧窗口记录由现有窗口状态 owner 去掉模式字段，真实 Academic 存储迁移保留在存储 owner。
