# `ash` Electron Desktop 架构与协作边界

> 负责人：Desktop 开发者
> Rust 对接负责人：crates 开发者
> 当前开发基线：[`ash-app-server-api.md`](ash-app-server-api.md)
> Workbench 模式装配与切换边界：[`workbench-modes.md`](workbench-modes.md)
> Renderer 控件、Workbench Part 与 CSS 状态所有权：[`ui-styling-ownership.md`](ui-styling-ownership.md)
> Pane-like Part 的标题槽位、CompositeBar、命名与生命周期：[`workbench-pane-composite-design.md`](workbench-pane-composite-design.md)
> Renderer Command、MenuId 与 UI Action 组合系统：[`menu-system.md`](menu-system.md)
> Chat 内 Session Inspector 的信息架构与 Plan 演进：[`chat-session-inspector.md`](chat-session-inspector.md)
> 外部 Agent Skill 来源与加载边界：[`skills.md`](skills.md)
> Agent 自定义对象、`.ash` 与外部导入边界：[`agent-customizations.md`](agent-customizations.md)
> 三条公开产品线与宿主边界：[`product-lines.md`](product-lines.md)
> 共享 Rust 进程入口实现：[`ash-app-server`](../crates/app-server/README.md)

## 快速理解

`ash` 是 Ash 的 Electron 产品界面和平台宿主：它负责窗口、交互和系统能力，只投影后端状态，
不复制 Agent、权限或持久化规则。

| 用户或开发者需求          | Desktop 负责                                   | 必须交给后端                       |
| ------------------------- | ---------------------------------------------- | ---------------------------------- |
| 显示对话、工具和批准状态  | Renderer 组件、交互状态和可访问性              | Session、Thread、Turn 的权威状态   |
| 启动桌面应用              | Electron Main、Preload、窗口和 App Server 监督 | Agent 生命周期与恢复               |
| 调用本地产品能力          | 通过类型化 Preload API 和 App Server 客户端    | 领域校验、授权和持久化             |
| 使用浏览器、终端或系统 UI | 平台桥接、用户可见控制和能力请求               | 是否允许执行的最终决定             |
| 增加新产品功能            | 界面拥有呈现，App Server 提供类型化能力        | 禁止在 Renderer 中补一套业务状态机 |
| 断线或后端重启            | 显示连接状态并重新取得快照                     | 不根据旧 UI 状态猜测服务端事实     |

## 1. 目标

`ash` 是 Ash 的 Electron 富客户端，负责窗口、浏览器、系统能力和 UI，不拥有
Session、Thread、Turn、ThreadItem、审批策略或持久化状态机。

Desktop 只能通过版本化 App Server API 使用 crates：

```text
Renderer
  → typed Preload API
  → Electron Main
  → JSON-RPC / JSONL / stdio
  → ash-app-server
```

Desktop 禁止执行 `ash ask ...` 后解析终端输出，也禁止直接链接 `ash-core`。

跨客户端的唯一外部门禁、进程内嵌规则和 Core 旁路禁止项以
[`ash-app-server-api.md#唯一外部门禁`](ash-app-server-api.md#唯一外部门禁) 为准；本文件只补充
Electron 的 Renderer、Preload、Main 和可信 IPC 适配细节。

## 2. Desktop 所有权

Desktop 负责：

- Electron Main、Preload、Renderer；
- App Server 进程启动、初始化、监督、重启和关闭；
- 窗口、菜单、快捷键、命令面板；
- Browser View、Tab、BrowserSession、CDP 和下载；
- Renderer 纯 UI 状态与服务端状态投影；
- 宿主权限、导航策略、origin 策略；
- Desktop 端集成测试。

Desktop 不负责：

- Session、Thread、Turn、ThreadItem、Tool Call 的权威状态；
- Agent 规划和工具循环；
- 是否需要审批的业务策略；
- rollout、SQLite 投影和 Thread writer lease；
- 模型供应商与长期凭据持久化；
- Rust 协议 DTO 的定义。

### 2.1 新功能归属判断

不能因为功能从 UI 进入，就把整项功能都归给 Renderer。设计新功能时，按下面的顺序判断并
拆分职责：

1. 没有 Desktop 时，CLI、TUI 或远程客户端是否仍需要相同语义？如果需要，权威行为和共享
   contract 属于 Rust，并通过 App Server 暴露。
2. 功能是否修改权威状态、访问磁盘或网络、执行进程，或者承担权限与安全校验？如果是，它
   不能只在 Renderer 实现。跨客户端的产品语义归 Rust；Desktop 独有的宿主能力归 Electron
   Main，并通过窄的 typed Preload API 暴露。
3. 功能是否只决定如何显示、如何交互，或维护可丢弃且可重建的视图状态？如果是，它属于
   Renderer。
4. 如果以上答案跨越多层，就把它实现为纵向功能，不把后端语义复制到前端，也不把 UI 状态
   塞进 Rust。

前端可以为了即时反馈重复一部分格式校验，但这不替代权威 owner 在可信边界内重新校验。
Renderer 不能因为已经校验过输入，就获得直接使用 `fs`、网络或任意 IPC/RPC 的权限。

`Files` 按下表拆分所有权；“当前状态”用于区分本阶段实现和后续能力：
Rust primitive 与 model adapter 的实现细节分别见
[`crates/file-system/README.md`](../crates/file-system/README.md) 和
[`crates/file-system-tool/README.md`](../crates/file-system-tool/README.md)。跨平台 Rust
`file:` URI 的 canonical implementation contract 见
[`crates/utils/path-uri/README.md`](../crates/utils/path-uri/README.md)；Project root 的 App Server
输出已接入该契约，Files 的共享 URI 状态仍为“部分具备”。

| 能力                                              | Owner                                        | 当前状态                                                          |
| ------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| 文件树渲染、展开、加载态                          | Renderer                                     | ✅ 单目录 Explorer 与 Seti 文件图标                               |
| 选中、快捷键、文件打开与编辑                      | Renderer                                     | 已接入文件编辑和保存；选择与快捷键由 Explorer 和 Editor 维护      |
| 系统目录选择器                                    | Electron Main / Preload                      | ✅ Empty Explorer 选择单目录并重启绑定 workspace                  |
| 在原生文件管理器中显示                            | Electron Main / Preload                      | 尚未完成                                                          |
| 目录枚举、metadata、文件读写与 workspace 边界校验 | Rust / App Server                            | ✅ metadata、目录枚举、原始字节读写和条件发布                     |
| 重命名、删除                                      | Rust / App Server                            | 尚未完成                                                          |
| workspace 内容搜索执行、取消与结果限额            | Rust / App Server                            | ✅ connection-owned pull job                                      |
| 搜索表单、增量结果分组与高亮                      | Renderer                                     | ✅ Search contrib                                                 |
| 搜索结果打开文件                                  | Files / Editor vertical                      | 尚未完成                                                          |
| Explorer watcher invalidation 与文件树自动刷新    | 文件 provider + Renderer                     | ✅ Workspace 持有 watch；Rust 事件或浏览器观察 / 前台回退驱动刷新 |
| 文件位置 identity                                 | 共享 URI contract；Renderer 只维护其视图投影 | 部分具备：单根 URI 映射                                           |
| 跨重启的领域 `FileId` 或 `DocumentId`             | 拥有该生命周期的 Rust 领域模型               | 尚未完成                                                          |
| Tab、Pane 等纯 UI 实例 ID                         | Renderer                                     | 已有 Workbench 基础设施                                           |

集成终端同样按 UI 与进程 authority 拆分：

| 能力                                                            | Owner                                          | 当前状态                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| 每实例 xterm、Tab、输入、焦点和 panel actions                   | Renderer                                       | ✅ `TerminalViewPane` / `TerminalInstanceWidget`                            |
| 实例列表、active instance、输入 batching 与 resize coalescing   | Renderer `ITerminalService`                    | ✅                                                                          |
| 前端进程契约与 App Server DTO adapter                           | Renderer `platform/terminal`                   | 已接通生成 decoder，适配器统一转换原始字节与退出码；Main 透明转发协议 frame |
| SSH Terminal bearer lease 与 attach                             | Renderer `ReconnectableTerminalProcessService` | 同一后端内 30 秒有界恢复；Main 不保存 token                                 |
| Terminal ID、workspace binding、输出 ring 与 connection cleanup | Rust `exec-server`                             | 已实现 connection-owned 与 reconnectable 生命周期                           |
| PTY/ConPTY spawn、raw bytes、resize 与进程终止                  | `ash-utils-pty`                                | ✅                                                                          |
| 可信 Shell Profile discovery 与 ID 解析                         | Rust / App Server                              | ✅ 不暴露 executable                                                        |
| 宿主终端环境继承                                                | Electron Main + Rust / App Server              | ✅ 双层 allowlist，凭据变量不进入 App Server 或 PTY                         |
| 任意 executable/environment 选择                                | 无                                             | ❌ 当前客户端不能提交                                                       |

Seti 文件图标是 Renderer 主题能力：`platform/theme/browser` 直接拥有主题 JSON、WOFF、文件名解析和 DOM glyph 渲染。App Server 与 Rust 客户端不参与文件图标解析；`ash code` 的当前产品要求也不包含该呈现，因此不存在跨客户端数据契约。

因此，一项完整功能可以具有一条跨层执行路径：

```text
Renderer component
  → UI command
  → typed Preload API
  → Electron Main
  → typed App Server method
  → Rust authority
```

### 2.2 外部 Agent 配置导入（仅限 Desktop）

外部 Agent 配置导入是 Desktop 专属的用户工作流。当前
[`external-agent-migration`](../crates/external-agent-migration/README.md) 已实现 Codex/Claude 已知路径的
检查、canonical containment、symlink 拒绝、确定性 `AgentPathInspection` 和安全诊断，并能读取
有界源格式生成类型化 `MigrationPlan`（settings、MCP、hooks、plugins、memory、agents 等
fragment）；它不读取 skill/command/memory 正文，不应用配置。Desktop 的目录选择、内容预览、
冲突确认、导入进度和撤销入口，以及 App Server 的 apply orchestration 仍是计划设计。TUI 不提供
对应命令、目录选择器或配置界面。

底层解析、来源身份、安全校验和持久化仍由各 Rust 领域 authority 与 App Server typed
contract 拥有，Renderer 不能直接扫描用户主目录或自行解释外部配置。
Ash 原生 Instructions/Skills/Agents、`.ash` 命名空间以及 Import 与 source registration 的区别
由 [`agent-customizations.md`](agent-customizations.md) 统一定义。

| 外部内容                                                    | Desktop 导入行为                                                  | 权威 owner 与安全边界                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Codex 的 `~/.agents/skills` 与 Claude 的 `~/.claude/skills` | 用户明确选择后注册为窄的只读外部来源                              | Config authority 保存来源；Skill manager 校验 containment、格式、摘要和来源身份          |
| 规则或 instruction 文件                                     | 预览并按明确映射导入；没有 canonical contract 时不可导入          | 对应 instruction/config 领域定义优先级，外部内容不能覆盖系统、开发者或产品策略           |
| Agent 定义                                                  | 仅在 Agent definition authority 提供 typed import contract 后开放 | Agent/Multi-Agent authority 校验角色、工具请求和生命周期；Desktop 只呈现映射与诊断       |
| MCP 声明                                                    | 单独展示并要求用户确认，不因导入自动连接或获得凭据                | MCP/config authority 保存声明；连接、网络和凭据继续走各自授权                            |
| 认证文件、密钥、日志和历史记录                              | ❌ 不导入                                                         | Desktop 不读取 `~/.codex/auth.json`，也不把整个 `~/.codex` 或 `~/.claude` 注册为可浏览根 |

导入操作只授予已选择且经过规范化的内容根只读访问，并且必须可查询、禁用和移除。它不是
“以后同类工具都允许”的长期执行批准；导入 Skill 附带的脚本仍通过普通工具、权限与沙箱流程。
具体来源和激活语义由 [`skills.md`](skills.md) 定义，批准语义由
[`permissions.md`](permissions.md) 定义。

该功能即使首版很小，也不能整体放入 `crates/utils`。外部目录识别、格式映射、敏感内容排除和
配置 mutation 都属于产品领域语义；`external-agent-migration` 拥有只读发现与计划模型，Desktop 只
拥有交互，App Server 负责协调，各目标领域负责校验和落库。只有不理解 Codex、Claude、Skill、
MCP 或 Agent definition 的路径规范化、目录 containment 和文件 identity 原语可以复用
`crates/utils/path-utils`、`crates/utils/path-uri` 等基础 crate。

## 3. 目录边界

```text

├── src/
│   ├── main.ts
│   ├── bootstrap.ts
│   └── ash/
│       ├── base/
│       ├── code/
│       ├── editor/
│       ├── platform/
│       ├── sessions/
│       └── workbench/
├── generated/
│   └── app-server/
├── package.json
├── tsconfig.main.json
├── tsconfig.preload.json
└── tsconfig.renderer.json
```

`src/` 根目录属于宿主进程启动侧。`bootstrap.ts` 只配置必须在 Electron `ready`
之前生效的进程级策略，`main.ts` 在 bootstrap 完成后加载 Ash 应用入口。
`src/ash/` 是 Desktop 源码命名空间；其中 `code/electron-main/main.ts` 读取初始 Workbench Mode 并创建
`AshApplication`，`code/electron-main/app.ts` 持有服务、窗口、IPC 与退出生命周期。
Workbench 功能不得反向进入根 bootstrap。

Desktop 主进程创建应用后启动异步启动任务，不在 ESM 顶层等待 Electron `ready`。
`LifecycleMainService` 持有启动任务和取消信号，等待 `app.whenReady()` 后调用应用的初始化。
启动中退出时，先取消后续初始化，再等待正在执行的初始化结束，最后关闭服务；不能通过
抢先释放服务来结束启动。窗口打开前取消必须保留待恢复的窗口会话；窗口开始打开后，先完成
窗口设置，再进入可被窗口否决的正常退出。
`AshApplication.startupAfterReady()` 断言 Ready 前置条件，并在创建业务窗口前
完成 App Server gate。gate 成功后才创建 Workbench；主窗口在 `ready-to-show` 前保持隐藏，
启动过程不创建额外的 splash 窗口。gate 失败时，Retry/Quit 对话框允许 supervisor
回到 stopped 后重新初始化，或按正常退出生命周期关闭应用。

Electron 自动化共用 `test/automation/playwrightElectron.ts` 的进程启动、诊断和退出管理。
恢复场景使用 `quit()` 完成窗口关闭参与者和状态保存，测试结束及启动失败使用 `close()` 销毁窗口。
窗口状态等待按页面对应的窗口 ID 检查实际焦点和全屏状态，独立于 Renderer 就绪；系统报告
桌面锁定时直接报告环境错误，不把它当作窗口切换成功。进程退出后才停止测试 daemon，
进程退出和 daemon 停止分别使用各自的期限。

前端 adapter 和构建工具直接引用 `.build/protocol/typescript/` 的生成快照，不手写 wire DTO，也不生成消费副本。构建入口自动准备这份 Git 忽略的产物，输入和输出未变化时复用缓存；源码匹配的后端包也可恢复完整产物，无匹配缓存或包时需要 Rust 工具链，协议修改可通过 `pnpm protocol:generate` 更新；职责和验证见 [App Server 协议来源](ash-app-server-api.md#12-权威来源)。
生成的 `APP_SERVER_SCHEMA_HASH` 是 bundled Desktop 的 exact-schema 基线；Electron Main
必须比较 initialize response，hash 不一致时不得创建业务窗口或进入 Ready。

开发态与发布态共享 canonical Ash package contract。Python 开发组装器
`build/prepare.py` 按 target、JavaScript runtime 与 build profile 组装不可变 debug
package；Rust package store 在完整文件清单校验通过后发布编号 manifest，并用进程 lease 保护正在运行的 package。它读取 production builder
使用的同一份 runtime lock、校验 archive digest。`appServerDaemonExecutablePath()` 在开发态选择该
package root，在发布态选择 Electron `resourcesPath`，两者都只启动
`<package>/bin/ash-app-server-daemon[.exe]`，其 `connect` 命令负责取得共享服务连接。独立监听使用同包的
`<package>/bin/ash-app-server[.exe]`。两者都由开发与发布组装器
显式构建和校验。因此 ripgrep、sandbox helper 与 built-in Skills 不依赖开发机
`PATH`，缺失或 digest 不匹配会在 package preparation 阶段失败，而不是推迟到 App Server
initialize gate。

## 4. 主进程

Main 必须：

1. 从应用包内确定的绝对路径启动 `ash-app-server-daemon connect`；`ash-app-server-daemon` crate 串行化 start，启动独立 `ash-app-server --managed` 并连接 profile-scoped local authority，以
   connection prelude 用 `dir_root`、`dir_grant_source` 与产品服务身份选择隔离的 App Server 组合，并在交付 stdio 前完成真实 initialize
   readiness probe；显式诊断和恢复使用 `ash-app-server-daemon start|restart|stop|version` 的单行 JSON
   控制面；
2. 使用 `shell: false`，只传递环境变量 allowlist；
3. 在创建业务 UI 前完成 `initialize`；
4. 校验 protocol major、生成协议指纹和必需能力可用性，记录 server build 供诊断；
5. 将 stdout 仅交给 JSONL 协议解析器；
6. 对 stderr 做大小限制和 secret 脱敏；
7. 为启动、初始化、请求和关闭设置 deadline；
8. 采用有上限的指数退避处理崩溃重启；
9. 校验每个 Renderer IPC 的 sender、frame URL、origin 和参数；
10. 持有 Browser Target 与 Resource 的宿主侧所有权。

Main 不把 `ipcRenderer`、`fs`、`child_process`、`webContents` 或任意 JSON-RPC method
直接暴露给 Renderer。

本地 daemon 的 TypeScript 对接位于 `platform/app-server-daemon`：创建入口负责包路径、摘要、
环境变量与 `connect` / `connect-selected` 选择，开发重载器负责明确重启后台。
`code/electron-main/app.ts` 只装配启动器、窗口连接和重载器；SSH 启动与远程包定位仍由
`platform/remote` 拥有。`platform/app-server` 保留 renderer 协议客户端和 Main 连接转发。
窗口关闭只终止连接程序，实际共享后台的生命周期由 Rust daemon 管理。

当前 `ChildProcessJsonlTransport` 将子进程 stream lifecycle 与 JSON-RPC pairing 分开。它在积累无限 buffer 前按原始 byte 拒绝超过 1 MiB 的 frame，只接受严格 LF 和有效 UTF-8；outbound write 同时等待 callback 与 drain，并限制 pending write 数。child/stdio 任一错误都会关闭 transport；stderr 只保留 64 KiB ring，诊断读取时脱敏 credential。`close()` 异步、幂等，并在 graceful deadline 后强制终止。`pnpm run test:main` 覆盖分片 UTF-8、超限 frame、非法 framing、backpressure、stderr 和 close。

`JsonRpcPeer` 在 transport 之上负责双向 JSON-RPC envelope、request ID pairing、remote
error、timeout/abort、late/unknown/duplicate response、入站 handler cancellation、pending
上限和 listener 隔离。协议生成器输出 `APP_SERVER_METHODS` 与
`APP_SERVER_NOTIFICATIONS` typed definitions，Electron Main 通过 `AppServerClient` 使用；
产品代码不能传任意 method string 或手写 result 泛型。

正式包的 `ash-package.json` 绑定 first-party Server Host/daemon SHA-256、target、版本、protocol
metadata 和由这些字段确定性生成的 `buildId`。该清单随产品包进入签名边界；Desktop 在 spawn 本地
Server Host 前复验清单形状和二进制 digest，开发热重载不把可变产物伪装成签名发布物。

`AppServerSession` 独占一个 peer，只有 initialize response 同时通过 server identity、protocol major
和生成协议指纹、必需能力可用性检查后才进入 Ready，并保存 server info/capabilities。
前后端由同一次构建交付；schema hash 不同会拒绝连接，避免旧后端静默忽略新字段。

`AppServerSession` 是 connection lifecycle。它不是产品 `Session`，不得保存产品 Session
membership、lineage 或权威业务状态；Renderer 只维护可以丢弃并重新读取的 `ISession / IChat`
前端对象。
`AppServerSupervisor` 只接受绝对 executable、显式 child environment allowlist，并管理
Stopped/Starting/Initializing/Ready/Stopping/Crashed/Restarting 状态、initialize deadline、
有界指数退避和 crash budget。崩溃会拒绝旧 Session 的 pending request；新 Session 不自动
重放结果未知的副作用操作。

结构化 IPC router 集中注册有限 channel，并在调用 validator/handler 前同时验证目标
webContents、main frame identity 和确切入口 URL。各能力在自己的
`platform/<capability>/electron-main/*IpcRoutes.ts` 中拥有 channel、exact-shape validator 与
App Server method 映射；`platform/app-server/electron-main` 只拥有连接状态、通用 Resource
route、Supervisor、Session 与 JSON-RPC transport。通用可信 router 和 exact-shape validation
primitive 位于 `platform/ipc/electron-main`，不反向依赖任何产品能力。`code/electron-main/app.ts`
是这些 route factory 的 composition root。unknown field、错误 enum、空 ID 或畸形 Turn input均
不会到达 App Server。协议生成 runtime validator 后，应替换这些同形显式 validator 的来源而
不改变 router 边界。

### 4.1 Workspace 身份与窗口策略

Electron 主进程由 `code/electron-main/main.ts` 编排启动，`app.ts` 装配产品服务并管理应用事件。
进程参数归 `platform/environment/node/argvHelper.ts`，系统默认数据目录归同目录的
`userDataPath.ts`，外部窗口启动请求归 `platform/launch/electron-main/launchMainService.ts`。
`WindowsMainService` 统一拥有窗口身份、活动顺序和工作区复用；`app.ts` 只保留窗口对应的
App Server、模式和产品资源。Windows 最近项目跳转列表由 `WorkspacesHistoryMainService` 更新。

当前实现明确区分两个所有权边界：

- `platform/workspace`（单数）定义一个窗口当前工作区的模型、结构化标识、
  `WorkbenchState` 和 `IWorkspaceContextService`；
- `platform/workspaces`（复数）负责解析、识别和管理工作区。当前已实现启动目标解析，
  单根 Folder 的运行时 authority 切换，以及已解析 Remote Folder 的同 SSH host 重连；最近项目和
  Untitled Workspace 尚未实现。

Desktop 在创建窗口前由 `WorkspacesMainService.resolveStartupWorkspace()` 解析一次启动参数，
并产生不可变的 `IAnyWorkspaceIdentifier`：

- 无项目参数为 `Empty`；
- 目录参数或 `--folder <path>` 为 `Folder`；
- `.ash-workspace` 文件或 `--workspace <path>` 为 `Workspace`。

`resolveWorkspaceOpenTarget()` 只在 Node/Electron Main 中规范化路径、判断文件类型并为
Folder/Workspace 产生稳定 ID。标识采用 `{ id }`、`{ id, uri }` 或
`{ id, configPath }` 的结构，不存储重复的 `WorkbenchState` 判别字段。窗口状态策略从标识
推导状态：按用户明确指定的 Ash 产品要求，`EMPTY`、`FOLDER`、`WORKSPACE` 与 Agents
新窗口统一使用 `1200 × 800` 默认尺寸，单位为逻辑像素。这是对本地 VS Code 默认值的明确
调整：VS Code 的空窗口为 `1200 × 800`，工作区和 Agents 窗口为 `1440 × 900`。
`WindowsMainService` 统一记录 Workbench 与 Agents 的活动顺序，
为两类新窗口提供最后活动窗口、最后关闭窗口、已有窗口位置和共享 profile 设置。
`WindowsStateHandler.getNewWindowState()` 先恢复具体 Workspace/Folder/空窗口备份的已存位置；
只有没有活动窗口时，才使用最后关闭窗口或共享 `windowsState.lastActiveWindow` 的位置。
其余新窗口遵循 `window.newWindowDimensions`：`default` 按屏幕边界居中，
`inherit` 继承最后活动窗口的普通尺寸和位置，`offset` 继承并按 30 个逻辑像素错开，
`maximized` 和 `fullscreen` 指定启动模式。默认窗口也避开与已有窗口相同的横坐标或纵坐标。
全屏继承只继承模式，普通尺寸仍取新窗口所属种类的默认值。多屏时 macOS 选择鼠标所在屏幕，
Windows/Linux 选择最后活动窗口当前所在屏幕；最终普通矩形限制在屏幕可用区域内。
大屏不会放大默认窗口；可用区域不足时，宽高分别缩小到可用区域上限，扣除任务栏等占用。
系统缩放通过屏幕的逻辑可用区域影响这个上限，不重复乘除默认尺寸。单屏下这与 VS Code
的尺寸限制规则一致。多屏边缘处理按用户要求保留 Ash 的规则：新窗口和带有 `workArea`
记录的窗口在恢复、调整屏幕位置时，把完整窗口限制在目标可用区域内，保证标题栏、窗口按钮
和内容可见。这是有意保留的产品差异；本地 VS Code 的多屏校验只要求普通窗口与目标屏幕
相交，允许部分窗口超出边缘。

具体窗口位置由 Workbench 的 `windowsState.openedWindows` 与 Agents 的
`sessionsWindowState.openedWindows` 分别保存；每个记录用 `workspaceIdentifier`、`folder`、
`backupPath` 或 `emptyWorkspaceId` 绑定 UI state。两类窗口共同更新
`windowsState.lastActiveWindow`；退出时按活动顺序保存，关闭事件不能覆盖这份退出记录。
`window.newWindowDimensions` 与 `window.restoreFullscreen` 均为应用级设置。
已保存的全屏模式仅在 `window.restoreFullscreen` 开启或应用更新重启时恢复。
旧的 `windowState` 与 `windowState.empty` 键不会迁移或读取。

窗口 UI state 同时保存普通窗口矩形、显示器 ID 和该显示器的逻辑可用区域 `workArea`。
分辨率、系统缩放或显示器位置变化时保留用户保存的逻辑宽高，并按可用区域原点的移动调整位置；
仅在目标可用区域放不下窗口时缩小窗口。屏幕本身小于最小尺寸时，以可用区域为限。
显示器移除时选择距原窗口中心最近的可用显示器。
`WindowsStateHandler` 统一处理重启恢复与运行中的显示器变化，并在窗口资源释放时移除监听。
跨显示器拖动结束后按目标可用区域调整尺寸，保留拖放位置的中心，拖动过程中不主动调整大小。
最大化和全屏期间只更新普通窗口矩形，退出对应模式后应用；界面字号仍由系统 DPI 和
`window.zoomLevel` 决定。没有保存过 `workArea` 的窗口在下次保存时记录当前显示器信息。

窗口种类和工作区另存于 `windowSession` 状态，不与窗口位置混用。`WindowSessionStateHandler`
在窗口打开、获得焦点、关闭和退出时保存清单；`WindowsMainService` 按设置筛选需要恢复的窗口；
`app.ts` 只负责创建对应的 Workbench 或 Agents 窗口。正常启动默认恢复上次仍打开的全部窗口，并把
最后使用的窗口带到前面。`window.restoreWindows` 是共享 profile 中的启动偏好，支持
`preserve`、`all`（默认）、`folders`、`one` 和 `none`。直接指定 Folder 或 Workspace 时，
除 `preserve` 外以本次目标为准。手动关闭的窗口从清单移除；关闭最后一个窗口导致应用退出时，
保留该窗口作为下次启动目标。Agents 窗口可以单独恢复，不要求同时打开 Workbench。
Workbench 与 Agents 使用固定产品入口，窗口恢复只依赖窗口种类与工作区；旧记录中的模式字段在读取时移除。
`LifecycleMainService` 在更新安装时记录目标版本；首次启动该版本时，无论 `window.restoreWindows` 当前选项如何，
均恢复上次打开的全部窗口，然后清除更新标记。普通启动继续遵循用户设置。
Workbench 的 `workbench.editor.restoreEditors` 默认开启。`WorkbenchLayout` 判断是否恢复编辑器，
`EditorParts` 将主编辑器与独立编辑器窗口的标签页、分组、激活项和视图状态保存在各自工作区的状态中，并在窗口重新打开时恢复。
关闭该选项只跳过常规编辑器状态；未保存内容仍从工作副本备份恢复。

连接共享 Rust 后端的 Electron 编辑器把未保存内容写入 profile SQLite，使用稳定的工作区 ID
和完整资源 URI。Renderer 负责序列化、恢复编辑器及旧 IndexedDB 内容迁移，Rust 负责原子保存、
版本冲突和备份目录。启动时 Renderer 查询待恢复的工作区，Main 只负责打开窗口，因此
`window.restoreWindows: none` 仍会恢复含未保存内容的工作区。保存或放弃修改按已观察的版本删除备份，
恢复失败不消费正文。浏览器和无后端 UI 模式仍使用 IndexedDB。
共享协议及其他客户端的接入状态见 [备份约定](../crates/app-server-protocol/README.md#未保存内容备份)。

Renderer 通过受信 IPC route 和 `workspace.getWorkspace()` 读取该身份，并在
`parseWorkspaceIdentifier()` 校验和恢复 URI。`WorkspaceContextService` 根据该标识构造当前
`IWorkspace`，并从 `configuration` 或单根 `folders` 推导 `WorkbenchState`。Workbench
contribution 不得通过该服务直接访问文件系统。单根 Folder 启动时，Electron Main 将该根
配置给 App Server；Renderer 的 `BrowserFileService` 只把 workspace URI 映射成根相对路径，
目录枚举、metadata、有界原子写入、filesystem invalidation 与最终边界授权由 Rust / App Server
完成。文件 provider 的 `readFile()` 返回原始字节和不透明 revision；公共 `FileService` 按 scheme
路由读写，并为文本调用执行保留 BOM 的严格 UTF-8 解码和编码。provider 的 `writeFile()` 接收
原始字节及 create、overwrite、expectedRevision；文本保存允许创建或覆盖，二进制导入要求目标
不存在。App Server 的字节写入使用显式 mode，并由 Rust 在发布锁内完成版本校验。
`FileService` 按 provider capability 阻止只读修改，能力变化使 metadata 失效。`TextFileService` 继续负责编辑器的
文本格式、BOM 与保存策略。App Server 通过连接所属的 resource 分块传输文件字节，Renderer
在读取成功或失败后释放该 resource。文件读取保持既有的 50 MiB 上限；其他 resource 默认
16 MiB，所有 resource 仍共享每连接 64 MiB 和 128 个句柄的配额。

`FileService.watch()` 对相同 URI 和规范化选项共享 provider 句柄，最后一个调用方释放、provider
注销或服务销毁时关闭句柄；`WorkspaceWatcher` 随当前目录集合更新注册。Rust 继续拥有授权目录
的 OS 监听和 `fs/changed`，Renderer 的 watch 不重复建立系统监听。Electron profile 目录的
OS 监听由 Main 的 `DiskFileSystemProvider` 持有，随窗口关闭释放；用户数据 provider 映射其事件。
IndexedDB 通过跨窗口消息提供变化通知。浏览器选取的文件夹由 `HTMLFileSystemProvider` 检测并接入
`FileSystemObserver`，把变化和移动前后的路径转成 FileService 事件。观察失效或页面恢复焦点、重新可见时，
通过失效通知重读打开且未修改的文件和已加载、展开的 Explorer 目录；不支持观察 API 时同样使用这条前台回退路径，
后台不轮询，也不自动请求权限。最后一个 watch 释放时移除页面监听，取消或卸载 provider 时断开观察器；
未保存内容继续由文本模型保护，保存时校验内容 revision。

Workspace 内容搜索通过独立的
`grep/search/start|read|cancel` contract 接入；其 ownership 与限制见
[`search.md`](search.md)。Desktop 已接入保存命令、dirty state 和 watcher 消费；
多根 Workspace 内容访问按目录身份路由。

首次进入未授权目录时，Electron Renderer 在窗口内显示目录权限选择，启动阶段也先完成选择再
建立 Workbench。Electron Main 提供按当前语言翻译的文案并等待选择；App Server 保存目录能力。
前端 `IWorkspaceTrustRequestService` 负责取得选择，`IWorkspaceTrustManagementService` 按当前
Workspace 各目录的实际权限提供界面状态和变化通知；它每次从 App Server 读取权限，不保存独立的
“已信任”配置。只有全部目录具备开发权限时，界面才视为已信任。只读授权显示“只读文件夹”；
允许部分开发操作的目录显示“受限工作区”。文件读写和命令执行仍由 App Server 按具体权限检查，
编辑器自身的只读状态只针对有文件工作副本的编辑器。

编辑器窗口的 Workspace 不归 Session catalog 所有。前端 `ISession.workspace` 只描述该 Session
使用的 Environment、`cwd` 和目录；它可以帮助界面显示位置或请求切换运行环境，但不能改变窗口
Workspace，也不能授予目录权限。选择另一个 Environment 中的 Session 时，由宿主建立对应
App Server 连接并重新读取 Session/Thread；Renderer 不直接读写 SQLite，也不能在旧连接上执行
目标 Session。

当前限制：

- 运行时已支持单根 Folder authority 切换；关闭项目、多根 Workspace 内容切换和最近项目流程尚未实现；
- `.ash-workspace` 当前只作为窗口身份，尚未定义或解析其内容；
- 普通单文件参数仍属于空窗口，文件编辑器尚未实现；
- Explorer 按需读取目录并消费 `fs/changed` 自动刷新；文件编辑器通过共享文本服务保存。
- 最近项目和 workspace 配置管理尚未实现；
- 空窗口的未保存内容已由共享 Rust 备份服务保存和恢复；恢复身份使用工作区 ID，
  不依赖磁盘 `backupPath`；
- 启动目标无效时记录错误并安全回退到空窗口。

## 5. 沙箱桥接与 Renderer API

Electron sandbox 边界分为两层。`ISandboxGlobals` 是 preload 唯一暴露到主世界的底层桥接：
它包含只读进程元数据、受 `ash:` 频道前缀约束的 `send` / `invoke` / `on`，以及按 nonce 交付和取消等待的 MessagePort 桥接。preload 必须保持
自包含，运行时除 `electron` 外不得加载任何模块，也不得把 Electron event 对象传给 Renderer。
构建后的 preload 由 `build/desktop/host.ts` 检查这一约束。

`createElectronRendererApi()` 组装领域化、强类型、可枚举的 `AshElectronRendererApi`。Electron 系统能力经平台适配器读取；跨宿主领域能力由其父接口
`IRendererHost` 定义，Electron 专属能力保持以下精确形状：

```ts
interface AshElectronRendererApi extends IRendererHost {
  readonly environment: IRuntimeEnvironment;
  readonly browserView: IBrowserViewService;
  readonly configuration: IConfigurationApi;
  readonly nativeContextMenu: INativeContextMenuApi;
  readonly nativeMenubar: INativeMenubarApi;
  readonly workspace: IWorkspaceContextApi;
}
```

Workbench composition root 是聚合 `IRendererHost` 的唯一产品消费者：它把每个 transport
capability 注入对应的领域 Service。Contribution 只能依赖 `IChatService`、`IGitService`、
`IContentSearchService`、`ITerminalService` 等前端契约和前端自有领域类型，不能取得整个
Renderer Host，也不能导入生成 DTO。UI 与领域代码不能直接导入 sandbox globals；该桥接只由 IPC 等平台传输适配器消费。禁止提供绕过领域 capability 的通用 App Server 调用：

```ts
execute(method: string, params?: unknown): Promise<unknown>
```

### 5.1 平台服务与 Workbench 装配

平台目录按“契约、运行时适配、Workbench 装配”分层，不按 VS Code 的目录名称机械对齐。当前稳定边界如下：

| 能力              | 前端契约 owner                         | 运行时或传输 owner                                                                                                      | Workbench 装配责任                                                                                                                                                             |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 配置              | `configurationService.ts`              | `configurationIpc.ts` 与 Electron adapters                                                                              | Workbench 创建窗口级 service                                                                                                                                                   |
| 生命周期          | `ILifecycleService`                    | Web 使用 `BrowserLifecycleService`；Electron Renderer 使用 `ElectronLifecycleService`，Main 使用 `LifecycleMainService` | Workbench 注册 backup、storage 等 joiner；Desktop 与 Agents 的入口加入日志 flush                                                                                               |
| 日志              | `ILogService` / `ILogSink`             | Console、System Output 与 Desktop 文件 sinks；Main `LoggerService` 拥有文件                                             | composition root 选择运行时 logger；窗口身份由已认证 IPC 提供                                                                                                                  |
| 外部 URL 与剪贴板 | `IOpenerService` / `IClipboardService` | Browser、Electron Main adapters                                                                                         | Connector host 注入适配器                                                                                                                                                      |
| 编辑器打开        | `IEditorService`                       | `BrowserEditorService`                                                                                                  | Workbench 把具体 `EditorPart` 封装在 service 后面                                                                                                                              |
| 窗口宿主操作      | `IWorkbenchHostService`                | `WorkbenchWindow`                                                                                                       | Workbench 注册当前窗口实现                                                                                                                                                     |
| Code Mode 能力    | 各领域 `I*Service`                     | 对应 browser service implementation                                                                                     | `workbench.common.main.ts` 加载共同贡献与 Extension Host、Codebase Symbols；Web、Desktop 入口选择 Tasks 实现；Debug、Testing contribution 加载各自服务注册，窗口容器按依赖安装 |

`common/*Service.ts` 只能包含调用方使用的领域类型和 service identifier。IPC channel、生成 DTO、
context bridge API 与 host validation 留在 `*Ipc.ts` 或具体运行时实现中。功能 contribution 可以加载
所属 service 注册，但实例创建与释放由窗口容器统一负责。`workbenchServiceContributions.ts` 只描述 service、依赖与安装函数，composition root
负责提供原始 capability，并在缺失依赖或依赖环时启动失败。

Electron 主进程连接由 `IMainProcessService` 提供 channel。Workbench 和 Sessions 在创建领域 API 前，先取得可信路由确认的窗口 ID，随后创建同步可用的 Electron IPC client。`base/parts/ipc` 使用 `ash:hello`、`ash:message` 和 `ash:disconnect` 建立每份 Renderer 文档的连接，不再为 Main 服务申请 MessagePort。Main 在加载窗口入口前注册允许的 webContents、入口 URL 和窗口上下文；每条消息都验证发送者、main frame identity 和确切入口 URL，连接上下文不接受 Renderer 输入。窗口重载或关闭会取消该连接的请求并释放订阅，其他窗口的连接继续使用。

`base/parts/ipc` 拥有 Electron 消息传输、JSON 消息帧、调用取消和事件订阅生命周期；`platform/ipc` 提供 Main 服务契约与薄适配。Main 在应用启动时为系统颜色、配置、系统与用户键盘布局、更新和最近项目历史各注册一次共享 channel；日志、存储、URI 分发等既有 channel 也复用该连接。领域适配器校验命令、事件和参数，服务事件直接成为 channel 订阅，应用不再逐窗口转发这些共享服务的变化。窗口启动与窗口专属操作仍通过有限可信路由提供，App Server 业务调用继续由 `AppServerProtocolClient` 和 Rust 协议负责，其 MessagePort transport 保留。

Ash 当前没有 VS Code `externalServices` 中的 telemetry machine ID / Marketplace header 组合语义，
也没有构建时替换的 Copilot license endpoint，因此不建立同名空目录。Marketplace 请求继续由
`platform/marketplace` 拥有；不可把任意网络调用、外部 URL 或产品常量汇总进一个模糊的
`externalServices` 或 `endpoint` 包。运行时事实保留在 `base/common/environment.ts`，固定 Desktop
应用标题和 Sessions 页面名保留在 `code/common/application.ts`，由产品入口提供。存储以用户数据根、作用域及 profile/workspace id 隔离，不再携带产品身份；
跨客户端本地资料根在 `platform/profile`；只有出现需要注入、替换或拥有生命周期的真实
调用方时，才把这些不可变策略升级成 service。

## 6. Renderer

Renderer 负责 Command Registry、路由、组件、输入框、虚拟列表和状态投影。

```text
button / menu / shortcut
  → UI Command
  → typed renderer API
  → sandbox IPC bridge
  → trusted IPC route
  → domain RPC
```

Renderer 不复制 Rust 状态机。Session 没有 sequence；`session/changed` 到达后重新读取 Session。
只有 Thread 拥有 durable `sequence` 与 `streamCursor`；出现空洞时停止合并该 Thread，并通过
`session/thread/subscribe` 取得权威 snapshot + gap。

### 6.1 Editor 宿主

`EditorParts` 是跨浏览器窗口的协调面，主窗口和每个辅助窗口各自拥有一个 `EditorPart`；每个 `EditorPart` 使用二维 `SerializableGrid` 管理稳定 ID 的 `EditorGroup`，每个 group 管理 tabs、preview/pinned、pane 生命周期、活动状态和 JSON-safe view state。`EditorInput` 表示待打开资源，`IEditorPane` 定义编辑器真正共享的创建、输入、取消、布局、可见性、聚焦与释放语义，`EditorPaneRegistry` 负责默认匹配、候选枚举和显式 `Reopen With` 选择。具体产品装配规则由 [`workbench-modes.md`](workbench-modes.md) 负责。

打开新输入时，旧 pane 保持可见，直到新 pane 的异步 `setInput()` 成功；首次打开失败时，group 提供可重试、可关闭的错误 pane，严格文本检测发现二进制或非 UTF-8 内容时还可切换到只读 Binary Editor。被后续打开或普通内容替代时，宿主中止 `AbortSignal` 并释放候选 pane。dirty close 由 Workbench 统一执行 Save / Don't Save / Cancel，工作区切换与跨窗口关闭先完成全局预检再变更状态。

Workbench editor 宿主当前拥有多组二维拆分、跨组与跨窗口移动、MRU、最近关闭、Quick Pick、working set/Grid 持久化、tabs 三种显示模式、资源路径 breadcrumbs、状态栏投影、自动保存、外改冲突标记和辅助窗口关闭 veto。文本 transaction、undo、selection、viewport、语言能力和模型引用仍由 `src/ash/editor` 与具体 editor contribution 拥有，不能反向并入 Workbench。

### 6.2 iframe Webview

统一容器位于 `workbench/contrib/webview/browser`。`IWebviewService` 通过 Workbench
公共入口注册，负责创建 `WebviewElement`、登记存活实例和发布当前 Webview 焦点变化。
创建者负责挂载和释放容器；服务只持有登记及事件订阅，不接管调用方的生命周期。
Markdown Preview、自定义编辑器和发布说明页都通过注入的服务创建容器。它不负责完整
网页浏览、导航历史、Cookie、CDP 或 Agent Browser Target；后者属于第 7 节的
`WebContentsView` 能力。

`WebviewElement` 为每个实例创建独立来源的 iframe。桌面端使用 `ash-webview://<uuid>`，
本机 Web 使用当前端口上的 `<uuid>.localhost`。宿主通过 `IWorkbenchEnvironmentService`
提供地址；部署到其他域名时，Web embedder 必须提供 `webviewEndpoint`，其 `{{uuid}}`
必须区分不同来源，且来源使用 HTTPS。该来源负责提供构建生成的 Webview HTML 和 worker 资源。
两个端共享以下边界：

```text
sandbox: allow-scripts allow-same-origin，仅共享该实例的独立来源
无 Workbench DOM 访问 / forms / popups / downloads / top-navigation
引导页注册资源 worker，文档由独立的内容 iframe 承载
内容 CSP 只允许映射资源及 data/blob 图片，脚本由 allowScripts 控制
无外部 network / nested frame / object / form action
无 Electron preload、Ash renderer API 或 Node capability
```

内容通过 `acquireAshWebviewApi().postMessage()` 发送 structured-clone 数据。宿主只接收
`event.source === iframe.contentWindow`、实例来源和当前文档 channel 都匹配的 envelope。
宿主向引导页发送消息时指定实例来源，引导页再向内容页发送原始消息；内容检查
`event.source === parent`。

宿主 `postMessage()` 返回 `Promise<boolean>`，在页面完成加载并注册消息处理程序前排队，
实际发送后返回 `true`；替换文档或释放时，未发送的消息返回 `false`。每次文档替换生成
独立 channel，旧文档的就绪、焦点和内容消息不会作用于新文档。相同 HTML 不重新加载，
保留输入等页面状态。容器只能挂载一次，因为移动 iframe 会重新加载内容。

`asWebviewUri()` 保留文件路径层级，将资源映射到仅由 worker 回应的资源来源。
图片、CSS、字体及模块相对导入都经过 `WebviewElement`、`localResourceRoots` 检查和已有
`IFileService`；Webview 的目录许可只收窄文件服务的授权，不增加磁盘访问权。
桌面协议和本机 Web HTTP 入口只向实例来源提供引导 HTML 和 worker，不负责读取工作区文件；
本机 Web 的认证、工作区与 App Server 接口仍只接受原 Workbench host。
引导页持有待处理请求，文档替换或关闭时结束这些请求；worker 不保留页面状态，空闲回收后
可以重新向存活引导页请求资源。文件服务已发起的读取完成后也不会发回旧文档。

当前实现拥有 DOM sandbox、HTML replacement、focus、双向 message、实例登记与释放、
独立来源和受限资源读取。跨位置保留内容的 overlay、端口映射、find widget 和 state persistence
尚未实现。当前也尚未接管 iframe 自身的页面跳转；调用方仍只应提供产品控制的 HTML。

### 6.3 Markdown

当前 Renderer 有两条 Markdown 渲染路径，但共享同一个最终安全边界：

```text
Workbench 短内容
  → marked
  → DOMPurify allowlist
  → MarkdownElement（普通 DOM）

完整文档预览
  → marked
  → DOMPurify allowlist
  → MarkdownPreview
  → WebviewElement（独立来源的 sandbox iframe）
```

`base/browser/domSanitize.ts` 是 DOMPurify 的唯一直接适配器，为目标 document 创建隔离的
sanitizer 实例，防止 hook 跨窗口或跨消费者泄漏。`base/browser/markdownRenderer.ts` 拥有
普通 Markdown 组件、Markdown 标签/属性 allowlist 和 URL policy。
`workbench/contrib/markdown/browser/markdownPreview.ts` 负责完整文档解析、预览样式及 iframe
链接消息桥接，通过 `IWebviewService` 创建并持有容器。
`workbench/contrib/markdown/browser/markdownDocumentRenderer.ts` 将预览适配为 Editor Part
可持有的 `MarkdownDocumentView`，并拥有产品级链接打开回调。

`workbench/contrib/markdown/browser/markdown.contribution.ts` 是 Workbench 功能入口，由
`workbench.contribution.ts` 静态加载；该层只接入产品视图和样式，不重复解析器或 sanitizer。
解析器返回的 HTML 从不视为可信内容，也不得绕过 DOMPurify 直接写入 DOM 或
`WebviewElement.setHtml()`。

当前 allowlist 覆盖标题、段落、列表、表格、代码块、引用和任务复选框等标准 Markdown
结构，拒绝脚本、事件属性、内联样式、SVG/MathML 与未知元素。链接只保留 `http:`、
`https:`、页内 fragment 和源文档允许的本地链接，并由宿主接管点击；图片经过 URL policy，
本地图片进一步映射到 Webview 资源来源，由文件服务在允许的目录内读取。
预览消息仍需通过 `WebviewElement` 的 source/origin/channel
校验，并在 `MarkdownPreview` 中再次做 exact-shape validation。

当前没有语法高亮、Markdown 扩展插件、Mermaid、KaTeX、滚动同步
或预览状态持久化。这些属于后续能力，加入时必须继续保持“解析后统一 sanitize，再进入隔离
容器”的顺序。

### 6.4 Workbench 布局

`base/browser/ui/grid/GridView` 是不感知 Workbench 语义的索引路径布局引擎：它用
branch/leaf descriptor 创建嵌套 `SplitView`，拥有运行时拓扑、尺寸、显隐和隐藏 leaf
的 cached visible size，并通过 `GridLocation` 执行 add/remove/move。`Grid` 在其上提供
以 View identity 为参数的常用 API，Workbench 调用方不持有索引路径。`SerializableGrid`
通过底层 `GridView` 的 `toJSON()` 与显式 deserializer 生成和恢复完整拓扑快照；这些
base 能力不引用 Part、ViewContainer 或其他 Workbench domain。

`workbench/services/layout/browser/layoutService.ts` 拥有面向 contribution 的窗口级布局
契约、Part identity 和 service identifier。`workbench/browser/layout.ts` 是具体实现，
拥有合法的 Workbench 拓扑和初始化策略；Mode 入口通过
`workbench/browser/workbenchSession.ts` 提供初始 Sidebar、Auxiliary Bar、Agent Sidebar 和
Panel profile，Workbench 不反向导入 Mode contribution。窗口变化由高优先级 Editor 区域吸收，
Part 即使隐藏也保持挂载，尺寸查询返回其可恢复尺寸。

`IWorkbenchLayoutService` 扩展平台 `ILayoutService`，两者共用一个注册标识和同一个
`WorkbenchLayout` 实例。它复用 `BrowserLayoutService` 的容器尺寸观察与事件机制，在 Parts
创建前注册，装配完成后通过 `createParts` 建立 Grid。浮层从该实例读取容器与偏移；每次尺寸变化
先完成 Grid 和 Part 布局，再发布容器、主容器和活动容器事件。
`WorkbenchLayout` 通过构造注入获取配置和存储服务，监听 Activity Bar 和 Sidebar 位置设置；
Modern UI contribution 直接通过 `IWorkbenchLayoutService.setLayoutStyle` 更新布局样式。
Panel 最大化经 `IWorkbenchLayoutService.toggleMaximizedPanel()` 执行。布局记录最大化前的 Panel
高度，换 Sidebar 或 Activity Bar 位置时保留最大化状态；恢复编辑区或关闭最大化 Panel 时恢复原高度。
最大化期间保存布局仍使用恢复后的高度，工作区布局恢复会重新显示编辑区。

当前可变尺寸和显隐快照是具体 `WorkbenchLayout` 的私有实现关注点，不是 Layout Service
契约，也不存在独立的 `layoutState` service。状态流为：

```text
Workbench Mode session profile defaults
  → initialization state
  → Profile/Workspace scoped stored values
  → SerializableGrid runtime
  → resize / visibility event
  → onWillSaveState
  → scoped Storage Service
```

`platform/storage/common/storage.ts` 定义 Renderer 通用存储契约，包括 Application、
Profile、Workspace scope，User/Machine target，值变更事件和 will-save lifecycle。
Web 的 `workbench/services/storage/browser/storageService.ts` 以产品、profile 和
workspace identity 隔离 versioned `localStorage` 文档。Desktop 与 Agents 的入口选择
`workbench/services/storage/electron-browser/storageService.ts`，并在创建工作台前完成初始化。
窗口保留同步读取缓存，通过 `storage` IPC channel 立即发送单键更新；
`platform/storage/electron-main/storageMainService.ts` 是唯一磁盘写入者，串行合并更新，
原子写入 Electron user-data 下的 `workbench-state.json`，再广播带 revision 的快照。
Renderer 不提交整个 scope，因此不同窗口更新不同键不会互相覆盖。

Desktop 第一次读取 scope 时校验并导入对应的旧 `localStorage` 文档。目标已存在且相等时
完成旧项清理；值冲突或格式错误会报告错误并保留旧项。旧项只在目标落盘后移除，之后只读写
主进程存储。Application 仍按产品隔离；普通 Workbench 使用默认 Profile，Agents 使用
自己的 Profile 与固定 `sessions` Workspace。工作台在显式关闭前等待工作副本备份和存储
flush，保存失败保持窗口开启。直接刷新页面时，每次状态更新已经发往 Main；Main 接收后的
写入不随窗口断开取消。周期 flush 仍负责收集需要在 will-save 时保存的缓存。

启动恢复结束 30 秒后，存储 owner 清理不再活跃、也不在恢复列表中的 `empty-window-*`
Workspace。IPC 订阅保护仍在使用的 scope；真实目录、Agents、Application 和 Profile
状态不参与这项清理。App Server 的业务数据继续由 Rust 拥有。

Desktop 结构化日志经 `platform/log/common/logIpc.ts` 与
`platform/log/electron-main/logIpc.ts` 到达 `platform/log/node/loggerService.ts`。
每次启动在 Electron logs 目录创建独立会话目录，保存 `main.log` 与 `window-<id>.log`；
记录时间、级别、类别、消息、错误栈、来源和写入进程 PID。Main 的连接阶段日志包含窗口 ID、
连接 generation、前后状态及阶段耗时；`ready` 仍由 Renderer 完成协议初始化后的原有确认产生。
窗口关闭等待日志 flush，进程退出等待文件队列结束。每个来源保留三份不超过 5 MiB 的日志，
超出单条限制的记录报告错误；后台维护保留当前会话和最新九个旧会话，只删除日志 owner
识别的会话目录，并在删除前确认目标位于 logs 目录内。

具体 Layout 内的私有 `WorkbenchLayoutStateModel` 负责把 domain state 映射为存储 key：
Sidebar、Auxiliary Bar 和 Panel 的尺寸使用 Profile/Machine，显隐使用
Workspace/Machine。Layout Service 契约和通用 Storage Service 都不包含这组 key 或状态
schema。Sidebar 支持左右换边；Panel 换边、任意 Part 移动和多窗口拓扑尚未实现，出现真实产品需求
时应扩展具体 Layout，而不是让 contribution 直接操作 Grid。

Renderer Part 的视觉所有权仍以
[`ui-styling-ownership.md`](ui-styling-ownership.md) 为准；Grid 只拥有几何和 sash，
不拥有 Part 内部样式。

### 6.5 Workbench View 与 Chat

Workbench 使用 `ViewContainerLocation` 区分 Sidebar、Auxiliary Bar、Agent Sidebar 和 Panel。
这些 pane-like Part 均由 `PaneCompositePart` 持有统一的标题槽位、`CompositeBar`、可选标题
toolbar 与 retained `PaneComposite` 生命周期；Editor 保留其专用 editor-group 架构。容器贡献只
负责声明位置、顺序和默认项，不直接操作 Workbench 布局。`IViewsService` 根据 view ID 解析所属
container，再委托对应 Part 显示并激活该 composite。Primary Sidebar 和 Panel 显示标准
`CompositeBar`；Auxiliary Bar 隐藏固定 Chat container 的冗余 bar 并投影 Chat 自有标题；Agent
Sidebar 保留统一标题和 CompositeBar host，但过滤唯一冗余 container item，并在标题右侧
`titleActions` 槽位投影收起动作。四者仍使用相同的 Composite 生命周期。该层级、命名和槽位契约以
[`workbench-pane-composite-design.md`](workbench-pane-composite-design.md) 为准。

Chat 是独立 contrib，而不是 Auxiliary Bar 的内建内容：

```text
Open Chat / New Chat
  → IViewsService
  → AuxiliarybarPart
  → Chat ViewContainer
  → ChatViewPane

ISessionsService
  → 当前 session / root thread
  → IChatService
  → ChatService
  → thread.subscribe + thread/stream 事件
  → ChatWidgetModel
  → ChatViewPane
```

`ISessionsService` 负责当前项、可见项、导航和焦点；`ISessionsManagementService` 负责 Session
列表、草稿和操作；App Server provider 负责把生成 DTO 映射为前端 `ISession / IChat`。
`IChatService` 隔离 thread、turn 和 App Server lifecycle transport；`ChatWidgetModel` 负责单个活动
thread 的可释放订阅、已提交 transcript 与临时 stream projection。活动 Turn 处于 running、
waitingForApproval 或 waitingForUserInput 时，普通文本 Send 调用 `session/request::SteerTurn`，不会新建
第二个 Turn；输入工具栏同时保留 Send 和 Stop，显式 Skill 只允许在新 Turn 接受边界选择。重新连接或 stream 序号
不连续时，以 `thread.read` 返回的权威状态重建展示。`ChatViewPane` 当前支持文本发送、中断、
审批、用户输入请求和经过统一 sanitizer 的 Markdown 展示。

当前尚未实现 session/thread picker、附件和图片输入、fork/history 导航、动态工具执行器。
由于 session 列表当前没有最近活动时间，启动时只能按服务端顺序选择首个活动 thread；
Browser 入口没有 App Server 连接时会明确显示不可用状态。`dev:web` 是不构建 Rust 的独立
Workbench 开发入口，本地文件夹由浏览器授权的 `HTMLFileSystemProvider` 直接读写，内容搜索通过
`FileContentSearchService` 遍历同一文件服务；用户配置和备份写入 IndexedDB。内置声明式扩展及资源
由构建生成的 Browser catalog 提供，可信开发扩展的 `browser` 入口通过页面持有的 Worker 执行。
`IRendererHost.hasAppServer` 区分宿主能力与暂时断线：独立 Web 不创建 App Server 语言和语法 provider，
不读取后端账户，进程终端、任务和调试命令按能力禁用。Git 和 Agent 操作仍需连接后端。
`build:web` / `start:web` 提供同一独立 Web 模式。当前本地
`dev:web:full` 与 `build:web:full` / `start:web:full` 使用受管理 Rust App Server 的认证
HTTP/WebSocket 浏览器入口。每个浏览器页签独立交换 JSON-RPC，服务仍由 profile registry 管理。
`build/desktop/web.ts` 只持有启动租约、读取启动信息和收尾；不转发业务消息。
Vite 提供开发资源，发布资源由 Rust HTTP 入口读取可信配置中的目录。
Web 构建输出 `.build/desktop/web/ash`，仅包含浏览器入口；普通 `build:renderer` 保留 Desktop 入口与 disconnected 模式。`build:web:full` 显式启用后端连接。
可信启动入口绑定工作区和允许的 Origin；一次性票据兑换后，浏览器通过会话凭证连接，
不声明目录授权宿主，也不调用 `env/dirs/set` 扩大权限。具体契约和验证见
[前端连接与浏览器能力](design/app-server-connection.md)。
公网远程部署的认证、TLS 和访问策略不属于这个本地服务的能力。

Renderer 与 Stanza 共用 `build/desktop/vite/rendererOutput.ts` 的分包规则，保留模块执行顺序，避免贡献注册
顺序改变。构建对超过 500 kB 的 JavaScript chunk 直接报错；`build-metrics.json` 另外记录
每个入口的静态 JavaScript 总量。分包不等于减少总下载量，worker 资源不计入此 chunk 限额。

### 6.6 听写设置与模型准备

Workbench 的“常规 → 听写”和 Sessions 的“常规”页使用同一套听写内容，各自的设置
外壳拥有导航、搜索和布局。`workbench/contrib/chat/browser/speechToText` 拥有听写设置、
窗口共享的 `IChatSpeechToTextService` 和目标编辑器的听写会话；`platform/dictation` 负责麦克风与后端通信。
Workbench 和 Sessions 各自在窗口服务容器中注册一个听写服务，输入区通过构造注入使用它，
不各自创建录音状态。`DictationSession` 拥有当前编辑器的麦克风动作、模型就绪检查和转写插入，
`DictationActionViewItem` 呈现按钮。输入区只组合工具栏、转写预览和错误通知。
只有发起录音的输入区接收文字与错误；提交等待最终转写，隐藏或销毁该输入区丢弃后续转写并释放录音。
服务输出累计转写与已确认部分，停止后返回完整结果；旧录音的迟到事件不会进入下一次录音。
最终识别文字通过编辑器编辑操作插入当前选区，临时识别文字不进入编辑器模型。
`workbench/contrib/localTranscription` 拥有本地模型安装、导入、选择、卸载及进度控件。
模型表使用 `base/browser/ui/table` 的列布局、行渲染、焦点、选中及键盘交互；基础表格不识别模型业务。
表格保留未安装模型，安装完成后提供使用与卸载操作。云端听写页显示麦克风、转写语言、服务商、连接状态和
管理 API 连接入口，凭据表单仍由 Models 设置负责。当前听写接入 API，聊天订阅不授予听写权限。
云端识别使用 `dictation.cloudProvider` 指定的服务与固定语音模型，凭据与聊天共用后端密钥存储。
移除密钥时，界面说明对聊天和语音输入的共同影响。

模型准备任务属于共享 Rust 进程。`dictation/model/read` 和 `dictation/model/list` 返回已安装
状态、包大小和当前阶段；`dictation/model/changed` 通知所有产品窗口重新读取快照。
关闭设置、隐藏 Chat 或关闭发起窗口只解除前端监听；`dictation/model/cancel` 才停止对应模型
的任务。Rust 拒绝同一模型的重复准备，并在停止工作线程、清理临时文件后确认取消。
删除只移除 Ash 管理的包文件，保留导入源目录；准备中或语音使用中拒绝删除。

本地模型的状态、下载和取消操作集中在听写设置页。Chat 输入区不订阅模型准备状态，也不展示
模型管理提示条；点击麦克风时检查模型是否就绪，未就绪时直接打开听写设置，不开始录音。
模型准备期间仍可输入和发送文字。设置页下载仅有已传输字节时显示文件名、MiB 和不定进度条，
不推算百分比。浏览器及未连接后端的宿主明确禁用本地模型操作。

Chat、普通编辑器与终端共用同一个窗口听写服务。编辑器通过“编辑器：开始听写”命令或
Ctrl/Cmd+Alt+V 启动，再按该快捷键结束，
已确认文字替换当前选区并形成独立撤销操作；换文档、隐藏或关闭编辑器取消其录音。
终端提供标题栏麦克风按钮与开始、停止命令，文字只写入发起录音时选中的运行实例，
换实例、退出或隐藏面板取消录音。终端插入前移除换行及控制字符，执行仍由用户按 Enter 触发。

“麦克风与语言”设置使用 `dictation/options` 查询音频进程列出的设备和所选服务支持的语言提示，
查询不会打开麦克风。`dictation.inputDevice` 保存设备身份，空值跟随系统默认；设备断开会明确报错。
`dictation.language` 的 `auto` 交由模型检测，显式值仅发送给支持提示的云端服务；本地 Paraformer
不接受强制语言选项。OpenAI 提示进入转写会话的 `languages` 字段，xAI 提示进入 STT 请求参数。
切换设备或语言时先停止当前听写、释放音频设备，再保存选择。设置归当前产品配置档，
不保存在项目或聊天草稿中。

首次使用且模型就绪时，在聚焦的输入区显示引导，提供设备、语言、模型设置与独立试录。
试录文字只显示在引导中，关闭引导会取消其录音；使用记录按配置档保存，
“听写：显示入门引导”可再次打开。编辑器、终端和引导提供键盘操作、无障碍帮助与转写视图。

当前设置入口覆盖如下；Workbench 位于“常规 → 听写”，Sessions 位于“常规”：

| 能力                                    | 设置页当前状态     | 使用入口与限制                                                                                     |
| --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| 麦克风选择                              | 已加入             | “麦克风与语言”提供设备列表和系统默认选项。                                                         |
| 转写语言                                | 已加入             | 云端可选择支持的语言提示；本地模型使用自身语言能力，语言选择禁用。                                 |
| 本地／云端、服务商、模型管理与 API 连接 | 已加入             | 本地显示模型管理；云端显示服务商、连接状态和 API 连接管理入口。                                    |
| 普通编辑器听写                          | 无独立设置开关     | 使用编辑器命令、上下文菜单或 Ctrl/Cmd+Alt+V。                                                      |
| 终端听写                                | 无独立设置开关     | 使用终端标题栏麦克风或开始、停止命令。                                                             |
| 首次引导与独立试录                      | 设置页入口尚未完成 | 首次使用显示引导，也可通过“听写：显示入门引导”命令打开；设置页尚无“测试麦克风／重新打开引导”按钮。 |

设置页待补：在上述两个设置宿主共用的听写内容中加入“测试麦克风／重新打开引导”直接入口，
复用现有引导及其试录会话，避免另建录音状态。此项尚未实现。

这些能力使用 Ash 的音频进程、本地模型与直接 API 服务。上游云端专属客户端、模型协议和
发光、悬停等按钮呈现仍未全部对齐。

### 6.7 集成终端

Terminal 的实例契约与实例管理位于 `workbench/contrib/terminal/browser/terminal.ts` 和
`terminalService.ts`。Tasks、Debug 的执行编排由各自 contribution 消费该契约。输入
batching、resize coalescing 与进程创建/关闭由 `TerminalService` 负责；增量读取、两个游标、
命令事件排序和解析等待由每个 Shell 的 `terminalProcessManager.ts` 负责。process contract 位于
platform layer 的 `ITerminalProcessService`。`IRendererHost` 直接提供该领域契约；Electron、
Vite development 和 disconnected runtime 分别实现它，wire DTO 只出现在对应 runtime
implementation 内。Contribution 和 xterm view 都不直接调用 `IRendererHost`：

```text
TerminalViewPane / xterm
  → ITerminalService
  → TerminalService (Renderer)
  → ITerminalProcessService
  → AppServerTerminalProcessService / SSH ReconnectableTerminalProcessService
  → Renderer AppServerProtocolClient
  → MessagePort transport → Main transparent relay
  → terminal/* App Server methods
  → exec-server TerminalService (Rust)
  → ash-utils-pty
```

Web 宿主的 `window.createTerminal` 通过 `IEmbedderTerminalService` 接收自供输出 PTY，
由 `TerminalMainContribution` 在 BlockStartup 接入同一个 `ITerminalService` 和 Terminal View。
实例保留界面订阅前的同步输出与退出，标题跟随宿主改名；xterm 按只读终端运行。
这条链路不创建 Rust Shell，不要求 Workspace folder，也不依赖后端连接状态。
宿主的打开、关闭及监听释放沿窗口与实例生命周期处理；当前只补齐宿主输出所需的进程事件契约，
Shell 输出已通过 `IProcessDataEvent.writePromise` 等待 xterm 的真实解析回调，再续读、发布命令完成
和退出；完整标准 child process 的输入、属性及服务器 flow control 仍未完成。
已有 Shell 首次输出会加载解析器，即使实例隐藏也可完成后台 Tasks；不显示隐藏面板、不改变焦点。
进程管理器在关闭或断线时取消读取等待，恢复同一 Shell 时保留原屏幕写入和字节游标；
Relaunch 使用新管理器，旧回调不影响新进程。OS PTY drainer 与 bounded ring 仍由 Rust 拥有，
Renderer 的解析确认不等于服务器输出背压。

SCM 同样通过 `IGitService → GitService → IGitApi` 访问仓库，并由 Service 把 status notification
和 reconnect lifecycle 投影成前端事件；Search 通过
`IContentSearchService → BrowserContentSearchService → IContentSearchApi` 消费有界批次。
两者的 contrib 都不接触 App Server notification union 或生成 DTO。

SCM 的打开操作由 `scmViewPane.ts` 解释：预览保留列表焦点，双击固定文件，修饰键点击或 Enter
请求侧边分组。打开链中的 `gitSCMProvider.ts` 解析 Git 版本并传递打开参数，`IEditorService` 和 Editor Part
负责目标分组、pane 生命周期与布局。2026-10-02 已确认将该文件保留为 Ash 的 App Server→SCM
适配器；VS Code 对应的仓库适配职责位于 `extensions/git/src/repository.ts` 和 `model.ts`，
依赖扩展宿主 SCM API，不能直接承接 Ash 当前的 App Server 调用链。

Terminal title actions 通过 `MenuId.TerminalTitle`、Context Key 与
`MenuWorkbenchToolBar` 接入 MenuService；profile selector 仍由 Terminal 自定义 action view
item 呈现。Command/Menu/Toolbar 的分层以 [`menu-system.md`](menu-system.md) 为准。

当前输出采用 `terminal/read` 有界分页读取；后端缓存满时报告输出缺口。前端字节事件表示已交给监听者，
尚未形成 xterm 解析完成后的 ACK 或有背压的主动输出协议，不能据此宣称完整标准数据流已对齐。
Renderer 对文本输入做 8 ms batch，对 resize 做微任务合并；xterm onBinary 的原始字节
与文本共用实例发送队列。Rust 重新校验输入字节上限、rows/cols、owner 和输出游标。
创建和 attach 返回实际 OS PID、启动目录；Relaunch 后实例更新该身份，DAP 成功回复带 shellProcessId。
Rust 的 processInfo 查询实际 cwd（macOS/Linux）和最后一次成功应用的尺寸；不支持查询的平台或退出后 cwd 为 null。
Unix 显式中断针对 PTY 当前前台进程组，Windows 返回结构化不支持错误；这两项 Rust 出口尚未等同完整前端属性与信号契约。

Terminal 服务要求已打开的 Workspace folder；多根窗口把选定 `dirId` 绑定到该实例，空窗口明确拒绝
进程操作。Remote 多根工作区尚未实现。PTY 不跨后端进程重启恢复。每个实例拥有独立 xterm widget，Tab 切换或 Panel 隐藏不会丢失
窗口生命周期内的 scrollback 与 ANSI parser 状态。xterm、尺寸适配器和样式在创建终端实例时按需加载；
组件先订阅输出，再加载渲染器，加载期间的输出、命令状态和退出消息按顺序保留。加载完成前关闭
组件会清理订阅和待显示内容；焦点已移到其他控件时不再抢回。Profile picker 只提交 App Server 已列出的
稳定 ID。连接离开 ready 后，本地 `connectionOwned` 实例进入 `disconnected`；用户可显式
Relaunch，新 PTY 使用原 Profile，不重放未确认输入。SSH `reconnectable` 实例进入 `reconnecting`，
Renderer 在同一后端的 30 秒租约内 attach 原 PTY，首次续读成功后才回到 `running`。后端已有
命令状态检测，但尚未接入完整前端 shell integration capability、跨后端重启恢复或持久 scrollback。
窗口服务按实例 ID 持有可释放资源，关闭完成后撤销该持有关系；窗口或实例释放会立即停止输入与读取。
窗口释放后的创建结果、实例关闭后的重启结果仍拥有真实 PTY，必须关闭后才结束操作。
同一实例的并发重启共享一次创建，并发 close 共享释放结果；close 也等待进行中的重启清理，避免遗留第二个 PTY。
创建、释放和移动均在列表、标题与活动项更新后发出 `onDidChangeInstances`。创建与重启开始读取前查询窗口当前连接状态，
避免异步返回覆盖已发生的断线。Tasks 与 DAP 在发送命令前要求新实例处于 running；否则关闭自己创建的实例并报告启动失败，
不在连接恢复后自动发送这次命令。
platform 到 services 的装配缺口、对应目录与职责见 [Terminal 对齐台账](terminal-api-alignment-status.md)。

### 6.8 产品链接与 URL 回调

Workbench 在窗口服务容器中提供 `IURLService`。`platform/url/common` 定义 URL 创建、
处理器注册与 IPC 契约；处理器按注册顺序执行，首个接受链接的处理器结束分发，注册句柄负责注销。
URL 服务在编辑器服务完成注册后接入 `IOpenerService`，并在窗口报告就绪前完成初始化。

桌面 `RelayURLService` 创建带 `windowId` 的 `ash:` 回调链接。产品内 opener、系统 `open-url`
和 `--open-url` 启动参数进入 Main 的同一条分发链；Main 按窗口 ID 或最近活动窗口选择接收者，
`windowId=_blank` 请求新窗口。反向调用使用现有可信 IPC 连接的窗口身份，等待 Renderer 就绪后
进入该窗口的 `urlHandler`。处理器接受回调后才聚焦窗口；`ash://file` 仍交给 launch 服务打开文件。
未知窗口和无人接受的回调返回 `false`，不把回调路径当作工作区或文件。

浏览器 `BrowserURLService` 接收宿主提供的 `IURLCallbackProvider`。宿主通过
`IWebWorkbenchHost.urlCallbackProvider` 提供回调 URL 创建及回调事件；没有提供器时，`create`
明确报错。产品内 opener 传递 `trusted: true`，系统和宿主回调保留外部来源语义。IPC 保留 URL 的
编码形式、query、fragment 和 `originalUrl`。URL 服务不执行扩展 JavaScript，也不完成身份认证；
接收回调的功能仍须注册自己的处理器并校验回调状态。

## 7. 浏览器能力

Electron Main 是 Browser Target 的唯一权威持有者。

### 7.1 当前实现

`platform/browserView` 以 `IBrowserViewService` 为共同入口。`BrowserViewMainService` 管理窗口内唯一的页面实例表，`BrowserView` 持有每个页面的 `WebContentsView`、Session 网络租约、状态、事件和关闭信号。新页面默认隐藏；Renderer 先通过 `layout(id, bounds)` 提交窗口内容坐标，再通过 `setVisible(id, true)` 显示。

| 场景                       | 入口                            | 执行路径                                                                                                  | 所有权                                                |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Workbench 创建、布局和导航 | `IBrowserViewService`           | 可信 IPC → `BrowserViewMainService` → `BrowserView`                                                       | Main 管理实例，页面管理资源                           |
| Agent 观察和输入           | Rust 内置浏览器工具             | `BrowserHost` → 反向 JSON-RPC → `AppServerBrowserHost` → 独立 Playwright 进程 → Group/CDP → `BrowserView` | Rust 决定批准，Playwright 执行元素操作，Main 持有页面 |
| 截图                       | `browser_screenshot` 或观察选项 | Playwright 截取同一页面 → Rust `ResourceStore`                                                            | 图片按连接隔离                                        |
| App Server 断开或重启      | Supervisor 状态迁移             | `AppServerBrowserHost.reset()`                                                                            | 关闭 Agent 页面、撤销用户页面分享并取消待处理权限请求 |

`AppServerBrowserHost` 属于 `platform/app-server`，只绑定协议请求、连接生命周期和取消信号。页面查询由 `BrowserViewMainService` 的唯一实例表决定；宿主只跟踪需释放的页面 ID 和 Thread，不持有第二套页面状态。页面按顺序执行编辑器导航和 agent 的观察、截图、输入；取消请求立即结束调用方等待，已发给 Chromium 的操作结束后才释放顺序。关闭页面统一中止等待、取消权限请求及下载，并释放监听器、Session 网络租约和 Chromium 页面。

`common/browserView.ts` 定义服务和可序列化参数，`browserViewIpcRoutes()` 校验 IPC 后调用服务。Electron 对象不跨越 IPC。Workbench 的 `BrowserEditorInput` 属于 `contrib/browserView/common`，编辑器 CSS 属于该功能的 `media/browser.css`。

当前已接通 Session、Thread 所有权、Group/CDP、独立进程 Playwright，以及编辑器 Model 和恢复。应用持有一个共享自动化进程，每个窗口持有独立 MessagePort 和 Group 管理器；Playwright 连接按 Thread 管理。Group 只引用该 Thread 的 Agent 页面和用户明确分享给该 Thread 的页面；撤销分享中止访问并移除调试引用，保留用户页面。Chromium target ID 保持原值，通过额外的 `browserViewId` 关联 Ash 页面。

`BrowserViewModel` 镜像 Main 状态，`BrowserEditorInput` 懒加载模型，Workbench 服务拥有输入与编辑器组引用。Renderer 重载接回存活的用户页面，不重建网页；最后一个编辑器引用关闭时才销毁页面。后端连接退场时仍关闭 Agent 页面，包括重载导致连接退场的场景。应用重启恢复用户页签的 URL、标题及工作区 Session。Agent 页签只作为用户临时页面恢复，不恢复任务权限或 Agent 登录。`browserViewService.ts` 与 `browserViewIpc.ts` 保留 Ash 可信 IPC 的适配职责；共享进程使用通用 `ProxyChannel`。

桌面内置浏览器注册为 `ash.browser.open`，用户通过 `workbench.externalUriOpeners` 按网站选择打开方式。例如：

```json
{
  "workbench.externalUriOpeners": {
    "localhost:*": "ash.browser.open",
    "127.0.0.1:*": "ash.browser.open",
    "https://docs.example.com": "ash.browser.open",
    "*": "default"
  }
}
```

规则按配置顺序选择第一个匹配且已注册的打开方式；`default` 使用系统浏览器。未配置时内置浏览器不接管链接。编辑器、聊天、终端、Git、问题报告和发布说明中的用户链接均使用同一选择服务。编辑器 Markdown 提示、富文本文档链接，以及 Code 和 Agents 窗口的 `window.open` 请求也走这条链。富文本中按 Ctrl/Command 点击或按 Ctrl/Command+Enter 打开当前链接，普通点击保留编辑行为；聚焦链接后也可按 Enter 打开。终端的网址支持鼠标打开和命令面板的“终端：打开检测到的链接…”；取消选择返回终端。通过规则打开的页面属于用户，并复用当前工作区的浏览器 Session。Web 不注册桌面浏览器打开方式。

Ash 可执行扩展可以声明 `externalUriOpener` 能力，在激活结果中注册 HTTP/HTTPS 打开方式。设置补全显示扩展提供的名称，规则 ID 为 `extension:<encodeURIComponent(扩展 ID)>:<encodeURIComponent(注册 ID)>`。前端负责规则选择，既有扩展宿主负责带代次校验的调用和取消；扩展退出、重启或连接关闭时，旧注册与请求一同撤销。这条接口属于 Ash 扩展协议，尚未实现 VS Code JavaScript 扩展的 `registerExternalUriOpener` 和按 URL 惰性激活。完整协议字段与调用约定见 [Browser foundation](browser-foundation.md#external-uri-opening)。

当前 URL policy 允许 HTTPS、loopback HTTP 与精确的 `about:blank`，拒绝 URL credentials、
`file:`、`javascript:` 和其他特权 scheme。用户 Session 按工作区持久保存，Agent Session 按窗口和 Thread 使用内存 partition，同一 Thread 的多个页面共享登录。所有页面固定：

```text
nodeIntegration: false
contextIsolation: true
sandbox: true
webviewTag: false
无远程页面 preload
默认拒绝 permission / device permission / download / popup
```

popup 请求只以 `openRequested` 事件返回已验证 URL，不会由远程页面直接创建窗口。Renderer
可收到目标 state、加载失败、popup 请求、renderer 崩溃和关闭事件，但不能获得底层 Electron
对象。

Desktop 在 `initialize` 中声明浏览器宿主能力版本 3，并注册四个必须携带 `threadId` 的 Server → Client 请求：

- `browser/create` 创建隔离且默认隐藏的目标；
- `browser/observe` 返回 URL、标题、加载状态，以及可选的 accessibility tree、DOM snapshot 和
  PNG 截图；
- `browser/perform` 只接受导航、按后端 DOM node ID 点击/输入、滚动、后退和刷新；
- `browser/close` 只关闭请求中的精确目标。

Electron Main 通过 `webContents.debugger` 持有 CDP 连接。独立 Electron utility process 中的 Playwright
使用 MessagePort transport 连接 Thread Group，不开放 localhost remote-debugging port，也不另起浏览器。
Group 处理 browser/target 域和虚拟 session，将页面命令转给选中的 Chromium 页面；产品工具仍只暴露领域动作。
accessibility tree 与 DOM snapshot 各限制为 8 MiB，PNG 限制为 16 MiB。Main 按页面保持操作顺序，取消阻止后续步骤；
即使自动化进程退出，已发给 Chromium 的命令也结束后才释放页面顺序。进程退出释放 Group 和调试器引用，页面保留手动操作能力。

Rust `BrowserHost` 使用独立的字符串 request ID 复用现有 JSONL 连接；任务提交时绑定发起任务的
Desktop connection，新建目标、后续观察、动作和关闭同时核对 connection 与 Thread owner。Web 或未绑定宿主的任务
不能借用其他桌面连接。非 owner 响应、目标身份变化和
重复响应均失败。请求在 30 秒后超时，取消或超时会发送 `$/cancelRequest`，安全忽略已放弃请求的
晚到终态。截图经 Base64 长度、PNG MIME/signature 校验后进入 5 分钟 TTL 的 connection-owned
`ResourceStore`。

内置工具为 `browser_open`、`browser_observe`、`browser_navigate`、`browser_click`、
`browser_type`、`browser_scroll`、`browser_back`、`browser_reload`、`browser_screenshot` 和
`browser_close`。Rust 重新执行 URL、目标与 node ID 校验，并把每次动作建模为
`BrowserInteraction` + `UserInterface` capability；当前策略要求一次性用户批准，Electron Main
不能自行放宽。完整浏览器工具面只有在当前 Environment tool composition 已建立，并且至少一个 version 3 connection 同时声明
`observe + input` 时才进入当前 Tool generation；最后一个完整宿主断开时会原子移除，Environment runtime 切换则重建对应 Tool generation。
反向 RPC handler 可以继续注册，但 Agent 无法在没有 live browser host 与动作批准时发起操作。

每次浏览器工具调用还持有独立的网络授权，由 Rust `BrowserHost` 绑定发起连接并在工具结束、取消或断线时释放。
`browser/create`、`browser/observe`、`browser/perform` 携带可选的 `networkToken`；缺少授权时 Agent 页面拒绝 HTTP(S) 请求。
Chromium Session 的 `onBeforeRequest` 对 HTTP(S) 导航、重定向、子资源和 fetch 逐条请求
`browser/network/authorize`。WebSocket 在握手前拒绝，因为 Chromium 的连接清理不能撤销已建立的 WebSocket。
App Server 先检查当前 `network.allowedHosts`，再通过 Core 的网络审批端口评审精确的
协议、主机、端口和方法，并在回复前再次检查配置与授权是否仍有效。策略与审批凭据保留在后端。
宿主撤销页面授权时拒绝待处理请求并关闭 Session 的网络连接；Agent 弹窗不能创建不受此策略约束的用户页面。
共享用户页面只允许观察，Agent 的输入和导航必须使用隔离的 Agent Session。没有页面身份的后台请求默认拒绝。

这条链路还不能作为完整网络沙箱：Electron 44.4.5 的 WebTransport 不经过 `onBeforeRequest`，
即使 HTTP(S) 请求被拒绝，仍可发出 QUIC UDP 包。`disable_non_proxied_udp` 限制 WebRTC 的直接 UDP，
但不提供按工具撤销所有传输的能力。完整隔离还需要把 Agent Session 接入后端拥有、可撤销的代理，
并封闭绕过该代理的传输；在此之前只能保证上述 HTTP(S) 请求的策略检查。

`agent/capabilities/read` 的 `sandboxDiagnostics` 区分准备通过、策略不受支持和后端不可用，并报告原因。
检查复用实际执行的 sandbox backend，针对当前授权目录执行只读进程准备，不启动子进程；网络禁用、开放和受管模式分别检查。
它不保证具体命令或 PTY 可以启动，这些请求仍在启动前按实际策略校验。

### 7.2 当前限制与计划演进

当前限制：

- Workbench 已提供浏览器编辑器、地址栏、标签页及容器布局；Agent 创建和关闭页面同步到页签。
  `F6` 或 `Ctrl+L` 返回地址栏，`Alt+F1` 打开帮助；分组引用与关闭已有验证，同一页面只在当前宿主编辑器显示；
- 用户工作区 BrowserSession 已持久保存；用户可分享页面给指定 Thread 并撤销访问；网站权限按来源弹窗并支持重置，下载可选择位置、查看进度和取消；证书信任与 PDF 导出尚未提供；
- 当前观察结果是有界的原始 CDP JSON，还没有面向 Agent 的 locator、ARIA snapshot、trace、console
  或 network inspection；
- Electron Debugger 的单条在途命令不能被 Chromium 抢占；取消会阻止后续步骤并使 Rust 调用
  终止，但底层命令仍可能在目标关闭前完成；
- 应用重启只恢复用户页签与工作区登录，不恢复在途任务或 Agent Session；
- 远程 BrowserSession 在创建页面前配置 SSH SOCKS5，包含域名解析、子资源、fetch、WebSocket 和 loopback；失败后保留代理规则，最后一个页面关闭时释放进程。

后续基座继续补齐设备权限选择、证书信任和网页交互。Rust 保留工具注册、
授权和 App Server 协议，用户页面默认私有，分享只授予指定 Thread 的当前连接。PDF、trace、network inspection、console 和高级 locator
属于后续独立契约。当前连接、释放与恢复的细节见[前端连接与浏览器能力](design/app-server-connection.md)。

## 8. Desktop 提交 App Server 能力需求

Desktop 开发者在实现前提交一份符合
[`ash-api-interface-requirements.md`](ash-api-interface-requirements.md) 的产品接口需求。
Desktop 是需求提出方；crates 是已接受 App Server 契约的 owner。接口必须同时评估 CLI、
daemon 和远程客户端影响，不能定义为 Desktop 私有业务 API。

文档必须覆盖：

- Client → Server 方法；
- Server → Client 请求；
- Server → Client 通知；
- Resource RPC；
- Browser Target 生命周期；
- 错误码、超时、取消、幂等和顺序；
- 每个请求、成功响应和错误响应的 JSON fixture。

crates 开发者根据该文档实现 Rust DTO、dispatcher、typed client、handler、schema 和
TypeScript 生成。进程内 CLI client 与 Desktop stdio client 必须经过同一个 dispatcher。

当前已接受的方法、通知、错误码和前端可开发范围以
[`ash-app-server-api.md`](ash-app-server-api.md) 为准。

## 9. Rust 交付给 Desktop 的产物

每次协议交付至少包含：

- 可运行的 `ash` 二进制；
- `ash-app-server-daemon connect`（共享 local authority）与 `--listen stdio://`（direct compatibility）；
- 独立的 `ash-app-server --managed` 后台进程与 `ash-app-server-daemon` 控制程序（profile authority、process-generation record、真实
  initialize readiness、协作停止、socket 与 idle lifecycle）；
- `.build/protocol/typescript/index.ts` 与 `types/` 类型目录；
- `.build/protocol/json/schema.json`；
- schema hash；
- 当前 schema fixtures；
- Rust contract tests；
- API 变更说明。

## 10. Desktop 验收

Desktop 完成的最低证据：

- TypeScript strict build 通过；
- initialize 成功并校验 protocol major、生成协议指纹与必需能力可用性；
- Session 创建、Thread 创建/fork、订阅恢复和 Turn 中断端到端通过；
- 通知能从 App Server 到 Renderer；
- 未生成或参数错误的 IPC 被拒绝；
- 不可信网页无法访问应用 IPC；
- Browser Target 关闭后不会操作其他 Tab；
- App Server 崩溃、重启和 graceful shutdown 有测试。
