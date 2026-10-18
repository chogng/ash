# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## Windows Rust 开发循环

- 保存 Rust 到 App 可用的 15 秒目标尚未达到。已保留第二轮实测 42.15 → 29.10 秒的改进；后续候选均未证明完整流程收益并已撤回。完整数据、验证与公开项目实践核对见 `docs/build.md` 第三轮记录。
- 后续重点：按既有领域职责缩小业务编辑失效的编译单元；若具备 Dev Drive，再测文件与新 exe 首次加载成本。尚无这些方案的性能结论。
- 实验资源暂存目录 `.build/desktop/dev/app-server/.staging-c8813138-4733-4acc-8ebe-05eee0827ccd` 的 bin 为空；自动审批拒绝删除，目录仍保留，不影响正常构建。

## Remote / Browser 多根工作区 · TODO

本地、SSH 与独立 Browser 目录句柄模式已实现并提交，职责与验证范围见 `docs/desktop-architecture.md` §4.2。下列能力仍未完成：

- [ ] **后端前置** · 用户已确认纳入连接 App Server 的 Web 多根支持，并要求对齐 VS Code 的工作区公开契约与职责。已补齐 `IWorkspaceEditingService.enterWorkspace`，Browser 保存与外部配置重载已迁入这一共享入口；16 项工作区单测、Renderer 4,203 文件类型检查和真实 Chromium 目录句柄多根 smoke 均通过（日志 `.build/todo-workspace-entry-*.log`）。这不代表 App Server Web 多根已完成：当前仍是服务端单根会话；先在 `crates/app-server-protocol/src/web.rs`、`crates/app-server/src/managed/web.rs` 和对应 transport owner 实现多目录授权／会话契约，再适配 `appServerWebWorkspaceClient.ts`；不能把 Browser 提升为 `directoryGrantsHost`。
- [ ] **后端前置** · 为上述 Web 模式实现工作区配置文件的独立访问生命周期：移除配置所在根后，仍能访问已授权的准确配置文件，不扩大父目录授权。接通 Browser Host／编辑器链，验证权限拒绝、脏文件、连接关闭和真实 Web App Server。
- [ ] **后端前置** · 实现直接保存工作区配置到远端机器；当前 SSH 配置仍保存在 Desktop 本地，内容为远端 URI 根。
- [ ] **验收** · 补 Windows／Linux 远端多根及真实系统文件选择器验证。现有多根 SSH 验证使用 macOS 同机隔离 OpenSSH fixture，选择器使用受控返回值；跨机器单独步骤通过不能替代多根场景验证。

## Desktop 跨机器验收 · TODO

- [ ] **验收** · Complete one real Desktop → selected Windows host run over SSH/Tailscale with all 10 steps, cleanup and evidence QA. The implementation is committed in `7cfdccd9b`; end-to-end acceptance remains unfinished. Preserve concurrent changes in both requested original checkouts; do not reset or substitute another checkout.
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

- [ ] **验收** · Windows 实机运行 `just verify ash-app-server --lib --filter browser_upload` 与 `just verify ash-file-system --lib`，确认硬链接替换和 opened-file link information 两个回归通过，记录源码 SHA、Windows 版本／架构及日志。macOS 已通过上传 6 项、文件系统 77 项及共享策略 1 项；Windows 文件系统交叉编译通过，App Server 因缺 SDK 头文件中止，不能代替实机结果。
- [ ] **验收** · Linux 实机运行上传验证，覆盖符号链接叶节点、父目录替换及硬链接竞态并记录 SHA／日志。文件系统交叉编译通过，App Server 因缺 `x86_64-linux-gnu-gcc` 中止。

测试步骤及平台边界见[浏览器上传文件访问验证](docs/browser-foundation.md#浏览器上传文件访问验证)。

## 系统授权保存 · TODO

- [ ] **验收** · Windows 交互桌面按 [UAC 验收手册](docs/windows-system-authorization.md) 分别完成真实取消和批准。使用未提升权限的进程、开启 UAC，记录实际弹窗、程序／发布者、两次各 `1 passed` 及日志；自动断言须覆盖字节／BOM／CRLF、dirty、ACL 和焦点。管理员成员普通终端与标准用户输入另一管理员凭据分别验收；skipped 或通用保存失败不算通过。
- [ ] **验收** · macOS 密码授权和 Linux pkexec 各自完成对应系统验收；Windows UAC 结果不覆盖其他系统。

## Configuration / Preferences · TODO

- [ ] **复核** · 闭合配置迁移后的真实窗口 smoke：定位程序设置选区后辅助 live 文本仍报告旧位置，以及 Appearance 的 `Unknown select option 'ash-dark'`；重跑外部文件更新／跨窗口重载、非法值保存、脏草稿保护与文件冲突。已有模型、文件链和 Chromium 迁移验证不代替端到端通过；先复核旧 App Server 文件访问 API 编译阻塞在当前 HEAD 是否仍存在。
- [ ] **验收** · 在 macOS／Linux 验收真实系统 Policy 来源；用真实登录账户验证 GitHub managed settings 的读取、账户切换、撤回和失败保留。Windows 固定注册表只读探测和受控账户链已验证，不能代替其他 OS／真实账号结果。
- [ ] **复核 · Preferences 目标与语言入口**：`validateOpenSettingsOptions` 仍拒绝非本地用户目标和未支持选项，`SettingsSearchQuery` 尚未解析 `@lang:`。沿设置命令确认 folder／焦点／编辑器组与语言覆盖的实际入口，再接入已有 Workspace／Folder 配置 owner；不能只增加筛选 token 而继续写入基础用户值。普通文本、`@id:`、`@modified`、`@tag:` 与 `@stable` 已有生产消费者及测试源码，不再作为缺失项。参照上游 `services/preferences/common/preferences.ts` 与 `settingsTreeModels.test.ts`。

当前存储、配置层和设置入口见 [Preferences 与 Configuration](docs/preferences-and-settings.md)。

## Sessions · TODO

- [ ] **验收** · 在有 Docker、官方 Dev Container CLI 和兼容 Remote runtime 的机器验证容器创建、实际执行、断线重连及 Stop／Remove。已有 SDK 进程测试使用受控 Docker／CLI，需补真实环境证据；见 [Docker Provider](extensions/dev-containers/README.md)。
- [ ] **后端前置** · 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。
- [ ] **后端前置** · 为 CI rerun、logs／annotations 和 Fix CI 请求闭合领域端口及 UI 生命周期；当前只读 checks／statuses 不代表这些操作已实现。
- [ ] **验收** · 对已接通的提交／会话切换、Changes 审阅与 PR 表单执行上游窗口配对场景，观察仓库身份、修订、焦点、取消和关闭后的结果；现有 Ash Electron、浏览器和架构回归仅覆盖原有范围。尚未接入的 CI 操作和后台合并不纳入这次已实现行为的验收。
- [ ] **复核** · 复核并重跑 Common 的标准 unit runner，闭合 Windows `Get-CimInstance Win32_Process` 清理超时；原 203 项直接 Mocha 结果保留其范围，不当作整条标准命令通过。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] **后端前置** · Speech 动态注册：Host 当前 `sealActivation` 冻结注册，`host.mjs` 只允许 activating 期间 register。先为原 admitted registry 定义晚注册／注销与后端 fleet 更新端口，覆盖精确 registration／activation generation、退休清理和迟到事件；不用前端轮询或另一张 provider 表替代。
- [ ] **后端前置** · 标准 Voice／hold 命令先闭合聚焦 Chat widget 与输入生命周期的 `IChatWidgetService` 调用链；PTT／audio／session-context 的完整 VoiceClient 仍缺兼容 producer。现有 Ash Call／VoiceAgent 验证不代表上游 API 对齐；远端自有 Voice/Core bridge 不继续扩展为本轮对齐任务。
- [ ] **后端前置** · MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。
- [ ] **验收** · 补真实账户、物理音频设备与音质验收；现有本地 Call/LiveKit、模拟 Live wire 和 AudioHost 设备替身不能代替该结果。本地转写的 Foundry Local cacheDir／下载／代理契约与完整 Prompt／Agent 格式按真实调用需求另核对。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## Terminal · TODO

当前进程、屏幕、关闭保护、reload 与输出背压已接通，见 [Terminal](docs/terminal.md)。以下按现有调用链分批推进；未排期的独立增强见文末发展候选。上游行为参照 `terminalActions.ts`、`terminalTabsList.ts`、`terminalContrib/clipboard` 与 `terminalContrib/history`，不以文件数衡量对齐。

- [ ] **可做 · 多行粘贴确认**：`TerminalClipboardContribution` 已拥有菜单／快捷键粘贴，浏览器原始粘贴还须核对 xterm 输入入口。统一适用条件、确认和取消行为；bracketed paste 不能替代确认。保留既有异步读取期间的实例身份与 generation 校验。参照上游 `terminalClipboard.test.ts` 的换行和 bracketed-paste 场景。
- [ ] **可做 · 命令级复制、重跑与选区**：现有 command capability、markers、完成状态和普通文本复制可复用，`DecorationAddon` 目前仅显示／hover。补命令文本／输出复制、命令范围选区及明确触发的重跑；先核对输出边界和 buffer trim，不把屏幕剩余内容当作完整命令输出。异步菜单、关闭及重连不能把动作发给另一实例。
- [ ] **可做 · 分屏方向与编辑区分屏**：`TerminalGroup` 固定创建横向 `SplitView`，Split 命令明确跳过 Editor 目标。分别闭合面板方向切换和从编辑区终端创建相邻终端，沿现有 group／editor owner 保留 PTY、输入、比例与焦点。
- [ ] **可做 · 拖动合并、跨组移动与组内重排**：`TerminalTabList` 仅改变全局实例顺序；已有 `joinInstances`、组成员操作和取消拆分。补拖放到组／窗格的行为及键盘等价入口，不把组连接线当作交互完成。
- [ ] **可做 · 最近目录**：已有命令 cwd 元数据和最近命令选择器，但没有 Go To Recent Directory。目录历史归既有终端历史 owner，选择后按执行宿主 Shell 发送路径；覆盖无 cwd、重复目录、切换实例和取消。Shell 历史文件导入另列为发展候选。
- [ ] **后端前置 · 运行当前文件**：Ash 尚无上游 `sendPath` 对应的实例端口。先闭合执行宿主路径、Shell quoting、本地／远端资源匹配和不支持 scheme 的反馈，再接 Run Active File；不能把编辑器 URI 直接当命令文本。与 Run Selected Text 分开验收。
- [ ] **后端前置 · 文件／文件夹拖入输入路径**：当前屏幕没有文件 drop 链，标签 drop 仅接受本地终端实例。复用上一项的执行宿主路径发送契约，覆盖 OS 文件与工作台资源拖动；不另造路径映射。
- [ ] **后端前置 · 跨窗口转移**：独立定义进程租约、屏幕及输入交接并验收；现有 30 秒租约只闭合同一 Desktop 窗口 reload，Web 保持 connection-owned 生命周期。
- [ ] **后端前置 · 应用退出后恢复输出、cwd 和布局**：有限 `TerminalRecorder` replay 与命令文本历史不等于完整终端恢复；缺少持久化缓冲、布局和重建 Shell 的入口。与保留原进程的 reload 分开验收；不承诺任意旧命令跨应用退出继续执行。
- [ ] **复核 · 文件链接扩展**：补目录打开、工作区搜索型链接、外部 provider 与适用配置的实际入口，复用执行宿主 cwd／路径和文件服务授权，验收鼠标、键盘及异步关闭／重连。
- [ ] **验收** · 补真实 SSH、Windows／Linux PTY、PowerShell／Fish 的运行，覆盖文件链接、连续输出、关闭清理和 reload；应用退出后的 revive 独立验收，macOS 或 URI 单测不能替代。

高频交互验收同时观察原进程身份、待提交输入、选区和焦点；执行、权限和工具调度继续归 Rust。

## Stanza 编辑器 · TODO

- [ ] **复核** · 完成 3.4 装饰／View Zone 的软换行、隐藏行、滚动交叉场景及 Electron 验收。零高度展开／收起、折叠标题坐标和回调 `this` 已修复并有 Standalone Chromium 回归，不能据此宣称整个 3.4 完成。
- [ ] **验收** · 补系统 IME 候选窗口、Electron 平台及屏幕阅读器验收；浏览器合成 composition 事件不代替物理输入法。
- [ ] **复核** · 复核历史 `editor-architecture` 11 项和 `dom-foundation` 2 项失败在当前 HEAD 的状态，按生产调用链处理缺口／过时断言，不削弱测试。2026-09-13 的 242 文件 unit、54 项浏览器及构建结果是历史基线。

后续阶段由[编辑器路线图](docs/design/editor-roadmap.md)维护；本清单不再把整条路线图重复记成一个未完成任务。

## Work / 通用文档 · TODO

当前共享 `TextModel`／工作副本、共同编辑器注册及 Academic 模式退场已完成；目标与依赖见 [Work / Code 设计](docs/design/work-code-workbench.md)。

- [ ] **Ash 产品** · 先完成 `ash.document` v2 自描述 `general`／`academic` 类型与 Academic v1 一次性读取升级，覆盖类型冲突、损坏数据、双视图、备份和另存为资源转移；纯文本不能成为结构化文件解析失败后的隐式读法。
- [ ] **Ash 产品** · 接入 general 文档、`.ash-doc`、新建／保存／回退／备份／冲突及显式 txt／Markdown 转换，保留不支持语义的定位错误及稳定图片资源。
- [ ] **Ash 产品** · Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。
- [ ] **Ash 产品** · 增加 Work 产品入口和默认布局，复用现有生命周期，明确 Code／Work 的资源、未保存内容、会话与状态恢复，不恢复模式注册表或第二份配置。
- [ ] **Ash 产品** · Chat 主画布与辅助栏共用会话、附件和草稿状态，接通 Move Chat to Editor Area；验证布局切换、重启、并排焦点及不误发送。分页、docx／PDF 输出仍属另行设计范围。

## Desktop 启动性能 · TODO

- [ ] **测量** · 用 CPU profile 和构建清单量化入口脚本执行，按实际使用推迟非首屏模块；每次比较静态 JS、首次功能成本及四组重复启动样本。
- [ ] **测量** · 对齐 Renderer／Main／App Server 同一连接的时间点，定位重复请求和顺序等待；覆盖后端停止／复用，首次授权独立计量并保留用户决策。

聊天输入框扩展缩减已完成。复测命令、基线及未保留实验见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

固定页 framing、入口副本／重复编码清理、Code Chat 有界历史、大帧 Worker 与流式 Markdown 尾部更新已完成；[审计与测量](docs/ash-app-server-data-path-audit.md)保留各自快照、脚本和适用范围。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **测量** · 测 Worker 回传对象的复制、Thread／transcript 重复 item 与领域保留堆；按稳定 ID／revision、有界领域值评估减量，不把 transport DTO 变成权威业务状态。
- [ ] **复核** · 完善过期只读 refresh 的取消／合并、大内容按需资源读取及迟到响应清理；状态变更请求不得自动重放或合并。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。
- [ ] **测量** · 先量化大代码围栏的完整 `TextModel.setValue`、配置／布局成本及巨大单块 Markdown 尾部预算，再决定增量编辑或更新合并；此前 Markdown 子阶段收益不能当作整条响应同幅度加速。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 终端 Suggest                               | 命令／参数／路径候选与接收 UI。先选实际 Shell 和候选 producer，再接已有输入与命令状态；Shell 自身 Tab 补全已经通过 PTY 工作。上游位于 `terminalContrib/suggest`。                                                                                                                                                                                    |
| 终端 Sticky Scroll／命令引导               | 长输出中保留当前命令及命令范围导航。先用已有命令边界验证滚动、换行、trim 和焦点；上游位于 `terminalContrib/stickyScroll`。                                                                                                                                                                                                                           |
| 终端 Quick Fix                             | 根据失败命令及输出展示可执行修正。先确定实际 provider、结果来源和执行授权；现有错误标记仅展示状态。上游位于 `terminalContrib/quickFix`。                                                                                                                                                                                                             |
| 终端扩展 API                               | 按真实扩展需要补链接、Quick Fix、补全 provider 和 Shell Execution 事件。已有 Profile／环境变量／自定义 PTY 继续复用；没有消费者时不增加空 API。                                                                                                                                                                                                      |
| 终端进程属性与 backend port                | 先找到缺失属性、其他信号或 child-process／port 的具体消费者，再扩充 Rust 领域契约；现有 SIGINT 链不表示完整支持。                                                                                                                                                                                                                                    |
| Fish 增强 Shell Integration                | Fish 启动与增强注入分开；确定支持范围后补命令生命周期、可信 cwd／env 及实机回归。基础 Fish 运行验收仍在当前待办。                                                                                                                                                                                                                                    |
| Shell 历史文件导入                         | 将 Shell 历史与 Ash 最近命令组合。需要执行宿主侧读取、格式解析、限额和隐私／禁存配置，不让 Renderer 读取另一台机器的历史文件。                                                                                                                                                                                                                       |
| 鼠标剪贴板偏好                             | 选中即复制、可配置右键复制／粘贴；沿 `TerminalClipboardContribution` 和已有配置链实现，覆盖平台差异、焦点及异步剪贴板失败。多行确认单独保留为当前待办。                                                                                                                                                                                              |
| 完成通知／自动回复                         | 分别确认后台命令完成提醒和固定响应规则的产品需求；bell signal 不等于完成通知，自动回复需复用后端输入与权限边界。                                                                                                                                                                                                                                     |
| 远端本地回显／尺寸提示／独立缩放           | 先量化输入延迟或确认显示需求，再选具体交互，避免用局部回显掩盖真实 PTY 状态。                                                                                                                                                                                                                                                                        |
| GPU／字符宽度／图片显示                    | 先证明 renderer 性能问题、具体 Unicode／grapheme 兼容用例或图片协议需求；不能仅凭没有 addon 判断现有中文显示缺失。                                                                                                                                                                                                                                   |
| 终端内嵌 Chat                              | 先确认相对“附加终端到 Chat”的独立使用场景，再设计终端覆盖层及焦点；会话、Agent 执行、审批和工具调度沿原 owner。                                                                                                                                                                                                                                      |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                            |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。已知设置渲染迁移债务见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前迁移债务)。 |
