# 待办

按功能记录尚未完成或缺少通过证据的工作；本次文档归并于 2026-10-18。每项保留当前进度、下一步和验收边界，完成后移除。设计中的可选方向不自动视为实施承诺；开始时复核代码与最新证据。

## Remote / Browser 多根工作区 · TODO

本地、SSH 与独立 Browser 目录句柄模式已实现并提交，职责与验证范围见 `docs/desktop-architecture.md` §4.2。下列能力仍未完成：

- [ ] 用户已确认纳入连接 App Server 的 Web 多根支持，并要求对齐 VS Code 的工作区公开契约与职责。已补齐 `IWorkspaceEditingService.enterWorkspace`，Browser 保存与外部配置重载已迁入这一共享入口；16 项工作区单测、Renderer 4,203 文件类型检查和真实 Chromium 目录句柄多根 smoke 均通过（日志 `.build/todo-workspace-entry-*.log`）。这不代表 App Server Web 多根已完成：当前仍是服务端单根会话；先在 `crates/app-server-protocol/src/web.rs`、`crates/app-server/src/managed/web.rs` 和对应 transport owner 实现多目录授权／会话契约，再适配 `appServerWebWorkspaceClient.ts`；不能把 Browser 提升为 `directoryGrantsHost`。
- [ ] 为上述 Web 模式实现工作区配置文件的独立访问生命周期：移除配置所在根后，仍能访问已授权的准确配置文件，不扩大父目录授权。接通 Browser Host／编辑器链，验证权限拒绝、脏文件、连接关闭和真实 Web App Server。
- [ ] 实现直接保存工作区配置到远端机器；当前 SSH 配置仍保存在 Desktop 本地，内容为远端 URI 根。
- [ ] 补 Windows／Linux 远端多根及真实系统文件选择器验证。现有多根 SSH 验证使用 macOS 同机隔离 OpenSSH fixture，选择器使用受控返回值；跨机器单独步骤通过不能替代多根场景验证。

## Desktop 跨机器验收 · TODO

- [ ] Complete one real Desktop → selected Windows host run over SSH/Tailscale with all 10 steps, cleanup and evidence QA. The implementation is committed in `7cfdccd9b`; end-to-end acceptance remains unfinished. Preserve concurrent changes in both requested original checkouts; do not reset or substitute another checkout.
- Current status and machine-specific connection/build details are in ignored `.build/remote-desktop-acceptance/cross-machine/status.json` and `.build/ash-playwright-mcp/cross-machine/`. No passed acceptance report has been written.
- Final Windows package is the dedicated-cache `runtime-desktop-84d5912d-isolated-git`, buildId `3595725c14837525c7385b4e02d3e62c46de7ac8385f86674790a2e52b441152`; actual executable protocol major8/schema `25796190…a61a1eb4` matched its manifest and Desktop. `artifact.json` and `source-pin.json` are current. Source base `84d5912dea1d9279aedf785381322b41eecd2271`; exact runtime patches/source SHAs in runtime-cwd.patch, runtime-git.patch and metadata. Do not reuse rejected shared-cache cwd/cwd-protocol packages (manifest257, actual513); direct probe exposed that mismatch.
- Normal frozen client: `.build/remote-desktop-acceptance/desktop-client-84d5912d-fixed`, inventory2915files/critical Mac binary hashes/reachable247moduleRenderer graph verified in client-snapshot.json. Retained Mac backend73061 has schema257; independent direct backup/workspaces probe passed. Diagnostic copies are separate. Fixed exported build input is client-input-84d5912d; it contains only task fixes plus documented filename-case correction. It is a build input, not a replacement for root edits.
- Root fixes: SSH Session/Thread target normalization and returned provenance; MessagePort acquisition uses initialization budget; Windows drive/UNC PathService and resolver; DebugSession breakpoint/returned source paths through Remote canonical URI owner; Rust explicit cwd normalization through existing file-access Dir; protocol build.rs reads invocation CARGO_MANIFEST_DIR instead of embedded compiling root. New internal Git ResourceUri retains editor authority while reusing PathUri algebra, used by workspace/repository/worktree/resource paths. Git's prior ash-remote decode failure was reproduced by regression before this fix. No dependency/lock changes.
- Validation passed in fixed input:129 focused TS tests/7files plus full test compilation; Renderer typecheck4192files and normal build; Mac+Windows debug-adapter check/6tests/rust-warnings; protocol check/148unit+2boundary+1schemahash/rust-warnings; Mac+Windows Git check/13unit+2hosttests/rust-warnings. Root rustfmt-check and git diff-check passed. Logs `.build/remote-desktop-acceptance/cross-machine-*.log`. Current shared HEAD is newer and full-root generation/compile previously had unrelated concurrent errors; do not claim full HEAD acceptance or overwrite others' shared-file edits.
- Latest useful full run: evidence `desktop-cross-machine-windows-2026-10-18T05-35-43-184Z` PASSED DEPLOY, FILES and AGENT on final359runtime; DEBUG failed before adapter process (adapter-host absent, DAP requests empty), console only `[application] unavailable`. Cause remains unknown. Earlier provisional packages passed task/PTY/ports/Browser/recovery and an earlier diagnostic passed Debug; these do not constitute all10 on the final package.
- Final Git UI is still unaccepted. Before ResourceUri fix it failed HostRPC invalid protocol; afterward UI initialization hit invocation deadline. Scenario now waits120s for Git's existing3×30s bounded initialization retries (mutations/index assertions remain30s). Need verify Desktop stage/unstage through independent Windows index reads.
- Fixture setup now uses seed-profile.cjs: same packaged app-server direct stdio owning RPCs configure synthetic model/private-file secrets BEFORE Desktop, then exit. It asserts ZERO managed package manifests before Desktop so cold runtime installation remains tested. This removed live setup/catalog race; Agent passed. Run.mjs holds real Windows Node fixture through its SSH owner, verifies health, seeds, launches scenario, finally cleans exact profile/service/PTY. Cleanup JSON records nonce/profile. App-server direct fixture is not CLI/TUI product host.
- Debug diagnostics: scenario-debug-after-agent.mjs currently selects DEPLOY/FILES/DEBUG; attaches CDP pause-on-exceptions only during Debug, resumes immediately and writes debug-exceptions.json. Last diagnostic `desktop-cross-machine-debug-exceptions-2026-10-18T06-00-35-621Z` failed DEPLOY on management SSH loss, so did NOT reach CDP capture. Prior diagnostic selected Agent first but failed extensions/list during Agent. Do not claim an exception stack was captured.
- Optional ASH_CROSS_TRACE_PROTOCOL=1 routes only test SSH connect stdio through trace-ssh.py; logs ONLY id/method/error code/message, never request bodies/keys. Byte forwarding handles partial writes. Normal env does not enable this. Trace `ssh-protocol-trace-0dc4cdbe.jsonl` and RPC latency JSON show slow nested calls during that failed diagnostic; timings are diagnostic, not a performance benchmark. No new performance/cache core fix was implemented.
- Network repeatedly lost packets and changed public endpoints despite both hosts sharing a LAN. Windows Meta TUN was observed; async user question remains pending asking to temporarily disable Windows Meta TUN while retaining Tailscale. No reply/approval is assumed, and network is NOT proven the sole cause of Debug unavailable. Agent did not edit proxy config files. Only transient Tailscale rebind/DERP reconnect diagnostics occurred; no persistent Tailscale preference change.
- A temporary Windows peer-only outbound UDP restriction was ineffective and REMOVED. Independent verification returned absent; temporary-relay.json has restored/removalVerified=true. No temporary firewall rule remains. All last fixture processes were stopped, remote scan found no owned profile/service processes, Mac test processes absent, observer93962 stopped, owned SSH Master socket already absent. No active test/build/monitor remained at that recorded handoff; the ongoing acceptance chat has since resumed diagnostics.
- Resume: establish owned SSH Master and bounded network observer using ignored config; incorporate user's network response. First identify pre-adapter Debug error via the CDP diagnostic and RPC traces, preserving normal client. Then run fresh prepare-fixture.mjs + default run.mjs all10 with normal client, no diagnostic tracing. Collect gather-proofs.mjs, review per-step PNG/browser capture and ALL WebM recordings (review-video.mjs handles all), inspect trace/cleanup, then report.mjs (guards all10/identity/model request count/seed cold state/network restoration). Stop observer/Master and remove only this TODO section when complete.
- Scope: explicit development runtime, deterministic model SSE and DAP peers while Desktop/backend/Agent/processes/SSH real; supported isolated file secret mode (OS vault not accepted); no signed feed/autodownload, real provider or WAN reliability claim. Raw WebM/trace/screenshots; no captioned-video tooling. Machine-specific details remain in ignored artifacts.

## 浏览器文件上传 · TODO

- [ ] Windows 实机运行 `just verify ash-app-server --lib --filter browser_upload` 与 `just verify ash-file-system --lib`，确认硬链接替换和 opened-file link information 两个回归通过，记录源码 SHA、Windows 版本／架构及日志。macOS 已通过上传 6 项、文件系统 77 项及共享策略 1 项；Windows 文件系统交叉编译通过，App Server 因缺 SDK 头文件中止，不能代替实机结果。
- [ ] Linux 实机运行上传验证，覆盖符号链接叶节点、父目录替换及硬链接竞态并记录 SHA／日志。文件系统交叉编译通过，App Server 因缺 `x86_64-linux-gnu-gcc` 中止。

测试步骤及平台边界见[浏览器上传文件访问验证](docs/browser-foundation.md#浏览器上传文件访问验证)。

## 系统授权保存 · TODO

- [ ] Windows 交互桌面按 [UAC 验收手册](docs/windows-system-authorization.md) 分别完成真实取消和批准。使用未提升权限的进程、开启 UAC，记录实际弹窗、程序／发布者、两次各 `1 passed` 及日志；自动断言须覆盖字节／BOM／CRLF、dirty、ACL 和焦点。管理员成员普通终端与标准用户输入另一管理员凭据分别验收；skipped 或通用保存失败不算通过。
- [ ] macOS 密码授权和 Linux pkexec 各自完成对应系统验收；Windows UAC 结果不覆盖其他系统。

## Configuration / Preferences · TODO

- [ ] 闭合配置迁移后的真实窗口 smoke：定位程序设置选区后辅助 live 文本仍报告旧位置，以及 Appearance 的 `Unknown select option 'ash-dark'`；重跑外部文件更新／跨窗口重载、非法值保存、脏草稿保护与文件冲突。已有模型、文件链和 Chromium 迁移验证不代替端到端通过；先复核旧 App Server 文件访问 API 编译阻塞在当前 HEAD 是否仍存在。
- [ ] 在 macOS／Linux 验收真实系统 Policy 来源；用真实登录账户验证 GitHub managed settings 的读取、账户切换、撤回和失败保留。Windows 固定注册表只读探测和受控账户链已验证，不能代替其他 OS／真实账号结果。
- [ ] 按实际消费者核对剩余 Configuration 契约：registry／schema、typed parse/serialize、控件描述和 `ashBinding`、`config.toml` 编辑宿主归属，以及 configuration variables、Remote User、缓存默认值／实验覆盖和跨 profile 规则；不按文件缺失批量补 API。
- [ ] 补 Preferences 的 folder／焦点／编辑器组打开选项、目标与语言筛选及 `@lang:` 等搜索行为；页面容器、pane registry 和 Sessions 设置组织先确认实际产品入口，再逐项迁移。底层 Workspace／Folder 读写已接入，不能继续按旧文档记为全部未实现。

当前存储、配置层和设置入口见 [Preferences 与 Configuration](docs/preferences-and-settings.md)。

## Sessions · TODO

- [ ] 在有 Docker、官方 Dev Container CLI 和兼容 Remote runtime 的机器验证容器创建、实际执行、断线重连及 Stop／Remove。已有 SDK 进程测试使用受控 Docker／CLI，需补真实环境证据；见 [Docker Provider](extensions/dev-containers/README.md)。
- [ ] 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。
- [ ] 为 CI rerun、logs／annotations 和 Fix CI 请求闭合领域端口及 UI 生命周期；当前只读 checks／statuses 不代表这些操作已实现。
- [ ] 如需跨客户端 reviewed-file、transient/provider changeset、隔离和反馈评论，先建立后端领域契约及实际消费者，再扩展 Changes；当前审阅标记仅属于窗口且绑定 revision。不为上游路径差异新造身份 facade。
- [ ] 完成与上游窗口的配对全场景验证；现有 Ash Electron 提交／会话隔离、浏览器和架构回归只覆盖已接通行为。
- [ ] 复核并重跑 Common 的标准 unit runner，闭合 Windows `Get-CimInstance Win32_Process` 清理超时；原 203 项直接 Mocha 结果保留其范围，不当作整条标准命令通过。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] Speech 动态注册：Host 当前 `sealActivation` 冻结注册，`host.mjs` 只允许 activating 期间 register。先为原 admitted registry 定义晚注册／注销与后端 fleet 更新端口，覆盖精确 registration／activation generation、退休清理和迟到事件；不用前端轮询或另一张 provider 表替代。
- [ ] 标准 Voice／hold 命令先闭合聚焦 Chat widget 与输入生命周期的 `IChatWidgetService` 调用链；PTT／audio／session-context 的完整 VoiceClient 仍缺兼容 producer。现有 Ash Call／VoiceAgent 验证不代表上游 API 对齐；远端自有 Voice/Core bridge 不继续扩展为本轮对齐任务。
- [ ] MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。
- [ ] 补真实账户、物理音频设备与音质验收；现有本地 Call/LiveKit、模拟 Live wire 和 AudioHost 设备替身不能代替该结果。本地转写的 Foundry Local cacheDir／下载／代理契约与完整 Prompt／Agent 格式按真实调用需求另核对。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## Terminal · TODO

当前进程、屏幕、关闭保护、reload 与输出背压已接通，见 [Terminal](docs/terminal.md)。以下从 2026-10-17 功能比较收回；P2 为交互候选，P3 需产品选择或测量，不要求批量实现。

- [ ] 补真实 SSH、Windows／Linux PTY、PowerShell／Fish 的运行验收，覆盖文件链接、连续输出、关闭清理和 reload；应用彻底退出后的 revive 单独验证，不能用 macOS 或 URI 单测替代。
- [ ] 完整通用 process property、child-process/backend port 按实际消费者补齐；现有 SIGINT 生产链不代表其他信号和完整属性均已支持。
- [ ] 跨窗口转移独立定义进程租约、屏幕及输入交接并验收；现有 30 秒租约只闭合同一 Desktop 窗口 reload，Web 保持 connection-owned 生命周期。
- [ ] 文件链接补目录打开、工作区搜索型链接、外部 provider 与完整配置，复用执行宿主 cwd／路径和文件服务授权，验收鼠标、键盘及异步关闭／重连。
- [ ] P2 · **应用退出后恢复输出、cwd 和布局**：有限 `TerminalRecorder` replay 与命令文本历史不等于完整终端恢复；缺少持久化缓冲、布局和重建 Shell 的入口。这与已完成的保留原进程 reload 语义分开实现和验收。VS Code 的 revive 也会重新创建进程，不保证旧的任意命令跨应用退出继续运行。
- [ ] P2 · **把文件 / 文件夹拖入终端输入路径**：当前屏幕没有文件 drop 输入链；标签 drop 只接受本地拖动的终端实例。需要执行宿主对应的路径、quoting 和远端映射。
- [ ] P2 · **拖动合并分屏、跨组移动和组内重排**：已有单标签排序、内部 `joinInstances` 和取消拆分；标签 drop 仅改全局实例顺序，没有形成组移动、拖入合并和窗格顺序变更。不能把组连接线显示算作这些交互已完成。
- [ ] P2 · **分屏方向与编辑区分屏**：面板组目前固定左右排列；缺少随面板位置调整方向或手动切换方向。Split 命令明确跳过编辑区实例，缺少从编辑区终端创建相邻终端的行为。
- [ ] P2 · **运行编辑器选区 / 当前文件**：`sendText` 已有，Tasks / Debug 启动也已有；未注册 VS Code 对应的 Run Selected Text / Run Active File 用户入口，也未找到等价的编辑器到活动终端行为链。
- [ ] P2 · **命令级复制输出、重跑与选区**：命令 markers、状态、前后导航和输出范围已有；装饰当前只有显示 / hover，没有点击菜单里的复制命令、复制该命令输出、重跑、按命令范围选择等操作。普通文本选区复制不受此限制。
- [ ] P2 · **最近目录与 Shell 历史导入**：Ash 自己记录的最近命令可选择重跑；缺少 Go To Recent Directory，以及读取 Shell 历史文件合并到终端历史选择器的链路。
- [ ] P2 · **多行粘贴确认和鼠标剪贴板偏好**：文本粘贴和 bracketed paste 已有；缺少适用条件下的多行确认、选中即复制、可配置右键复制 / 粘贴等行为。bracketed paste 不能代替确认策略；应覆盖菜单、快捷键和浏览器粘贴入口。
- [ ] P2 · **Fish 的增强 Shell Integration**：Fish 可发现并启动，但当前归为 `ShellKind::Other`，没有自动注入命令生命周期、可信 cwd / env 等增强信息。Bash / Zsh / PowerShell 的集成已经存在。若 Fish 是首发支持范围，应随 P1 基础能力验证。
- [ ] P2 · **终端 Suggest 补全 UI**：没有命令 / 参数 / 路径候选列表、候选接收和 provider 接入。Shell 自身 Tab 补全仍正常走 PTY，不能把它算作缺失。
- [ ] P2 · **Sticky Scroll 与命令引导**：有命令边界，缺少滚动时固定当前命令的顶部区域；也没有上游的命令范围引导交互。
- [ ] P2 · **失败命令 Quick Fix**：没有根据命令和输出展示修正动作及运行修正命令的链路，相关 provider 也未接入。现有错误标记仅展示状态。
- [ ] P2 / 按扩展需求 · **终端 provider 扩展面**：Profile、环境变量、自定义 PTY 已有；链接、Quick Fix、补全 provider 和 VS Code Shell Execution 事件 API 尚未形成对应公开契约。按 Ash 实际扩展消费者决定范围，不为了兼容声明新增空 API。
- [ ] P3 · **通知、自动回复、远端本地回显、尺寸提示和独立缩放**：上游对应贡献尚未加载，也未找到等价功能链。按完成通知、固定响应规则、远端输入延迟或显示需求分别选择；已有 bell signal 不等于命令完成通知。
- [ ] P3 / 先测量 · **渲染与显示增强**：未接入 GPU renderer、可选 Unicode / grapheme 宽度 addon 和图片协议 addon。现有中文输入、字符显示不能因此判为缺失；是否增加这些机制取决于真实字符兼容用例和性能测量。
- [ ] P3 / 产品选择 · **终端内嵌 Chat**：附加终端到现有 Chat 已有；缺少直接覆盖在终端中的 inline Chat 交互。是否增加独立入口应由使用场景决定，不能把 Rust 拥有的 Agent 执行、审批和工具调度再搬回前端。

高频交互验收同时观察原进程身份、待提交输入、选区和焦点；Suggest／Sticky Scroll／Quick Fix 复用已有命令状态与屏幕边界，执行、权限和工具调度继续归 Rust。

## Stanza 编辑器 · TODO

- [ ] 完成 3.4 装饰／View Zone 的软换行、隐藏行、滚动交叉场景及 Electron 验收。零高度展开／收起、折叠标题坐标和回调 `this` 已修复并有 Standalone Chromium 回归，不能据此宣称整个 3.4 完成。
- [ ] 补系统 IME 候选窗口、Electron 平台及屏幕阅读器验收；浏览器合成 composition 事件不代替物理输入法。
- [ ] 复核历史 `editor-architecture` 11 项和 `dom-foundation` 2 项失败在当前 HEAD 的状态，按生产调用链处理缺口／过时断言，不削弱测试。2026-09-13 的 242 文件 unit、54 项浏览器及构建结果是历史基线。
- [ ] 后续依赖顺序按[编辑器路线图](docs/design/editor-roadmap.md)：3.4 后依次核对视图几何、语言异步、Code 贡献、Academic、Diff 和宿主持久化。每个实际功能独立核对 API、行为、失败、释放及正常构建；文件数量不作为完成率。

## Work / 通用文档 · TODO

当前共享 `TextModel`／工作副本、共同编辑器注册及 Academic 模式退场已完成；目标与依赖见 [Work / Code 设计](docs/design/work-code-workbench.md)。

- [ ] 先完成 `ash.document` v2 自描述 `general`／`academic` 类型与 Academic v1 一次性读取升级，覆盖类型冲突、损坏数据、双视图、备份和另存为资源转移；纯文本不能成为结构化文件解析失败后的隐式读法。
- [ ] 接入 general 文档、`.ash-doc`、新建／保存／回退／备份／冲突及显式 txt／Markdown 转换，保留不支持语义的定位错误及稳定图片资源。
- [ ] Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。
- [ ] 增加 Work 产品入口和默认布局，复用现有生命周期，明确 Code／Work 的资源、未保存内容、会话与状态恢复，不恢复模式注册表或第二份配置。
- [ ] Chat 主画布与辅助栏共用会话、附件和草稿状态，接通 Move Chat to Editor Area；验证布局切换、重启、并排焦点及不误发送。分页、docx／PDF 输出仍属另行设计范围。

## Desktop 启动性能 · TODO

- [ ] 用 CPU profile 和构建清单量化入口脚本执行，按实际使用推迟非首屏模块；每次比较静态 JS、首次功能成本及四组重复启动样本。
- [ ] 对齐 Renderer／Main／App Server 同一连接的时间点，定位重复请求和顺序等待；覆盖后端停止／复用，首次授权独立计量并保留用户决策。

聊天输入框扩展缩减已完成。复测命令、基线及未保留实验见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

固定页 framing、入口副本／重复编码清理、Code Chat 有界历史、大帧 Worker 与流式 Markdown 尾部更新已完成；[审计与测量](docs/ash-app-server-data-path-audit.md)保留各自快照、脚本和适用范围。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] 测 Worker 回传对象的复制、Thread／transcript 重复 item 与领域保留堆；按稳定 ID／revision、有界领域值评估减量，不把 transport DTO 变成权威业务状态。
- [ ] 完善过期只读 refresh 的取消／合并、大内容按需资源读取及迟到响应清理；状态变更请求不得自动重放或合并。
- [ ] 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。
- [ ] 先量化大代码围栏的完整 `TextModel.setValue`、配置／布局成本及巨大单块 Markdown 尾部预算，再决定增量编辑或更新合并；此前 Markdown 子阶段收益不能当作整条响应同幅度加速。
