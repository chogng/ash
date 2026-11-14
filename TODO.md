# 待办

## Desktop · CPU 与内存占用调查

- [ ] **测量 · 源文件扫描、TypeScript 与长期 Chat** · 2026-11-14 Windows 四千个合成 TypeScript 文件、十二个标签场景中，符号索引已按文件增量写入并复用基础匹配器，增量受文件数、符号数和事实字节数限制，超限合并。一次前测、两次后测中，已有文件更新可见耗时 2559→278–289 ms，更新窗口后端 CPU 时间 1.02→0.08–0.22 s，全流程累计提交峰值 281→200–201 MiB，常驻约 159–169 MiB；65 项相关 Rust 测试通过、1 项原有忽略，真实 Desktop 已验证搜索、覆盖层和删除，运行包散列已核对。证据：`.build/perf-incremental-20261114/results.json`；前轮证据：`.build/perf-resource-20261114/local-optimization-results.json`。新增、删除文件仍分别需约 11.6–11.8 s、10.5–10.7 s，需继续定位 canonical 源文件扫描；关闭标签后 TypeScript 语义服务器仍保留约 840 MiB 分析缓存，默认未开启 `languageServers.autoSuspend`，尚需验证同等语言能力下的释放、重开和冷启动成本。十二个合成 Chat 会话完成与再次访问已测，尚无长期增长复现；仍缺整机 CPU 稳定降幅及长期运行数据。
- [ ] **验证阻塞** · `just verify ash-host-logs` 的库测试 `rotation_preserves_three_files_and_reports_replacement` 在 `crates/host-logs/src/store_tests.rs:74` 的 `next.gap` 断言失败，单独复核仍失败；本轮未改轮转实现。需定位该失败后补齐包级 verify，不能将本轮定向测试通过视为整包通过。

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

## Chat 应用窗口截图 · macOS 实机验收

- [ ] **验收** · 应用窗口截图已接入选窗、快捷键、权限 Setup 和原草稿附件管线；Snapshot 已迁为内置编辑器并移除扩展包，标注、复制、保存和代码图片继续共用一条链路。4 个真实桌面／其他应用像素场景因测试宿主缺少 macOS 屏幕录制权限跳过，尚缺真实其他应用窗口到聊天附件的整链证据。授予测试用 Ash 屏幕录制权限后，运行 `pnpm test:smoke:desktop:no-compile test/smoke/areas/chat/chat-screenshot.spec.ts test/smoke/areas/chat/chat-app-window-screenshot.spec.ts`；用例使用仅包含测试色块的窗口，检查选窗、区域捕获、取消保留草稿、编辑和附件回填，通过后移除此条。

## Chat 输入框 · 布局切换验收

- [ ] **验收** · 已将两个 Chat 入口默认统一为单行自适应，在设置 → 外观增加「Chat 输入框布局」单行／分层选项，切换保留草稿。配置、设置页面与 Chat 测试共 259 项通过，渲染器、自动化和测试类型检查及中文翻译检查通过。真实窗口测试入口因进程枚举触发 `spawn EPERM`，尚未完成视觉验收。在允许启动测试进程的环境运行 `pnpm test:smoke:ui test/smoke/areas/sessions/sessions-window.spec.ts --grep 'Chat input layout switches live|Sessions empty chat centers'`，检查默认单行、即时切换、长文本展开、重开保留和设置控件与背景色选项的视觉一致性；通过后删除本条。

## Artifact 工具栏 · Desktop 验收

- [ ] **验收** · `ArtifactToolbar` 已统一浮动外壳、动作分组和菜单生命周期，画布默认底部居中；103 项定向单测运行、2 项浏览器集成测试、渲染器与分层类型检查通过。Desktop 启动被语言包校验阻断：内置 `ash` bundle 有 10,003 条消息，`parseLanguagePackCatalog` 上限为 10,000，报 `Invalid display language resource`。修复该边界后运行 `node test/scenario/out/runScenario.js .build/ash-playwright-mcp/artifact-toolbar.cjs`，复核居中、Motion 时间线避让和模式切换，通过后删除本条。最终完整单测编译另被 `src/ash/sessions/test/common/sessions-configuration.test.ts:30` 的 `IConfigurationSettingSchema.options` 类型错误阻断；本轮定向运行使用已核对包含最新工具栏实现的编译产物。

## Docs · 空段落首次输入修复集成

- [ ] **集成** · Mac Studio 已修复空白富文本段落首次输入的模型同步、选区恢复与输入法组合提交；新增工作副本备份／恢复回归及真实 Electron 输入、保存重开场景。定向编辑器测试 51 项通过，新增备份跟踪器回归 3 项通过，Electron UI 与连接 App Server 场景各 1 项通过。当前 checkout 的 `main` 基线为 `f06080352e`，远端 `origin/main` 为 `b98e8522fe`，另有 105 个既有修改／未跟踪文件；原内容已核对保留。按提交规范不能自动 stash 或切换工作区以 rebase，故本次只准备本地任务提交。由现有修改的 owner 收尾后，fetch 最新 main，仅 rebase 本任务未发布提交，复验受影响场景并通过 `just commit-check origin/main`，再串行非强制推送并核验远端；完成后删除本条。备份覆盖使用生产工作副本跟踪器与内存存储，Sessions 窗口当前未接入自动备份跟踪器，未验证其整窗崩溃恢复。

## 终端恢复 · macOS 验收

- [ ] **验收 · 断线期间退出的 PTY** · Linux 已验证重连后能读到末尾输出和退出码 `7`。Windows 上针对 macOS 的交叉检查在构建 `libsqlite3-sys` 时因缺少目标 C 编译器中止。在装有 Xcode Command Line Tools 的 macOS 上运行 `just verify ash-exec-server --lib --filter attach_replays_final_output_and_status_after_disconnected_child_exits`，通过后移除此条。

## Agents Window · 真实 SSH 主机验收

- [ ] **验收 · SSH 工作区信任** · 已通过本地桌面场景和远程路径的定向自动化测试。真实远程主机验收缺少可连接的 SSH 地址及允许创建临时目录的路径。取得这两项后，在隔离目录验证 SSH 工作区启动恢复、已有受限授权时重新提示并在确认后挂载，以及取消后目录未挂载。用远端目录绑定状态核对结果。

## Agents Window · Windows 图片预览

- [ ] **验收 · Windows 默认应用图标和应用选择** · 已接入 Windows Shell 的文件关联查询、应用图标和按应用打开。当前会话缺少可用的 Windows 桌面。用包含改动的 Windows Ash 安装包，在 Agents Window 的 Code 输入框粘贴 PNG 并打开预览。
  1. 让「照片」作为 PNG 默认应用，确认「打开」显示正确的图标，加载时图标位置稳定，没有通用图标闪现。点击主按钮，确认图片在默认应用中打开。换一个默认应用后重开预览，确认图标随系统关联更新。
  2. 用鼠标和键盘打开下拉，确认默认应用排首并勾选。选择另一款兼容应用，确认主按钮图标和勾选同步，再点击「打开」并确认图片由选中的应用打开。重新打开预览，确认仍按系统默认应用初始化。两项通过后移除此条。

## ChatGPT Web · 历史读取实测

- [ ] **测量** · Ash 已用隔离测试验证缓存复用、过期刷新和 429 恢复。现有浏览器连接读不到已登录 Edge 标签页的 DevTools Network，缺真实网页的请求次数、状态码和耗时。可访问 Network 后保持缓存开启，分别采样一次普通刷新和一次切回聚焦，单独记录 `/backend-api/conversations` 的请求，与 Ash 模拟结果对照。用模拟响应验证 429。

## Ash Chat · 公网分享

- [ ] **验收 · 部署只读分享服务** · Ash 桌面已能通过本地 Worker 生成链接，独立浏览器可读到整段消息快照。默认公网地址仍返回 404，当前缺少目标 Cloudflare 账号的 Worker 和 R2 部署授权。取得授权后按 [分享服务部署说明](services/chat-share/README.md#deployment) 配置私有存储桶及过期规则，再用合成对话验证公网链接。

## Desktop Chat · App Server 调试与采样

- [ ] **macOS 实机验收** · 用同一个本地 Ash 桌面窗口和带调试符号的 Rust App Server 验证断点、分离和 CPU 调用栈。

  1. 在 macOS 的 Terminal 中进入 Ash 仓库根目录。若缺少 Xcode Command Line Tools，先运行 `xcode-select --install`。若缺少 Samply，运行 `cargo install --locked samply`，再运行 `export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"`。从能找到 Samply 的同一个终端启动 Ash。逐条确认以下命令成功：

     ```sh
     node --version
     pnpm --version
     /usr/bin/lldb --version
     samply --version
     pnpm install --frozen-lockfile
     pnpm prepare:backend
     pnpm debug:backend
     pnpm build
     ASH_HOME="$PWD/.build/desktop/debug/profile" \
       ASH_DEV_APP_SERVER_RELOAD=1 \
       ASH_DEV_APP_SERVER_GENERATION="$PWD/.build/desktop/debug/app-server/current.json" \
       pnpm start --backend-prepared --user-data-dir="$PWD/.build/desktop/debug/user-data"
     ```

  2. 在新启动的 Ash 窗口按 `F1`，运行「网络诊断」（`Network Diagnostics`），等报告打开，确认后端已就绪。另开一个 Terminal 标签页，在仓库根目录运行 `pnpm debug:backend:status`，记下 `pid` 和 `instanceId`。
  3. 回到 Ash，运行「调试本地 App Server」（`Debug Local App Server`）。若 macOS 弹出控制 Terminal 或附加调试的授权提示，批准后继续。确认 Terminal 中的 LLDB 附加到刚才记录的 PID，然后在 LLDB 输入：

     ```text
     breakpoint set --file network.rs --line 85
     breakpoint list
     continue
     ```

     断点应解析到 `crates/app-server/src/server/request_processors/network.rs` 的 `network_targets`。如果行号随源码变动，改用该函数首个可执行语句的行号。回到 Ash 再运行一次「网络诊断」，看到 LLDB 因断点暂停后，在 LLDB 输入：

     ```text
     thread backtrace
     process detach
     quit
     ```

     保留包含 `network_targets` 和 `Process … detached` 的终端输出。确认暂停时发起的网络诊断在分离后打开新报告，再运行 `pnpm debug:backend:status`，核对 `pid` 和 `instanceId` 与附加前一致。

  4. 在同一个 Ash 窗口运行「开始录制本地 App Server CPU 样本」（`Start Local App Server CPU Recording`）。等开始通知出现后，多跑几次「网络诊断」，每次等报告返回。运行「停止录制本地 App Server CPU 样本」（`Stop Local App Server CPU Recording`），在保存对话框中把报告保存为 `~/Downloads/ash-app-server-cpu.json`，然后运行：

     ```sh
     samply load "$HOME/Downloads/ash-app-server-cpu.json"
     pnpm debug:backend:status
     ```

     `samply load` 运行期间，在打开的 Firefox Profiler 中选择刚才记录的 `ash-app-server` 进程及有样本的线程，检查 `Call Tree` 能展开多层调用栈并显示 Rust 函数名。查看完按 `Ctrl+C` 退出 `samply load`，再核对 `pid` 和 `instanceId`。断点、分离和采样均通过后，保留 LLDB 输出及 CPU JSON，再移除本条待办。

## Roadmap · Rust 运行时与 Node 退场

最终目标是让 Rust 承担产品宿主、核心执行与基础设施，移除产品对 Node 运行时的依赖。迁移以实际调用链、打包依赖和进程退出为完成条件；把 Node 文件操作包成 Rust 原生模块、改目录名或另建一套平行业务后端，都不等于 Node 退场。浏览器 JavaScript／TypeScript 与 Node 是不同运行时：界面可以继续使用浏览器能力，Rust 可逐步进入前端计算与渲染流程，不要求先整体重写 UI。

以下是已确定的发展方向，按可验证切片推进，不承诺整阶段已经实现。当前 Electron 是过渡宿主；构建工具使用 Node 与产品启动依赖 Node 分开核对。

- [ ] **产品基础设施迁入 Rust** · 沿实际消费者迁移日志、存储、文件与网络 IO、进程和后台资源管理。每个切片同时删除旧 Node owner、注册与线上消费者，覆盖启动失败、取消、重连、多窗口及退出；日志落盘不能依赖它所诊断的 App Server 业务连接。Electron 仅保留尚未迁走的宿主适配。
- [ ] **扩展与工具运行时去 Node** · 逐项核对扩展、语言服务器及 Electron run-as-Node 的消费者，将已需能力迁到 Rust、Rust/V8、浏览器 Worker 或原生程序。保留作者契约、权限、调试和资源回收语义；无法等价支持的 Node API 依赖须明确迁移或支持范围，不能通过兼容层继续隐式启动 Node。
- [ ] **Rust 产品宿主替换 Electron／Node 启动链** · 闭合窗口、浏览器嵌入、系统集成、原生 IPC、更新、打包和跨平台生命周期，再替换过渡宿主。日志等 Rust 基础模块由 Rust 宿主直接拥有；过渡期内部 helper 随之退出。验收默认产品启动与主要工作流不加载或启动 Node，不能以仍需 Electron Main 的实现宣称完成。
  - 内置浏览器按基础网页浏览验收：打开网页、站内跳转、前进／后退、刷新，以及常见网页的输入和登录。Agent 浏览器自动化和 Electron 专用调试集成不作为退场前置。外部网页使用独立的浏览视图和存储分区，与 Ash 工作台的认证及宿主 IPC 隔离。普通浏览器中的 Ash 继续走独立 Web 入口。
- [ ] **Rust 前端计算与渲染演进** · 沿真实 DOM 更新、布局、文本／差异计算和渲染调度热点选择 Rust／WASM 等切片，以匹配负载测量输入到可见更新、帧时间和内存。保持模型／编辑历史唯一 owner，覆盖 IME、选区、焦点、键盘和无障碍；现有 [WebGPU 渲染任务](#多文件审阅--webgpu) 按其独立范围验收，不把引擎 GPU 合成或 Rust 代码存在当作渲染优化完成。

## Connectors 面板 · 点击后窗口无响应

- [ ] **历史现场复核** · 2026-10-21 用户随后确认点击已正常；实际开发窗口的只读检查也显示主线程响应、无活动动画、Connectors 读取已结束。隔离 Desktop 中全折叠后展开／键盘切换通过，尚未建立原先整窗无响应的故障链。潜在的状态通知请求放大已单独复现并修复：25 次通知在读取进行中不再追加 25 组读取，只在结束后补读一次；保留最新状态、隐藏时撤销待补读，显式导航及可物理取消的市场查询仍可抢占。原始故障仅在再次出现时采集实际 Renderer／Main 栈继续归因，不把这一防护称为历史根因修复；证据与运行限制见 `.build/ash-playwright-mcp/connectors-validation.json`。

## SCM 普通文件点击 · 残余极端往返

- [ ] **测量** · 最终独立窗口中最慢暖点击 375.6 ms：extensionHost/invoke/read（connection 1，request 2907）客户端往返 274.3 ms，同 ID 服务端处理 0.088 ms、出站 0.040 ms，Git 请求在之后才开始且仅 3.4 ms。尚未拆清 Renderer→Main→daemon 送达与返程 decode/dispatch，不能归因扩展执行或渲染。下一步补这些边界的 method/request ID 标记，保留极值复现；本轮全部原始数据和已完成实现见[报告](.build/scm-tail-v2/report.md)。
- [ ] **checkIgnore 排队残余** · 统计读取与普通文件读取的两层共享读已完成；新 16 窗对照中 Git RPC p99 79.8→16.6 ms、资源排队 p99 77→0 ms，暖端到端 p95/p99 均通过预设稳定规则。仍有 1/960 暖点击等待 47 ms，前方三个独占 `git/checkIgnore` 请求依次完成；后续评估该路径须保留取消、写者顺序及仓库权限约束，不直接移除序列化。原始关联与完整结果见[报告](.build/scm-statistics-concurrency/report.md)。

## 2026-10-08 main 集成交接余项

- [ ] **并行开发** · `/team develop` 已有持久化和冻结工作树绑定，仍缺专用运行时、调度、review/check 执行、RPC/UI 和 SCM 落地。实现前该入口返回不可用。范围见 [Workflows](crates/ext/workflows/README.md)。
- [ ] **复核 · 浏览器集成中的 scrollbar 点击偶发失败** · 2026-10-08 完整集成 840 项通过、1 项失败，未修改的基线重复 10 次出现 5 次相同失败。调查时保留现有断言。见 [main 集成交接记录](docs/archive/ash-main-handoff-2026-10-08.md#本次实际验证)。
      2026-11-06 在 Windows 11 23H2 x64、`bd00f5e926` 使用 Chromium 复跑编辑器滚动条的显示尺寸、滚轮和轨道点击、箭头点击和长按三条用例各 10 轮，30/30 通过。历史 macOS 记录没有具体用例名，仍待复核原失败。日志位于 `.build/todo-local-acceptance-20261106/scrollbar-retry.log`。

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

- [ ] **Sessions contribution 对齐余项** · 多对话会话的目录切换还需跨 Thread 原子提交执行目标并保留各自的工作区。远程和 Provider 会话还需对接其拥有方的目录选择和授权契约。列表撤销通知需先由归档、分组和筛选各自提供可撤销操作。常驻列表提示和存储清理提示分别缺少对应的引导和清理建议生产方。

- [ ] **New Environment · Cloud** · 需要可路由的 Sessions provider 与目标发现和创建契约。

### Artifact Integrations

- [ ] **Artifact Integrations** · 对照 VS Code `0dc300b2c77` 的 `src/vs/platform/artifactIntegrations`。Changes 直接创建的 GitHub PR 已记录为会话产物。Sessions 从存储投影通用记录，按 provider／Session／产物／集成绑定操作，经显式选择调用 GitHub 合并或 GitHub 托管的自动合并。Agent 可记录 PR 产物，App Server 保存来源 Thread／Turn 和一次性的记录身份。PR Autopilot 的 CI 修复由既有 Automations owner 保存授权与运行历史，移除产物后旧身份失效。仍需通用集成注册与 provider 生命周期、手动原生动作的持久运行与结果对账、通用详情和 prompt 动作，以及真实 GitHub 测试仓库的写入与重连验收。

- [ ] **评估 · Agent Window 20px 图标字体**：可能需要按 20×20px 设计基准制作独立图标字体；后续确认适用范围、线宽与留白，并对比现有 16px 字体放大的效果，再决定实施。
- [ ] **后端前置** · 为 Agent PR 的持续合并策略与 request metadata 补后端工作流契约；当前只闭合请求提交／排队、直接创建 PR、Draft 和 auto-merge，任务提交成功不能视为 PR 已创建。

布局、工作集、Common 与 Changes 契约见 [Sessions](docs/sessions.md)。

## Chat / Speech · TODO

- [ ] **Chat widget 剩余对齐** · 对照本地 VS Code 的 `chat/browser/widget`，仍有 74 个 TypeScript／CSS 同路径差异。回复的 Turn 文件可行内预览或打开完整变更，Markdown Git diff 可逐文件切换。问题和权限确认、计划列表、进行中状态、推理标题、检查点按钮与工具调用摘要已有独立部件。MCP 输出重挂载会恢复尺寸。此前已接入 Code Review 引用、模型选择控制器和 Sessions 共享工具目录，并归位排队重排、归档只读提示、工具结果、MCP 登录、代码出处、工作区文件变更、输入介绍和编辑器显示配置。模型选择器已复用供应商图标、速度选项和推理档位逻辑，扩展安装审批可跳转到 Extensions 搜索。会话输入区可展开当前检查点的文件变更并审查单个文件，聊天文件链接支持编辑器关联。MCP 启动提示需先由服务暴露可观察的启动状态。

- [ ] **Ash 产品 · 补齐聊天行内文件图标** · 下载链接已经由 Ash 的共享聊天渲染器处理。Word、Excel、CSV 和 PDF 已用彩色图标，TXT、压缩包和源代码文件仍显示通用文件图标。在 Ash 复用现有的文本、归档和代码图标，按文件名后缀匹配并保留通用回退。数据源继续提供文件名和可读取的引用。用同一条聊天回复验证各类文件图标、链接的可访问名称和键盘下载。

- [ ] **验收 · 听写模型最终版桌面安装** · 已撤掉开发态的一次性迁移。25 项 Rust 测试通过，空缓存已实测 Paraformer 下载、校验、加载和复用。当前 `pnpm prepare:backend` 卡在 `crates/automation/src/store.rs:101`，该处仍引用已不存在的 `AutomationSession::NewChat`。待 Automation 修复后重新构建 Ash，在空模型缓存的隔离桌面 profile 中从「设置 → 语音」安装 Paraformer，核对下载进度、安装完成后显示已就绪，以及重开设置后仍能选用该模型。通过后移除此条。

- [ ] **共享宿主前置 · widgetHosts 窗口归位** · 上游独立 Chat 窗口沿 `chatMoveActions.ts` 进入公共 `browser/parts/editor/auxiliaryEditorPart.ts` 与 titlebar，Quick Chat 外框由 Quick Input 承担。迁移本地 `widgetHosts/chatAuxiliaryWindow.ts` 及其样式前，先闭合非编辑器 Chat／Cowork 组件在公共窗口中的挂载、焦点、置顶、关闭归还和释放契约；现有 `ITitleService.createAuxiliaryTitlebarPart` 要求编辑器分组，不能用虚构分组或转调壳承接。`widgetHosts/media/chatQuick.css` 的外框迁移也先补公共 QuickWidget 外框 owner，保留 Chat 自身的标题与内容布局。随后迁移真实调用方并验证同一组件／草稿与关闭归还。

- [ ] **验收前置 · 上游同场景对照** · Ash 当前命令提示、补全、链接及快照已取得 86 项定向回归、2 项链接补验和 Windows Desktop 两个自托管场景的通过证据，范围见 `docs/chat.md`。Actions 的移动命令、工作区选择入口及四个内置 context 来源已完成本地迁移，128 项上下文界面回归、36 项最终定向测试和 macOS Electron 键盘流程通过。后续听写显式注册、New Chat／Helpful 命令契约与 Find 行为已通过本地定向测试，新的 New Chat ID 及附件键盘流程也通过 macOS Electron 自托管。 本轮三个诊断命令、Agent 窗口目录服务装配及日志导出共享入口已通过 IDE／Agent Window 两个 Electron/App Server 场景。本轮插件管理入口及 New Chat 的共享注册／窗口焦点委派通过 89 项定向测试和两个 Desktop 场景。只读 VS Code 源码的测试产物已由其原编译工具补齐，官方 Chromium runner 的 105 项 actions／插件入口测试通过；上游真实桌面的 Plugins 查询、重复打开、搜索焦点及未发送草稿四项语义也已补验。其内置 GitHub／Emmet／Git 扩展产物仍不齐，这组通过结果不覆盖插件安装、授权或 marketplace。仍需对 `chatMoveActions`、`chatExecuteActions`、`chatContext`、`chatNewActions`、`chatTitleActions`、`chatFindActions`、`chatSpeechToTextActions`、`chatDeveloperActions` 的完整界面场景复核输入、焦点／选区、换行和主题；完整上游 API／UI 对齐验收仍未完成。
- [ ] **PromptSyntax 剩余能力（用户已确认六类均需要）** · 已实现 Skill／Agent／Instructions 的原生 schema 编辑、引用补全与跳转、正文原生文件引用补全、Quick Fix、Agent／Instructions 文件创建与角色管理、保留来源及 digest 的 Skill 执行、从当前已保存 Agent 打开草稿并正常发送，以及项目 Instructions 的审阅导入与后续加载；这些链路已有中英文 Ash 自举与定向回归。已接入用户级 Claude／Codex Instructions 导入、Agent 工具列表 CodeLens 和新聊天浮层。Claude 同步 POSIX PreToolUse 命令可审阅后导入为禁用，重复来源可识别，后端执行继续使用原 Hook 权限。本轮按 Ash 原生范围继续，第三方 harness Hook 兼容与迁移暂缓。原生剩余项包括扩展来源作者契约、模型引用的目录校验（已接入目录补全和引用格式校验）、工具集编辑、通用改写和 URL 入口。当前 Markdown 已可另存为原生 Agent 或 Instructions；逐条沿原 owner 实现并验收，不能以补文件计完成。范围与现状见 [promptSyntax 目录对应](docs/chat.md#promptsyntax-目录对应)，跨产品同场景复核仍待执行。

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

## 多文件审阅 · WebGPU

- [ ] **Ash 产品 · WebGPU 渲染演进** · 沿现有 `src/ash/editor/browser/gpu/` 的 `ViewGpuContext`、字形图集和可见区渲染接入多文件审阅，先验证可见文本与差异背景这一切片。继续复用 TextModel、DiffModel 和现有虚拟布局，编辑仍进入现有完整编辑器；保留 DOM 无障碍视图、键盘选择／复制、主题与高对比度，以及设备丢失或不支持 WebGPU 时的 DOM 回退。以冻结的真实仓库代码改动对照完整编辑器，覆盖快速反向滚动、遍历全部文件、进入编辑、未保存内容、Undo／Redo、保存与 Git 刷新；分别记录输入到可见更新、帧分布、图层／绘制和 GPU 资源，明确冷暖状态。当前原生预览使用 DOM，浏览器 GPU 合成启用不代表此项已完成；本轮真实负载证据保留在 `.build/ash-playwright-mcp/multidiff-real/`。

## Desktop 启动性能 · TODO

- [ ] **Windows 首启** · Setup 已预置后端包，本地 Code 工作台已拆分协议协商和服务就绪。冷启动复用安装时的 Electron 验证结果，扩展和语言服务在启动子进程时仍校验文件摘要。打包版已授权工作区各五轮，身份检查中位数从 647 降至 347 毫秒，目录准备从 1.11 降至 0.73 秒，端口到完整初始化从 1.54 降至 0.93 秒，启动到首次保存从 5.53 降至 4.78 秒。Windows 打包已预先合并主进程模块。原生安装对照各一次，主进程应用模块加载从 4.14 降至 1.46 秒。重新编译 Setup 后的原生新安装验证中，首个窗口在 2.95 秒创建，空工作台在 8.75 秒就绪，之后打开新工作区到首次保存为 6.34 秒。后续已并行启动渲染端连接和贡献注册，并将远程 Agent Host 实现和探测移出初始加载。同一路径的打包版对照使用预置配置并逐轮重启后端，各五轮首个命令中位数从 2.22 降至 2.12 秒。新配置对照各两轮，改动后首个命令为 4.07–4.27 秒，其中端口到完整初始化为 2.57–2.66 秒。本地 F1 和原生目录选择已从完整 `initialize` 中解耦。暂停初始化时验证了选择目录，恢复后在原窗口授权和保存。新版 Setup 原生首装一轮，首窗 2.88 秒、F1 搜到打开文件夹 5.53 秒、App Server 完整初始化 8.13 秒、工作台恢复 9.16 秒。剩余工作是缩短首次开窗后的本地贡献加载和后台冷初始化。该轮贡献导入耗时 1.92 秒，端口到完整初始化耗时 3.22 秒。原始数据在 `.build/startup-trace/windows-installed-20261105/` 的 `ready-{baseline,candidate,native-install}.json`、`empty-native-{modules,bundle}-probe.json`、`empty-final-native.json`、`renderer-progressive-matched{,-fresh}.json` 和 `local-startup-native.json`。
- [ ] **评估** · 基于已采集的入口清单和四组 CPU 证据，验证选定语言资源的惰性加载生命周期；候选需比较静态 JS、首次功能成本及四组重复启动，不凭 87.6% 静态语言资源占比宣称启动收益。
- [ ] **复核** · 旧启动诊断的部分 F1 失败仍未复现、未归因。当前 macOS 激活原生窗口的 F1／命令列表／Escape 焦点恢复回归已通过；名义 hidden 对照在观测时也实际可见且有焦点，不能据此认定隐藏窗口导致旧故障。保留历史失败产物及新的焦点／键盘到达记录，继续核对旧批次的条件；范围见[启动复核](docs/desktop-startup.md#2026-10-18-f1-本机复核)。

### Windows 首用基线与 Zed 对照

Windows 11 22631、i5-12600KF。Ash 使用打包 `dev-small` 和隔离配置。已授权组保留操作系统文件缓存，表中为五轮中位数，单轮和两轮另行标明。Ash 用 Playwright 观察正文和编辑焦点，再输入并核对落盘字节。Zed 1.26.2 用原生窗口输入探针，以实际保存的内容回溯首次接受输入。两种探针的开销和判定点不同，目标是达到同机 Zed 的约 0.4 秒可编辑、0.8 秒落盘量级，验收前先统一探针。

| 场景                                                                             | 发起操作到可用                                                                                                                               | 证据                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Ash 已授权本地 `.txt`，每轮停后端，编辑器与窗格解耦前 → 后                       | 首窗观察 0.442 → 0.474 秒，正文 2.518 → 2.601 秒，可编辑 2.533 → 2.655 秒，首次保存 2.759 → 2.871 秒                                         | `startup-deep-editor-gate-ab-preauthorized.json`       |
| Ash 已授权本地 `.txt`，同一目录索引构建，停后端 → 复用后端                       | 可编辑 2.705 → 2.355 秒，首次保存 2.929 → 2.581 秒                                                                                           | `startup-deep-ed-mix{,-warm-daemon}.json`              |
| Ash 已授权，普通文件夹／含 Git 工作区，同一轮目录优化后的构建                    | 首正文 2.572／4.312 秒，首次保存 2.851／4.567 秒                                                                                             | `startup-deep-directory-summary.json`                  |
| Ash 已授权普通目录，停后端，Git 同步发现 → 按需发现                              | 首正文 2.779 → 2.627 秒，可编辑 2.846 → 2.681 秒，首次保存 3.132 → 2.930 秒                                                                  | `startup-deep-git-first-use-current-ab-retry.json`     |
| Ash 已授权 Git 仓库，停后端，Git 同步发现 → 按需发现                             | 首正文 3.779 → 3.573 秒，可编辑 3.794 → 3.588 秒，首次保存 4.015 → 3.805 秒                                                                  | `startup-deep-git-first-use-current-git-ab.json`       |
| Ash 已授权本地 `.txt`，停后端，关闭编辑器恢复，完整目录等待 → 优先交付编辑器声明 | 首窗观察 0.447 → 0.442 秒，首正文 2.510 → 2.511 秒，可编辑 2.534 → 2.555 秒，首次保存 2.772 → 2.786 秒                                       | `editor-declarations-ab-summary.json`                  |
| Ash 已授权本地 `.txt`，停后端，开启编辑器恢复，完整目录等待 → 优先交付编辑器声明 | 首窗观察 0.445 → 0.436 秒，首正文 2.510 → 2.469 秒，可编辑 2.552 → 2.492 秒，首次保存 2.784 → 2.792 秒                                       | `editor-declarations-restore-ab-summary.json`          |
| Ash F1 搜到打开文件夹，打包版预置配置／新配置                                    | 预置配置 2.119 秒，新配置 4.067–4.268 秒（两轮）                                                                                             | `renderer-progressive-matched{,-fresh}.json`           |
| Ash 原生 Setup 首装空窗，两次独立单轮                                            | 首窗 2.881 秒、F1 5.531 秒、完整初始化 8.127 秒、工作台恢复 9.156 秒。另一轮空工作台 8.749 秒就绪，从已开的空窗选新工作区到首次保存 6.337 秒 | `local-startup-native.json`、`empty-final-native.json` |
| Zed 已授权本地文本，每轮退出 Zed                                                 | 首窗 0.378 秒，可编辑 0.378 秒（0.355–0.451），首次保存 0.818 秒（0.797–0.940）                                                              | `zed-native-reference.json`                            |

从源码看，Zed 的本地 `BufferStore` 直接向本地 `Worktree` 读文件，在应用后台执行器创建文本缓冲。扩展宿主启动时读已有索引，过期后在后台重建。Ash 首文件经过 Electron、carrier、managed App Server 和 Workbench 恢复。Zed 各内部阶段的实测耗时仍待采集。[Zed 本地文件路径](https://github.com/zed-industries/zed/blob/fda552edce4ab52373ebaaff168bd7417bd8010b/crates/project/src/buffer_store.rs#L690-L727) · [Zed 扩展索引](https://github.com/zed-industries/zed/blob/fda552edce4ab52373ebaaff168bd7417bd8010b/crates/extension_host/src/extension_host.rs#L410-L455)

### 首文件在等什么

以下阶段以编辑器与窗格解耦后的 `.txt` 冷后端五轮为基线，另标不同批次。端到端由测试进程计时，阶段由各自进程计时。carrier 可在 Renderer 请求端口前启动，目录及校验也有父子跨度，各行和子项分别读，不能累加成总耗时。

| 路径与归属                              | 已测到的等待                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron Main 和 Renderer 入口          | 首窗观察 474 毫秒（435–539），首窗到可编辑 2181 毫秒。Renderer 从 splash 到开始取端口 315 毫秒。历史原生首装单轮 Main 模块合并前后为 4.135 → 1.464 秒，另一轮首装 Renderer 本地贡献导入 1.921 秒。当前首窗前的 Windows 映像加载与 Main 执行占比待拆。                                                                                                                                                                                             |
| Renderer／Main 连接                     | 取端口 23 毫秒，有一轮 176 毫秒。端口交付到协议协商完成 261 毫秒，协商完成到初始化确认 188 毫秒，端口交付到初始化确认共 449 毫秒。原生首装单轮同一后半段为 3.225 秒。                                                                                                                                                                                                                                                                             |
| Rust carrier 与 managed App Server 启动 | 打包版 carrier 的 `connect` 入口先按安装摘要验证后端，141 毫秒。选定进程身份的 `executable-identity` 349 毫秒，包含后端 SHA-256 170 毫秒和 Electron SHA-256 171 毫秒。启动并等待 managed App Server 229 毫秒，创建进程 8 毫秒、操作锁 1.4 毫秒、daemon probe 约 0.1 毫秒。后端自己的 `managed-bind` 131 毫秒，其中发布身份前自校验约 119 毫秒。                                                                                                   |
| Rust 工作区准备和协议处理               | `directory-open` 185 毫秒，其中服务构造 36 毫秒、工作区装配 107 毫秒。Git 发现占该装配 80 毫秒，初始目录打开及授权检查约 0.7 毫秒。历史 Git 工作区对照目录打开 553 毫秒，其中 Git 发现 393 毫秒。复用后端时目录打开约 1.3 毫秒，冷后端的 `initialize` 处理约 2.5 毫秒。                                                                                                                                                                           |
| 扩展目录与 Renderer Workbench           | 初始化确认到 shell 就绪 303 毫秒，shell 到工作台完全恢复 622 毫秒。Rust 内置目录 173 毫秒。拆窗格前的配套打点显示，窗格完成后到声明目录提交仍有 350 毫秒（332–386），从工作区配置就绪算起为 255 毫秒，之后到服务贡献就绪约 43 毫秒。历史 54 包扫描中，枚举 45、文件身份与元数据校验 167、读取 55、哈希 20 毫秒，目录锁最大约 0.2 毫秒。可校验的小型索引把 Rust 目录从 311 降至 162 毫秒，同组可编辑 2.850 → 2.705 秒，首次保存 3.102 → 2.929 秒。 |
| 编辑器输入和保存                        | 拆窗格前的空草稿样本中，开始恢复编辑器到草稿恢复结束约 2 毫秒。暂停窗格的单轮仍在 2.527 秒可编辑、2.738 秒落盘，普通窗格已不再是首文件的必要等待。最新五轮可编辑到确认落盘为 223 毫秒，包含测试输入及读盘轮询，文件读写、保存前检查点和 UI 焦点尚缺各自的端到端配对。                                                                                                                                                                             |

Git 首次发现已由 watcher 或首个 Git 查询接手。使用同一 Electron、前端、carrier、协议和授权条件的打包对照，普通目录的同步 Git 发现从 91 毫秒降到约 0.06 毫秒，`directory-open` 从 204 降到 109 毫秒。小型 Git 仓库对应为 342 → 0.06、451 → 111 毫秒。Git 组从保存后打开 SCM 到看到已修改文件为 979 → 975 毫秒。两个场景每个变体各五轮，正式样本均通过。SCM 观察在首文件保存后进行。

扩展声明目录先交付已校验的编辑器关联、语言识别、配置和键位。当前配色与编辑器恢复同步，其他配色、图标、snippet 和语言配置资源在后台加载。打包版暂停扩展资源读入时，普通文本使用了工作区配色，保存时按工作区配置移除尾部空格并补齐换行。Markdown 自定义预览在完整重启后恢复未保存草稿，并在资源仍暂停时成功落盘。证据为 `editor-declarations-held-save.json`、`editor-declarations-held-draft.json`。

拆分前后使用相同的 Electron 和 Rust 二进制、授权目录、配置及硬件 GPU。每组各五轮，交替启动。关闭编辑器恢复的普通文本组中，Renderer 等扩展目录快照为 578 毫秒，之后校验、本地化与声明注册为 206 毫秒。主题启动 284 → 262 毫秒，shell 到编辑器就绪 610 → 538 毫秒。后台扩展资源耗时 436 毫秒。候选包的 carrier 可执行文件身份确认 337 毫秒，等待 managed App Server 启动 230 毫秒，工作区打开 115 毫秒，协议 `initialize` 处理 3.2 毫秒。这些计时有重叠。两组的首文件可编辑和首次落盘区间均重叠。逐轮数据为 `startup-deep-git-first-use-editor-declarations-{plain,final}-ab.json`，其中 `final` 为开启编辑器恢复组。

对照已跑过硬件／软件合成（可编辑 2701／2656 毫秒，保存 2924／2884 毫秒）、编辑器 WebGPU 开／关（2674／2730、2891／2912 毫秒），样本范围重叠。主题校验复用和小资源内联原型已撤回。小资源内联将首文件前的资源打开、读取和释放请求从 434 降到 158，可编辑却从 2632 到 2701 毫秒，首次保存从 2879 到 2908 毫秒。原始证据根目录为 `.build/startup-trace/windows-installed-20261105/`，阶段与实验汇总为 `declarative-catalog-and-zed-summary.json`、`startup-deep-directory-summary.json`、`startup-rust-gpu-ab-summary.json` 和上表的同批样本。

### 专项优化

- [ ] **首文件声明目录剩余开销** · 分开测量前台清单验证、本地化、声明注册和当前配色资源。验证可校验索引能否直接提供首文件所需的编辑器关联与保存配置，以及切换工作区时目录代次与配置能否一致更新。随包 JSON Worker 已按语言激活。
- [ ] **Windows 首窗与 Rust 冷启动** · 继续拆分系统加载、Main 入口及 Renderer 首批脚本。已实现同一已验证安装代次的子进程摘要复用，覆盖替换、伪造与失败路径；停后端连接五轮中位数 559 → 423 毫秒，验证与范围见[摘要复用](docs/desktop-startup.md#2026-11-14-windows-后端启动摘要复用)。Git 首次发现已完成普通目录与单仓对照，多仓工作区和开窗后立即进入 SCM 的成本待测。
- [ ] **Git 冷启动计时的退出异常** · 定位本轮改动版通过 CDP `Browser.close` 退出时两次出现的 `0x80000003`，采集 Main 原生栈并核对窗口关闭握手。同一失败配置回切原版三次通过，改动版通过产品关闭窗口动作三次通过；这些结果尚不能解释两个入口的差异，失败批次不计有效提速对照。原始失败、复用配置与命令见[第二轮验证](docs/desktop-startup.md#第二轮启动优化与回切验证)。
- [ ] **首文件与首次保存尾段** · 配对记录启动文件交付、首读 RPC、编辑器构造、焦点到首个输入、备份检查点、首写 RPC 和落盘确认。分开队列等待、后端处理和测试轮询。保留曾拒绝草稿写入的 `ServerOverloaded` 样本，记录请求阶段和并发负载后复现。
- [ ] **统一基准探针** · 两个应用用同一个 Windows 输入与磁盘观察器跑同一份本地文本，记录首窗、首个被接受的键盘输入、首次落盘。Ash 另测首个 F1 命令和授权后打开目录。原生新装、新配置首次授权、已授权停后端、复用后端、Git 工作区分组，基线和候选各至少五轮，保留每轮数据和失败。2026-11-14 已完成 Ash／VS Code 各五轮 CDP 输入与落盘对照；原生对照仍受阻：VS Code 窗口无法获得前台，Zed 冷启动轮没有输入落盘证据。待在能完成原生交互的会话中复核，不与历史 Zed 探针混合排名；范围与有效样本见[安装准备复核](docs/desktop-startup.md#2026-11-14-安装准备与进程冷启动复核)。

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

## Chat accessibility · 缺失宿主入口

- [ ] **前置** · `src/ash/workbench/contrib/chat/browser/accessibility/` 已接入消息标签、响应纯文本视图和 Chat 信号 owner；37 项定向测试与 1 项 Desktop 自托管场景通过。上游对应的 `chatTerminalOutputAccessibleView.ts`、`chatBackgroundShellOutputAccessibleView.ts`、`chatPetJumpGameAccessibleView.ts` 尚无 Ash 生产入口：缺少终端工具输出的焦点／内容契约、后台 Shell 输出视图和宠物游戏 owner。先闭合各自真实宿主及焦点恢复契约，再在对应路径接入 Accessible View 并验证键盘、内容更新和释放；不提前创建无调用方文件。
