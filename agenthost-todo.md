# AgentHost 文件对齐与实施记录

本轮通用服务已按下节的真实调用与领域 owner 闭合；下面各批记录保留其当时的范围和验证。产品差异及真实环境验收由 [AgentHost TODO](TODO.md#agenthost--todo) 维护。保留 Ash 的 Rust 执行与持久化架构，不声明上游 AHP wire protocol 兼容。

## 通用服务端到端闭合 · 2026-10-18

本节取代下面历史记录中的“统一连接、主列表、Chat scope、文件过滤尚未实现”结论。范围为现有通用能力；SDK、续接、模型安装和其他独立产品能力继续由根 TODO 列缺口。这里按公开职责核对实际调用与唯一 owner，不以 Node、state／meta 或同名文件数量判断完成，也不声明兼容上游 AHP wire protocol。

| 公开职责／用户入口                                                        | Ash 生产契约与唯一 owner                                                                                                                                                                       | 本次闭合                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IAgentHostService` 的 ambient connection、启动／退出、恢复；额外宿主连接 | `IRendererHost.agentHosts`、`AgentHostConnectionsService` → Renderer scope → 既有 Local／Remote lease、Main carrier 与 Rust daemon                                                             | 统一窗口连接投影，canonical SSH host＋root 去重；pending 关闭、迟到 OPEN、同步事件关闭、目录重绑失败和恢复均沿原连接生命周期；Main 不解析领域协议。                                                                                                                                              |
| `IAgentService` 的 Session 列表、创建／读取／关闭和 Chat 归属             | `IAgentSessionService`、`AppServerSessionsProvider` → `session/*` → Rust Agent processor／ThreadController／持久 Session store                                                                 | Provider registry 驱动统一主模型；附加宿主的 Session／Thread 使用可逆限定身份，后端仍用原始 ID；主列表按宿主分组，新建选择宿主，导航、重命名、归档、删除和草稿按原 owner 执行。                                                                                                                  |
| 消息执行、取消、历史、fork、排队、审批／交互                              | `IChatService`、`IAgentThreadService`、`IAgentTurnService` → `session/thread/*`、`turn/*`、`queue/*`、交互契约 → Rust core、queue、ThreadController                                            | Sessions Chat／thread 路由捕获 Provider，读取和写入显式反解原始 ID；事件、goal、origin 和 transcript 投影限定身份；retained Code／Cowork pane 持有对应 child scope，关闭后不转发到 ambient。                                                                                                     |
| root／Session state 的订阅与元数据                                        | 原 Rust catalog、UpdateBroker／subscriptions、Thread snapshot／transcript 与现有 Chat 模型                                                                                                     | 保持一份持久业务事实；前端只聚合展示和连接生命周期。上游 reducer、meta bag 和 Node provider 实现不进入第二份镜像状态。                                                                                                                                                                           |
| 模型、账号、prompt、权限和可选扩展                                        | 各宿主 `model`／`accounts`／`skills`／`hooks`／`executionSettings`／`workspaceTrust` 领域端口                                                                                                  | 会话 pane 与窗口路由使用对应 Provider scope；模型、prompt、Tools／Instructions 目录和权限不借主窗口连接；语音 state／任务投影使用限定身份，启动和任务应答仍回到来源宿主的原始坐标。原 Rust provider 和扩展运行时仍是 owner。SDK 专属认证、Copilot entitlement 和远端 Guardian 安装属于产品缺口。 |
| 文件与 opaque 附件／工具资源                                              | `IFileService` → `AgentHostFileSystemProvider` → 原宿主 `fs`＋`resource`；thread resource 使用原始 Session／Thread 坐标                                                                        | 历史 Session worktree 挂载随 Provider 生命周期释放；相同路径不同宿主隔离；图片、App、工具资源和 trace 调用回到来源宿主。                                                                                                                                                                         |
| renderer 已选择的文本附件快照                                             | `AgentHostResourceService` → 正式 `hostResource/read`／`hostResource/release` → Rust 输入准入                                                                                                  | capability 协商后以 connection-owned 随机 handle 分块读取不可变快照，校验长度、偏移、base64、hash、UTF-8、期限及读取次数后转为原 durable Context；handle 不持久化。未协商时保留既有 inline Context。不存在允许远端任意读取本机路径的文件接口。                                                   |
| Quick Open 文件 include／exclude 与文件名交集                             | 现有 Search 设置 → `QueryBuilder`／`AgentHostFileSearchProvider` → `file/glob`／`file/fuzzy` → Rust file-search／Browser 遍历                                                                  | 路径过滤与文件名条件在计数、排序预算和截断之前执行；带过滤的 fuzzy 使用当前授权目录发现，避免在有限索引结果之后过滤而漏项；Session 搜索沿来源宿主的 SessionDirectory。                                                                                                                           |
| 历史会话的仓库／PR／Issue                                                 | `ILocalGitService.readRepositoryContexts` → `git/repositoryContexts` → Rust Session directory authorization、原 Git discovery／GitService；`SessionsGitHubService` → 来源宿主 GitHub／accounts | 历史目录不借当前 environment，也不创建第二个仓库 registry／watcher；撤权、取消和晚到结果拒绝；remote root URI 保留 scheme／authority，PR／Issue 写入和账号变化隔离。                                                                                                                             |

复制／打开会话链接通过导航 owner 提供的稳定宿主 authority 与原始 Session／Thread 坐标往返，不把可能很长的窗口限定 ID 写入后端链接字段；会话卸载后拒绝解析到主宿主。已有新建 peer Chat、导出日志与执行轨迹入口也沿同一 Session owner，分页 cursor 的线程键双向转换，opaque payload 保持原样。

上游 Node 执行、state／meta 与生成类型的对应是上述领域职责分流，不是逐文件移植。具体协议源位于 `crates/app-server-protocol/src/protocol/{session,turn,queue,interaction,search,git,host_resource}.rs` 和 registry；前端 transport DTO 仅留在 adapters，产品消费者使用领域契约。现有 Local／SSH／Dev Container provider 沿原 admission／extension owner；Terminal 的并行工作不计入本批。

保留的产品差异：synced OpenPlugin customization／active-client 分发需要独立 producer 与运行策略，当前没有对应执行链；不创建空内存文件系统或通用 live-file broker。SDK 下载／重载、Codex→Copilot 续接、本地模型 lifecycle、独立 Web 启用、Cloud Sandbox、Tunnel／WSL、Mission Control 仍在根 TODO。真实外部账号、跨机器／跨平台和系统休眠验收也继续保留，受控回归不作为这些环境已验收的证据。

验证（macOS，证据目录 `.build/agenthost-complete-20261018/`）：

- 标准 `pnpm test:unit` 完成全项目测试编译，按 `unit-exact-selection.txt` 选择的 33 份实际调用／生命周期及架构测试共 **574 项通过**，包含 API 分层约束；没有仅以 helper 测试代替 Session、Chat、权限、MessagePort 或 RPC 链路。
- `just verify ash-file-search`：14 项库测试、3 项 CLI 测试通过，既有 1 项忽略；`just verify ash-app-server-protocol`：156 项库测试、3 项 export 测试、1 项生成元数据测试通过，含 check／warnings。`just test ash-app-server-runtime host_resource --lib` 的 7 项、`repository_context` 的 2 项、`file_search_filters_are_applied` 的 1 项通过；`just check ash-app-server` 与 `just rust-warnings ash-app-server-runtime` 通过。
- `just generate-protocol` 及 Common 2,777、Renderer 4,340、Protocol 1,679 文件类型检查通过；最终 `pnpm build:prepared` 通过。中文新增文本、权限 Help 和 Instructions 来源回归已覆盖；准备报告剩余 1 项翻译缺项属于本批未改的既有文案。
- Chromium Quick Open 路径过滤 1 项及 Session GitHub／PR／Issue 9 项通过。完整多宿主与英文／中文宿主选择 3 个场景的功能断言已执行通过，实际键盘、EditContext 输入、宿主专属模型选择、保留草稿和卸载均已走到末尾；当前 shared Sessions fixture 的并行 Debug workspace 存储不可用日志会令严格 afterEach 失败，不能将该整体场景报告为通过，也不能将受控测试当作跨机器或真实账号验收。

## Workbench 服务切片 · 2026-10-18

用户明确选择先补通用服务和现有能力，SDK、Codex 续接和本地模型等新产品项列明缺口。本轮三个子代理在原 checkout 并行工作，基线 Ash `3bb4be221`、只读 VS Code `72e9539ed`；保留开始前已有的 Debug、Log、Menubar 等未提交改动。

| 用户行为 → 生产调用方                                                      | 同路径服务与唯一 owner                                                                                                                                                              | 已验证结果                                                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 打开本地、SSH 或扩展远端工作区 → `electron-browser/rendererApi.ts` | 新增 `electron-browser/agentHostService.ts`，Workbench 拥有宿主选择、能力组合和电源订阅；平台 Local／Remote lease 继续拥有连接、恢复和协议代次，Main／Rust 保持进程及领域状态归属。 | SSH 工作区 lease 不可用时拒绝启动；本地设备保留本地连接；远端不继承本地目录授权／Desktop tools；重启重新解析并初始化扩展；释放阻止迟到初始化发布。 |
| Quick Open／附件文件查询 → `SearchService.fileSearch`                      | 新增 `common/agentHostFileSearchProvider.ts`，唯一执行 Workbench 文件查询聚合；平台 `IFileSearchService` 保持授权目标和后端 glob／fuzzy owner。                                     | 保持全局排序、去重、预算与 Session 目录路由；取消及 scope 关闭立即拒绝等待，即使后端尚未返回；预先检查全部查询根，不向未授权根发请求。             |
| 编辑／保存工作区文件 → `browser/workbench.ts`                              | 新增 `common/agentHostFileSystemService.ts`，拥有 `file`／`ash-remote` 成对注册；既有平台 Provider 仍拥有文件执行、路径身份和事件。                                                 | 本地／Browser provider 优先级保持；冲突不覆盖既有 provider；第二项注册失败会回滚；释放只注销，不处置借用的 provider。                              |

三个生产文件均为上游已有、Ash 原来缺失的对应路径，由 Ash 现有调用链独立实现，没有复制上游私有实现。`SearchService`、Workbench／Sessions 创建点和测试 fixture 同批迁移 DI 与释放；新增三个行为测试文件。同路径存在只表示本批职责落位，不代表上游全部公开契约已等价。

验证：8 个文件共 **80 项定向单测通过**，其中新增服务测试 17 项，含实际 MessagePort／socket 连接、重连、pending dispose、注册失败回滚、取消和中文错误路径。标准 `pnpm test:unit` 的全量编译被既存 `debugService.test.ts:2375` 的构造参数错误阻挡；按原 `tsconfig.test.json` 编译选项，仅收窄输入至受影响测试，编译通过后由标准 runner 执行上述 80 项。定向配置保存在忽略目录 `.build/agenthost-workbench-validation/`。17 项层级／App Server 架构测试通过。Common 2,749、Renderer 4,288、浏览器集成 4,255 文件类型检查通过；`pnpm build:prepared` 的 Desktop 构建和 16 个 touched TS 文件格式检查通过。新增文案中文验证通过；本地化报告仍有本批未改的 `ash/path.platformUnavailable` 缺项。未执行真实 SSH／多窗口／系统休眠的产品验收。

复核时撤销了无生产调用方的新文件过滤字段：后端在最多 5,000 个候选之后过滤会漏结果，当前没有相交过滤或分页契约；不把这一未闭合能力放入公开查询。本轮保留既有 glob／fuzzy 语义与实际取消修复。

剩余契约与产品缺口：

- `common/agentHostFileSystemService.ts` 的多 authority 注册已在下面“多 authority 文件服务”切片实现；synced customization 尚无生产消费者，不能预建另一个内存文件系统。
- `common/agentHostResourceService.ts` 需要 renderer 本地文件授权／realpath owner、正式双向 host request 与实际消费者。现有 `IResourceApi` 是后端 opaque bytes，不能改名充当本地授权 broker。
- `browser/editorRemoteAgentHostServiceClient.ts`、`common/editorRemoteAgentHostTransport.ts` 的上游 AHP／Session 协议与 Ash Rust typed protocol 不同。本轮由 Workbench service 接入现有平台远端 lease，不创建第二个 transport 或无消费者 facade；统一宿主管理仍在根 TODO。
- `browser/codexAccountService.ts`：现有多 provider 账号仍归 `IAccountService`／`AppServerAccountService`；Codex 专属 root state、头像及 SDK 状态尚无等价契约。`browser/codexContinuation.ts`、`codexContinuationService.ts` 还缺配额新鲜度、Copilot entitlement、Session／model 配对与跨窗口 reservation。正式 `account/rateLimits/read` 已存在，但前端账号契约尚未接入，不能据此宣称续接已实现。
- `browser/agentSdkSetupService.ts` 缺 SDK 下载／重载领域契约；`common/localModelService.ts`、`browser/localModelService.ts` 缺安装／下载／server lifecycle 后端 owner。按用户决定保留为新产品缺口。
- `browser/webAgentHostEnablementService.ts`：当前 Web 可用性仍由 transport／initialize 和 `hasAppServer` 表达，独立设置／context-key owner 尚未建立，不用一个恒真服务冒充启用能力。

## 多 authority 文件服务 · 2026-10-18

本轮继续用户已选的通用服务范围，三个子代理协作补齐平台路由、Workbench／Sessions 装配和 Main 租约取消，保留同 checkout 的 Debug／Log 等并行改动。

准入链：现有“管理已连接宿主”命令 → `SSHAgentHostContribution` 的独立 backend scope → `IAgentHostFileSystemService.registerAuthority` → 平台 `AgentHostFileSystemProvider` 的唯一 authority／授权根注册表 → 现有 Chat Markdown 远端文件链接或 URI 拖入 → Editor／`IFileService`。本轮不依赖尚未实现的远端 Session 选择。

- `platform/agentHost/common/agentHostFileSystemProvider.ts` 在原文件独立实现注册表；每个连接沿用原文件读写、大小写与 opaque resource owner。authority 按 URI 比较语义处理大小写，同 authority 多根按最长根匹配，重复根拒绝覆盖。注销保留根身份作为屏障，旧 URI 即使被主工作区重新投影也不会回落到另一连接；重连后重新注册可取得新路由。
- Workbench 的同路径 `common/agentHostFileSystemService.ts` 提供服务标识和 `registerAuthority`，只拥有挂载句柄；Workbench／Sessions 启动入口各注册一个实例。SSH scope 在 `agent-host:<scope id>` 环境根初始化后挂载对应文件域，关闭时先卸载，再释放原连接。事件、路径身份和流读均归所属连接；没有新增窗口以外的进程或第二份业务状态。
- pending 查询在卸载或换代时及时取消；目标解析的 await 之后、实际后端写入之前再次检查生命周期，避免已关闭 scope 继续派发写操作。流读及时结束，同时让原连接负责释放迟到的 snapshot，资源 ID 不发到新连接。该切片当时拒绝跨连接 copy／rename；下面“通用复制与权限取消”已接通 copy，rename 仍拒绝。
- `platform/remote/electron-main/remoteConnectionIpc.ts` 仍是 pending lease 的唯一 owner；关闭、导航重置或 dispose 会立即结束等待 catalog 的 OPEN，而不等待旧目录请求返回；迟到结果／失败不会创建 carrier 或影响同 ID 的新租约。

最终验证合计 **128 项**：最新受影响文件／路径／scope 回归 7 文件、102 项通过，未再变化的 Main 租约 9 项和层级／App Server 架构 17 项复用先前通过结果。新增平台测试 10 项、Workbench 服务现 7 项、SSH contribution 现 8 项；均经原编译选项的定向 `tsc` 编译后由标准单测 runner 执行。初轮两项失败来自新测试 fixture 未实现默认字节读写的完整资源链；补齐 binary snapshot／read／release、持久字节与 revision 后，默认读取及 Unicode 写入断言通过，没有改用文本捷径。配置位于 `.build/agenthost-authority-validation/`。

Common 2,752 文件检查、10 个改动 TS 文件 formatter 和 whitespace 检查通过；新增冲突错误已通过真实中文语言包验证。Desktop `pnpm build:prepared` 通过，日志 `build-final.log` 位于上述证据目录。该切片验证时，全量测试编译、Renderer 和浏览器集成代码类型检查受并行 Debug 代码阻挡：`debugSession.ts` 的 `exceptionBreakpoints` 重复声明／调用、`rawDebugSession.ts` 缺 `DebugExceptionsSnapshot`，以及 adapter 的生成 exceptions 类型缺 `appliedFilters`；这些文件未由本轮修改。受影响 2,339 文件的定向编译／检查通过。未执行真实跨机器 SSH 或窗口 UI 验收，不把受控后端测试计为这些环境已验收。

剩余范围：renderer 本地文件权限 broker、synced customization 的实际 producer、统一宿主管理，以及远端 Session 选择后的 Chat／模型／搜索／仓库／权限 scope 仍按根 TODO 推进。本轮只接通完整 URI 的文件域，未把远端 Session 开放保护去掉。

## 通用复制与权限取消 · 2026-10-18

本轮继续现有能力，并准备提交本聊天累计的 AgentHost 服务改动。三个子代理分别补跨连接复制、权限生命周期和独立复核；未新增无生产消费者的 resource broker、synced customization 或搜索路由。

- 现有 Explorer 粘贴／拖入复制 → `FileService.copy` → 平台文件 dispatcher。无附加连接时保留原生 copy；挂载附加连接后撤下整个 namespace 的原生 copy 能力，让 `FileService` 复用既有跨 provider 字节／目录复制算法；最后一个挂载退出后恢复能力并通知消费者。没有捕获原生失败再重放。通用递归复制在写入前拒绝目录自身／子目录目标；跨 authority、同 authority 不同根、目标冲突、目录失败回滚、单次写入和资源释放均有回归。跨连接 rename 仍拒绝。
- 连接退出 ready → `initializeWorkspaceDirectories` 取消本次权限等待 → `IWorkspaceTrustRequestService` 的可选 signal → `DirectoryPermissionDialog` 复用现有 Dialog abort 链。IPC 返回前即占有请求；取消同步撤下 modal、释放请求槽位并恢复焦点；旧 IPC 和 finally 不会关闭下一请求。迟到选择／拒绝不产生 grant 或目录写入，后续请求可正常打开并通过键盘确认。

验证：18 文件累计 **220 项定向单测通过**。首轮标准入口完成全测试编译，复制测试有两项 Buffer／Uint8Array 类型断言差异，统一实际字节类型后 57 项文件测试全过，其余 163 项复用原通过结果。重跑标准编译时碰到并行 `debugTerminalLauncher.test.ts` 的重复 LabelService imports，未修改该文件；改用已存在的同编译选项定向项目编译后执行 57 项，配置在 `.build/agenthost-authority-validation/`。权限取消另外有 **2 项真实 Chromium 测试通过**，覆盖 modal 移除、焦点恢复、后续权限和旧 metadata 迟到。

Renderer 4,291、Common 2,752、浏览器集成 4,264 文件类型检查及 Desktop `pnpm build:prepared` 通过。日志 `.build/agenthost-commit-validation/{unit,unit-copy-final,unit-copy-targeted,build-final}.log`；浏览器结果 `.build/desktop/playwright/editor-browser-BuEd2W/`。当前未验证真实外部 SSH、跨平台复制或系统休眠，不将受控 scope 测试计为实际机器验收。本次提交仅包含本任务改动，按仓库提交门禁核对；门禁结果以提交交付报告为准。

## 通用服务作用域契约 · 2026-10-18

本批基线 Ash `972bb6e28`，继续用户已确认的通用服务范围，三个子代理分别推进宿主恢复、文件查询与复制作用域；保留其他正在进行的改动。没有新增产品入口、Renderer 本地资源 broker 或 synced customization。

- 工作区运行时替换 → 平台 Local／Remote host 恢复 → `rendererApi.ts` 重绑当前工作区目录。扩展远端的 `onDidReconnect` 只在首次成功之后、当前代次的扩展初始化完整成功时发布；SSH 使用选中的 workspace carrier，本机设备连接恢复不重绑远端目录。失败沿原日志 owner 记录，下一次恢复仍能重试。测试通过真实 Renderer 装配、MessagePort 与现有 `config/directoryGrants/read`／`env/dirs/set` 端口观察实际目录重绑，不只测试事件次数。
- Quick Open／附件与 Search View → 文件名／文本查询 → 当前 Workspace snapshot。每个 pending 查询借用其启动时的不可变工作区快照；工作区替换、同 URI 换目录 ID、服务释放或调用者取消立即退役旧等待并阻止迟到进度。事件处理读取 Workspace owner 的当前快照，保留更早监听器或嵌套替换已经启动的新查询；没有第二份工作区状态。文本查询的取消继续传到现有 App Server 搜索 job 的 cancel／release；同批进度回调里切换工作区或关闭服务会停止后续发布。
- Explorer 复制 → `FileService.copy` → 可选的 `IFileSystemProviderWithCopyScope`。平台 `AgentHostFileSystemProvider` 为整个递归复制固定原始连接、代次和路由；每次执行与目标解析后的 dispatch 都验证作用域，不跨越其他嵌套挂载，也不重新选择替代连接。复制整体取消与目标连接存活分别表达：源连接退役会阻止迟到目标写入，原目标仍有效时可以清理；目标退役则不对新连接执行回滚。无关挂载的变化不取消复制。普通 provider 和原生 copy 快路径保留。已经派发的后端写入仍可能完成，这不是跨连接原子事务；不自动重放，跨连接 rename 继续拒绝。

准入路径为既有 `platform/agentHost/{browser/remoteAgentHostServiceImpl.ts,common/agentHostFileSystemProvider.ts}`、`platform/files/common/{files.ts,fileService.ts}`、`workbench/electron-browser/rendererApi.ts`、`workbench/services/agentHost/common/agentHostFileSearchProvider.ts`、`workbench/services/search/common/searchService.ts` 及对应原测试、台账和 TODO。对应平台／Workbench 文件按已有职责原地修改；Ash 自有文件领域、Renderer 和正式协议保留既定 owner；未更改 Rust、生成 DTO、协议版本、进程拓扑或目录授权规则。

重新核对的前置缺口保持开放：正式双向宿主请求注册表没有 Renderer 本地文件资源请求；`IResourceApi` 只承接后端 connection-owned opaque bytes。Rust `CanonicalPathRoot`／file-access 可复用，但尚无贯通的 Renderer host-resource 身份、realpath／授权 owner 与生产消费者。synced customization 仍无 producer。Workbench 文件查询仍无 include／exclude producer；现有 Tasks problem matcher 已将根、文件 suffix 和排除下推为单个 glob，不以它制造新的交集契约。SDK、账号配额续接、本地模型和独立 Web 启用等产品项继续按根 TODO 保留缺口。

验证：11 文件的定向测试累计 **163 项通过**，覆盖上述真实 Renderer／MessagePort、文件复制与资源释放、搜索 job cancel、重入进度以及层级／App Server 架构。首次标准 `pnpm test:unit:prepared` 完成前置检查时碰到并行 `platform/dialogs/test/electron-main/dialogMainService.test.ts:168` 的 `filePath` 类型错误；本批新搜索测试的 readonly ranges fixture 也一并修正。随后用原 `tsconfig.test.json` 选项收窄输入编译，标准 runner 执行 163 项时仅一个新复制断言遇到 Buffer／Uint8Array 类型差异；保留完整字节比较并统一类型后，62 项 FileService 测试重跑全过，其余 101 项沿用同轮通过结果。早期 Renderer fixture 曾因持久日志追加错误消息导致精确匹配超时，已改为匹配消息前缀与错误内容并增加有界截止时间，最终两个真实装配恢复用例通过。配置位于 `.build/agenthost-contracts-20261018/tsconfig.json`，日志为同目录 `{search-red,services-green,units-final,units-targeted,copy-final}.log`。

Common **2,761**、Renderer **4,300** 文件类型检查通过，Desktop `pnpm build:prepared` 通过；见同目录 `common-final.log`、`renderer-final.log`、`build.log`。本批没有改 UI、产品文案、协议或 Rust；未执行真实外部 SSH、OS sleep／wake、跨平台或多窗口产品验收。提交门禁的具体结果随交付报告列出，不将未纳入本提交的其他工作树错误记为通过。

## 当前文件台账 · 2026-10-18

首次盘点基线为 Ash `9cdd17c01337eae7119cb62d04d94e1679aee588` 与只读参照 `../vscode` 的 `2de8dcf8062d43587ee1c552d60b099a58e5c9ef`。下面数量保留首次盘点快照，包含当时的重连策略、领域数据拆分、文件 Provider 迁移及新增回归；本轮 Workbench 的局部复核与新增行在 TSV 的 `reviewScope` 单独记录，不据此重新推断其他目录的最新数量。开始时及实施过程中已有 Terminal、Notifications、Sessions 测试、编辑器路线图与根 TODO 的并行变化，本次保留这些变化。

[完整文件清单](docs/research/agenthost-file-alignment-2026-10-18.tsv) 逐行记录路径、双方存在关系、源码类别、职责分组、审查状态、双方顶层导出名称（含再导出）、Ash 直接生产引用路径及本批复核范围。路径分别相对 `src/ash/` 与 `src/vs/`。查询覆盖 Git 管理或非忽略的现有 `.ts`／`.css` 文件，选择路径中包含 `agenthost` 的项，忽略大小写：因此包含完整 AgentHost、RemoteAgentHost、AgentHostFilter 目录及同名相邻文件，不把语义相关但名称不同的 Chat／Rust 文件混入存在性统计；后者按下表记录真实 owner。

| 范围                                                | Ash 生产 / 测试 | VS Code 手写生产 / 生成 / 测试 | 双方同路径生产文件 |
| --------------------------------------------------- | --------------- | ------------------------------ | ------------------ |
| `platform/agentHost/`                               | 41 / 19         | 824 / 891 / 605                | 7                  |
| `workbench/services/agentHost/`                     | 0 / 0           | 13 / 0 / 11                    | 0                  |
| `workbench/contrib/chat/` 中名称含 AgentHost 的路径 | 0 / 0           | 135 / 0 / 81                   | 0                  |
| `sessions/contrib/providers/agentHost/`             | 5 / 1           | 43 / 0 / 29                    | 1                  |
| `sessions/contrib/providers/remoteAgentHost/`       | 2 / 1           | 41 / 0 / 22                    | 2                  |
| 其他同名相邻路径                                    | 7 / 1           | 22 / 0 / 15                    | 6                  |
| 合计                                                | 55 / 22         | 1078 / 891 / 763               | 16                 |

原始清单共 2790 行：1062 个仅上游的手写生产文件、39 个仅 Ash 的生产文件、16 个双方同路径生产文件，另有 891 个生成文件和 782 个测试／fixture 源码。本轮新增一行 Ash 文件注册测试，当前 TSV 为 2791 行数据。生成文件包括 888 个 `node/codex/protocol/generated/` 文件与 3 个协议生成文件，不属于前端手写文件补齐队列。

`both` 只表示同路径存在；`pending-review` 表示尚未完成公开契约、owner 与行为复核，不能计为已对齐。`ownership-migrated` 表示唯一 owner 和调用方迁移完成，`verified-slice` 表示仅说明栏中的行为已验证，均不表示整份上游 API 等价。`todo-by-user` 表示用户决定先记 TODO 的新产品文件，当前有 66 个生产文件和 39 个测试；`reference-only` 用于其余生成物和测试，不表示对应能力已经实现或无需测试。直接引用数包括类型导入、再导出、字面量动态导入和模块 URL，不等于生产运行证明；例如 Worker 由 `appServerFrameDecoder.ts` 的 URL 创建，Sessions contribution 由两个 Code 启动入口动态加载，不能把没有静态 import 的文件判成无调用方。

### 同路径文件的实际差异

| 路径                                                                                                             | 当前 Ash 调用链与结论                                                                                                                                                           | 下一步                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `platform/agentHost/common/reconnectPolicy.ts`                                                                   | 本次完成策略切片；Web 装配 → `AppServerConnectionRecovery` → 策略计算。对齐策略接口与两个公开函数，Desktop 保留原固定退避。                                                     | 不增加无调用方的 `DEFAULT_RECONNECT_POLICY`；该文件以本批验证范围计完成。                                |
| `platform/agentHost/common/agent.ts`、`agentService.ts`                                                          | 已把 101 项既有领域数据声明迁入 `agent.ts`，29 个源码／测试调用方迁入；原 service 文件只保留服务与 ID，领域边界有架构检查。                                                     | 本批职责拆分完成；上游 `IAgentService`／`IAgentHostService` 宿主管理契约仍未等价，按真实消费者继续复核。 |
| `platform/agentHost/common/agentHostFileSystemProvider.ts`                                                       | 已按用户批准迁移唯一 Provider 并改名 `AgentHostFileSystemProvider`，更新 7 个源码／测试调用方；common 编码不再使用浏览器 `btoa`。                                               | 迁移完成，旧 browser 路径及类名零源码引用；不宣称 Ash Rust 文件协议等价于 AHP。                          |
| `platform/agentHost/browser/remoteAgentHostServiceImpl.ts`                                                       | 已修复本地宿主重启发生在远程地址解析／扩展初始化期间时丢失恢复的问题；本轮进一步取消旧初始化等待，新代次不依赖旧回执返回；断线／释放及时退役，Renderer 只接收当前代次扩展结果。 | 该生命周期切片完成；上游多端点查找、分组及窗口服务契约仍待复核。                                         |
| `platform/agentHost/electron-browser/localAgentHostService.ts`                                                   | Renderer 装配 → socket lease → Rust App Server；上游同名类还承接 AHP 宿主管理。                                                                                                 | 保留本地 lease owner；逐个追踪确有消费者的管理能力，不能把目录同名当成 AHP 兼容。                        |
| `platform/agentHost/common/openSessionLink.ts`                                                                   | Chat 复制／渲染与宿主打开使用显式 connection／Session／Thread ID。上游还有外部链接、turn 链接与展示契约。                                                                       | 分别核对复制→点击→目标定位及外部 URI handler；不能把上游 URI 身份直接替换后端 ID。                       |
| `sessions/common/agentHostSessionsProvider.ts`                                                                   | `AppServerSessionsProvider` 的提供方契约；缺少上游同文件的远程分组、配置解析等端口。                                                                                            | 与 Provider 切片一起审核真实消费者，不新增无调用方成员。                                                 |
| `sessions/common/agentHostSessionWorkspace.ts`                                                                   | 现有选择器、GitHub、Changes 与 WorkspaceContext 共用目录转换；SSH 使用 canonical authority，host `local` 与本地目录隔离，Provider Windows URI 可往返。                          | 目录身份切片完成；上游 branch protection 等仓库契约仍需真实 owner 和消费者。                             |
| `sessions/common/devContainerAgentHostService.ts`                                                                | Sessions 的 Dev Container actions → 本地 service；上游 target／connector／配置契约更广。                                                                                        | 沿现有 Remote 扩展与容器连接所有权复核，不新增第二个容器连接表。                                         |
| `sessions/contrib/providers/agentHost/browser/agentHostAutomationStore.ts`                                       | 现有 Provider → Automation 后端；迟到保存／删除／停止／调度回执不再覆盖重连后缓存，旧取消句柄不操作新连接，旧只读结果取消。                                                     | 连接代次切片完成，7 项新增公开入口回归通过；调度与持久事实仍归 Rust。                                    |
| `workbench/contrib/terminal/browser/agentHostOutputChannel.ts`、`agentHostPty.ts`、`agentHostTerminalService.ts` | 终端实例／backend → 当前 Rust Terminal 执行契约；上游使用 AHP Terminal。                                                                                                        | 独立核对终端契约；本次不修改正在进行的 Terminal 工作。                                                   |

### 仅 Ash 文件与现有归属

下列 39 个生产文件完整对应清单的 `ash-only` 项。本表记录现状和后续路由，不替未完成的职责复核作保留／移动／删除决定。本次已按用户批准将唯一文件 Provider 从 browser 迁至上游对应 common 路径并删除旧文件；其余专属归属不因文件数量而迁移。

| 目录与准确文件名                                                                                                                                                                                                       | 当前 owner / 生产入口                                                            | 处理范围                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/agentHost/browser/`：`appServerProtocolClient.ts`、`appServerRequest.ts`、`appServerFrameDecoder.ts`、`appServerProtocolDecoding.ts`、`appServerProtocolWorkerMain.ts`                                       | Renderer adapter → 窗口协议客户端 → decoder／Worker；Rust 生成契约负责线上类型。 | 保留已明确的 App Server 协议职责；重连策略本次移到 common 文件，协议状态与定时器仍归原 owner。                                        |
| `platform/agentHost/common/`：`appServerApi.ts`、`appServerEnvironment.ts`、`appServerError.ts`、`appServerProtocolCompatibility.ts`、`appServerTransport.ts`                                                          | 各领域 adapter、Renderer 装配与协议客户端共用连接契约。                          | 按 Ash 协议复核；不改名冒充 AHP。                                                                                                     |
| `platform/agentHost/browser/`：`appServerSocketTransport.ts`、`appServerWebSocketTransport.ts`；`electron-browser/`：`appServerMessagePortTransport.ts`                                                                | Local／Remote service 与 Web 装配取得并持有 transport。                          | 保留现有 carrier；对照上游 transport 时单独核对认证、代次、关闭与资源回收。                                                           |
| `platform/agentHost/electron-main/`：`appServerConnectionRelay.ts`、`appServerProcessLauncher.ts`、`appServerBrowserHost.ts`；`electron-browser/`：`appServerBrowserHost.ts`；`node/`：`childProcessJsonlTransport.ts` | Electron 应用／窗口 → 连接转发与浏览器宿主；daemon 生命周期归 Rust。             | 不迁入 Node agent runtime；宿主端口、carrier 与 daemon 职责分别复核。                                                                 |
| `platform/agentHost/browser/`：`appServerAgentService.ts`；`common/`：`agentModels.ts`、`agentToolsApi.ts`、`agentExecutionSettingsService.ts`、`approvalModes.ts`、`automation.ts`                                    | Chat／Sessions／模型选择／工具调用与设置消费者使用各自领域契约。                 | 领域数据已迁入同路径 `common/agent.ts`，服务契约保留 `agentService.ts`；模型、工具、设置和 automation 专属职责继续按真实 owner 复核。 |
| `platform/agentHost/browser/`：`appServerAgentModels.ts`、`agentToolsApi.ts`、`appServerExecutionSettingsService.ts`、`appServerAutomationService.ts`                                                                  | Workbench Renderer 装配 → model／tools／config／automation 的现有 Rust owner。   | 核对领域 adapter；不新增另一份目录、配置或 automation 状态。                                                                          |
| `platform/agentHost/common/`：`extensionBackendApi.ts`、`extensionHostApi.ts`；`browser/`：`extensionBackendApi.ts`、`extensionHostApi.ts`、`extensionHostProtocol.ts`                                                 | Renderer 扩展客户端 → Rust 监管的 extension fleet／invocation。                  | 属于扩展接入链；上游 `agentHostExtensionProtocol.ts` 不能按名称直接替代，另核对 provider／客户端对象边界。                            |
| `sessions/contrib/providers/agentHost/browser/`：`appServerSessionsProvider.ts`、`appServerTeamsProvider.ts`、`sessionFileService.ts`、`workbenchSessionsService.contribution.ts`                                      | Sessions Workbench、Provider 与 Code 启动贡献 → 后端 Session／Team／文件领域。   | 先核对 `baseAgentHostSessionsProvider.ts`、local provider 与 contribution 职责；保留 Ash Session／Thread 身份，团队专属能力单独记录。 |
| `sessions/browser/devContainerAgentHostService.ts`                                                                                                                                                                     | Sessions Workbench → Dev Container actions／Remote 连接。                        | 对照上游 connector 调用链核对最终 owner；本次未迁移。                                                                                 |

### 剩余上游职责与实施顺序

| 顺序与清单分组                                    | 需要核对的准确入口                                                                                                                                                       | Ash 当前 owner、缺口与准入条件                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · 连接服务，`platform-client`                   | `common/remoteAgentHostService.ts`、`common/agentHostConnectionsService.ts`、`browser/agentHostConnectionsService.ts`、`browser/agentHostProtocolClient.ts`              | 先沿 Renderer 的 Local／Remote service 及 `platform/remote` 确认窗口连接／端点注册契约，再处理现有同路径文件。App Server 请求配对继续由现有客户端拥有；AHP 协议客户端不能另建平行实现。                                                                                                                                                          |
| 2 · Workbench 服务，`workbench-services`          | `common/agentHostFileSystemService.ts`、`agentHostFileSearchProvider.ts`、`agentHostResourceService.ts`、`electron-browser/agentHostService.ts`，以及清单中另外 9 个文件 | Workbench 宿主组合、文件注册及文件搜索切片已落到同路径服务并验证，范围见本轮记录；多 authority 文件路由已继续接通；renderer 本地资源授权和统一宿主管理仍缺前置契约；SDK、账户 continuation、本地模型与独立 Web 启用按用户决定先列产品缺口。                                                                                                      |
| 3 · Sessions Provider，`sessions-provider`        | `browser/baseAgentHostSessionsProvider.ts`、`localAgentHostSessionsProvider.ts`、`localAgentHost.contribution.ts`、`electron-browser/agentHost.contribution.ts`          | 当前调用方在 Sessions Workbench 与 `AppServerSessionsProvider`。先闭合共同提供方端口、创建／订阅／关闭及身份映射，再处理 picker、文件、fork、权限、PR 与 automation；42 个上游独有文件均未计为完成。                                                                                                                                             |
| 4 · Code Chat，`workbench-chat`                   | `browser/agentSessions/agentHost/`、`browser/remoteAgentHost/` 与相关 actions／测试                                                                                      | 当前由 ChatService、Chat widget、LanguageModelsService 与 Sessions invitation 等不同 owner 承担。先记录每条用户入口和真实缺失行为，再确定对应文件；完整 135 个生产文件见清单。                                                                                                                                                                   |
| 5 · 远程与相邻服务，`remote-provider`／`adjacent` | `sessions/contrib/providers/remoteAgentHost/`、`sessions/services/agentHost/`、`sessions/services/agentHostFilter/`、相邻 Dev Container／Terminal／Chat 入口             | 当前复用 `platform/remote`、扩展解析与单窗口 App Server 连接。多 host 分组、筛选、隧道及 cloud sandbox 不能因上游有文件就视作现有能力；先确定真实连接 producer 与状态 owner。                                                                                                                                                                    |
| 后端分支 · `backend`／`protocol-state`            | `platform/agentHost/node/`、`common/state/`、`common/meta/`                                                                                                              | 454 个 Node 手写文件与 190 个 state／meta 手写文件按 Thread／Turn／权限／存储／工具／provider 职责分别核对 `crates/core`、`crates/state`、`crates/app-server-protocol`、`crates/model-provider`、`crates/models-manager`、`crates/subscriptions` 等现有领域。当前只是路由，尚未逐文件证明能力等价；不移植 Node runtime、AHP reducer 或生成协议。 |

### 本次完成的重连策略切片

Web 连接断开 → `connectWebRendererApi` 创建的 `AppServerConnectionRecovery` → `common/reconnectPolicy.ts` 的策略契约与计算 → 原调度器持有定时器、重试计数和睡眠预算 → 原协议客户端替换连接。新策略文件不持有连接或业务状态。Web 保持 500 ms 起步、10 秒封顶、五分钟恢复预算；Desktop 原固定重试与业务请求不重放的行为继续由既有测试验证。

允许修改的生产路径为新 `src/ash/platform/agentHost/common/reconnectPolicy.ts`、现有 `src/ash/platform/agentHost/browser/appServerProtocolClient.ts` 的策略参数／调度分支，以及 `src/ash/workbench/browser/webRendererApi.ts` 的 Web 策略构造；测试修改限于 `src/ash/platform/agentHost/test/browser/appServerProtocolClient.test.ts`。旧 `delay(attempt)` 回调契约已从源码调用链退出，没有兼容别名。

- `pnpm test:unit --run src/ash/platform/agentHost/test/browser/appServerProtocolClient.test.ts --run src/ash/platform/agentHost/test/browser/remoteAgentHostService.test.ts --run src/ash/platform/agentHost/test/browser/appServerSocketTransport.test.ts`：最终标准入口 68 项通过，0 个失败文件。新增真实恢复调度回归验证退避封顶、次数耗尽、显式重连重置，以及关闭自动恢复时唤醒仍等待显式连接；既有恢复、休眠、迟到结果和 socket 清理回归继续通过。过程中标准编译曾被并行 Terminal 的 `IQuickInputService.pick` 类型错误阻塞，定向同配置编译通过，随后标准命令重跑也通过。
- `./node_modules/bun/bin/bun.exe check -p tsconfig.renderer.json --all`：4210 个文件无类型错误；`pnpm build:web` 正常构建通过。本批没有改 Rust 协议、Main relay、UI、翻译或运行系统休眠。文件清单和引用图不替代产品验收。
- 台账生成器、公开导出／引用边与本批命令日志位于 `.build/agenthost-evidence/file-alignment-20261018/`；测试与生成物只保留证据，不复制上游实现。

### 远程扩展初始化退役 · 本轮完成

基线 Ash `01325b8c1ea3c2fb11c6e889dc72d79620a70fbb`，VS Code `2de8dcf8062d43587ee1c552d60b099a58e5c9ef`；开始时工作树干净，完整 Platform 目录存在关系与原始差异保存在 `.build/agenthost-alignment-20261018/`。本轮链路：Desktop Remote 连接 → `createElectronRendererApi` → `RemoteAgentHostService.connect/whenConnected` → 现有协议客户端和扩展初始化 owner → 本地重启后无需等待旧初始化即可恢复；释放／断线及时结束旧等待，迟到回执不能发布新连接状态。没有 DOM、布局、文案或协议变更。

允许修改 `platform/agentHost/browser/remoteAgentHostServiceImpl.ts`（双方已有，只补初始化等待的退役）、其既有 `test/browser/remoteAgentHostService.test.ts`（仅 Ash，沿用现有测试归属；上游相同职责测试在 electron-browser）、`workbench/electron-browser/rendererApi.ts`（仅 Ash，沿用既有 Renderer 装配职责，只校验扩展结果所属连接代次），以及本台账、根 TODO 和清单对应行。Ash 协议、carrier、Renderer 装配与 Rust owner 保持既有已确认归属；不新增公开端口或平行恢复机制。上游公共契约区分连接 readiness 与 intentional disposal；直接测试覆盖废弃 setup 的迟到成功／失败及重连等待。Ash 独立实现复用 `raceCancellationError`，从当前客户端状态取消初始化等待，订阅在本次等待退出时释放。定向回归先证明旧初始化不返回时新代次仍能 ready，再核对释放与迟到结果隔离。

验证：新增的重启后迟到成功、迟到失败和释放三个测试先失败，再随修复通过；另补重初始化期间 socket 断开后原有有限重试继续恢复的回归。最终标准入口 `pnpm test:unit` 选择 `remoteAgentHostService.test.ts`、`appServerProtocolClient.test.ts`、`appServerSocketTransport.test.ts`、`remoteExtensionHost.test.ts`、`nativeExtensionService.test.ts`，83 项通过，其中 Remote service 9 项，新增 suite 启用 disposable leak 检查。Renderer 类型检查 4,213 文件通过；三个源码／测试文件格式检查及 `git diff --check` 通过。原始证据为 `.build/agenthost-alignment-20261018/{red-tests,green-tests,renderer-check}.log`。这只证明现有 Ash Remote 连接生命周期，不证明上游多 host API 等价或跨平台、真实 OS 休眠验收。

### 文件资源退役与领域契约 · 本轮完成

本批调用链为 Editor／Session 文件读取 → `IFileService` → `AgentHostFileSystemProvider` → 原 `IFileApi` 分配与 `IResourceApi` 分块读取／释放 → Rust connection-owned resource store。原有字节读取缺少连接约束，旧分配／chunk 回执可能继续对新连接发出 read／release。本批使用既有连接事件与 generation 隔离分配、分块返回及释放，断线取消流式读取；旧连接资源由后端关闭清理，取消但连接仍有效时仍释放晚到分配。上游对应 Provider 的连接注册／移除测试只作为失效边界证据，没有采用其 AHP 重连宽限实现。无 DOM／布局／文案变化。

准入路径仅为双方已有的 `platform/agentHost/common/agentHostFileSystemProvider.ts`、`platform/files/test/browser/fileService.test.ts`、本台账、根 TODO 和文件清单对应行。既有 Rust resource store 仍是唯一资源 owner，不增加缓存或公开 API。行为回归通过真实 Provider 的整读／流读入口，在分配与 chunk 等待点触发同 generation 关闭或 generation 替换，核对取消、无跨连接读取／释放及当前连接取消仍正确释放。继续任务基线及 24 文件／353 项已通过测试见 `.build/agenthost-completion-20261018/`。

续做复核补齐了 release 等待边界：释放回执返回前连接关闭或替换时，整读不能发布旧内容，流读不能报告完成；旧释放失败归为取消，当前连接的实际释放失败继续传播。释放仍只发往原有效连接，不重放分配／读取或释放请求。相同公开入口的 16 项新增回归覆盖分配／chunk／release 的迟到成功、旧释放失败与当前释放失败，suite 启用 disposable leak 检查。

同一调用链的生成类型已收回至 adapter：既有仅 Ash 的 `platform/files/common/fileApi.ts` 保留文件领域 contract 职责，`platform/files/browser/fileApi.ts` 负责机械协议转换，双方已有的 common Provider 使用领域结果；既有 `test/architecture/app-server-architecture.test.ts` 收紧这两份 common 文件的生成依赖限制。没有新增导出或服务／状态 owner；不可变输入编码列表只由 adapter 转为 wire 数组，Provider 不再重复复制。

验证：分配／chunk 的原 8 项回归先失败后通过；续做的 release 迟到成功 4 项同样先红后绿。最终标准 `pnpm test:unit` 文件服务、路径身份、Session 文件及架构检查 4 文件／68 项通过，文本文件服务与 App Server 文档宿主另 2 文件／97 项通过。Renderer 4,213 文件类型检查、`pnpm build:web`、8 个改动 TS 文件格式检查及 `git diff --check` 通过。日志保存在 `.build/agenthost-completion-20261018/{file-resource-red,file-release-red,file-resource-final,file-text-final,renderer-final,web-build-final}.log`。没有重跑 Rust、真实断网或跨平台验收；本批结果不代表剩余 AgentHost API 已等价。

### 搜索重连与 Session 创建生命周期 · 本轮完成

文件搜索沿 Quick Open／SearchService／SessionFileService → `IFileSearchService` → 既有 `platform/search/browser/fileSearchApi.ts` → 当前协议连接与 Rust file search owner。修复让每次查询绑定发起时的连接代次：连接退役后丢弃迟到结果，不通过替换连接发送旧 cancel，同连接取消仍使用原 operationId 并等待 terminal response。没有改 Search controller、结果模型、Session 搜索策略或 Rust owner，也没有新增公开端口。上游公开契约要求取消令牌；对应连接替换测试只用于确认失效边界，没有移植目录遍历或缓存实现。

Session 创建切片的真实入口为新建 composer／SessionsManagement → 现有 `AppServerSessionsProvider.create` → Rust 原子创建 root → Provider 获取详情订阅 → 返回可交互 root。详情快照缺少已创建 root 或该 root 已归档时，Provider 释放当前 lease 并让相同 commandId 重试既有持久 Session；不删除成功创建的持久数据，也不新增订阅 owner。只修改既有 Ash Provider 和管理服务回归，没有新增 UI、导出或后端契约。

验证：文件搜索最终记录 `.build/agenthost-completion-20261018/file-search-green.log`，38 项／5 文件通过，含连接关闭、替换、迟到结果和旧 cancel 隔离；Session 创建最终记录 `session-create-green.log`，142 项／4 文件通过，含缺失／归档 root、lease 释放、同 commandId 重试及真实入口回归。两片与 Remote 生命周期、文件资源和领域契约合并为本次本地提交范围；AgentHost 多端点／宿主管理契约、其他 Sessions／Chat 职责及真实跨平台验收仍保留在 TODO。

### Session runtime 连接退役 · 本轮完成

基线 `e87cb6f87`，开始时工作树干净，保留已提交的生命周期与 release 边界修复。本批既有容器入口沿 `DevContainerAgentHostService` → `IAgentSessionService.invokeRuntime` → `appServerAgentService.ts` → Rust admitted Session runtime Provider；只修改这一既有仅 Ash adapter 与 `platform/agentHost/test/browser/appServerAgentService.test.ts`，以及本台账与根 TODO。现有 cancel 只判断 generation，但 close 可在 generation 未改变时退休回执；list／probe／prepare 的迟到结果也缺少退休检查。使用查询自己的状态订阅约束结果与 cancel，不复制容器目录、状态或连接 registry，不改变 connector 归属或新增公开端口。回归核对 close／replacement 后迟到结果取消、旧 cancel 不跨连接，以及当前连接仍发送同 operationId 的 typed cancel。

上述行为现已实现，取消统一通过前端 CancellationError 表达。新增 5 项回归先失败后通过；标准 `pnpm test:unit` 选择 Agent adapter、Dev Container service、RemoteExtensionHost、NativeExtensionService 共 37 项通过；Renderer 4,213 文件类型检查、两个源码／测试文件格式及 diff whitespace 检查通过。证据 `.build/agenthost-completion-20261018/runtime-{red,green,renderer-check}.log`。未改变 Rust Provider 执行、取消或持久化协议；当前其他编辑器与 Collab 改动不属于本批。

### 多宿主范围复核 · 尚未完成

用户要求继续完成根 TODO 的两条文件对齐任务，明确暂不扩入 Cloud Sandbox、Tunnel／WSL、Mission Control 和环境验收。对“同窗口多宿主”用户请求了产品对照并将建议交给执行者；先前建议暂不纳入，源码复核后修正为不能为清空 TODO 而排除这一缺口，用户随后以 `do` 授权实际实现；当前连接／Provider 切片已落地，完整多宿主管理尚未完成。

只读证据：VS Code `2de8dcf8062` 的 `IAgentHostConnectionsService` 统一 ambient 与多个 remote，普通 Editor 与 Agents Window 的连接支持分别由 `EditorWindowRemoteAgentHostService`／`AgentsWindowRemoteAgentHostService` 约束；Zed `56934ec056` 的 `MultiWorkspace.find_or_create_workspace` 支持每个 Workspace 的独立 RemoteClient，`ProjectGroupKey` 同时包含 host 与 paths；Codex `822e58cc3d` 的公开仓库不能证明桌面 UI 的全部实现，官方 [Remote connections](https://learn.chatgpt.com/docs/remote-connections) 文档确认 SSH 远程项目及跨宿主会话交接。不能把“单工作区有明确执行宿主”与“一个窗口只能管理一个宿主”混为一谈。

Ash 的 `SessionsProvidersService` 现已接入独立 SSH Provider，Automation 是当前可使用它们的生产消费者；`SessionsManagementService` 主模型仍由启动入口直接绑定单个 Provider，Chat／模型服务仍绑定主 Renderer host；文件服务已接通额外宿主的完整 URI 路由，但不表示 Session 选择、搜索及其他领域 scope 已切换。连接与 scope 验证后，下一步必须沿“有宿主归属的 Session 身份 → registry 驱动的主模型 → 对应 Chat／模型／文件／仓库／权限 scope → 窗口显示／切换”深度闭合；不能新增无消费者的标准 AHP facade 或把原始 SessionId 当作跨宿主唯一身份。仓库事实仍由现有 Git/GitHub owner 持有，尚未将 Node/state/meta 文件逐项判为能力等价，两条根 TODO 保留。

### 本轮代码迁移与行为修复

用户已批准唯一文件 Provider 的精确路径迁移；Cloud Sandbox、Tunnel／WSL、Mission Control 的整套新产品能力按用户答复“先todo”保留待办。它们需要先确定后端 producer、认证、Provider 和运行分发归属，当前未创建占位文件、转发类或新服务表。清单按明确的产品文件名标记 `todo-by-user`，没有把本地 sandbox 权限功能一并延期。

| 已完成切片             | 生产入口、唯一 owner 与结果                                                                                                                                   | 验证                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 领域数据与服务职责拆分 | Chat／Sessions／Voice → `agent.ts` 数据、`agentService.ts` 服务 → 原 App Server adapter；数据声明主体保持原样，无第二份状态或兼容再导出。                     | 服务、interaction、Chat、Sessions 与领域依赖架构回归；101 项声明主体比较通过。                            |
| 文件 Provider 迁移     | Workbench 文件装配与 Sessions 文件服务 → `common/agentHostFileSystemProvider.ts` → 原 Rust 文件与资源 owner。旧 browser 文件已删除且可从 Git 恢复。           | 文件读写、revision／dirty editor、路径大小写、elevated、Session 文件与 Editor 回归通过；common 检查通过。 |
| Automation 连接隔离    | Provider → 原 Automation store → Rust automation；写操作成功回执保持成功，退役连接结果不能发布到新缓存，旧 run 取消不能发给新连接。                           | 7 项新增测试先失败后通过；Automation 既有 UI／观察回归 19 项通过。                                        |
| 远程重初始化           | Electron 装配 → 原 Remote service／recovery → 扩展端点；本地重启立即退役旧连接，恢复任务等待最新初始化。                                                      | 地址解析和扩展初始化阶段各新增 1 项红转绿回归，同文件 5 项通过。                                          |
| 目录身份               | Workspace／GitHub／Changes → 原 Session 目录转换 → 既有 Remote authority 与路径工具；SSH host `local` 不再取得本地身份，远程 Windows 路径保留 canonical URI。 | 2 项新增回归先失败后通过；Common、Session Management、approval environment 共 88 项通过。                 |

验证证据位于 `.build/agenthost-evidence/implementation-20261018/`：

- 标准 `pnpm test:unit` 在 20 个文件执行 731 项，其中 730 项首次通过。唯一失败来自 Automation 测试仍使用旧 Notification mock；改用真实 `NotificationService` 后，该文件 19 项重跑全部通过，未放宽断言。其余通过结果复用，没有把整条首次命令写成全绿。
- 目录身份修复后标准入口定向执行 3 个文件共 88 项，全通过；层级／App Server 架构测试再执行 16 项，全通过。skill 中的旧 `valid-layers-check` 脚本在当前 package 不存在，层级结论以上述现有架构测试为准。
- `pnpm build:web` 正常构建通过；最后目录修复后的 common／renderer 检查再次通过。52 个本批 TypeScript 文件 formatter 检查通过；本批路径 whitespace 检查通过。没有更改产品文案，准备阶段 zh-CN 缺项为 0。
- 本批未执行真实 SSH／WSL／Cloud 后端、系统休眠、多窗口产品验收或浏览器集成场景；不把单元测试和路径迁移计为上游全部 API／产品能力完成。

## 既有实现与历史验证

2026-10-08 接手集成已包含 B1 持久会话事实、B2 公开账号范围下的模型目录生命周期、picker 焦点保持和 B3 被动管理状态。首次账号快照缺口已修复：接受目录前通过现有账号服务建立范围，首个同账号或无关账号事件的失败重读保留有效目录，真实换账号及重连隔离迟到结果。下面保留原方案和历史验证，不作为当前文件对齐清单，也不代表本次重新执行。

### 2026-10-18 复核

在 `/Users/lx/Desktop/ash` 确认记录既有修复的 `0fff2125f25ffe641b5a3393fc47034d39dc52ba` 是当前 HEAD 的祖先。旧交接的停工、红测、待集成步骤和 worktree 信息已过时，交接文件已退场。

- 标准单测入口执行 `languageModels.test.ts`、`chatViewPane.test.ts`、`gitHubConnectionService.test.ts`：208 项通过，0 个失败文件。
- 新增 [MCP 进程回归](crates/app-server/tests/mcp_restart.rs)：隔离 profile 持久禁用 MCP，临时连接完成真实 loopback HTTP 握手并发现工具；退出后新进程仍禁用、工具数为零且无新握手；第三个进程显式连接仍成功。
- `just test ash-app-server --test mcp_restart` 和 `just test-processes ash-app-server --test mcp_restart --profile ci-test --locked` 各 1 项通过。回归接入 Desktop runtime acceptance 的 Windows/macOS matrix，远端 CI 尚未执行。
- `just rust-warnings ash-app-server --profile ci-test` 全目标检查通过；`just test-python scripts` 执行 196 项、跳过 1 项，其余通过。

命令、日志与文件哈希记录于 `.build/agenthost-evidence/recheck-20261018/validation.json`。真实账号、跨平台、系统休眠、TUI 与旧隔离故障复现仍未完成，详见根 TODO；不据此宣称整体验收通过。

2026-10-18 本机补验 B2 GUI 长周期：先在隔离 HOME、OS 拒绝出站网络的环境验证已安装 `codex-cli 0.163.0-alpha.10.2` 的缓存身份与 schema，再用真实 Rust observer 和认证 Web App Server 驱动已打开的 Code／Cowork picker。正常五分钟调度的 metadata 更新和下一周期 invalidResponse 均通过，目录重读、账号范围不变、手动选择／Code Auto、推理级别及失败保留断言全部成立；完整 smoke 为 1 passed（10.2m），日志 `.build/todo-subscription-browser-final.log`。Electron 字节流 observer 现按端口处理 UTF-8／换行分片；headless Browser 的合成 key 通过产品确认切换到隔离 profile 的文件存储。该结果使用合成账号与版本校验的本地缓存，不代表真实外部账号或 TUI 验收。此前桌面交互干扰和 Browser 启动／存储失败证据单独保留。

### 2026-10-08 后续凭证范围修复

1. **Kimi subscription 重登录已修复。** 账户 ID 由 Kimi owner 对私有 device ID 做单向摘要；新登录改变 ID，token 轮换保持 ID。新旧 revision 同为 1 的重登录也会退役旧目录。过期账户的查询、资料刷新和登出不能操作新账户。
2. **external `kimi-desktop` / `kimi-cli` 已接通后台观察和缓存快照。** `model/list` 同次捕获当前凭证范围与缓存发现行，读取不触发远程请求。共享观察器每 60 秒检查凭证身份，每 5 分钟刷新远程目录；身份变化先通知退役，刷新后校验身份，迟到结果不作为当前数据发布。外部来源不创建 `AccountDto`；通知 authority 使用外部 scope，正常订阅仍使用账户身份。
3. **首次账户快照缺口已修复。** 模型 service 通过现有必需账号 service 建立权威范围，保留同账户失败语义，隔离换账户与重连的迟到结果。

旧 `agenthost-catalog-epoch-plan.md` 未交付；实现沿既有 Kimi、ModelsManager、subscription observer 和前端 service owner 工作，没有新增第二个持久 catalog 或依赖缺失提案，因此不再将该文档列为待交付前置。剩余环境验收以 [AgentHost TODO](TODO.md#agenthost--todo) 为准。

### 第一批历史验证

2026-10-08 UTC，代码基线仍为 `dd086508b8c0eabe5931793302e8f7dc3d7a47b3` 加下述未提交六文件 diff：

- 生产 owner：SQLite catalog predicate、Session provider、Management equality，准确路径与本节后续 todo 一致。
- 测试：`crates/state/src/sqlite_tests.rs`、`sessionsManagementService.test.ts`、`chatViewPane.test.ts`；startup 测试原文件未修改但参与验证。
- Rust 红测真实复现 3 个失效条件，原有 passive-read 测试通过；修复后相同 4 个测试全绿。
- `just verify ash-state` 完成 check、97 个全包测试和 rust-warnings；1 个手动性能 benchmark 按原有标记 ignored。
- 标准 `pnpm test:unit --run src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/sessions/test/browser/chatViewPane.startup.test.ts` 最终通过完整 test 编译、5 个 runner 回归和 134 个定向测试。此前定向回退也通过，但最终结论以标准入口为准。
- `pnpm typecheck:renderer`、`pnpm build:web`、定向格式与 whitespace 检查通过。Web 构建仅有 Vite 插件耗时诊断。
- 初期 optional native-keymap 声明缺失曾阻塞完整编译；最终声明和 manifest 已与官方 3.3.9 archive 核对，archive SHA512 匹配冻结 lock，标准编译已不再受阻。native runtime binary 没有因此得到验证。
- 独立六文件源码审核无阻塞。未修改 Core 生产执行/trace、协议 schema、SCM、锁文件、公共指导或其他并行任务文件。

交付源码补丁为 `agenthost-b1.patch`，40,113 bytes，SHA256 `fa94415673aa83fb054856e41a3f17c5a92c6683efa4066879e29a0d671032b3`。它只包含本批六个实现/测试文件；完整 todo 单独交付，不把其他规划文件混入补丁。

剩余验收是实际 picker DOM、pane/profile 关闭重开、Code/Cowork、多窗口和 Web/Electron 运行时。模型/DI 至 inputState/startTurn 的单测通过不等于这些交互已通过。锁定 Chromium 下载曾收到截断 ZIP，随后安装调用的 approval review 被取消；已停止此步骤，未改用系统 Chromium。云端没有就绪的 Electron binary/display，Mac 需消费完整补丁与本文件后验证。

### 第二批历史验证

2026-10-08 UTC，仍基于 Ash `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`；本片只新增下列两文件未提交 diff，未改动第一批六文件：

- 生产 owner：`src/ash/workbench/contrib/chat/common/languageModels.ts`。
- 对应测试：`src/ash/workbench/contrib/chat/test/common/languageModels.test.ts`。
- 消费 `provider/models/updated`、`account/updated`、`account/login/completed` 和原有 API-key/connection 事件。Models、Empty、Failed 均作为失效信号，重读完整后台目录和 provider 状态，不能用单 provider payload 替换全局数组。
- 完成并发刷新合并、刷新中失效补读、成功/失败完成微任务边界、旧连接/旧账户调用者的迟到结果与错误、pending successor 所有权和 dispose 检查。旧调用者不会在新账户结果之后再写回捕获的空视图。
- 公开 model account 的 accountId/organization/plan/status 变化先发布空的当前可选视图，避免 pane 在新账户查询失败时保留旧数组；同账户查询失败保留有效快照。以真实 provider connection 集合过滤无关登录账户，credentialRevision-only token 轮换只重读，不误当新身份清空。
- 比较 provider 状态与模型元数据，provider-only readiness 改变会通知，完全相同结果保持安静。目录刷新不调用模型选择、默认值、visibility 或配置写入 API。
- 最初标准红测共 20 项，3 通过、17 失败；独立复核新增的成功完成边界、同时完成的消费者、token 轮换与 GitHub 范围四项也真实复现红测。修复后最终 service 文件有 30 项通过，包括真正权威空目录必须清空的独立回归。
- 最终标准 `pnpm test:unit --run src/ash/workbench/contrib/chat/test/common/languageModels.test.ts --run src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/sessions/test/browser/chatViewPane.startup.test.ts` 通过完整 test 编译、5 个 runner 回归和 164 个定向测试。已有 Code/Cowork 手选/Auto 回归继续通过，但它们不是新 provider notification 入口的真实产品验收。
- `pnpm typecheck:renderer`、`pnpm build:web`、两文件格式、`git diff --check` 通过；独立源码复核在上述明确公开身份范围内无阻塞。没有运行 Cargo，也没有改 Rust、Core、Trace、公共 Terminal/SCM 协议、锁文件或公共规则。
- 第一批六文件 SHA256 全部保持不变。第二批补丁在 clean HEAD 的两文件 fixture 上完成 `git apply --check`、实际 apply 和逐字节比对。

独立源码补丁为 `agenthost-b2.patch`，35,119 bytes，SHA256 `682821e7a3a691d5746af0d341d60fe5c8dc7ac414f7b722fc12e82ee85875d7`。只含本批两文件；本文件、后续只读契约方案与证据单独交付。先保存第一批本地 checkpoint，再消费第二批，保持两片可独立审阅与提交。

尚需统一 Mac 验收：已打开的 Code/Cowork picker 收到真实 provider notification 后更新；失败/Empty/账户变化行为可解释；模型、能力和 thinking 选项反映权威目录；手选、显式 Auto、隐藏模型与 profile 默认保持各自 owner；pane/profile 重开、重连和多窗口验证。Kimi 两类身份未闭环不能因这些常规用例通过而标成完成。

## 现有能力与演进方向

| 现有能力                                                                          | 初始审计确认的缺口                                                       | 演进方向                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 一份 Rust 后台服务、多窗口独立 connection；Renderer 持有协议客户端，Main 透明转发 | 连接与恢复已有覆盖，仍需验证不同宿主的恢复边界                           | 保留拓扑，验证 generation、订阅重建、未知结果和窗口关闭隔离    |
| Rust 持久化根 Thread 模型并提供 Session.model                                     | SQLite 的 Session 目录失效判定遗漏 model；前端目录映射忽略 Session.model | 第一批修复真实持久事实到模型选择器的完整链路                   |
| Rust 维护模型发现结果，发布 provider/models/updated                               | 前端 LanguageModelsService 不消费该通知                                  | 第二批使真实模型目录更新抵达已打开的选择器，保留账户与结果语义 |
| Session 目录读取不加载整份历史；订阅按需加载详情                                  | 后台目录缺少每个 Thread 的管理状态，列表也未呈现该状态                   | 第三批暴露现有粗粒度管理事实；精确 Turn 状态另行决定           |
| Core 拥有 Thread/Turn 顺序、policy、交互、取消和执行                              | 本轮未证明需要替换这些 owner                                             | 后续只补可复现的端到端差异，沿现有 Rust owner 修复             |

### 审计基线与证据范围

- Ash：`dd086508b8c0eabe5931793302e8f7dc3d7a47b3`，隔离云端 clone 的 `main`；根目录工作树在写本文件前干净。读取了最近 150 个提交范围内相关文件历史。
- VS Code：`ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5`，2026-10-08 04:42:38 UTC；只读稀疏 checkout 覆盖 platform/agentHost、Workbench agentHost/chat 和 Sessions。
- 上游近期演进来自按 `src/vs/platform/agentHost` 路径筛选的 50 条提交，不代表整个 VS Code 最近 50 条提交或完整历史。最近一条相关提交为 `9447b39a0b72cd07a936427b944fd865866f348a`，2026-10-08 04:37:30 UTC。
- 本地实施前必须重新记录 HEAD、目标文件未提交差异和对应上游基线。云端 clone 没有用户本地分支、未提交改动或其他任务实时 diff，不能据此断言本地也干净。

相关上游变化：

| UTC 日期            | 提交与公开变化                                                                                                                          | Ash 使用方式                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 2026-10-07 19:18:18 | [ac4cf28d 缓存 peer chat 详情并在未订阅时提供状态](https://github.com/microsoft/vscode/commit/ac4cf28d8cc5d9bdf08b8578d1931135fa12a1ae) | 核对被动目录状态、详情按需加载和前端缓存责任                    |
| 2026-10-07 19:18:41 | [e11f0d83 保留启动期间的 Codex 模型选择](https://github.com/microsoft/vscode/commit/e11f0d833b19f1035dde69cf974b1515863d884f)           | 核对已持久化选择、临时选择与默认模型的优先级                    |
| 2026-10-07 21:16:50 | [b3a9b152 空 SDK 刷新时保留模型目录](https://github.com/microsoft/vscode/commit/b3a9b152d558e1bd66ae0437cf6d6cae2a9707ad)               | 仅借鉴失败不应意外清空的行为；Ash 的成功 Empty 有独立含义       |
| 2026-10-07 21:22:27 | [19f093cc 启动前执行 MCP enablement](https://github.com/microsoft/vscode/commit/19f093cc13efc8e2c0e3fc694a03cdaa6afc7169)               | 后续核对禁用、恢复、认证与工具可见性，不能只隐藏 picker         |
| 2026-10-08 01:07:22 | [91fa1538 OS sleep 后保留 relay 恢复](https://github.com/microsoft/vscode/commit/91fa1538649fa815b4c6810eda29f032e6e9a342)              | 核对恢复计时与重新鉴权；不移植 AHP reconnect/outbox             |
| 2026-10-08 01:25:41 | [51ec2ee4 AHP 与 legacy version 兼容](https://github.com/microsoft/vscode/commit/51ec2ee42fdaa95257129e1dcea2f64cb7ae55e3)              | 核对兼容失败可观察性；Ash 仍使用自身 major/schema hash 锁步契约 |
| 2026-10-08 03:59:07 | [58afa23a 标题策略与旧配置迁移](https://github.com/microsoft/vscode/commit/58afa23a1cb18ac5d0aa894d9f2d88765889fae3)                    | 暂列后续产品能力，当前不增加同名设置或工具                      |

## 职责与真实调用链

Ash 的 [前后端边界](docs/frontend-app-server-boundary.md)已明确 `platform/agentHost` 承接 Rust App Server 接入。原云端审计时两仓的 AgentHost 文件路径不同；该结论已不能描述当前检出，当前存在关系以本文开头的文件台账为准。同路径仍需核对真实职责，不能把上游独有清单直接转成新文件队列。已有 Ash 专属 adapter 保留其职责，新增专属归属或重大 owner 变化须重新确认。

下表的 VS Code 前端缩写路径相对 `src/vs/`，Ash 前端缩写路径相对 `src/ash/`；`crates/` 路径相对仓库根目录。后续 todo 均列完整仓库相对路径。

| 职责                   | VS Code 证据入口                                                                                                                    | Ash 唯一 owner 与调用链                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务契约与装配         | `platform/agentHost/common/agentService.ts`、`common/agent.ts`；`workbench/services/agentHost/electron-browser/agentHostService.ts` | `platform/agentHost/common/appServerApi.ts`；各领域 common API；`workbench/browser/workbench.ts`、`sessions/browser/workbench.ts` 经现有 DI 创建 service/provider                               |
| 初始化、请求配对与事件 | `platform/agentHost/browser/agentHostProtocolClient.ts`、`common/state/sessionProtocol.ts`                                          | `platform/agentHost/browser/appServerProtocolClient.ts` 负责一个 Renderer connection 的 pending、双向 dispatch、decoder、generation 与关闭；生成契约源在 `crates/app-server-protocol`           |
| transport 与进程       | `platform/agentHost/common/agent.ts` 中 starter/connection 契约及对应宿主                                                           | `appServerMessagePortTransport.ts` / `appServerWebSocketTransport.ts` → Main `appServerConnectionRelay.ts` → `platform/app-server-daemon` → `crates/app-server-daemon` → 共享 Rust App Server   |
| Session/Chat/Thread    | `sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`；`platform/agentHost/node/agentService.ts`          | `AppServerSessionsProvider` → `platform/sessions/browser/sessionApi.ts` → `app-server/server/session_operations.rs` → Core/Thread store；`SessionsManagementService` 仅拥有显示目录、草稿与路由 |
| 状态、历史与流         | `node/agentHostStateManager.ts`、`node/agentSideEffects.ts` 与 AHP channels                                                         | `crates/core` reducer/controller 拥有顺序和执行事实，`crates/state` 保存 verified catalog/history；`ChatService` 与 pane model 接收 snapshot/transcript/update 并维护呈现状态                   |
| 模型与工具             | 上游 provider 与 catalog 契约                                                                                                       | `crates/models-manager`、`crates/subscriptions`、`crates/model-provider` 拥有发现和调用；Frontend `LanguageModelsService` 拥有显示目录，pane 拥有未发送选择；工具执行不迁入 frontend            |
| 权限与取消             | 上游 permission/turn/provider 契约及行为测试                                                                                        | Rust Core policy/interaction/turn owner；`ChatService` → `ITurnApi` → `session/request` 的 typed interrupt/interaction。取消 Promise 不代表后台停止                                             |

### 第一批闭环

用户重开已有会话或后台启动进行模型迁移 → Rust Thread snapshot/ThreadCatalogRecord → SQLite 同事务刷新 session_catalog → `session/list` / `session/catalog/read` → Session provider 映射 → SessionsManagement → Code/Cowork pane 模型选择器 → 下一次 `startTurn` 使用正确选择。

唯一持久 owner 仍为 Rust Thread；Session 是分组只读视图，不新增 Session reducer 或独立 sequence。Pane 的未发送手动选择、显式 Auto 和 profile 默认值各自保持已有 owner。

## 第一批 修复会话模型事实一致性

**优先级最高，建议首个本地实施批次。** 用户收益是重开或重连时不显示错误的全局默认模型，后台模型迁移不会让 Session 目录继续报告旧值。

初始基线确认的源码条件：

1. [Rust Session.model](crates/protocol/src/session.rs)来自根 Thread 最近接受的 Turn，child/fork 的选择不替换根模型。
2. [thread_catalog_record](crates/core/src/thread_controller.rs)把该模型写入 ThreadCatalogRecord；现有 Core 测试 `session_catalog_uses_root_model_even_when_a_child_uses_a_different_model` 覆盖重开，但使用内存 store。
3. [SQLite append_batch / session_list_changed](crates/state/src/sqlite/thread.rs)总是更新 thread_catalog，但仅在 predicate 为真时更新 session_catalog；predicate 未比较 model 和 execution_target。仅模型变化可使目录滞后。
4. [Provider](src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts)的 `toSession` 忽略 DTO.model；`list` 再把全部 Session.model 覆盖为全局 `readModel` 结果，`readCatalog` 继续沿用旧 model。
5. [Management equality](src/ash/sessions/services/sessions/browser/sessionsManagementService.ts)的 `sameSession` 未比较 model 与 workspace。只修 provider 后，model-only 目录更新仍可能被当作无变化而丢弃。

上述失效条件现已由本批 Rust 和前端红测复现，并在相同回归中转绿；没有证据说明用户历史已丢失，修复针对目录事实滞后和前端选择映射。

### Todo 与路径边界

- [x] 在 `crates/state/src/sqlite_tests.rs` 添加先失败的 model-only catalog 更新回归：通过正常 append transaction 更新 root model，其他比较字段保持不变；同时检查 list、指定 catalog read、reopen 和 verified digest。
- [x] 在同一文件使用已存在的 `ash-core` dev dependency 增加 SQLite-backed Core migration 回归：root Turn 处于启动可保留的 user-input 等待态，实际 reopen/recover 后执行 provider identity migration，再检查历史模型、目录和 reopen 一致；不以直接 backfill 或内存 store 代替真实迁移链路。
- [x] 仅在 `crates/state/src/sqlite/thread.rs` 的目录失效 predicate 补齐 Session 导出事实所需 model/execution_target 比较。两项遗漏分别完成红绿回归，未重构 store 或更改现有格式版本。
- [x] 在 `src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts` 原地修复 model 映射与 list/readCatalog 优先级。持久化目录忠实读取 DTO.model，包括缺失值；全局默认仅在已知 create/draft 流程中选择，不能替换既有目录事实。保留 pane 的未发送手动选择和 Auto，不能用 catalog 更新覆盖它们。
- [x] 在 `src/ash/sessions/services/sessions/browser/sessionsManagementService.ts` 的现有 `sameSession` 补齐 model 与 workspace 事实比较，保持其他刷新、selection 和 subscription 算法不变；默认模型写入不再根据历史模型相等而跳过或改写所有 Session。
- [x] 在 `src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts` 覆盖两会话不同模型、config 默认不同、child 模型不同、重连、迟到旧目录与 model/workspace-only 变化。
- [ ] 使用现有 `src/ash/sessions/test/browser/chatViewPane.test.ts`、`chatViewPane.startup.test.ts` 和 Cowork 测试，验证真实创建入口到 picker/startTurn 的效果。已通过 Code/Cowork WidgetModel/DI/inputState/startTurn 与 startup 单测；真实 DOM 与 profile/pane 重开验收待 Mac。没有修改 pane 生产 owner。

主要 production 写入限于三个现有 owner：SQLite predicate、Session provider 和 Management equality。若现有 `setModel` 的全目录替换与上述事实分离冲突，先核对真实生产调用方，再决定局部变更，不能机械保留或删除旧 API。

Session.model 缺失仅表示目录没有模型事实，不能据此推断没有已接受 Turn 或用户选择了 Auto；例如 model-less shell Turn 同样可能没有值。显式 Auto 由现有 composer 选择标记表达，profile remembered/default 是新建流程偏好，两者不能写回或伪装成历史模型。不为判断缺失而额外加载整份历史。

### 验收

- root=A、child=B、全局默认=C 时，目录与重开 root 会话保留 A；打开 child 后使用其自身 B。
- model-only append 和启动模型迁移后，Thread/read、session/list 与 session/catalog/read 结果一致；完成历史、Thread sequence 和幂等规则不被修改。
- Catalog 更新期间的未发送手动模型与显式 Auto 不回退；旧 connection 的目录结果不能改写新 connection。
- 开启与关闭 Code/Cowork pane、重连和 profile reopen 均经过真实入口；没有第二份模型持久化 owner。
- `just verify ash-state`，现有 Core 根模型回归按需定向运行；上述 TS 定向单测、`pnpm typecheck:renderer`、受影响产品构建和 Web/Electron Playwright 完成。若无协议变化，不新增或手改生成类型。

## 第二批 接通模型目录更新

依赖第一批的模型事实与选择优先级固定。用户收益是账户或订阅模型列表变化能抵达已打开的选择器，失败不会意外替换当前可用快照。

初始缺口链路：`crates/subscriptions/src/lib.rs` 观察账户与发现 → `crates/app-server/src/server/subscription_adapter.rs` → `provider/models/updated` → generated decoder → `IServerEventApi`。基线 `LanguageModelsService` 仅处理 `provider/apiKey/changed`，遗漏此更新；本片现已原地消费，具体可证明范围和未闭环项见文首。

- [x] 在 `src/ash/workbench/contrib/chat/common/languageModels.ts` 原地消费该事件作为 invalidation，重读当前 `model/list` 和 provider 状态；不把某一个 subscription 的 payload 直接替换全局目录。
- [x] 将 connection generation、dispose、并发刷新与“刷新期间又有新通知”的责任闭合在该 service。旧 load 完成不得覆盖新连接目录；合并通知后仍至少完成一次涵盖最新失效的刷新。
- [x] 在 `src/ash/workbench/contrib/chat/test/common/languageModels.test.ts` 增加 Models、Empty、Failed、公开账户切换、连续通知、迟到结果、消费者赋值与零选择/配置写入回归；实际 picker 手选/Auto 验收仍属下一项。
- [x] 只读核对 `crates/app-server/src/server/subscription_adapter_tests.rs`、`crates/subscriptions/src/subscription_tests.rs` 和 `crates/models-manager/src/manager_tests.rs` 的既有 Models/Empty/Failed 语义。本片没有修改或重跑 Rust；确有目录身份缺口已单列后续契约方案，不能为凑跨端 diff 修改 Rust。subscription adapter 自身 Empty 覆盖的补齐随后续协议批次安排。
- [ ] 通过 Code/Cowork 的真实模型选择器验证目录、能力、thinking 选项和非默认语言。仅在确有缺口时登记相关 pane 路径。

**结果语义不可照搬上游：** Ash `ProviderModelsListResult` 明确区分成功 Models、成功 Empty 和 Failed。成功空发现会更新 backend 最新发现集；失败保留已有 metadata，认证/权限失败会降级可用性。账户、organization 或 plan 改变时旧结果由 subscription owner 丢弃。禁止统一忽略 Empty，也禁止保留上一个账户的可选模型。Frontend 以当前 backend 查询为权威。

验收：一次 provider update 能更新已打开选择器；相同结果不产生无意义变更；失败、空目录和账户切换的行为分别可解释；不会触发全局模型选择或写配置。涉及现有 wire fixture 时运行 `just verify ash-app-server-protocol` 与 generated-contract 检查；实际变动 package 再执行对应 `just verify`。

## 第三批 显示后台会话的被动管理状态

本批已按粗粒度管理事实实现，对应提交 `388e4276f`；原验收涵盖 Rust owner、旧缓存迁移及 Web/Electron 中英文后台列表场景。以下保留原方案的职责与验收契约。

原调查基线要求目录读取、通知和 owner 保持成立，上游依据为 ac4cf28d。现有 Session catalog subscription 在 committed Thread event 后发布 `session/changed`，无需订阅全部历史。本批在原生命周期元数据之外透出同源管理事实，列表无需加载详情即可显示该事实；它不伪造精确 Turn 执行状态。

**本批采用现有粗粒度管理状态。** `ThreadCatalogRecord.manager` 已由 Core 的 `thread_manager_info` 生成，能区分 Idle、NeedsInput、Working、ReadyForReview、Failed、Stopped 等管理事实。Working 合并 created/running/cancelling，NeedsInput 合并三类等待；它不是精确 TurnStatus。

- [x] 采用现有粗粒度管理事实；精确 latest-turn summary 仍属于独立的后续协议/存储决定。
- [x] `crates/protocol/src/session.rs` 为 SessionThread 暴露已有 manager；`crates/thread-store/src/store.rs` 的 `session_from_catalog` 透出同一事实。
- [x] `crates/core/src/thread_controller.rs` 只调整现有目录构造所必需的投影，复用已存在的 `thread_manager_info`，不新增执行 reducer。`crates/app-server/src/server/operations.rs` 的 full Session 结果必须使用同源事实；只读核对 `session_operations.rs` 的被动路径。
- [x] `crates/state/src/sqlite/thread.rs`、`crates/state/src/sqlite/connection.rs` 更新必要的 Session catalog 格式与迁移：从 verified ThreadCatalogRecord 重建，不能默认把旧行全部变 idle，不能为了列表读取重放每份历史。
- [x] 从 Rust source 重新生成 TS、schema 和 decoder；核对 registry/export 与 fixtures，需要时才改 `crates/app-server-protocol` 的实际生成 owner。
- [x] `src/ash/sessions/services/sessions/common/session.ts` 增加前端领域 management-state 契约，provider 做机械转换，management 保持更新与 equality 正确。不能伪造 `executionStatus=running` 或具体 waitingReason。
- [x] `src/ash/sessions/browser/parts/sidebar/sessionsList.ts` 现有 row 显示本地化状态及 aria 描述；复用 Ash 自有 DOM、主题和尺寸，保留 row identity、焦点、滚动与 PR 图标。
- [x] 在 `src/ash/sessions/test/browser/sessions-list.test.ts`、management 单测、Rust store/catalog/update broker 测试及现有 Sessions Web/Electron smoke 中验证后台切换。新文案同步所属 NLS 和语言词条，至少覆盖一种非默认语言。

验收：另一 connection 启动、等待输入、失败、完成或停止后，未打开详情的会话行会更新；subscriber 数量和 history-load 次数不因状态显示增加；选择、draft、焦点和滚动保留；重连后 retired connection 的活动事实不残留。

粗粒度方案只改变 Session cached-row 的格式版本与重建，不因为公开 DTO 增加 manager 就升级全部 Thread row 版本。当前 outer ThreadCatalogRecord.manager 已有权威事实；旧 nested SessionThread 新字段的默认值不能反向覆盖它。否则可能触发 Core 的 missing-catalog repair 并重放所有旧历史，破坏被动读取目标。

准确 Turn 状态的后续选项：在 catalog 保存最新 TurnId/TurnStatus，改变 Thread 与 Session catalog 版本并从 verified history 回建，生成新契约，再复用现有 executionStatus mapper。这是新协议/存储决定，当前还没有可直接复用的精确被动 primitive。不能把这一选项藏在粗粒度状态批次里。

## 第四批 验证恢复 权限 取消与历史

2026-10-08 本批已运行协议/Renderer/Sessions 迟到与恢复回归、App Server 权限和 connection owner 测试，以及真实 Web/Electron 中英文 Stop、失败、草稿和 profile 重开。以下复选框保留原方案状态，不作为当前执行清单；剩余环境缺口由 [AgentHost TODO](TODO.md#agenthost--todo) 维护。

这是定向验证与缺陷驱动批次，不是预先授权整目录重写。前述前三批通过后，先复用已有覆盖，只有观察到差异才登记具体修改路径。

- [ ] 连接：验证 `appServerProtocolClient.ts`、MessagePort/WebSocket transport、`platform/native/electron-browser/rendererApi.ts` 和 Web renderer assembly 的旧 generation、inbound cancel、pending 关闭、重连及 auth terminal failure。Desktop 当前有三次恢复尝试，Web 使用退避恢复；不能未经产品决定统一策略。
- [ ] 多窗口：关闭一个 Renderer 只清理自己的 pending/resources/subscriptions，另一窗口与共享后台继续工作；process exit 使所有连接失效。Main 不新增 JSON-RPC 分类或业务 pending map。
- [ ] 恢复：catalog-only、已加载后台 details、当前 Thread transcript 和草稿分别恢复；uncertain mutation 不自动重放。现有 `sessionsManagementService.test.ts` 与 `agentHost/test/browser/webRendererApi.test.ts` 已覆盖多种迟到/恢复场景，先运行它们。
- [ ] 权限：沿 Core frozen policy、UpdateBroker interaction capability 与对应 connection owner 验证允许/拒绝/过期/断线。保留现有 approval/user-input 向同 scope、能力匹配且已订阅 connection 重新分配的语义；旧 owner 不能答复新 assignment。dynamic-tool interaction 不重新分配，owner 丢失时取消。不能把 catalog 订阅当成交互授权，不能转交任意窗口；普通 JSON-RPC host request 继续绑定来源 connection。
- [ ] 取消：从实际 Stop/interrupt 按钮到 `ITurnApi` 和 Rust 终态验证 completion race、重复 interrupt、待审批取消；保留 expectedSequence 和 commandId 规则。通用 JSON-RPC Promise cancel 不替代 domain interrupt。
- [ ] 历史与工具：核对现有 snapshot/transcript revision、fork、模型/工具输入和 disabled MCP 恢复。历史编辑/rollback、标题自动生成、bulk questions、Mission Control 或 remote credential delegation 若无 Ash 真实消费者，保持待调查，不创建占位 API。

每个新增实现的验收都必须给出用户入口、唯一 owner、状态/副作用、释放边界与真实测试。现有测试名称或源码审阅不能当成测试已通过。

## 与正在进行工作的边界

| 工作                          | 本计划的交集与处理                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trace / Sessions / Core trace | 第一批不改 `core` 执行与 trace recorder；第三批如触及 `thread_controller.rs`，必须与 Trace 任务对照 exact diff、串行集成。`sessionApi.ts` 同时承载 trace API，默认只读，禁止整体整理 |
| SCM 与 Git 协议               | 初始模型修复无需 `git/*` 或 turnChanges；第三批生成 shared protocol 时只在双方变更合并后统一生成/验证，不能覆盖另一任务 schema fixture                                               |
| Preferences 输入迁移          | 不改 keybinding/input/settings editor；模型默认值、visibility 和 pane 临时选择保持既有 owner。模型服务路径变更必须核对相关配置任务的实际 diff                                        |
| Notifications 菜单            | 不改 contextmenu、toast 或全局 action failure 路径；新状态文案只放所属 Sessions 行                                                                                                   |
| Search 生命周期               | 不改 search controller、cancel handle 或 session file/search provider；generic connection 测试不代表 Search 可重新执行                                                               |
| Output                        | 不改 output filter/autoscroll；诊断只说明已测失败，不引入另一份日志状态或新 output owner                                                                                             |

云端只能确认 main 已提交内容，无法判断这些任务尚未集成的本地冲突。执行者开始每批前读取真实工作树并保护已有变化；中途发现新路径时重新确认边界。

## 环境与验证安排

初始审计环境为 Linux，约 9.8 GiB 总内存、30 GiB 可用磁盘，缺少 Rust/Just/前端依赖。按后续授权现已在 task-local 路径固定 Rust 1.98.0、Node 24.21.0、pnpm 12.8.0、Just 1.46.0，并使用仓库 hashed Python venv、冻结 JS lock 和 Rust generator。Cargo 仅使用 2 jobs、单个 package 验证；未修改全局工具配置或启动 workspace/V8 构建。第一批结束时约 22 GiB 磁盘与 7 GiB 内存可用；第二批复用依赖/生成物，结束时云端约 12 GiB 磁盘可用。保留正常缓存，不主动清理。第二批未占用 Cargo build/verify 进程或共享可写 target。

- 文档可在云端立即校对路径、链接、Markdown 和 whitespace；这些检查不验证产品行为。
- 第一批不改 wire schema，但 TS 测试仍需要有效生成物；可复用与源码指纹匹配的 backend package contract，否则需要 Rust generator，不能手写 `.build/protocol` 来绕过。
- 按仓库脚本准备工具链后串行运行 `just verify ash-state` 和定向前端测试。Rust 初次冷构建先评估依赖图、V8/其他资源与磁盘，限制并发；不直接启动全 workspace build。
- 第三批需 `just generate-protocol`、`just verify ash-protocol`、`just verify ash-app-server-protocol`、受影响 `ash-state`/`ash-core`/`ash-app-server` 检查、`pnpm typecheck:protocol` 和 renderer/build 验证。依据实际变动范围缩小 package，不并行争抢同一 Cargo cache。
- Web 和 Linux Electron 的真实协议/UI行为在相应环境可验证；macOS 的真实系统菜单、OS sleep/wake 和 macOS daemon/窗口边界需在连接的 Mac 上验证。云端 Linux 通过不能标记为 macOS 通过。
- 方案、第一/第二批独立源码补丁和验证证据在云端交付。本地先保存第一批 checkpoint，再按完整补丁与 todo 消费第二批，统一完成 Mac 运行时验收；其余批次和新增身份契约仍需确认。不私自提交、push、开 PR 或修改公共规则。

## 非目标与后续规范建议

本次不引入 VS Code Node/Copilot SDK runtime、AHP action/state/replay 协议、Mission Control，不用上游私有类图重写 Rust；不按文件数补空模块，不扩展 credentials、权限、部署或共享访问；不把 Project/Workspace/Environment/Session/Thread/connection 合并为一个身份。

通用流程建议落在现有 [AGENTS.md](AGENTS.md#development-workflow) 的 Development workflow，与普通任务流程相邻，而不是放进仅适用于 `/develop` 的四产物文档或对齐 skill 的私有结构说明。建议文字：

> 模块对齐先在云端核对现有能力、公开契约、真实调用链、唯一 owner 和近期上游行为，形成根目录 `<module>-todo.md`，写清基线、分批路径、依赖、产品验收与未决定事项；用户确认方案后，在指定本地 checkout 按批准批次实施并记录实际验证。云端审计不替代本地差异检查，不自动授权提交或推送。

此段仅是建议，尚未写入公共指导文件。若本地已有本次流程或模板，合并为一条规则并保持其既有例外，不重复扩张为四份阶段产物。

### 多宿主连接切片 · 连接与 Provider 已接通

用户 `do` 授权落地多宿主。基线与既有改动保存在 `.build/agenthost-multihost-20261018/`。本切片的生产链为 Agents 窗口选择已保存 SSH 目标 → Renderer 独立领域能力 → Main 窗口级 carrier 租约 → 现有 SSH bootstrap／Rust daemon。新增连接不创建后端业务状态副本，不让 Main 解析协议。

既有专属 owner 原地扩展：`platform/agentHost/common/appServerTransport.ts` 定义每连接 carrier 身份，`electron-browser/appServerMessagePortTransport.ts`／`localAgentHostService.ts` 与 `electron-main/appServerConnectionRelay.ts` 使用相同 channel 规则；`platform/remote/{common/remoteConnectionIpc.ts,electron-main/remoteConnectionIpc.ts}` 管理窗口临时租约，保存目标仍归原 Rust catalog；`code/electron-main/app.ts` 仅装配既有 launcher／relay；`platform/renderer/common/rendererHost.ts` 与 `workbench/electron-browser/rendererApi.ts` 装配独立领域能力。以上沿用已确认的 Ash transport／remote／Renderer 专属归属；无文件删除。

实现说明：Main 临时表只持有本窗口的 carrier 资源，不保存会话；打开请求先登记可退休租约，再核对用户选中时的完整 catalog 目标，关闭、页面导航或窗口释放均退休该租约，迟到核对不得创建连接。Renderer 各连接各有 protocol client、恢复与 adapter。此切片不修改 DOM／布局，窗口 Provider／会话身份及 Chat／文件路由仍需后续闭环。行为验证覆盖两个独立 carrier、关闭期间的迟到打开、目标变更、重复 ID 与资源释放。

窗口连接切片的真实消费者先接入已有 Provider 注册表和 Automation 聚合。新增上游同路径 `sessions/contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.ts`，从 Desktop Sessions 入口加载；窗口 contribution 是 child service scope 的唯一 owner，Quick Pick 使用现有组件的键盘、ARIA 与主题能力，无新 DOM/CSS。既有 `AppServerSessionsProvider` 只增加每实例 id/label 数据，保留其目录、订阅与操作 owner；注册表借用 Provider，注销先于 scope 释放。测试落在上游同路径 `remoteAgentHost/test/browser/remoteAgentHost.contribution.test.ts`，从真实命令和 Quick Input 操作到注册表、领域 adapter 与 Automation 聚合，核对相同后端 ID 的路由与 disconnect。该窗口注册不代表 Sessions 主列表／Chat 路由已完成，根 TODO 仍保留。

路径复核调整：保存 SSH 目标的窗口 scope 实现应归上游同路径 `remoteAgentHost/browser/sshAgentHost.contribution.ts`（`SSHAgentHostContribution`），而非通用 contribution。实现已收回此准确 owner，`remoteAgentHost.contribution.ts` 只保留真实的窗口 phase 注册；无别名、双实现或删除。连接键来自 Ash 既有 canonical catalog 的 host + workspace，内部资源 Map、取消与子容器按 Ash 生命周期独立实现，未沿用上游重连类图、存储或私有控制流。

同一切片必须隔离 Automation 的后续消费者：真实入口已发现 run 的 raw Session ID 曾丢失 Provider 归属，表单也可能沿用上一宿主的目录／conversation。既有 `workbench/services/chat/common/chatSessionNavigationService.ts`、`sessions/browser/{workbench.ts,workbenchChat.contribution.ts}` 与 `automationsView.ts` 现传递并在真实导航 owner 检查 Provider；主模型尚不支持其他 Provider 时拒绝导航，禁止回落到本机同名 Session。`automationDialog.ts` 只显示所选 Provider 的 destination，切换宿主清空旧目录及 conversation；`AgentHostAutomationStore` 的 Session resource 同时包含 Provider authority。导航 owner 与 Provider 完整聚合仍是后续任务，本次保护不能当作远端 Chat 已实现。

当前通过证据：9 份定向测试共 150 项通过，覆盖 carrier、窗口租约、目录授权退役、独立 Provider／Automation、跨 Provider 导航拒绝和原 Sessions 行为；日志 `final-targeted-unit.log`。标准 `test:unit:prepared` 的全测试编译和上述 9 文件／150 项定向运行最终通过，见 `final-standard-unit.log`。期间遇到并行改动中 `EditorPaneRegistry` 重复声明，先以原编译选项的精确入口集合验证；该声明随后由并行编辑消除，本批未修改该文件，并重新运行标准命令确认通过。真实 Chromium Automation 原有流程及新增双宿主键盘／中文／高对比度、目录与会话隔离场景见 `final-browser.log`；使用受控 backend，未作为实际多 SSH runtime 验收。证据均位于 `.build/agenthost-multihost-20261018/`。根两条文件任务仍未达到移除条件。

交付边界：原有及新增 Chromium Automation 共 18 项通过，其中双宿主场景使用相同后端 ID 和相同任务名称，核对视觉／ARIA 宿主标识、可访问文本视图、中文帮助、键盘连接／断开、目录清理及错误宿主会话过滤。Renderer 4,219 文件与 Main 2,039 文件类型检查通过；当前 scoped formatter 与 `git diff --check` 通过。SSH scope 入口、同路径台账和翻译均已更新；无 Rust、Terminal、CLI/TUI 变更，无提交／发布。仍须继续统一 Session 身份与主模型、Chat／模型／文件／仓库／权限路由，不能把目前拒绝错误宿主的保护当作这些能力已实现。

多宿主 Automation 同名条目现保留宿主名称并可按宿主搜索；复用既有卡片／运行行，不新增 CSS 或上游 DOM。已有 Activity Bar 帮助、Automation Help／Accessible View 与中文翻译同步说明连接命令、宿主选择及清空行为。最后的新增 Help／同名条目断言分别通过 `final-automation-unit.log`（19 项）和 `final-host-browser.log`（2 项），复用其余已通过的 carrier／Sessions／导航与浏览器验收结果。
