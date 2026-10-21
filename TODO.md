# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## macOS 系统内存耗尽 · 历史现场复核

- [ ] **复核** · 2026-10-21 截图中的 203.48 GB 尚无故障进程 footprint／分配栈，应用已经退出，不能确认分配 owner。文件监听的无界入口、路径积压和重复重扫防护已完成，并通过有界突发、慢消费者及真实 Ash 验证；实现契约见 [file-watcher](crates/file-watcher/README.md#事件风暴的预算与恢复)，原始现场及验证证据见 [.build/investigations/macos-memory-20261021](.build/investigations/macos-memory-20261021)。后续若再次发生，需采集当时 PID、footprint、监听丢事件日志及触发操作；不能用已修复的风险反推历史根因。

## PR #57 · 合并后剩余项

[PR #57](https://github.com/chogng/ash/pull/57) 已于 2026-10-20 正常 squash merge（`ee3dea640`）。后续仅在当前 main 本地整批修复与验证；不推送、不主动触发远端 CI、不恢复已暂停的 `pr-57-ci` heartbeat。保留其它任务修改，完整批次提交前准确 stage 并执行 `just commit-check origin/main`。

- [ ] **完整 CI 覆盖**：获准发布后，以新 main SHA 核对原失败矩阵及 Windows sandbox acceptance。[此前失败的 CI](https://github.com/chogng/ash/actions/runs/39490567225) 在旧安全门禁后跳过了前端、Bazel 和 Rust 作业；本地证书修复后 `just dependency-security` 的 advisories／licenses／sources 已全部通过，但尚未发布，不能称远端全绿。已有 Linux x64 47 项通过证据不等于旧 hosted 启动失败根因已证实；尚无完整跨平台全绿证据。本地证书验证日志 `/tmp/ash-pr57-certificate-{security,dependencies-final,http-final,bazel-final,app-server-build}.log`。本轮 rebase 后 `0d95ccc29` 基线的 macOS 定向复核及首败／修正复验见[验证记录](.build/pr57-rebased/validation.json)；该记录不覆盖随后并行任务的 Activity Bar、Chat 和 Rust 改动。

## MXC · 跨平台验收

- [ ] **验收** · 在支持 PSEC 的 Windows、WSL2 和独立 Linux／x64 运行当前 SDK pin `f1e8694b`，并补外部局域网／公网 IPv6。命令与验收边界见 [MXC 清单](MXC-TODO.md) 与 [适配器验证](crates/mxc-sandbox/README.md#验证)。

## Windows 开发实验资源清理

- 保存 Rust 到 App 可用的 15 秒目标尚未达到。2026-10-19 在 `3df4938da` 暂停开发与同步后完成迁移修复的 20 次匹配尝试：空库成功中位数 20.06 → 19.80 秒（5/5 → 5/5），100 条历史会话 22.27 → 21.15 秒（3/5 → 5/5），历史成功样本快 1.12 秒（5.0%）；仍差 4.80／6.15 秒。空库差异很小，不能用成功样本的条件中位数替代总体延迟或失败率结论。原始样本与阶段成本见 `docs/build.md` 完整循环复测及 `.build/perf-win-edit-20261019-migration/q2-summary.json`。
- 本轮复测完成，修复内容与正常构建已恢复；此前第五轮的 diff 适配器边界优化仍保留，旧源码上的约 25 秒结果不作为本轮基线。15 秒是体验目标，并非测量推导的性能下限；若继续优化，需根据发布前约 13.7 秒及历史发布后约 7.4 秒的成本选择方向。上述结果仅覆盖 diff 适配器编辑；本机卷均为 NTFS，没有 Dev Drive。

## Rust 函数级增量编译

- [ ] **后端前置 · 跨 crate／非标量函数热更新**：先闭合准确的 artifact target／feature／cfg 与实例身份，再处理一般语义依赖／布局失效、泛型单态化、引用／堆对象、drop／unwind、间接调用和更多实际注册入口；完整检查上下文复用还缺 owner 自身 build script。当前源码明确拒绝跨 crate 调用，现有同 crate 标量链路不能视为通用 Rust JIT。已完成范围与测量见 [标量 MIR 边界](docs/rust-analysis.md#标量-mir-与本机代码边界) 和 [App Server 实测](docs/build.md#2026-10-21路径依赖检查复用与-app-server-真实热更新)。

## Remote / Browser 多根工作区 · TODO

工作区契约见 `docs/desktop-architecture.md` §4.2。

- [ ] **后端前置** · 实现直接保存工作区配置到远端机器；当前 SSH 配置仍保存在 Desktop 本地，内容为远端 URI 根。
- [ ] **验收** · 补 Windows／Linux 远端多根验证。现有多根 SSH 验证使用 macOS 同机隔离 OpenSSH fixture，远端选择器使用受控返回值；跨机器单独步骤通过不能替代多根场景验证。

## Desktop 窗口收尾弹窗 · TODO

- [ ] **复核 · macOS 启动后立即退出**：2026-10-08 Sessions 尚在启动时退出曾记录两条 `IPC connection closed`；未修改的 storage owner 在同基线亦复现。2026-10-21 本机 `9402110a6` 正常重建后，真实 App Server 的自动恢复变体通过迁移、原文归档和布局恢复；窗口日志确认退出请求早于 `Agents restored` 6 ms，本轮未出现旧 IPC 错误。同批单窗口变体却在第二次启动后的退出超过 10 秒，Renderer 已回完成、载体已 stopped；定向复跑通过，首败仍保留，尚不能归因到旧存储 RPC。下一步取得该停留阶段的实际 pending／关闭诊断并修复，不增加等待或过滤错误消项。命令、日志和范围见 [macOS 补验](docs/desktop-startup.md#2026-10-21-macos-sessions-启动退出补验)；证据 `.build/local-todo-retirement/{first,retry}-test-results/`。此项不阻塞已验收的存储队列修复退场。

- [ ] **现场复核 · 开发重载时的原生无响应提示** · 后端发布漏通知与重启期间备份失败已修复，macOS 协议／备份及发布监听 81 项通过，双窗口重连和重载恢复未保存文件各 5 轮通过，已完成部分见 [后端发布与重载复核](docs/desktop-startup.md#2026-10-21-后端发布与页面重载重叠)。剩余是用户原先的“等待／重新打开”：本轮捕获的是主动保存失败，旧日志三次原生无响应前的 `initialize` 超时尚未关联到同一个原因；需用已有 token／reason、pending 标签及原生事件来源日志取得实际故障链，不能据新修复宣称所有无响应已解决。

## Desktop 跨机器验收 · TODO

- [ ] **验收** · 完成指定 Windows 主机真实 Desktop → SSH／Tailscale 全部十步、远端清理和证据 QA；同机 SSH fixture 不能替代跨机器验收。2026-10-19 已通过严格主机校验、公钥登录及原检出的 major10 Windows runtime 构建，真实冷部署一步通过；FILES 在扩展激活超时后的重连中失败，其余步骤未执行。SSH 握手／通道持续不稳定，按用户要求停止重试；待连接稳定后重跑全套并复核远端清理。失败证据保留在 `.build/ash-playwright-mcp/evidence/desktop-cross-machine-windows-major10-2026-10-19T13-46-20-671Z/report.html`，本轮未据此消项。

## 系统授权保存 · TODO

- [ ] **验收** · macOS 密码授权和 Linux pkexec 各自完成对应系统验收；当前 Dev Container 缺 pkexec／polkit／图形认证 agent，不能用免密规则或 root 执行代替真实系统授权。Windows UAC 结果不覆盖其他系统。

## Configuration / Preferences · TODO

- [ ] **验收** · 在 macOS 验收真实系统 Policy 来源；补两个真实 GitHub 身份切换及非空组织策略的保留／撤回，当前仅有个人账号。2026-10-19 Windows 隔离 profile 已通过个人账号真实刷新、进程内隧道断连失败、键盘显式重试恢复和退出清空；证据 `.build/ash-playwright-mcp/evidence/real-github-managed-policy-2026-10-18T20-45-26-513Z/report.html`，整套场景因缺上述账号覆盖标为 aborted，不能当作完整验收通过。强制新鲜度门禁不纳入本轮。Windows 固定注册表只读探测和受控账户链不能代替 macOS／非空组织策略结果。
- [ ] **验收 · Preferences 上游窗口配对**：以本地 VS Code `a2acc8c864a` 对照用户／Workspace／Folder、`@lang:` 与 `@modified` 组合、重置、JSON 草稿、侧边／指定组和焦点语义。Ash 中英文真实 Chromium 已通过单根与多根读写、重载、高对比度和字号实际生效，macOS Desktop 的用户／单目录 Workspace 真实 App Server 文件链也已通过；本地 VS Code 尚无可运行构建，源码／上游测试核对不能代替窗口配对。当前实现与证据范围见 [Preferences](docs/preferences-and-settings.md#已有验证与限制)。

当前存储、配置层和设置入口见 [Preferences 与 Configuration](docs/preferences-and-settings.md)。

## AgentHost · TODO

以下新产品能力和专项环境验收暂缓，按实际使用需要恢复。

- [ ] **复核 · 自举场景的完整外部 Codex 目录接入**：相同普通代码目录在无外部账号连接的对照场景中启动通过；使用完整外部 Codex home 时重复出现初始化或 `env/dirs/set` 超时，仅引用认证文件的隔离目录则可启动并调用真实模型。尚未证明是模型目录导入、认证路径还是其他初始化问题；排查前保留失败日志，补启动失败时的证据收集，不将有限启动重试当作通过。记录见上述场景目录的 `startup-attempt*.log` 与 `preflight-no-auth.log`。临时认证文件引用已移除，重跑需重新显式准备只读引用，不能复制凭证进入证据。

已完成的统一宿主、多 Provider Session／Chat、附件快照、查询过滤及历史仓库契约见 [通用服务端到端记录](agenthost-todo.md#通用服务端到端闭合--2026-10-18)。下面保留产品能力和真实环境验收缺口；文件台账不表示上游 AHP wire protocol 兼容。

- [ ] **新产品 · Agent SDK／Codex 续接／本地模型／独立 Web 启用**（用户决定先列缺口）：SDK 下载／重载、Codex 专属账号与配额续接、模型安装／server lifecycle、Web 启用设置／context owner 均须先闭合领域契约与生产入口；保留现有多 provider 账号和 Web transport 可用性，不新增空服务。准确文件清单见上述 Workbench 记录。
- [ ] **新产品 · 同步 customization 与附加宿主可选执行能力**：synced OpenPlugin／active-client 分发尚无 Ash producer 与执行策略；附加宿主尚无独立窗口 Git 扩展实例和跨宿主扩展命令契约，`pull`／`push`／`publish`／打开源代码只按真实 provider availability 提供，不能转发主窗口命令；Guardian 远端安装沿现有产品限制。现有通用 GitHub／PR、历史仓库读取、执行默认值和目录权限已按 Session scope 闭合。
- [ ] **新产品 · Cloud Sandbox**（用户决定先 TODO）：先确定服务端实例／仓库 producer、账号和凭证刷新、Session／文件权限及 Provider 归属，再实现连接、目录、模型和会话入口；当前没有对应生产 producer，具体路径见清单 `todo-by-user`。
- [ ] **新产品 · Tunnel／WSL**（用户决定先 TODO）：分别确定网关／认证／重连／存储与 WSL runtime 启停／分发／authority 契约，再接既有 Remote owner；当前 SSH／Dev Container 不作为这些能力已实现的证据。
- [ ] **新产品 · Mission Control**（用户决定先 TODO）：先确定后端控制与会话事实、认证／credential delegation、共享权限及 Provider 归属，再实现环境与会话入口；不预建镜像状态或转发类。
- [ ] **验收 · 跨平台**：Desktop runtime acceptance 的 macOS MCP 进程回归步骤尚未在远端执行。
- [ ] **验收 · 真实外部账号**：使用专用测试账号验收 Kimi Desktop/CLI 身份切换、同身份 token 轮换、旧结果隔离及临时发现失败，观察已打开的模型 picker。合成 scope/账号回归不能替代此结果。
- [ ] **验收 · 系统休眠恢复**：在可中断的测试机器运行实际 OS sleep/wake，核对连接恢复、重新鉴权、订阅和工具权限；尚未在日常开发机器执行系统休眠。
- [ ] **验收 · B2 TUI 与真实外部模型**：继续补真实外部账号的模型 picker 与 TUI 场景。本机已重新验证当前 CLI 缓存契约，并通过真实 Rust observer 的完整 10 分钟 Web Code／Cowork metadata 更新和失败保留场景；该合成账号结果不覆盖外部服务或真实 TUI，证据范围见 [AgentHost 台账](agenthost-todo.md)。
- [ ] **复核 · 旧隔离环境故障**：取得麦克风枚举失败的准确步骤和底层诊断，沿音频设备 owner 定位。原 2026-10-08 证据目录不在当前检出；不能凭通用错误码或普通音频测试关闭报告。

## Sessions · TODO

- [ ] **验收 · Dev Container 产品入口** · 从 Agents 窗口验收宿主 gateway 准入、窗口关闭／重开及持久容器控制清单，并补 authenticated Remote catalog 自动安装；当前测试容器缺 Docker daemon／CLI、Dev Container CLI 与认证 runtime catalog，受控脚本不替代这些产品前提。入口与环境要求见 [Docker Provider](extensions/dev-containers/README.md)。
- [ ] **后端前置** · 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。
- [ ] **验收** · 对已接通的提交／会话切换、Changes 审阅与 PR 表单执行上游窗口配对场景，观察仓库身份、修订、焦点、取消和关闭后的结果；现有 Ash Electron、浏览器和架构回归仅覆盖原有范围。后台持续合并不纳入这次已实现行为的验收。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] **后端前置** · MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。
- [ ] **验收** · 补真实账户、物理音频设备与音质验收；现有本地 Call/LiveKit、模拟 Live wire 和 AudioHost 设备替身不能代替该结果。完整 Prompt／Agent 格式按真实调用需求另核对。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## 扩展作者 SDK 与开发体验 · TODO

已采用 `@ash/sdk` / `ash.*` 自有作者契约；职责和宿主能力见[扩展架构](docs/editor-extensions.md#0-确定的产品方向)。命令、文档／配置、语言、UI、SCM、Tasks／Debug、Terminal 与 Speech 的已有作者接口及消费者已迁到统一实现，Node、可选 Rust/V8 与可信 Worker 使用同一入口。旧 `vscode` 作者模块、Open VSX 来源、VSIX 扩展安装／运行入口及旧类型依赖已删除；历史记录只保留退休识别、停用、撤权和卸载，不恢复旧授权。纯 TS 示例已通过仓库外安装／编译及真实 App Server 的 Rust 文件读取、授权、越界、取消和停用验证。Rust SDK 继续服务原生能力提供者，文档模型、dirty、撤销与 UI 保持客户端唯一所有权。

后续按[SDK 能力开放原则](docs/editor-extensions.md#sdk-能力开放原则)，从现有扩展的实际阻碍选择最小能力；[能力边界与待复核需求](docs/editor-extensions.md#现有能力与待复核需求)用于定位，不作为逐项补齐 API 的实施队列。Academy 等现有扩展用于验收已选行为：

- [ ] **独立准备 · PDF 查看、批注与 AI 阅读 Plugin**：方案归 [PDF Viewer](extensions/pdf-viewer/docs/pdf-content.md)。先核对已有批注保存／恢复与实际 AI 文字、页面图读取链，再选一个最小阅读场景复用工具和 Skill；仅对证实的阻碍补接线或最小 SDK 能力。不引入通用文档编辑；仓库外开发链不再作为下一项 SDK 功能需求，F5／`.ashx` 继续暂停。本轮仅记录方案，功能、Skill 和 Plugin 打包留待单独实施。
- [ ] **复核 · macOS 原生监听故障来源**：已复现原生监听注册／注销阻塞及注册成功却不送事件，并以隔离 helper、限时终止和限定目录轮询恢复修复 Ash 卡住的问题；系统 `fseventsd` 长期高 CPU 的来源仍未证实，不能认定由 Ash 引起。保留 `.build/file-watcher-reproduction-before.json`、`.build/file-watcher-deletion-reproduction.json`，后续需另取现场证据；本轮未重启系统服务。
- [ ] **Academy 作者侧迁移**：先以 Academy 现有声明、标签和注册接线确定具体作者阻碍，再由 Manifest、TS SDK 或构建工具承担必要的 Rust 接线，使普通作者无需手写 Rust 即可开发编辑器、提供 Agent 工具并附带 Skill；不借迁移预建通用 API。高级编辑器能力使用明确的公开客户端契约；Agent 结构化写入依赖下方 Work 文档服务任务，不另建模型或编辑历史。确有原生算法需求时再选用 Rust／WASM 等组件。
- [ ] **本地开发与源码调试**：按用户当前要求暂停，待明确恢复后实施；只读调查已确认可复用现有 F5／DebugService／Rust DAP 链，独立 Node DAP adapter 需要“受管子进程＋私有 socket”启动组合。隔离 Ash 开发实例显式加载开发目录，开发授权与正式安装信任分开；补 TS Source Map、源码断点、单步、变量、构建／重载及诊断。暂停预算归开发会话，普通调用的取消、撤权、deadline 与晚回复墓碑继续生效；不能只扩大 Host RPC 超时。验证暂停超过 30 秒后不误重启、恢复不续旧权限、停止／断连释放宿主和 adapter；Rust/V8 Inspector 另按实际宿主实现。
- [ ] **测试、打包与安装**：按用户当前要求暂停 `.ashx`，待明确恢复后实施；只读调查已确认可复用 `LocalPluginPackage`、`PluginPackageStore` 和 `PluginActivationAuthority`。计划使用带明确格式标记与内容摘要的 ZIP envelope／payload，严格解压后交同一安装 authority；普通 ZIP／改名 VSIX 拒绝，安装不自动启用或授权，也不冒充签名来源。支持已构建 TS、资源及按平台独立打包的可选原生程序；不在安装时执行构建脚本。补 CLI pack／install 与真实 `pack → install → enable/grant → TS 调 Rust → revoke/uninstall`，覆盖篡改、路径逃逸、重复／链接条目和大小限制。
- [ ] **端到端验收与文档**：以仓库外 Academy 项目的已选需求逐段验证 TS 作者入口、类型检查／构建、加载／重载及正式安装／授权／撤权／卸载，覆盖中英文、能力失效和资源释放，并同步 SDK、Academy 与平台文档。涉及 F5／源码断点和 `.ashx` 的阶段继续等待上述暂停任务明确恢复，不以验收要求倒推新增 API。已有 [Rust SDK 导出与进程诊断验证](sdk/docs/development.md) 是可复用底座，不代表完整 TS 作者体验或 F5 调试已完成；完成后删除对应待办。

## Stanza 编辑器 · TODO

当前 Editor 待办统一维护于本节，完成后移除；架构与已有证据范围见[编辑器架构](docs/editor-architecture.md#验证范围)。具体功能契约由对应实现文档维护，不按上游成员数量建立补齐清单。

- [ ] **功能 · 文献检索扩展**：后续实现查询、元数据获取及向文献管理扩展入库的工具／Skill 链路，PDF 阅读复用独立查看器；作者接入遵循上方扩展 SDK 任务。Agent 结构化文档写入仍按下方 Work 文档服务契约另行实施。尚未新增检索代码或迁仓。

- [ ] **验收 · 编辑器扩展平台组合**：在真实 Electron 多窗口／远端环境验收 Academy、可选 Reference Manager／PDF Viewer 外置签名包的装载、版本匹配、dirty／恢复及释放，以及客户端内置 Code 与共享宿主生命周期；物理 IME、屏幕阅读器、跨页输入及目标 Word 打开／编辑／再次保存的互通仍需对应环境。PDF 查看器独立包迁移及本机验证见[扩展说明](extensions/pdf-viewer/README.md)，文献管理见 [Reference Manager](extensions/reference-manager/README.md)，Academy 已有支持范围见 [包说明](extensions/academic/README.md)；不重复列为功能待办。

设计边界与功能依赖见[编辑器设计与演进](docs/design/editor-roadmap.md)；具体工作仅维护于本清单，不把整篇设计当作一个未完成任务。

## Work / 通用文档 · TODO

产品范围与约束见 [Work / Code 设计](docs/design/work-code-workbench.md)。

- [ ] **Ash 产品** · Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。现有 `AppServerTextDocumentHost` 仅闭合普通文本快照和 WorkspaceEdit；须先定义结构化编辑的真实 producer／领域端口及审阅行为，不能把 `.ash-doc` 的共享模型再解析成第二份普通文本模型。
- [ ] **Ash 产品** · 增加 Work 产品入口和默认布局，复用现有生命周期，明确 Code／Work 的资源、未保存内容、会话与状态恢复，不恢复模式注册表或第二份配置。

## Desktop 启动性能 · TODO

- [ ] **评估** · 基于已采集的入口清单和四组 CPU 证据，验证选定语言资源的惰性加载生命周期；候选需比较静态 JS、首次功能成本及四组重复启动，不凭 87.6% 静态语言资源占比宣称启动收益。
- [ ] **复核** · 旧启动诊断的部分 F1 失败仍未复现、未归因。当前 macOS 激活原生窗口的 F1／命令列表／Escape 焦点恢复回归已通过；名义 hidden 对照在观测时也实际可见且有焦点，不能据此认定隐藏窗口导致旧故障。保留历史失败产物及新的焦点／键盘到达记录，继续核对旧批次的条件；范围见[启动复核](docs/desktop-startup.md#2026-10-18-f1-本机复核)。

复测命令与基线见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

测量入口与约束见[审计与测量](docs/ash-app-server-data-path-audit.md)。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **复核** · 继续识别大内容按需资源及领域物理取消的具体消费者。文件模型、Chat Changes 摘要及 Code／Cowork Thread／transcript 的在途只读刷新已合并；后者补齐代次隔离、写后补读和落后 bounded 快照的有界重试，两个模型/视图文件 239 项测试通过。GitHub 已取消读取可跳过无消费者 payload 的 schema／Worker 回传；这些结果不代表通用传输取消或所有读取入口均完成。约束见[消费者刷新约束](docs/ash-app-server-data-path-audit.md#已接入的消费者刷新约束)。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一诊断包导出                             | IDE 与 Agent Window 已有 [Agent Host 调试日志包](docs/chat.md#调试日志导出)，包含客户端日志、Session 所属本地／SSH 宿主的进程日志与现存轮转文件、当前会话执行证据，以及当前 Chat／子 agent 已录制的请求和响应正文。manifest 记录录制状态、范围、限额和收集问题。更广的通用诊断包仍未排期：`feedback/prepare` 的构建、活动统计、响应诊断和指标快照尚未接入该入口，新增来源须沿其 owner 的真实收集契约接入。 |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                                                                                  |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。设置呈现与接入规则见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前实现)。                                                             |
| 托管策略强制新鲜度门禁                     | 当前生产账户映射仅 `ChatDefaultModel`；未接入 `forceRemoteSettingsRefresh`、跨重启的刷新要求或执行端门禁。若纳入企业治理，先确定 Ash 管理来源、作用域、启动／重载要求及 App Server 执行 owner，再贯通 pending／blocked／satisfied、显式恢复和跨端校验；普通网络失败不自动升级为全产品 AI 禁用，Renderer 禁用输入不作为执行端强制保证。                                                                     |

### 文本存储与语言覆盖

未排期候选：增量压缩与更广的 parser 级语言覆盖。分别先取得文本存储的空间／编辑延迟数据，或明确某种语言与真实 Provider 消费者的能力缺口，再决定是否进入实施；不因上游 API 存在而补接口，不让解析进入同步输入热路径。

### Academy 后续能力

以下由旧路线图归并，均未排期；选择具体用户场景后再转为上方可执行任务，不能按整份功能清单直接实施。

| 方向                  | 用途与进入实施的条件                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复杂页面与写作语义    | 富文本页眉页脚、重复表头／行拆分策略、脚注／尾注、题注、目录／交叉引用、浮动对象／环绕、多栏，以及公式、模板与投稿规则；从具体文档消费者确定 Schema、布局、位置映射与 DOCX 支持范围，沿 Academy 唯一模型与历史实施。 |
| 可检索 PDF 与系统打印 | 现有 PDF 为页面图像；需要可检索文本或真实打印时，先确定字体、文字与页面映射、输出限制和系统宿主契约，再验证固定版本输出、取消与资源释放。                                                                            |
| 长文档布局性能        | 可见区域虚拟化与增量重排尚未实现。先测量长文档首部插入、字体／图片变化和密集表格的重排范围、交互延迟及内存，再按数据选择优化；保留组合输入节点、跨页选区与唯一正文。                                                 |

### Sessions 按关联 PR 号查找

未排期的新工作流增强。`src/ash/sessions/browser/parts/sidebar/sessionsList.ts` 目前只按标题／provider label 过滤，随后才读取已有 `IGitHubService.getSessionPullRequests()` 绘制 PR 标记；关联 PR 的 number 已存在，不需要新增后端发现服务。参考 [VS Code Sessions PR 号查找](https://github.com/microsoft/vscode/pull/338904)，让用户能从 PR 号找回标题不含该号码的会话。

- 进入条件与范围：先确认 `#N` 与纯数字 `N` 精确匹配关联 PR 号的产品语义，再在现有 Sessions 列表 owner 内实现；仅消费已有分支关联／手动附加 PR 数据，不新增网络请求、第二份关联状态或通用搜索层。
- 风险与验收：在 `src/ash/sessions/test/browser/sessions-list.test.ts` 和真实列表场景覆盖两种输入、同号跨仓库的全部匹配、多个 PR、无 PR、关联解除／刷新以及不存在的号码；标题、provider、分组、焦点与清空查询行为保持可用。PR-only 命中不能伪造标题高亮；仅有现有关联数据的会话可按 PR 查找，不承诺尚未提供元数据的外部 provider。
