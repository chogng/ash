# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## MXC · 跨平台验收

- [ ] **验收** · 在支持 PSEC 的 Windows、WSL2 和独立 Linux／x64 运行当前 SDK pin `f1e8694b`，并补外部局域网／公网 IPv6。Ash Windows x64 全测试目标交叉编译仍缺目标 C 工具链；全仓依赖安全门禁仍被既有 zbus 生态停止维护公告阻挡。命令与验收边界见 [MXC 清单](MXC-TODO.md) 与 [适配器验证](crates/mxc-sandbox/README.md#验证)。

## Windows 开发实验资源清理

- [ ] 定位并清理 Windows 测量的五个临时目录。本机复核时 `.build/desktop/dev/app-server/.staging-c8813138-4733-4acc-8ebe-05eee0827ccd` 已不存在；`.build/perf-win-edit-20261018/round4-cleanup.json` 也不在当前检出，缺少五个目录的准确路径，不能据此宣称其已清理。

## Remote / Browser 多根工作区 · TODO

工作区契约见 `docs/desktop-architecture.md` §4.2。

- [ ] **验收** · Web 多目录授权、listener 独立运行域和 Apply／Finish 会话转换已实现，并复用原 WorkspaceEditingService／BrowserHost 链，Browser 不取得 `directoryGrantsHost`。后端工作区／撤权回归与前端 26 项定向测试通过；仍需在真实 Web 编辑器中经服务端可信逐根确认，验收新增、移除、脏文件拒绝和重载恢复。
- [ ] **验收** · Web 准确配置文件的独立 read／atomic write／watch、只读与显式撤权、关闭和失败回滚已实现；ExactFS、授权上限和后端撤权测试通过。仍需真实 Web 编辑器移除配置所在根后保存同一配置文件，验证拒绝、脏文件与连接关闭流程；现有自动回归不替代这条完整交互链。
- [ ] **后端前置** · 实现直接保存工作区配置到远端机器；当前 SSH 配置仍保存在 Desktop 本地，内容为远端 URI 根。
- [ ] **验收** · 补 Windows／Linux 远端多根及真实系统文件选择器验证。现有多根 SSH 验证使用 macOS 同机隔离 OpenSSH fixture，选择器使用受控返回值；跨机器单独步骤通过不能替代多根场景验证。

## Desktop 跨机器验收 · TODO

- [ ] **验收** · Complete one real Desktop → selected Windows host run over SSH/Tailscale with all 10 steps, cleanup and evidence QA. The implementation is committed in `7cfdccd9b`; end-to-end acceptance remains unfinished. Preserve concurrent changes in both requested original checkouts; do not reset or substitute another checkout.
- Current status and machine-specific connection/build details are in ignored `.build/remote-desktop-acceptance/cross-machine/status.json` and `.build/ash-playwright-mcp/cross-machine/`. No passed acceptance report has been written.
- Final Windows package is the dedicated-cache `runtime-desktop-84d5912d-isolated-git`, buildId `3595725c14837525c7385b4e02d3e62c46de7ac8385f86674790a2e52b441152`; actual executable protocol major8/schema `25796190…a61a1eb4` matched its manifest and Desktop. `artifact.json` and `source-pin.json` are current. Source base `84d5912dea1d9279aedf785381322b41eecd2271`; exact runtime patches/source SHAs in runtime-cwd.patch, runtime-git.patch and metadata. Do not reuse rejected shared-cache cwd/cwd-protocol packages (manifest257, actual513); direct probe exposed that mismatch.
- Normal frozen client: `.build/remote-desktop-acceptance/desktop-client-84d5912d-fixed`, inventory2915files/critical Mac binary hashes/reachable247moduleRenderer graph verified in client-snapshot.json. Retained Mac backend73061 has schema257; independent direct backup/workspaces probe passed. Diagnostic copies are separate. Fixed exported build input is client-input-84d5912d; it contains only task fixes plus documented filename-case correction. It is a build input, not a replacement for root edits.
- Latest useful full run: evidence `desktop-cross-machine-windows-2026-10-18T05-35-43-184Z` PASSED DEPLOY, FILES and AGENT on final359runtime; DEBUG failed before adapter process (adapter-host absent, DAP requests empty), console only `[application] unavailable`. Cause remains unknown. Earlier provisional packages passed task/PTY/ports/Browser/recovery and an earlier diagnostic passed Debug; these do not constitute all10 on the final package.
- Final Git UI is still unaccepted. Before ResourceUri fix it failed HostRPC invalid protocol; afterward UI initialization hit invocation deadline. Scenario now waits120s for Git's existing3×30s bounded initialization retries (mutations/index assertions remain30s). Need verify Desktop stage/unstage through independent Windows index reads.
- Fixture setup now uses seed-profile.cjs: same packaged app-server direct stdio owning RPCs configure synthetic model/private-file secrets BEFORE Desktop, then exit. It asserts ZERO managed package manifests before Desktop so cold runtime installation remains tested. This removed live setup/catalog race; Agent passed. Run.mjs holds real Windows Node fixture through its SSH owner, verifies health, seeds, launches scenario, finally cleans exact profile/service/PTY. Cleanup JSON records nonce/profile. App-server direct fixture is not CLI/TUI product host.
- Debug diagnostics: scenario-debug-after-agent.mjs currently selects DEPLOY/FILES/DEBUG; attaches CDP pause-on-exceptions only during Debug, resumes immediately and writes debug-exceptions.json. Last diagnostic `desktop-cross-machine-debug-exceptions-2026-10-18T06-00-35-621Z` failed DEPLOY on management SSH loss, so did NOT reach CDP capture. Prior diagnostic selected Agent first but failed extensions/list during Agent. Do not claim an exception stack was captured.
- Resumed diagnostics after the user selected “暂时关闭 Meta TUN 后重试”: isolated DEBUG run `desktop-cross-machine-debug-logs-2026-10-18T10-48-53-582Z` passed DEPLOY/FILES/DEBUG, including Windows DAP launch, breakpoint, source path, and `answer=42`; it is still only a partial run. Full runs `desktop-cross-machine-windows-2026-10-18T10-55-05-749Z` and `desktop-cross-machine-windows-2026-10-18T11-03-23-236Z` both lost the Desktop App Server stdout around 33 seconds into startup and remained connecting; increasing the ready wait to 180 seconds did not help. The first trace had `extensions/list` pending before a repeated `initialize`; the second had only `initialize` before transport ended. A direct post-failure initialize against the same Windows runtime returned the expected protocol 8/schema, so that does not establish a Desktop pass. On the last retry, one Tailscale ping answered in 325 ms; the Meta TUN/SSH verification command was canceled at the user's handoff, so its disabled state and sustained network stability remain unverified. No source, proxy, firewall, or persistent Tailscale settings were changed in these retries.
- Optional ASH_CROSS_TRACE_PROTOCOL=1 routes only test SSH connect stdio through trace-ssh.py; logs ONLY id/method/error code/message, never request bodies/keys. Byte forwarding handles partial writes. Normal env does not enable this. Trace `ssh-protocol-trace-0dc4cdbe.jsonl` and RPC latency JSON show slow nested calls during that failed diagnostic; timings are diagnostic, not a performance benchmark. No new performance/cache core fix was implemented.
- Network repeatedly lost packets and changed public endpoints despite both hosts sharing a LAN. The user selected temporarily disabling Windows Meta TUN while retaining Tailscale; one later ping answered in 325 ms, but the resumed verification was stopped before confirming the adapter/process state. Network is NOT proven the sole cause of Debug unavailable or Desktop startup loss. Agent did not edit proxy config files. Only transient Tailscale rebind/DERP reconnect diagnostics occurred; no persistent Tailscale preference change.
- A temporary Windows peer-only outbound UDP restriction was ineffective and REMOVED. Independent verification returned absent; temporary-relay.json has restored/removalVerified=true. No temporary firewall rule remains. All last fixture processes were stopped, remote scan found no owned profile/service processes, Mac test processes absent, observer93962 stopped, owned SSH Master socket already absent. No active test/build/monitor remained at that recorded handoff; the ongoing acceptance chat has since resumed diagnostics.
- Resume: incorporate the user's Meta TUN change, then verify Tailscale and management SSH stability without editing persistent network settings. Capture the Desktop App Server/SSH exit and remote daemon log before cleanup if startup fails again; distinguish app-server acquisition, protocol initialize, and workspace readiness. Preserve the normal client. Then run fresh prepare-fixture.mjs + default run.mjs all10 with normal client, no diagnostic tracing. Collect gather-proofs.mjs, review per-step PNG/browser capture and ALL WebM recordings (review-video.mjs handles all), inspect trace/cleanup, then report.mjs (guards all10/identity/model request count/seed cold state/network restoration). Stop observer/Master and remove only this TODO section when complete.
- Scope: explicit development runtime, deterministic model SSE and DAP peers while Desktop/backend/Agent/processes/SSH real; supported isolated file secret mode (OS vault not accepted); no signed feed/autodownload, real provider or WAN reliability claim. Raw WebM/trace/screenshots; no captioned-video tooling. Machine-specific details remain in ignored artifacts.

## 系统授权保存 · TODO

- [ ] **验收** · Windows 交互桌面按 [UAC 验收手册](docs/windows-system-authorization.md) 分别完成真实取消和批准。使用未提升权限的进程、开启 UAC，记录实际弹窗、程序／发布者、两次各 `1 passed` 及日志；自动断言须覆盖字节／BOM／CRLF、dirty、ACL 和焦点。管理员成员普通终端与标准用户输入另一管理员凭据分别验收；skipped 或通用保存失败不算通过。
- [ ] **验收** · macOS 密码授权和 Linux pkexec 各自完成对应系统验收；Windows UAC 结果不覆盖其他系统。

## Configuration / Preferences · TODO

- [ ] **验收** · 在 macOS／Linux 验收真实系统 Policy 来源；用真实登录账户验证 GitHub managed settings 的读取、账户切换、撤回和失败保留。
- [ ] **验收 · Preferences 上游窗口配对**：以本地 VS Code `a2acc8c864a` 对照用户／Workspace／Folder、`@lang:` 与 `@modified` 组合、重置、JSON 草稿、侧边／指定组和焦点语义。本地 VS Code 尚无可运行构建，源码／上游测试核对不能代替窗口配对。当前实现与证据范围见 [Preferences](docs/preferences-and-settings.md#已有验证与限制)。

当前存储、配置层和设置入口见 [Preferences 与 Configuration](docs/preferences-and-settings.md)。

## AgentHost · TODO

文件关系与实施顺序见 [AgentHost 文件台账](agenthost-todo.md#当前文件台账--2026-10-18)。已完成的通用服务、跨连接复制和权限取消验证见 [通用服务记录](agenthost-todo.md#通用复制与权限取消--2026-10-18)。

- [ ] **文件对齐 · 剩余连接／Workbench 契约**：闭合统一宿主管理和多端点公开契约；证明上游 `IAgentService`／`IAgentHostService` 与 Rust 执行契约的对应关系，不按同名文件计完成。范围见 [AgentHost 文件台账](agenthost-todo.md)。
- [ ] **前置契约 · Workbench 文件／资源服务**：renderer 本地资源 broker 尚缺双向 host request、realpath／授权 owner 及消费者；synced customization 尚无 producer。跨宿主复制和目录权限取消已闭合，验证见 [通用服务记录](agenthost-todo.md#通用复制与权限取消--2026-10-18)。文件查询交集过滤需要截断前后端过滤或分页契约；当前生产查询保留既有 glob／fuzzy。具体路径与现有 owner 见上述记录。
- [ ] **新产品 · Agent SDK／Codex 续接／本地模型／独立 Web 启用**（用户决定先列缺口）：SDK 下载／重载、Codex 专属账号与配额续接、模型安装／server lifecycle、Web 启用设置／context owner 均须先闭合领域契约与生产入口；保留现有多 provider 账号和 Web transport 可用性，不新增空服务。准确文件清单见上述 Workbench 记录。
- [ ] **文件对齐 · 剩余 Sessions／Chat／现有远程能力**：`SessionsManagementService` 主模型仍只绑定一个 Provider，尚须实现跨宿主 Session 身份、统一主列表／分组、创建和选择，以及 Chat／模型／文件／仓库／权限的对应 scope 路由；完整范围见 [多宿主复核](agenthost-todo.md#多宿主范围复核--尚未完成)。当前其他宿主的对话导航会明确拒绝，禁止打开本机同名 ID；这不代表远端 Chat 已完成。Node、state／meta 和生成协议的既有 Rust／可选 Provider 分流仍待逐项证明；不覆盖正在进行的 Terminal 工作。
- [ ] **新产品 · Cloud Sandbox**（用户决定先 TODO）：先确定服务端实例／仓库 producer、账号和凭证刷新、Session／文件权限及 Provider 归属，再实现连接、目录、模型和会话入口；当前没有对应生产 producer，具体路径见清单 `todo-by-user`。
- [ ] **新产品 · Tunnel／WSL**（用户决定先 TODO）：分别确定网关／认证／重连／存储与 WSL runtime 启停／分发／authority 契约，再接既有 Remote owner；当前 SSH／Dev Container 不作为这些能力已实现的证据。
- [ ] **新产品 · Mission Control**（用户决定先 TODO）：先确定后端控制与会话事实、认证／credential delegation、共享权限及 Provider 归属，再实现环境与会话入口；不预建镜像状态或转发类。
- [ ] **验收 · 跨平台**：取得 Windows/Linux 当前实现的实际运行结果；新增 Desktop runtime acceptance 的 Windows/macOS MCP 进程回归步骤尚未在远端执行。
- [ ] **验收 · 真实外部账号**：使用专用测试账号验收 Kimi Desktop/CLI 身份切换、同身份 token 轮换、旧结果隔离及临时发现失败，观察已打开的模型 picker。合成 scope/账号回归不能替代此结果。
- [ ] **验收 · 系统休眠恢复**：在可中断的测试机器运行实际 OS sleep/wake，核对连接恢复、重新鉴权、订阅和工具权限；尚未在日常开发机器执行系统休眠。
- [ ] **验收 · B2 TUI 与真实外部模型**：继续补真实外部账号的模型 picker 与 TUI 场景。本机已重新验证当前 CLI 缓存契约，并通过真实 Rust observer 的完整 10 分钟 Web Code／Cowork metadata 更新和失败保留场景；该合成账号结果不覆盖外部服务或真实 TUI，证据范围见 [AgentHost 台账](agenthost-todo.md)。
- [ ] **集成 · Worker 装配**：将 Sessions common 入口和 Electron rendererApi 连接作用域的 `IWebWorkerService` 注册补丁随并发 Worker 模块整体提交；对应入口／作用域回归通过，真实本机启动已越过该错误。四个补丁路径为 `sessions.common.main.ts`、`activityBarPart.test.ts`、`rendererApi.ts` 和新增 `rendererApi.test.ts`；它们依赖当前未提交的 Worker 接口，不能单独形成缺依赖的提交。
- [ ] **复核 · 旧隔离环境故障**：取得麦克风枚举失败与 `TerminalOperationFailed` 的准确步骤和底层诊断，分别沿音频设备、app-server terminal/environment owner 定位。原 2026-10-08 证据目录不在当前检出；不能凭通用错误码或普通终端测试关闭报告。

## Sessions · TODO

- [ ] **验收 · Dev Container 产品入口** · 从 Agents 窗口验收宿主 gateway 准入、窗口关闭／重开及持久容器控制清单，并补 authenticated Remote catalog 自动安装；入口与环境要求见 [Docker Provider](extensions/dev-containers/README.md)。
- [ ] **后端前置** · 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。
- [ ] **后端前置** · 为 CI rerun、logs／annotations 和 Fix CI 请求闭合领域端口及 UI 生命周期；当前只读 checks／statuses 不代表这些操作已实现。
- [ ] **验收** · 对已接通的提交／会话切换、Changes 审阅与 PR 表单执行上游窗口配对场景，观察仓库身份、修订、焦点、取消和关闭后的结果；现有 Ash Electron、浏览器和架构回归仅覆盖原有范围。尚未接入的 CI 操作和后台合并不纳入这次已实现行为的验收。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] **后端前置** · Speech 动态注册：Host 当前 `sealActivation` 冻结注册，`host.mjs` 只允许 activating 期间 register。先为原 admitted registry 定义晚注册／注销与后端 fleet 更新端口，覆盖精确 registration／activation generation、退休清理和迟到事件；不用前端轮询或另一张 provider 表替代。
- [ ] **后端前置** · 标准 Voice／hold 命令先闭合聚焦 Chat widget 与输入生命周期的 `IChatWidgetService` 调用链；PTT／audio／session-context 的完整 VoiceClient 仍缺兼容 producer。现有 Ash Call／VoiceAgent 验证不代表上游 API 对齐；远端自有 Voice/Core bridge 不继续扩展为本轮对齐任务。
- [ ] **后端前置** · MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。
- [ ] **验收** · 补真实账户、物理音频设备与音质验收；现有本地 Call/LiveKit、模拟 Live wire 和 AudioHost 设备替身不能代替该结果。本地转写的 Foundry Local cacheDir／下载／代理契约与完整 Prompt／Agent 格式按真实调用需求另核对。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## Debug · TODO

目标与所有权见 [调试系统](docs/debugging.md)。

- [ ] **后端前置 · Rust manager 领域状态**：当前会话运行意图/绑定、Watch 求值及检查链已在 Rust。继续迁移可编辑工作区断点/Watch 定义及原 Memento 数据、实时异常过滤器配置、父子生命周期与结构化输出；核对 Testing/扩展 API 消费者，保留保存、配置回调、Tasks/Terminal 的原 owner。
- [ ] **可做 / 后端前置 · Debug Console 对齐**：从 `debug.contribution.ts` → `debugConsoleViewPane.ts` → `common/replModel.ts` 的真实入口对齐 `repl.ts`、`replFilter.ts`、`replViewer.ts` 职责；继续实现过滤、就绪的结构化输出、分组/对象展开/源码链接、历史与补全。当前 output 只保留文本；补 NLS、无障碍、焦点与窄布局验证。选中暂停会话的栈帧求值已接通，Repl/DebugService 的 82 项定向测试通过，包含 frameId=0、会话范围及合并子控制台路由。
- [ ] **后端前置 / 验收 · 检查视图与跨端回归**：manager 端口就绪后，逐段对齐 Variables、Watch、Call Stack、Breakpoints 和 ViewModel。补新架构的真实 Desktop、Remote 路径、真实 LLDB 程序、父子会话及扩展停用/取消/崩溃回归；本轮 Browser 与确定性 adapter 结果不替代这些验收，历史跨机器记录也不证明新架构已通过。

## Terminal · TODO

- [ ] **复核历史启动抖动** · 定位终端首次 `page.goto` 的 HTTP 文档请求挂起／ERR_ABORTED；原 trace 未加载产品代码，原因尚未查明。若再次出现，按原 trace 调查服务器首次连接，不延长断言。原日志 `.build/path-owner-browser-final.log`、`.build/path-owner-terminal-retry-prepared.log`，原 trace `.build/desktop/playwright/editor-browser-PCDyWW/results/`。

终端契约见 [Terminal](docs/terminal.md)。以下按现有调用链分批推进；上游行为参照 `terminalActions.ts`、`terminalTabsList.ts`、`terminalContrib/clipboard` 与 `terminalContrib/history`。

- [ ] **布局前置 · 面板分屏方向**：先闭合布局 owner 的真实 Panel 位置契约：当前 `IWorkbenchLayoutService` 没有 `getPanelPosition`，Part 也未提供移动 Panel 位置的操作。不能按宽高猜位置或在 Terminal 自建第二份 Panel 状态；再让组按方向保留相对尺寸和焦点。
- [ ] **后端前置 · 跨窗口转移**：独立定义进程租约、屏幕及输入交接并验收；现有 30 秒租约只闭合同一 Desktop 窗口 reload，Web 保持 connection-owned 生命周期。
- [ ] **后端前置 · 应用退出后恢复输出、cwd 和布局**：有限 `TerminalRecorder` replay 与命令文本历史不等于完整终端恢复；缺少持久化缓冲、布局和重建 Shell 的入口。与保留原进程的 reload 分开验收；不承诺任意旧命令跨应用退出继续执行。
- [ ] **复核 · 文件链接扩展**：补目录打开、工作区搜索型链接、外部 provider 与适用配置的实际入口，复用执行宿主 cwd／路径和文件服务授权，验收鼠标、键盘及异步关闭／重连。
- [ ] **验收** · 补跨机器 SSH、Windows PTY／PowerShell，以及 Linux Desktop 的真实 OS 文件拖入；应用退出后的 revive 独立验收。Linux 文件链接、reload、活动文件／选中文本执行和最近目录选择器的 6 项真实 Desktop 场景已通过，范围见 [Terminal](docs/terminal.md)。

高频交互验收同时观察原进程身份、待提交输入、选区和焦点；执行、权限和工具调度继续归 Rust。

## Stanza 编辑器 · TODO

- [ ] **验收** · 补系统 IME 候选窗口、Electron 平台及屏幕阅读器验收；浏览器合成 composition 事件不代替物理输入法。

后续阶段由[编辑器路线图](docs/design/editor-roadmap.md)维护；本清单不再把整条路线图重复记成一个未完成任务。

## Work / 通用文档 · TODO

产品范围与约束见 [Work / Code 设计](docs/design/work-code-workbench.md)。

- [ ] **Ash 产品** · Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。现有 `AppServerTextDocumentHost` 仅闭合普通文本快照和 WorkspaceEdit；须先定义结构化编辑的真实 producer／领域端口及审阅行为，不能把 `.ash-doc` 的共享模型再解析成第二份普通文本模型。
- [ ] **Ash 产品** · 增加 Work 产品入口和默认布局，复用现有生命周期，明确 Code／Work 的资源、未保存内容、会话与状态恢复，不恢复模式注册表或第二份配置。
- [ ] **Ash 产品** · Chat 主画布与辅助栏共用会话、附件和草稿状态，接通 Move Chat to Editor Area；验证布局切换、重启、并排焦点及不误发送。分页、docx／PDF 输出仍属另行设计范围。

## Desktop 启动性能 · TODO

- [ ] **测量** · 用 CPU profile 和构建清单量化入口脚本执行，按实际使用推迟非首屏模块；每次比较静态 JS、首次功能成本及四组重复启动样本。
- [ ] **测量** · 对齐 Renderer／Main／App Server 同一连接的时间点，定位重复请求和顺序等待；覆盖后端停止／复用，首次授权独立计量并保留用户决策。

复测命令与基线见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

测量入口与约束见[审计与测量](docs/ash-app-server-data-path-audit.md)。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **测量** · 测 Worker 回传对象的复制、Thread／transcript 重复 item 与领域保留堆；按稳定 ID／revision、有界领域值评估减量，不把 transport DTO 变成权威业务状态。
- [ ] **复核** · 继续完善文件模型刷新、Chat Changes 摘要以外的过期只读 refresh，补齐传输取消、大内容按需资源读取及迟到响应清理；状态变更请求不得自动重放或合并。刷新与取消约束见[消费者刷新约束](docs/ash-app-server-data-path-audit.md#已接入的消费者刷新约束)。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。
- [ ] **测量** · 先量化大代码围栏的完整 `TextModel.setValue`、配置／布局成本及巨大单块 Markdown 尾部预算，再决定增量编辑或更新合并；此前 Markdown 子阶段收益不能当作整条响应同幅度加速。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 终端 Suggest                               | 命令／参数／路径候选与接收 UI。先选实际 Shell 和候选 producer，再接已有输入与命令状态；Shell 自身 Tab 补全已经通过 PTY 工作。上游位于 `terminalContrib/suggest`。                                                                                                                                                                                                                                          |
| 终端 Sticky Scroll／命令引导               | 长输出中保留当前命令及命令范围导航。先用已有命令边界验证滚动、换行、trim 和焦点；上游位于 `terminalContrib/stickyScroll`。                                                                                                                                                                                                                                                                                 |
| 终端 Quick Fix                             | 根据失败命令及输出展示可执行修正。先确定实际 provider、结果来源和执行授权；现有错误标记仅展示状态。上游位于 `terminalContrib/quickFix`。                                                                                                                                                                                                                                                                   |
| 终端扩展 API                               | 按真实扩展需要补链接、Quick Fix、补全 provider 和 Shell Execution 事件。已有 Profile／环境变量／自定义 PTY 继续复用；没有消费者时不增加空 API。                                                                                                                                                                                                                                                            |
| 终端进程属性与 backend port                | 先找到缺失属性、其他信号或 child-process／port 的具体消费者，再扩充 Rust 领域契约；现有 SIGINT 链不表示完整支持。                                                                                                                                                                                                                                                                                          |
| Fish 增强 Shell Integration                | Fish 启动与增强注入分开；确定支持范围后补命令生命周期、可信 cwd／env 及实机回归。基础 Fish 运行验收仍在当前待办。                                                                                                                                                                                                                                                                                          |
| Shell 历史文件导入                         | 将 Shell 历史与 Ash 最近命令组合。需要执行宿主侧读取、格式解析、限额和隐私／禁存配置，不让 Renderer 读取另一台机器的历史文件。                                                                                                                                                                                                                                                                             |
| 鼠标剪贴板偏好                             | 选中即复制、可配置右键复制／粘贴；沿 `TerminalClipboardContribution` 和已有配置链实现，覆盖平台差异、焦点及异步剪贴板失败。多行确认单独保留为当前待办。                                                                                                                                                                                                                                                    |
| 完成通知／自动回复                         | 分别确认后台命令完成提醒和固定响应规则的产品需求；bell signal 不等于完成通知，自动回复需复用后端输入与权限边界。                                                                                                                                                                                                                                                                                           |
| 远端本地回显／尺寸提示／独立缩放           | 先量化输入延迟或确认显示需求，再选具体交互，避免用局部回显掩盖真实 PTY 状态。                                                                                                                                                                                                                                                                                                                              |
| GPU／字符宽度／图片显示                    | 先证明 renderer 性能问题、具体 Unicode／grapheme 兼容用例或图片协议需求；不能仅凭没有 addon 判断现有中文显示缺失。                                                                                                                                                                                                                                                                                         |
| 终端内嵌 Chat                              | 先确认相对“附加终端到 Chat”的独立使用场景，再设计终端覆盖层及焦点；会话、Agent 执行、审批和工具调度沿原 owner。                                                                                                                                                                                                                                                                                            |
| 统一诊断包导出                             | IDE 与 Agent Window 已有 [Agent Host 调试日志包](docs/chat.md#调试日志导出)，包含客户端日志、Session 所属本地／SSH 宿主的进程日志与现存轮转文件、当前会话执行证据，以及当前 Chat／子 agent 已录制的请求和响应正文。manifest 记录录制状态、范围、限额和收集问题。更广的通用诊断包仍未排期：`feedback/prepare` 的构建、活动统计、响应诊断和指标快照尚未接入该入口，新增来源须沿其 owner 的真实收集契约接入。 |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                                                                                  |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。设置呈现与接入规则见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前实现)。                                                             |
