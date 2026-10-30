# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## 窗口缩放布局 · Windows 验收

- [ ] **验收** · 在 Windows 显示缩放 100%、125%、150%、200% 下，分别检查 IDE 与 Agents：连续拖动四边和四角、往返缩放、最大化后恢复；标题栏左右图标应保持相对窗口边缘的位置，按钮不得抖动、重叠或被裁切。再切换应用界面缩放，检查底部状态栏和右边缘是否出现 1px 裁切。
- [ ] **验收** · 将编辑器和会话分别弹出到辅助窗口，重复上述缩放与最大化恢复；检查编辑内容、状态栏与根容器边界对齐，切换紧凑模式后菜单、键盘操作和焦点恢复正常。记录 Windows 版本、显示缩放、应用缩放、窗口类型及复现步骤；验收通过后移除此节。

同步 resize 已收至共享布局服务；辅助窗口已补齐布局前后阶段，根容器统一保留小数尺寸。macOS 已通过 268 项定向单测、2 项原生回归和 3 个真实窗口场景；Agents 106 帧采样无布局滞后，IDE 113 帧图标位置稳定。Windows 分数缩放实机尚未验证；本地证据在 `.build/ash-playwright-mcp/titlebar-resize/foundation-fix/validation.json`。

## Connectors 面板 · 点击后窗口无响应

- [ ] **历史现场复核** · 2026-10-21 用户随后确认点击已正常；实际开发窗口的只读检查也显示主线程响应、无活动动画、Connectors 读取已结束。隔离 Desktop 中全折叠后展开／键盘切换通过，尚未建立原先整窗无响应的故障链。潜在的状态通知请求放大已单独复现并修复：25 次通知在读取进行中不再追加 25 组读取，只在结束后补读一次；保留最新状态、隐藏时撤销待补读，显式导航及可物理取消的市场查询仍可抢占。原始故障仅在再次出现时采集实际 Renderer／Main 栈继续归因，不把这一防护称为历史根因修复；证据与运行限制见 `.build/ash-playwright-mcp/connectors-validation.json`。

## SCM 普通文件点击 · 残余极端往返

- [ ] **测量** · 最终独立窗口中最慢暖点击 375.6 ms：extensionHost/invoke/read（connection 1，request 2907）客户端往返 274.3 ms，同 ID 服务端处理 0.088 ms、出站 0.040 ms，Git 请求在之后才开始且仅 3.4 ms。尚未拆清 Renderer→Main→daemon 送达与返程 decode/dispatch，不能归因扩展执行或渲染。下一步补这些边界的 method/request ID 标记，保留极值复现；本轮全部原始数据和已完成实现见[报告](.build/scm-tail-v2/report.md)。
- [ ] **checkIgnore 排队残余** · 统计读取与普通文件读取的两层共享读已完成；新 16 窗对照中 Git RPC p99 79.8→16.6 ms、资源排队 p99 77→0 ms，暖端到端 p95/p99 均通过预设稳定规则。仍有 1/960 暖点击等待 47 ms，前方三个独占 `git/checkIgnore` 请求依次完成；后续评估该路径须保留取消、写者顺序及仓库权限约束，不直接移除序列化。原始关联与完整结果见[报告](.build/scm-statistics-concurrency/report.md)。

## PR #57 · 合并后剩余项

[PR #57](https://github.com/chogng/ash/pull/57) 已于 2026-10-20 正常 squash merge（`ee3dea640`）。后续仅在当前 main 本地整批修复与验证；不推送、不主动触发远端 CI、不恢复已暂停的 `pr-57-ci` heartbeat。保留其它任务修改，完整批次提交前准确 stage 并执行 `just commit-check origin/main`。

- [ ] **完整 CI 覆盖**：获准发布后，以新 main SHA 核对原失败矩阵及 Windows sandbox acceptance。[此前失败的 CI](https://github.com/chogng/ash/actions/runs/39490567225) 在旧安全门禁后跳过了前端、Bazel 和 Rust 作业；本地证书修复后 `just dependency-security` 的 advisories／licenses／sources 已全部通过，但尚未发布，不能称远端全绿。已有 Linux x64 47 项通过证据不等于旧 hosted 启动失败根因已证实；尚无完整跨平台全绿证据；Desktop runtime acceptance 的 macOS hosted MCP 进程回归仍需远端通过证据，本机进程补验见 [AgentHost 记录](agenthost-todo.md#2026-10-29-macos-进程补验)。本地证书验证日志 `/tmp/ash-pr57-certificate-{security,dependencies-final,http-final,bazel-final,app-server-build}.log`。本轮 rebase 后 `0d95ccc29` 基线的 macOS 定向复核及首败／修正复验见[验证记录](.build/pr57-rebased/validation.json)；该记录不覆盖随后并行任务的 Activity Bar、Chat 和 Rust 改动。

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

## Desktop 窗口收尾弹窗 · TODO

- [ ] **复核 · macOS 启动后立即退出**：2026-10-08 Sessions 尚在启动时退出曾记录两条 `IPC connection closed`；未修改的 storage owner 在同基线亦复现。2026-10-21 本机 `9402110a6` 正常重建后，真实 App Server 的自动恢复变体通过迁移、原文归档和布局恢复；窗口日志确认退出请求早于 `Agents restored` 6 ms，本轮未出现旧 IPC 错误。同批单窗口变体却在第二次启动后的退出超过 10 秒，Renderer 已回完成、载体已 stopped；定向复跑通过，首败仍保留，尚不能归因到旧存储 RPC。下一步取得该停留阶段的实际 pending／关闭诊断并修复，不增加等待或过滤错误消项。命令、日志和范围见 [macOS 补验](docs/desktop-startup.md#2026-10-21-macos-sessions-启动退出补验)；证据 `.build/local-todo-retirement/{first,retry}-test-results/`。2026-10-29 两个变体各 5 轮、合计 10/10 通过；自动恢复变体的退出请求均晚于 Agents 恢复 4–11 ms，没有重现启动中退出或旧停留，继续保留待定位项。此项不阻塞已验收的存储队列修复退场。

- [ ] **现场复核 · 开发重载时的原生无响应提示** · 后端发布漏通知与重启期间备份失败已修复，macOS 协议／备份及发布监听 81 项通过，双窗口重连和重载恢复未保存文件各 5 轮通过，已完成部分见 [后端发布与重载复核](docs/desktop-startup.md#2026-10-21-后端发布与页面重载重叠)。剩余是用户原先的“等待／重新打开”：本轮捕获的是主动保存失败，旧日志三次原生无响应前的 `initialize` 超时尚未关联到同一个原因；需用已有 token／reason、pending 标签及原生事件来源日志取得实际故障链，不能据新修复宣称所有无响应已解决。

## Desktop 跨机器验收 · TODO

- [ ] **验收** · 完成指定 Windows 主机真实 Desktop → SSH／Tailscale 全部十步、远端清理和证据 QA；同机 SSH fixture 不能替代跨机器验收。2026-10-19 已通过严格主机校验、公钥登录及原检出的 major10 Windows runtime 构建，真实冷部署一步通过；FILES 在扩展激活超时后的重连中失败，其余步骤未执行。SSH 握手／通道持续不稳定，按用户要求停止重试；待连接稳定后重跑全套并复核远端清理。失败证据保留在 `.build/ash-playwright-mcp/evidence/desktop-cross-machine-windows-major10-2026-10-19T13-46-20-671Z/report.html`，本轮未据此消项。

## AgentHost · TODO

以下新产品能力和专项环境验收暂缓，按实际使用需要恢复。

- [ ] **复核 · 自举场景的完整外部 Codex 目录接入**：相同普通代码目录在无外部账号连接的对照场景中启动通过；使用完整外部 Codex home 时重复出现初始化或 `env/dirs/set` 超时，仅引用认证文件的隔离目录则可启动并调用真实模型。尚未证明是模型目录导入、认证路径还是其他初始化问题；排查前保留失败日志，补启动失败时的证据收集，不将有限启动重试当作通过。记录见上述场景目录的 `startup-attempt*.log` 与 `preflight-no-auth.log`。临时认证文件引用已移除，重跑需重新显式准备只读引用，不能复制凭证进入证据。

已完成的统一宿主、多 Provider Session／Chat、附件快照、查询过滤及历史仓库契约见 [通用服务端到端记录](agenthost-todo.md#通用服务端到端闭合--2026-10-18)。下面保留产品能力和真实环境验收缺口；文件台账不表示上游 AHP wire protocol 兼容。

- [ ] **新产品 · Agent SDK／Codex 续接／本地模型／独立 Web 启用**（用户决定先列缺口）：SDK 下载／重载、Codex 专属账号与配额续接、模型安装／server lifecycle、Web 启用设置／context owner 均须先闭合领域契约与生产入口；保留现有多 provider 账号和 Web transport 可用性，不新增空服务。准确文件清单见上述 Workbench 记录。
- [ ] **新产品 · 同步 customization 与附加宿主可选执行能力**：synced OpenPlugin／active-client 分发尚无 Ash producer 与执行策略；附加宿主尚无独立窗口 Git 扩展实例和跨宿主扩展命令契约，`pull`／`push`／`publish`／打开源代码只按真实 provider availability 提供，不能转发主窗口命令；Guardian 远端安装沿现有产品限制。现有通用 GitHub／PR、历史仓库读取、执行默认值和目录权限已按 Session scope 闭合。
- [ ] **新产品 · Cloud Sandbox**（用户决定先 TODO）：先确定服务端实例／仓库 producer、账号和凭证刷新、Session／文件权限及 Provider 归属，再实现连接、目录、模型和会话入口；当前没有对应生产 producer，具体路径见清单 `todo-by-user`。
- [ ] **新产品 · Tunnel／WSL**（用户决定先 TODO）：分别确定网关／认证／重连／存储与 WSL runtime 启停／分发／authority 契约，再接既有 Remote owner；当前 SSH／Dev Container 不作为这些能力已实现的证据。
- [ ] **新产品 · Mission Control**（用户决定先 TODO）：先确定后端控制与会话事实、认证／credential delegation、共享权限及 Provider 归属，再实现环境与会话入口；不预建镜像状态或转发类。
- [ ] **复核 · 旧隔离环境故障**：取得麦克风枚举失败的准确步骤和底层诊断，沿音频设备 owner 定位。原 2026-10-08 证据目录不在当前检出；不能凭通用错误码或普通音频测试关闭报告。

## Sessions · TODO

- [ ] **评估 · Agent Window 20px 图标字体**：可能需要按 20×20px 设计基准制作独立图标字体；后续确认适用范围、线宽与留白，并对比现有 16px 字体放大的效果，再决定实施。
- [ ] **后端前置** · 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] **后端前置** · MCP App sampling、media context 与双向 App tools 按原 Core 权限和能力契约逐项补齐；现有 tools/call、资源、消息/context、CSP、导出、诊断和 fullscreen 保持回归，缺失 capability 不宣告。

输入、渲染、工具与语音职责及历史验证范围见 [Chat](docs/chat.md)。

## 扩展作者 SDK 与开发体验 · TODO

已采用 `@ash/sdk` / `ash.*` 自有作者契约；职责和宿主能力见[扩展架构](docs/editor-extensions.md#0-确定的产品方向)。命令、文档／配置、语言、UI、SCM、Tasks／Debug、Terminal 与 Speech 的已有作者接口及消费者已迁到统一实现，Node、可选 Rust/V8 与可信 Worker 使用同一入口。旧 `vscode` 作者模块、Open VSX 来源、VSIX 扩展安装／运行入口及旧类型依赖已删除；历史记录只保留退休识别、停用、撤权和卸载，不恢复旧授权。纯 TS 示例已通过仓库外安装／编译及真实 App Server 的 Rust 文件读取、授权、越界、取消和停用验证。Rust SDK 继续服务原生能力提供者，文档模型、dirty、撤销与 UI 保持客户端唯一所有权。

后续按[SDK 能力开放原则](docs/editor-extensions.md#sdk-能力开放原则)，从现有扩展的实际阻碍选择最小能力；[能力边界与待复核需求](docs/editor-extensions.md#现有能力与待复核需求)用于定位，不作为逐项补齐 API 的实施队列。Academy 等现有扩展用于验收已选行为：

- [ ] **复核 · macOS 原生监听故障来源**：已取得 SIGUSR1 客户端快照，并复现、修复 Ash Rust 构建监听的根目录订阅：同一 10000 次缓存文件创建／删除，旧方案给 daemon 该客户端 10001 条事件，原生 manifest 文件监听为 0；原子保存／缺失恢复／清理回归、真实监听入口审计及开发启动已通过。尚未复现原 PID 355 的 19.3G footprint、notify 热点和注册锁等待，不能将本次订阅修复称为该长期失控的完整根因；旧内存状态已不存在。原故障再次出现时，先取 sample、客户端状态与同步文件操作，按 PID 和计数增量关联。证据及复现入口见 [.build/hmr-investigation/report.md](.build/hmr-investigation/report.md)。
- [ ] **功能 · 文献检索扩展**：后续实现查询、元数据获取及向文献管理扩展入库的工具／Skill 链路，PDF 阅读复用独立查看器；作者接入遵循本节扩展 SDK 任务。Agent 结构化文档写入仍按下方 Work 文档服务契约另行实施。尚未新增检索代码或迁仓。
- [ ] **Academy 作者侧迁移**：先以 Academy 现有声明、标签和注册接线确定具体作者阻碍，再由 Manifest、TS SDK 或构建工具承担必要的 Rust 接线，使普通作者无需手写 Rust 即可开发编辑器、提供 Agent 工具并附带 Skill；不借迁移预建通用 API。高级编辑器能力使用明确的公开客户端契约；Agent 结构化写入依赖下方 Work 文档服务任务，不另建模型或编辑历史。确有原生算法需求时再选用 Rust／WASM 等组件。
- [ ] **本地开发与源码调试**：按用户当前要求暂停，待明确恢复后实施；只读调查已确认可复用现有 F5／DebugService／Rust DAP 链，独立 Node DAP adapter 需要“受管子进程＋私有 socket”启动组合。隔离 Ash 开发实例显式加载开发目录，开发授权与正式安装信任分开；补 TS Source Map、源码断点、单步、变量、构建／重载及诊断。暂停预算归开发会话，普通调用的取消、撤权、deadline 与晚回复墓碑继续生效；不能只扩大 Host RPC 超时。验证暂停超过 30 秒后不误重启、恢复不续旧权限、停止／断连释放宿主和 adapter；Rust/V8 Inspector 另按实际宿主实现。
- [ ] **测试、打包与安装**：按用户当前要求暂停 `.ashx`，待明确恢复后实施；只读调查已确认可复用 `LocalPluginPackage`、`PluginPackageStore` 和 `PluginActivationAuthority`。计划使用带明确格式标记与内容摘要的 ZIP envelope／payload，严格解压后交同一安装 authority；普通 ZIP／改名 VSIX 拒绝，安装不自动启用或授权，也不冒充签名来源。支持已构建 TS、资源及按平台独立打包的可选原生程序；不在安装时执行构建脚本。补 CLI pack／install 与真实 `pack → install → enable/grant → TS 调 Rust → revoke/uninstall`，覆盖篡改、路径逃逸、重复／链接条目和大小限制。
- [ ] **端到端验收与文档**：以仓库外 Academy 项目的已选需求逐段验证 TS 作者入口、类型检查／构建、加载／重载及正式安装／授权／撤权／卸载，覆盖中英文、能力失效和资源释放，并同步 SDK、Academy 与平台文档。涉及 F5／源码断点和 `.ashx` 的阶段继续等待上述暂停任务明确恢复，不以验收要求倒推新增 API。已有 [Rust SDK 导出与进程诊断验证](sdk/docs/development.md) 是可复用底座，不代表完整 TS 作者体验或 F5 调试已完成；完成后删除对应待办。

## Work / 通用文档 · TODO

产品范围与约束见 [Agent Window 文档工作区设计](docs/design/work-code-workbench.md)。

- [ ] **Ash 产品** · Agent 结构化文档编辑经统一文档服务校验模型版本／文件修订、权限和 schema，一次事务可撤销；覆盖打开和未打开资源及过期拒绝。现有 `AppServerTextDocumentHost` 仅闭合普通文本快照和 WorkspaceEdit；须先定义结构化编辑的真实 producer／领域端口及审阅行为，不能把 `.ash-doc` 的共享模型再解析成第二份普通文本模型。
- [ ] **Ash 产品 · Stanza 基础之后** · 将 Academy 的插件消费限定在 Agent Window，沿产品装配收敛 IDE 既有文档贡献、菜单与恢复接线；共享编辑器桥、文件和工作副本服务继续复用。独立 Activity Bar 图标与界面仍为待定方案，不先实现入口；选定入口后沿现有 Parts 和生命周期验证资源、未保存内容、会话与恢复，不恢复模式注册表或第二份配置。2026-10-22 已同步目标设计；本轮未改宿主准入或运行时接线，既有备份的退出／恢复策略及真实宿主范围验收仍待闭合。

## Desktop 启动性能 · TODO

- [ ] **评估** · 基于已采集的入口清单和四组 CPU 证据，验证选定语言资源的惰性加载生命周期；候选需比较静态 JS、首次功能成本及四组重复启动，不凭 87.6% 静态语言资源占比宣称启动收益。
- [ ] **复核** · 旧启动诊断的部分 F1 失败仍未复现、未归因。当前 macOS 激活原生窗口的 F1／命令列表／Escape 焦点恢复回归已通过；名义 hidden 对照在观测时也实际可见且有焦点，不能据此认定隐藏窗口导致旧故障。保留历史失败产物及新的焦点／键盘到达记录，继续核对旧批次的条件；范围见[启动复核](docs/desktop-startup.md#2026-10-18-f1-本机复核)。

复测命令与基线见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

测量入口与约束见[审计与测量](docs/ash-app-server-data-path-audit.md)。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一诊断包导出                             | IDE 与 Agent Window 已有 [Agent Host 调试日志包](docs/chat.md#调试日志导出)，包含客户端日志、Session 所属本地／SSH 宿主的进程日志与现存轮转文件、当前会话执行证据，以及当前 Chat／子 agent 已录制的请求和响应正文。manifest 记录录制状态、范围、限额和收集问题。更广的通用诊断包仍未排期：`feedback/prepare` 的构建、活动统计、响应诊断和指标快照尚未接入该入口，新增来源须沿其 owner 的真实收集契约接入。 |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                                                                                  |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。设置呈现与接入规则见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前实现)。                                                             |
| 托管策略强制新鲜度门禁                     | 当前生产账户映射仅 `ChatDefaultModel`；未接入 `forceRemoteSettingsRefresh`、跨重启的刷新要求或执行端门禁。若纳入企业治理，先确定 Ash 管理来源、作用域、启动／重载要求及 App Server 执行 owner，再贯通 pending／blocked／satisfied、显式恢复和跨端校验；普通网络失败不自动升级为全产品 AI 禁用，Renderer 禁用输入不作为执行端强制保证。                                                                     |

### Rust 分析缓存持久化（暂缓）

2026-10-23 用户决定先使用内存缓存，持久化留作后续工作。当前保持按需分析、默认保留已启动服务，自动闲置回收可选；实现和设置见 [Rust 语言支持](extensions/rust/README.md#analysis-cache-and-memory)。

- 引擎：从 RA 的依赖 crate 名称解析结果（DefMap）验证 Salsa 持久化，恢复输入、ID 映射和查询依赖；进程真正退出后，只重算源码变化及受影响的查询。核对文件增删、Cargo 配置、features/cfg、工具链和过程宏变化；未保存编辑仍由编辑器拥有。
- 磁盘与设置：后端统一管理跨工作区容量、最近使用时间、过期清理和读写租约；覆盖低磁盘空间、损坏及未完成写入、多窗口和手动清理。10 GiB 总量、30 天保留期只是待实测的初始建议。能力落地后再提供开关、容量和保留天数的直接输入控件。
- 验收：用真实 RA 进程退出／恢复验证补全、跳转和增量失效，记录首次请求耗时、内存峰值及磁盘占用；覆盖崩溃、版本升级和清理并发。参考 [Salsa 恢复测试](https://github.com/salsa-rs/salsa/blob/master/tests/persistence.rs)与 [gopls 分层缓存设计](https://go.dev/blog/gopls-scalability)。

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
