# Sessions：布局、工作集与 Changes

Sessions 复用 Workbench 的 Part、编辑器和 ViewContainer 基座。Creator 聚合各贡献的创作入口；Library 是统一的分类文件和素材仓库，其分类、收藏、集合和搜索属于库内浏览状态。各功能向 Sessions 布局服务提供容器 ID 和中央内容，窗口布局负责共享宿主的尺寸与显隐。DesktopLayoutController 负责会话文档恢复及 Editor／Details 行为。窗口始终保留 SessionsPart，用于 Agent 对话和会话分屏。

本文概括边界。完整契约见 [LAYOUT.md](../src/ash/sessions/LAYOUT.md)，会话工作集和入口存储见 [LAYOUT_CONTROLLER.md](../src/ash/sessions/LAYOUT_CONTROLLER.md)。

## 职责与目录

| 负责方         | 文件                                                                                                | 契约                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 窗口装配       | [workbench.ts](../src/ash/sessions/browser/workbench.ts)                                            | 创建服务、保留 Parts，管理窗口生命周期                                                             |
| 桌面布局       | [desktopWorkbench.ts](../src/ash/sessions/browser/desktopWorkbench.ts)                              | 拥有窗口 Grid、Part 位置、显隐映射、尺寸和存储                                                     |
| 入口布局       | [sessionsLayoutService.ts](../src/ash/sessions/contrib/layout/browser/sessionsLayoutService.ts)     | 接收功能提供的容器和中央内容，串行打开并保存布局偏好，不按产品名字分支                             |
| 会话文档与详情 | [desktopLayoutController.ts](../src/ash/sessions/contrib/layout/browser/desktopLayoutController.ts) | 恢复会话工作集，管理 Editor／Details 操作                                                          |
| 对话区域       | [sessionsPart.ts](../src/ash/sessions/browser/parts/sessionsPart.ts)                                | SessionsPart 拥有独立 SessionGridLayout，每个会话由 SessionView 承载；Chat/Code 共用容器和分屏几何 |
| 编辑区域       | [parts/editor/](../src/ash/sessions/browser/parts/editor)                                           | 复用 Workbench EditorPart，保留产品页面编辑组；会话文档组独立恢复                                  |
| 底部工具       | [parts/panel/](../src/ash/sessions/browser/parts/panel)                                             | 使用共享 PanelPart 和工具 ViewContainer                                                            |
| 左侧区域       | [parts/sidebar/](../src/ash/sessions/browser/parts/sidebar)                                         | 使用共享 SidebarPart，挂载会话、团队、Library、Creator 的 ViewContainer                            |
| 会话身份       | [sessionsService.ts](../src/ash/sessions/services/sessions/browser/sessionsService.ts)              | 窗口唯一的活动会话、可见排列和导航历史                                                             |

组件和样式跟随所属 Part；会话宿主位于 browser/parts，样式位于相邻 media。模式页面放在 contrib，由 EditorInput / EditorPane 或 ViewPane 注册提供内容；页面名不产生新的窗口 Part。Workbench 和更低层不依赖 Sessions。

## 中间区域与模式

| 模式                | 左侧                       | 中间                             | 右侧                            |
| ------------------- | -------------------------- | -------------------------------- | ------------------------------- |
| Chat                | 会话 ViewContainer         | SessionsPart                     | 按该模式的显隐偏好              |
| Code                | 会话 ViewContainer         | SessionsPart 与文档 EditorPart   | Files / Changes，按活动文档选择 |
| Collaboration       | 团队 ViewContainer         | SessionsPart                     | 按该模式的显隐偏好              |
| Library             | 分类 ViewContainer         | LibraryEditorPane                | 素材详情 ViewContainer          |
| Creator 画布        | Layers ViewContainer       | CreatorEditorPane 保留的工作空间 | Shape properties ViewContainer  |
| Creator 首页 / Make | Creator 导航 ViewContainer | CreatorEditorPane                | 默认收起属性                    |

Sidebar 在每种桌面模式中都可用。用户显隐偏好按入口保存。Code 的 Panel 在其他模式不可用，回到 Code 恢复原显隐及工具视图。聚焦 Code 内的对话不改变模式；激活已打开的产品标签时恢复其对应的入口布局。

## 状态与生命周期

窗口布局负责 Part 宽度、Grid 和实际尺寸。会话分屏由 SessionsPart 的独立 Grid 管理；文档编辑组仍使用 Workbench 编辑组能力。模式切换保留这些实例，不创建另一份会话选择、文档或选区。

会话工作集只保存和恢复文档编辑组，产品页面编辑组排除在外且保持存活。隐藏编辑内容、收起整个 Code 侧面区域和切换模式都保留普通标签与未保存文档。实际关闭、文件替换和窗口退出继续检查保存、放弃或取消。

CreatorPage 拥有工作空间实例，文档内容和工作副本仍由各模式的原有服务拥有。LibraryService 拥有共享的可观察浏览状态；LibraryEditorPane、分类 View 和详情 View 分别创建并管理自己的界面。容器与 View 在 contribution 中注册，不依赖编辑器先创建。各区域隐藏时释放自己持有的预览资源，返回时保留搜索、视图模式和选择。

窗口布局按顺序完成 Grid、Parts 和内部内容，再通知容器布局完成。隐藏区域保留 Grid 缓存尺寸。窗口关闭等待布局切换、会话工作集和草稿保存结束，再释放 Parts 和存储。

## 共享契约与调用链

| common 文件                       | 底层契约与生产调用链                                                                                                                          | 状态 owner                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sessionCommands.ts`              | Files 命令注册、Add tab 菜单、布局操作队列共用公开命令标识                                                                                    | 命令注册表与布局控制器                                               |
| `sessionLinks.ts`                 | GitHubService 合并发现和保存的 PR；比较键与原始打开 URL 分开                                                                                  | GitHubService                                                        |
| `categories.ts`                   | ICommandAction.category → 命令注册 → Command Palette 的中文标题与英文搜索别名                                                                 | 命令注册表                                                           |
| `chatLayout.ts`                   | 配置/手机状态 → 生命周期内稳定的 presentation/owner 快照 → 既有布局队列                                                                       | BaseLayoutController                                                 |
| `sessionConfig.ts`                | 单一 IConfigurationRegistry 设置 → Sessions Appearance → 按 Session / Chat 保存文档及可见性                                                   | 共享配置服务与既有布局存储                                           |
| `dockedEditorInput.ts`            | Files/Changes 输入 → ExcludeFromEditorLimit → EditorGroupModel 与 GroupView 共用替换选择                                                      | EditorGroupModel；内容资源由 pane 释放                               |
| `sessionApplication.ts`           | Session 领域描述 → App Server 目录 adapter → Chat History 应用标签                                                                            | Session 目录来源；当前表示服务目录的 Ash 应用                        |
| `workspaceSelection.ts`           | 选择来源/历史状态快照 → 可取消的 WorkspaceSelection Quick Pick → 草稿执行目标                                                                 | 单个 picker 生命周期；历史仍由 IWorkspacesService 拥有               |
| `agentHostSessionsProvider.ts`    | 连接状态领域契约 → AppServerSessionsProvider → SessionsManagementService 的 loading/error/reload                                              | App Server 连接与 Provider                                           |
| `agentHostSessionWorkspace.ts`    | 本地/SSH/Provider 目标与 hydrated Thread directory → workspace 领域快照和无歧义缓存键                                                         | Session/Thread 后端目录事实                                          |
| `devContainerAgentHostService.ts` | Sessions 命令 → 可取消领域 service → 生成 RPC adapter → profile Provider → Docker/Dev Container CLI → managed gateway → 容器内共享 App Server | Docker 拥有容器；Provider 拥有启动策略；核心拥有授权、路由及连接释放 |
| `sizes.ts`                        | 浮动面板间距 → 现有 layoutPolicy                                                                                                              | 单个实际尺寸常量                                                     |
| `welcome.ts`                      | durable 目录 → profile welcome-complete 标记 → empty view；草稿不标记完成                                                                     | 既有 profile storage                                                 |
| `sessionsTelemetry.ts`            | 返回 Workbench 的实际操作 → host telemetry policy → 分类事件                                                                                  | 原有 ITelemetryService；不启用新的采集目的地                         |
| `contextkeys.ts`                  | 导航历史菜单条件                                                                                                                              | Sessions 服务；保留原实现                                            |
| `layoutConstants.ts`              | Part 标识与侧栏尺寸                                                                                                                           | 既有布局；保留原实现                                                 |
| `theme.ts`                        | Sessions 专属颜色注册                                                                                                                         | 主题服务；保留原实现                                                 |

## Docker Provider

新增 `extensions/dev-containers` 独立 Rust executable，使用现有 Rust SDK、
Host RPC v1 与 `sessionRuntime.v1` typed DataChannel。App Server 不链接其实现。
`session/runtime/invoke` 和 `/cancel` 由 Rust 定义并生成；`sessionRuntimes:1`
用于协商。Renderer 的领域 service 不导入生成传输类型，Main 不运行 Docker。

领域模型在 `src/ash/platform/agentHost/common/agent.ts`，服务契约在
`src/ash/platform/agentHost/common/agentService.ts`，转换在
`browser/appServerAgentService.ts`，线上连接仍由 `browser/appServerProtocolClient.ts`
唯一拥有。Rust 源契约在 `crates/protocol/src/session/runtime.rs` 和
`crates/app-server-protocol/src/protocol/session.rs`；生成类型、method map 和运行时
decoder 位于 `.build/protocol/typescript/`，由既有生成器产生。
`crates/app-server/src/session_runtime_provider.rs` 管理 profile 授权、activation 和准入记录，
Docker 操作在 `extensions/dev-containers/src/`。没有旧 Docker Host 需要迁移或保留。
Main 使用原有共享后端 starter/relay，未增加每窗口后台进程或 Docker 调用。
App 按命令激活 Provider；TUI 可读取 Provider 执行目标，但未增加独立容器选择 UI。
Provider 缺失时 probe 返回不可用，操作失败，不创建本地执行替代目标。
配置、布局和 dirty editor 仍由前端原 owner 处理；SessionDirectory 保留原始文件 authority，
切换 Session 不重定向已打开文档的写入。取消以 operation ID 发往同一 connection generation；
窗口关闭、取消和停用均释放属于该连接或 activation 的进程树。

创建先由 Provider 运行官方 CLI 的 `up`，确认容器内 `ash-remote-server` 可用，
完成真实 initialize 握手和 Session 目录读取后再发布规范化目标。网关只启动已准入的 Provider executable，沿既有 App Server
协议转发。Session/Thread 目录、终端、文件、资源 handle 和 Git 保留该执行 authority。
窗口断开释放 stdio 进程树；容器保留以供其他客户端使用。显式 Stop/Remove
结束旧连接；Stop 保留同一记录中的来源授权，重开 profile 后仍能从后端清单选择 Remove。Remove 撤销记录，删除带当前 workspace label 的容器，保留 volumes。
启停策略变更退休旧 activation/route generation，不重放旧调用。

实际使用要求主机安装 Docker 与官方 Dev Container CLI，发行包带有授权的 Remote runtime catalog，或镜像已经提供兼容的 Ash Remote runtime。Provider 不把宿主 Windows executable 复制到 Linux 容器。
若镜像未提供 Ash runtime，Provider 从产品授权的 Remote catalog 自动选择、校验并安装匹配架构与 libc 的包；复用共享下载 helper、安装脚本与 receipt 校验。真实容器启动、执行及重连的待验收项见[Sessions TODO](../TODO.md#sessions--todo)。
详细使用及验证说明见 [Docker Provider](../extensions/dev-containers/README.md)。

## 职责与调用链

| 用户入口                          | 当前调用链与唯一 owner                                                                                                                                                                           | 对齐问题                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 点击 Add tab 中的 Files / Changes | `SessionsLayoutService` 创建并持有 `EditorTitleMenuBridgeContribution`；`registerAddTabActions` 注册 Files / Changes 命令和菜单；回调通过现有队列调用布局控制器及 `DesktopDockedTabsCoordinator` | 已迁回 `addTabActions.ts` 和 `editor.contribution.ts`；布局状态仍只有原 owner           |
| 切换文件或比较标签                | `SessionsLayoutService` 观察活动编辑器，`DesktopDetailPanelCoordinator` 选择 Files / Changes 容器                                                                                                | 已有独立协调器，不能再创建平行的活动编辑器或 Details 状态                               |
| 在 Files 树中打开文件             | Sessions Files contribution → `SessionsExplorerView` → Workbench `ExplorerView` → `IEditorService`                                                                                               | Files 目录路径集合一致；此结论不代表整个 Explorer API 已审计                            |
| 切换会话                          | `ISessionsService` 选择 → `BaseLayoutController` 恢复工作集 → 桌面控制器协调标签及 Details                                                                                                       | 页面组与会话文档组必须继续分离；当前 Ash 替换会话策略不同于上游 transient / pinned 策略 |
| 拖动 Details 分隔线、隐藏编辑器   | `DesktopWorkbenchLayout` 提供尺寸及可见性 → `DockedAuxiliaryBarController` 挂载 Details、更新 sash 和编辑器 inset                                                                                | 几何继续由唯一 owner 提供；Part 按组件分目录保留，不新增桌面 Part 外壳                  |
| Changes 展示和提交                | `SessionChangesEditor` / `ChangesViewPane` → 共享 Chat 服务的 Turn ledger                                                                                                                        | 保留 Ash 后端账本语义；PR checks、同步和创建 PR 已接入，边界见下方功能表                |

点击 Add tab → 编辑器 contribution 与命令注册 → 既有布局操作队列、标签协调器及 `IEditorService` → 打开对应标签并显示正确 Details。原控制器退出命令、菜单和 context key 注册，继续拥有布局操作及会话恢复。窗口布局服务创建和释放两个 owner。

`registerAddTabActions` 的回调契约保留 Ash 既有命令 ID 和窗口生命周期，不伪造上游 `Action2` 类或宣称公开 API 已完全一致；后续 API 对齐须独立核对使用方和生命周期。

## Files 与 Changes

路径相对 `contrib/`。目录保持按组件分组。

| 文件                                                  | 唯一职责与本地调用方                                                                                | 处理结果                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `files/browser/files.contribution.ts`                 | 装配 Sessions 视图目录，注册聚焦、折叠及远程下载动作；main entry 加载，文件下载使用共享 FileService | 保留；容器标识沿用已有公开入口，与上游归属一致                                 |
| `files/browser/filesView.ts`                          | 适配共享 Explorer 视图的标题动作、空文件夹提示；Files contribution 创建视图                         | 保留；文件树和资源打开继续由 Workbench Explorer / EditorService 负责           |
| `files/browser/media/filesView.css`                   | Files 本地 DOM 和空视图布局、token 样式                                                             | 保留；不增加全局布局或复制上游样式                                             |
| `changes/common/changes.ts`                           | Changes 容器和视图标识；注册入口、Details 协调器及无障碍提供者消费                                  | 已从注册入口移入，不含 DOM 或注册副作用；现有 ID 值不变                        |
| `changes/browser/changes.contribution.ts`             | 装配视图容器、Changes 编辑器及无障碍注册；main entry 加载                                           | 已移出共享标识和无障碍内容逻辑                                                 |
| `changes/browser/changesView.ts`                      | 当前可见列表的行、选择、焦点和异步请求生命周期；通过 ChatService 读取不可变 Turn 账本并执行预览操作 | 保留视图状态归属；隐藏时停止刷新、使迟到请求和动作失效，重新显示后读取当前会话 |
| `changes/browser/sessionChangesEditor.ts`             | 输入所指会话的比较编辑器、子 pane、AbortController、视图状态与显隐生命周期                          | 保留；已具备隐藏失效及重新显示刷新行为，测试继续覆盖                           |
| `changes/browser/sessionChangesEditorInput.ts`        | 编辑器资源身份、展示元数据、能力及序列化；标签协调器创建，EditorService 持有                        | 保留；不缓存账本或持有第二套会话选择状态                                       |
| `changes/browser/sessionsChangesAccessibilityHelp.ts` | 定义列表和编辑器的 Help / Accessible View 提供者；注册入口统一注册                                  | 已移入既有四个提供者的内容和焦点恢复逻辑，读取 live pane，不保存内容副本       |
| `changes/browser/media/changesView.css`               | 变更列表本地 DOM 的排版、路径省略和状态文本样式                                                     | 保留                                                                           |
| `changes/browser/media/sessionChangesEditor.css`      | Changes 比较宿主的尺寸及溢出边界                                                                    | 保留                                                                           |

账本和提交操作继续通过 `workbench/services/chat/common/chatService.ts` 的领域契约执行。列表快照、编辑器显示内容各自属于 UI 生命周期，不成为另一份业务账本。`browser/turnMultiDiffSource.ts` 及其 contribution 同时供 Code、Cowork 和共享多文件比较消费，继续留在 Sessions core；将其移到 Changes contribution 会造成 core 反向导入 contribution。

### 已接通的 Changes 能力

Turn 内容、修订和提交状态继续由 ChatService 与后端账本拥有。以下入口已走生产调用链，UI 状态不改写账本证据：

| 用户入口                      | 唯一 owner 与当前行为                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表、摘要、失败重试          | ChangesViewPane 从账本读取文件；同一会话刷新保留焦点和选择，失败清除旧行，隐藏后忽略迟到结果。                                                                                                                          |
| Turn 筛选、List / Tree        | changesViewRenderer 独立构建按 Turn 和目录分组的树，重复路径可独立选择。changesViewActions 注册显示模式命令，ChangesViewService 保存展示状态。                                                                          |
| 逐文件审阅                    | 标记绑定 Session、Thread、ChangeSet、文件和具体 revision；只保留在当前窗口，修订变化不会继承标记，也不改变提交条件。                                                                                                    |
| 视图恢复                      | profile UI state 保存显示模式；窗口内分别保存会话、Turn 筛选和模式的选区、焦点、折叠及滚动快照。Checks 折叠状态按会话恢复。                                                                                             |
| Sync / Publish / working tree | Git 命令绑定会话目录下的确切仓库；pull 后重新核对 branch / remote，失败或切换会话阻止后续 push。Git 提供方返回真实 upstream 和未提交计数，命令边界验证非负安全整数；旧提供方缺失的计数不显示为 0。                      |
| CI checks                     | 可取消地读取关联开放 PR 当前 head 的全部分页 checks 和 commit statuses；账号变更清除旧数据，隐藏释放读取，普通刷新保留链接焦点。                                                                                        |
| 直接创建 PR                   | 准备与写入分离；提交前重核 local head、remote、账号和工作目录。创建后附加到发起会话，附加 / 自动合并失败仅作为已创建结果的警告；不同 published head 不启用自动合并。                                                    |
| Agent 创建 PR                 | createPullRequestChatRequest 在准备上下文复核后向发起 Thread 提交用户显示的字段。空闲 Thread 使用 startTurn，活动 Turn 使用 queueTurn，沿用正常权限。档案状态检查和准备失败不会提交；无法确认写入结果时禁用同表单重试。 |
| PR 表单偏好                   | profile UI state 仅保存 Draft、合并方式和主操作，不保存标题、正文、路径或账号。恢复时受当前仓库能力限制，未支持的合并方式及 Agent 入口不会恢复为有效操作。                                                              |
| Help / Accessible View        | 使用实际表单、树和状态内容，中英文覆盖新增控制。键盘支持树折叠、文件选择、表单焦点循环和取消后的焦点恢复。                                                                                                              |

ChangesViewService 当前只拥有上述展示状态及修订绑定的 read marker；它不是上游 provider changeset / isolation / feedback 的聚合服务。`reviewedFilesObs` 由树和无障碍内容消费，没有第二份业务账本。Agent 请求成功只表示任务已提交，不表示 PR 已创建，也不提供后台合并策略。

共享 multi-diff 的来源替换会取消旧模型的就绪等待；等待捕获所属代次的取消信号，防止已经释放的模型让编辑器一直停在 pending。SessionChangesEditor 在加载子比较前提供视口，并传递宿主输入取消信号。Turn / commit 源、来源操作和内容标签仍在已确认的共享 Sessions core 中，服务 Code 和 Cowork。

## 契约边界与验证

ChangesViewService 只拥有 Turn 展示状态和修订绑定的 read marker。Ash 的 Session／Thread、稳定 EditorInput 与上游 session URI／provider changeset 模型不同；共享 multi-diff 来源和标签保留在 Sessions core，服务 Code 与 Cowork。没有对应 DOM 的 label 样式、没有消费者的 facade 和独立 Part 不创建外壳。持续合并策略与 CI 操作仍需后端工作流契约，见 [Sessions TODO](../TODO.md#sessions--todo)。跨客户端审阅、provider changeset、隔离与反馈评论保留在[发展候选（未排期）](../TODO.md#发展候选未排期)，尚未实现，不要求按上游身份模型批量补 API。

扩展宿主注册在 `workbench/api/browser/extensionHost.contribution.ts`，按依赖就绪顺序装配。Sessions 使用窗口唯一 Plugin 实例及 disconnected API；AppTools 复用 Task／Terminal，入口装配 Task、Output 和 Marker registry，各窗口自行选择视图注册表。Sessions 加载标准 editor.all，避免 Diff breadcrumbs 缺少注册；窗口错误与 rejected promise 终止于日志服务，释放时恢复原处理器，防止错误重新抛出形成消息递归。

已有验证记录：Changes 定向单测 75 项（含 37 项架构检查），Changes／Sessions／viewpaneLayout 浏览器 31 项，错误处理与架构回归 54 项通过。真实 Electron 的部分提交、完整提交和返回原会话继续提交连续 3 次通过，核对独立 Turn 账本、文件内容与 Git 提交。Common 浏览器 4 项、Provider 单测 2 项／真实 SDK 进程 5 项、网关 11 项及 profile 准入 2 项通过；Docker／CLI 使用受控脚本，不能据此宣称真实容器验收通过。

2026-10-19 在 Windows 11 23H2 x64（22631.6199）、Node 24.21.0／pnpm 12.8.0，以 `01325b8c1ea3c2fb11c6e889dc72d79620a70fbb` 加本次测试 fixture 修正验证标准 unit runner。编译入口 `pnpm test:unit --run src/ash/sessions/test/browser/sessionsCommon.test.ts` 通过 6 项；修正菜单注册基线、Trace 命令装配和配置元数据断言后，复用新编译产物执行 `pnpm test:unit:no-compile --runGlob 'src/ash/sessions/**/test/**/*.test.js'`，76 个文件共 939 项通过，退出码 0。`node --test build/processes.test.ts` 的两个 Windows 清理回归通过、四个 Unix 专用用例跳过，未复现历史 CIM 超时；没有增加超时或绕过标准进程清理。日志与环境记录在 `.build/todo-windows-20261019/` 的 `sessions-common.log`、`editor-contribution-fixed.log`、`common-fixtures-fixed.log`、`sessions-all-fixed.log`、`processes.log` 和 `environment.json`。原直接 Mocha 203 项仅保留为历史范围，不再作为标准命令通过的依据。

布局回归入口为 [sessions-layout.spec.ts](../test/smoke/areas/sessions/sessions-layout.spec.ts)、[sessions-navigation.spec.ts](../test/smoke/areas/sessions/sessions-navigation.spec.ts) 和 Creator／Library／Code 场景，覆盖真实切换、DOM 实例、未保存文档、键盘帮助、resize 和 reload。历史结果不代表整个上游 API、两端配对场景或当前 HEAD 均已验收。
