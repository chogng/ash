# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## MXC · 跨平台验收

- [ ] **验收** · 在支持 PSEC 的 Windows、WSL2 和独立 Linux／x64 运行当前 SDK pin `f1e8694b`，并补外部局域网／公网 IPv6。全仓依赖安全门禁仍被既有 zbus 生态停止维护公告阻挡。命令与验收边界见 [MXC 清单](MXC-TODO.md) 与 [适配器验证](crates/mxc-sandbox/README.md#验证)。

## Windows 开发实验资源清理

- [ ] 清理 Windows 测量实验目录。既有记录 `.build/perf-win-edit-20261018/round4-cleanup.json` 曾核对五个临时目录及 staging 无进程引用，但删除被自动审批拒绝。本轮该记录不在当前检出，未重新验证目录状态或执行删除。
- 保存 Rust 到 App 可用的 15 秒目标尚未达到。2026-10-19 在 `3df4938da` 暂停开发与同步后完成迁移修复的 20 次匹配尝试：空库成功中位数 20.06 → 19.80 秒（5/5 → 5/5），100 条历史会话 22.27 → 21.15 秒（3/5 → 5/5），历史成功样本快 1.12 秒（5.0%）；仍差 4.80／6.15 秒。空库差异很小，不能用成功样本的条件中位数替代总体延迟或失败率结论。原始样本与阶段成本见 `docs/build.md` 完整循环复测及 `.build/perf-win-edit-20261019-migration/q2-summary.json`。
- 本轮复测完成，修复内容与正常构建已恢复；此前第五轮的 diff 适配器边界优化仍保留，旧源码上的约 25 秒结果不作为本轮基线。15 秒是体验目标，并非测量推导的性能下限；若继续优化，需根据发布前约 13.7 秒及历史发布后约 7.4 秒的成本选择方向。上述结果仅覆盖 diff 适配器编辑；本机卷均为 NTFS，没有 Dev Drive。

## Remote / Browser 多根工作区 · TODO

工作区契约见 `docs/desktop-architecture.md` §4.2。

- [ ] **后端前置** · 实现直接保存工作区配置到远端机器；当前 SSH 配置仍保存在 Desktop 本地，内容为远端 URI 根。
- [ ] **验收** · 补 Windows／Linux 远端多根及 Windows 真实系统文件选择器验证。现有多根 SSH 验证使用 macOS 同机隔离 OpenSSH fixture，远端选择器使用受控返回值；跨机器单独步骤通过不能替代多根场景验证。

## Desktop 跨机器验收 · TODO

- [ ] **验收** · 完成指定 Windows 主机真实 Desktop → SSH／Tailscale 全部十步、远端清理和证据 QA；同机 SSH fixture 不能替代跨机器验收。2026-10-19 已通过严格主机校验、公钥登录及原检出的 major10 Windows runtime 构建，真实冷部署一步通过；FILES 在扩展激活超时后的重连中失败，其余步骤未执行。SSH 握手／通道持续不稳定，按用户要求停止重试；待连接稳定后重跑全套并复核远端清理。失败证据保留在 `.build/ash-playwright-mcp/evidence/desktop-cross-machine-windows-major10-2026-10-19T13-46-20-671Z/report.html`，本轮未据此消项。

## 系统授权保存 · TODO

- [ ] **验收** · Windows 交互桌面按 [UAC 验收手册](docs/windows-system-authorization.md) 分别完成真实取消和批准。使用未提升权限的进程、开启 UAC，记录实际弹窗、程序／发布者、两次各 `1 passed` 及日志；自动断言须覆盖字节／BOM／CRLF、dirty、ACL 和焦点。管理员成员普通终端与标准用户输入另一管理员凭据分别验收；skipped 或通用保存失败不算通过。
- [ ] **验收** · macOS 密码授权和 Linux pkexec 各自完成对应系统验收；当前 Dev Container 缺 pkexec／polkit／图形认证 agent，不能用免密规则或 root 执行代替真实系统授权。Windows UAC 结果不覆盖其他系统。

## Configuration / Preferences · TODO

- [ ] **验收** · 在 macOS 验收真实系统 Policy 来源；补两个真实 GitHub 身份切换及非空组织策略的保留／撤回，当前仅有个人账号。2026-10-19 Windows 隔离 profile 已通过个人账号真实刷新、进程内隧道断连失败、键盘显式重试恢复和退出清空；证据 `.build/ash-playwright-mcp/evidence/real-github-managed-policy-2026-10-18T20-45-26-513Z/report.html`，整套场景因缺上述账号覆盖标为 aborted，不能当作完整验收通过。强制新鲜度门禁不纳入本轮。Windows 固定注册表只读探测和受控账户链不能代替 macOS／非空组织策略结果。
- [ ] **验收 · Preferences 上游窗口配对**：以本地 VS Code `a2acc8c864a` 对照用户／Workspace／Folder、`@lang:` 与 `@modified` 组合、重置、JSON 草稿、侧边／指定组和焦点语义。Ash 中英文真实 Chromium 已通过单根与多根读写、重载、高对比度和字号实际生效，macOS Desktop 的用户／单目录 Workspace 真实 App Server 文件链也已通过；本地 VS Code 尚无可运行构建，源码／上游测试核对不能代替窗口配对。当前实现与证据范围见 [Preferences](docs/preferences-and-settings.md#已有验证与限制)。

当前存储、配置层和设置入口见 [Preferences 与 Configuration](docs/preferences-and-settings.md)。

## AgentHost · TODO

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

- [ ] **后端前置** · 标准 Voice／hold 命令先闭合聚焦 Chat widget 与输入生命周期的 `IChatWidgetService` 调用链；PTT／audio／session-context 的完整 VoiceClient 仍缺兼容 producer。现有 Ash Call／VoiceAgent 验证不代表上游 API 对齐；远端自有 Voice/Core bridge 不继续扩展为本轮对齐任务。
- [ ] **后端前置** · MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。
- [ ] **验收** · 补真实账户、物理音频设备与音质验收；现有本地 Call/LiveKit、模拟 Live wire 和 AudioHost 设备替身不能代替该结果。本地转写的 Foundry Local cacheDir／下载／代理契约与完整 Prompt／Agent 格式按真实调用需求另核对。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## Stanza 编辑器 · TODO

- [ ] **验收** · 补系统 IME 候选窗口、Electron 平台及屏幕阅读器验收；浏览器合成 composition 事件不代替物理输入法。

后续阶段由[编辑器路线图](docs/design/editor-roadmap.md)维护；本清单不再把整条路线图重复记成一个未完成任务。

## Work / 通用文档 · TODO

产品范围与约束见 [Work / Code 设计](docs/design/work-code-workbench.md)。

- [ ] **Ash 产品** · Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。现有 `AppServerTextDocumentHost` 仅闭合普通文本快照和 WorkspaceEdit；须先定义结构化编辑的真实 producer／领域端口及审阅行为，不能把 `.ash-doc` 的共享模型再解析成第二份普通文本模型。
- [ ] **Ash 产品** · 增加 Work 产品入口和默认布局，复用现有生命周期，明确 Code／Work 的资源、未保存内容、会话与状态恢复，不恢复模式注册表或第二份配置。

## Desktop 启动性能 · TODO

- [ ] **评估** · 基于已采集的入口清单和四组 CPU 证据，验证选定语言资源的惰性加载生命周期；候选需比较静态 JS、首次功能成本及四组重复启动，不凭 87.6% 静态语言资源占比宣称启动收益。
- [ ] **测量** · Renderer／Main 同 nonce 的四组采样已通过；继续把 Rust carrier／daemon probe／App Server initialize 内部阶段配对到同一连接，解释冷后端约 520 ms、复用约 1.7 ms 的首写到首回传差异。保持首次授权独立计量，不直接相减跨进程时钟。
- [ ] **复核** · 旧启动诊断的部分 F1 失败仍未复现、未归因。当前 macOS 激活原生窗口的 F1／命令列表／Escape 焦点恢复回归已通过；名义 hidden 对照在观测时也实际可见且有焦点，不能据此认定隐藏窗口导致旧故障。保留历史失败产物及新的焦点／键盘到达记录，继续核对旧批次的条件；范围见[启动复核](docs/desktop-startup.md#2026-10-18-f1-本机复核)。

复测命令与基线见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

测量入口与约束见[审计与测量](docs/ash-app-server-data-path-audit.md)。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **复核** · 继续识别大内容按需资源及领域物理取消的具体消费者。文件模型、Chat Changes 摘要及 Code／Cowork Thread／transcript 的在途只读刷新已合并；后者补齐代次隔离、写后补读和落后 bounded 快照的有界重试，两个模型/视图文件 239 项测试通过。GitHub 已取消读取可跳过无消费者 payload 的 schema／Worker 回传；这些结果不代表通用传输取消或所有读取入口均完成。约束见[消费者刷新约束](docs/ash-app-server-data-path-audit.md#已接入的消费者刷新约束)。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。
- [ ] **测量 / 可做** · 继续测量更大段落、候选密集公式、列表与表格的单次分词及投递预算。已修复普通巨大段落的数学候选重复扫描：10,103 字节／128 次更新的累计同步成本下降 85.7%，7 样本长任务 84 → 0，单次最大更新中位数 57.3 → 5.8 ms；56 项 Markdown 单测及 3 项 Chromium 场景通过。此结果没有给任意输入提供硬时间预算，也不是完整 Desktop 收益；范围见[数学候选扫描复测](docs/ash-app-server-data-path-audit.md#20-已实施巨大段落的数学候选扫描减量2026-10-18)。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一诊断包导出                             | IDE 与 Agent Window 已有 [Agent Host 调试日志包](docs/chat.md#调试日志导出)，包含客户端日志、Session 所属本地／SSH 宿主的进程日志与现存轮转文件、当前会话执行证据，以及当前 Chat／子 agent 已录制的请求和响应正文。manifest 记录录制状态、范围、限额和收集问题。更广的通用诊断包仍未排期：`feedback/prepare` 的构建、活动统计、响应诊断和指标快照尚未接入该入口，新增来源须沿其 owner 的真实收集契约接入。 |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                                                                                  |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。设置呈现与接入规则见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前实现)。                                                             |
| 托管策略强制新鲜度门禁                     | 当前生产账户映射仅 `ChatDefaultModel`；未接入 `forceRemoteSettingsRefresh`、跨重启的刷新要求或执行端门禁。若纳入企业治理，先确定 Ash 管理来源、作用域、启动／重载要求及 App Server 执行 owner，再贯通 pending／blocked／satisfied、显式恢复和跨端校验；普通网络失败不自动升级为全产品 AI 禁用，Renderer 禁用输入不作为执行端强制保证。                                                                     |
