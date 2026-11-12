# 待办

按功能记录已选范围内尚未完成或缺少通过证据的工作，完成后移除。2026-10-18 以 Ash `e323c7bcb` 对照本地 VS Code `a2acc8c864a`，源码核对集中于 Terminal、Preferences、Workspace、Sessions 与 Speech／MCP App 入口的公开契约、生产调用及相关测试；其他领域按已有记录分类。上述清单审查未重跑历史验收；后续完成项以各领域的验证记录为准，不将源码存在当作行为通过。

任务标签：**可做**表示已能定位现有入口与 owner，可选择一个行为切片实施；**后端前置**表示须先闭合领域或宿主契约；**布局前置**表示须先补齐布局 owner 的位置或移动契约；**复核**表示还需确认具体消费者或复现旧问题；**验收**表示缺真实环境证据；**测量**表示先取得数据；**Ash 产品**表示独立产品需求，不能按 VS Code 是否存在来删除。可选增强统一放在文末的[发展候选（未排期）](#发展候选未排期)，不计入当前交付待办。

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

## Terminal · 滚动命令的渲染就绪边界

- [ ] **修复候选 · 终端冷加载期间的滚动命令**：`src/ash/workbench/contrib/terminal/browser/terminalActions.ts` 的六个滚动命令在 active instance 已有 screen 且未 disposed 时直接读取 `screen.raw.buffer`；但 `terminalInstance.ts` 在异步 `initialize` 前就暴露 screen，而 `xterm/xtermTerminal.ts` 的 `raw` 在模块加载完成前会抛错。参考 [VS Code 在 renderer 附着前保护终端滚动](https://github.com/microsoft/vscode/pull/339330)（2026-11-04 已合并，已包含于 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 稳定版），沿现有终端 owner 补安全的就绪检查，避免冷加载时由命令面板／命令调用触发异常。此处是静态调用链确认，尚未运行 Ash 时序复现，不宣称全部终端命令受影响。
  - 范围与前提：区分 screen 对象存在、底层 Terminal 已初始化和 renderer 已 open；恢复终端可先有缓冲而未打开 DOM，滚动命令不为就绪而强制 reveal／open。未就绪时安全返回，若选择等待则绑定原实例并重查释放／活动身份，不在异步完成后滚动另一个终端。不改 PTY、输出恢复或持久化，不额外排队；已退出和只读终端的可见历史仍可滚动，alternate buffer 保持现有边界。
  - 验收：在 `src/ash/workbench/contrib/terminal/test/browser/terminalActions.test.ts` 补 screen 已存在但 raw 尚不可用、初始化完成但恢复 renderer 未 open、等待中关闭／切换 active instance，以及正常就绪、已退出／只读和 alternate buffer 六组边界；使用受控延迟的真实初始化路径复核冷开终端时触发六个滚动命令无异常、无意外打开面板、不修改输入，原终端可见后滚动正常。不要把现有完整 fake raw 或 undefined screen 测试算作该竞态通过。

## 上下文菜单 · 原生窗口按钮避让

- [ ] **验收剩余 · 原生窗口按钮与浮动菜单**：[共享浮动菜单避让](https://github.com/chogng/ash/commit/d25ce1a8a0fd7458cef050b4c361b772d9a467e3) 已在 `src/ash/base/browser/ui/contextview/contextview.ts` 接入目标窗口可见 WCO 几何及 `geometrychange`，由 `windowControlsOverlay.ts` 先向下、再横移、最后按视口回退；子菜单沿既有 ContextView 复用。原“只按完整 viewport 定位、未消费按钮区域”的实现缺口已消除，保留原生 Windows 主／辅助窗口的实际遮挡与点击验收。参考 [VS Code 菜单避让窗口按钮](https://github.com/microsoft/vscode/pull/345326)（2026-11-02 已合并，已包含于 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 稳定版），不重复建立另一套定位器。
  - 已有证据与边界：`windowControlsOverlay.test.ts` 覆盖左右按钮区、高菜单、偏移 viewport 与无效几何；`contextview.test.ts` 覆盖 owner window、可见性更新和隐藏后释放监听；`menu.browser.test.ts` 覆盖多级菜单、主题和键盘。浏览器 fixture 注入 WCO 几何，不能等同原生按钮命中验收；提交记录的 Electron IPC smoke／构建通过也不替代该场景。当前窗口配置证据来自 Electron `windowImpl.ts`；[Windows Rust 预览宿主已移除](https://github.com/chogng/ash/commit/34dec548b372cb61795c3d3183b30c935deb4cf1)，不再将已删除的 AppWindow／DirectComposition 实现列为本项验收目标。
  - 剩余验收：在实际 Windows 自定义标题栏，以 Activity Bar 顶部账户／管理入口右键菜单及键盘子菜单核对主窗口和弹出窗口，包含缩放、窄窗口、高菜单、全屏／system 标题栏及 WCO 隐藏或不可用；菜单不被按钮遮住且可点击，焦点、Escape 和取消保持可用。记录当前 Electron 主／辅助窗口的 API 可用性和几何来源，不新增跨宿主模拟层。[已完成的 Windows 缩放验收](https://github.com/chogng/ash/commit/0953132eeb23cef0001eeebe38dfb217df62c945) 不等同于本项菜单遮挡与按钮命中验收；未来宿主切换按其届时契约另行验证。

## Connectors 面板 · 点击后窗口无响应

- [ ] **历史现场复核** · 2026-10-21 用户随后确认点击已正常；实际开发窗口的只读检查也显示主线程响应、无活动动画、Connectors 读取已结束。隔离 Desktop 中全折叠后展开／键盘切换通过，尚未建立原先整窗无响应的故障链。潜在的状态通知请求放大已单独复现并修复：25 次通知在读取进行中不再追加 25 组读取，只在结束后补读一次；保留最新状态、隐藏时撤销待补读，显式导航及可物理取消的市场查询仍可抢占。原始故障仅在再次出现时采集实际 Renderer／Main 栈继续归因，不把这一防护称为历史根因修复；证据与运行限制见 `.build/ash-playwright-mcp/connectors-validation.json`。

- [ ] **可做 · Connector OAuth 连接取消**：`src/ash/workbench/contrib/extensions/browser/extensionEditor.ts` 的 Sign in／重新授权和 `extensionsActions.ts` 的添加连接经 `AppServerConnectorService.connectOAuth` 后没有取消入口；`src/ash/platform/connectors/browser/connectorApi.ts` 的 device 等待／轮询与 browser callback 等待不接收调用方取消。服务端已有按 flow ID 的 cancel，当前只在异常等收尾路径触达。参考 [连接详情取消](https://github.com/microsoft/vscode/pull/344192)（2026-10-26 已合并，已包含于 [VS Code 1.144.0](https://github.com/microsoft/vscode/releases/tag/1.144.0)），补齐等待授权时的退出和重试；本项为静态链路缺口，不是上述历史面板无响应的根因。
  - 范围与兼容：沿 `IConnectorService`／`IConnectorApi` 及既有 browser／device OAuth owner 传递取消，详情提供可键盘访问的取消动作，随后按最新 catalog 恢复操作；复用 `connector/connect/oauth/cancel` 与 `connector/connect/oauth/device/cancel`，关闭本次 callback 并停止本次等待／后续轮询，不撤销已完成授权或其他连接。上游只取消本地轮询，不能照搬为 Ash 的服务端保证；先核对 device poll 暂时移出 pending 与 cancel／complete 的竞争，保留 flow／generation 校验，不用隐藏 UI 代替取消。
  - 验收：在 Connector API／service、Extensions 入口及 `crates/ext/connectors/src/oauth_tests.rs`、`device_oauth_tests.rs` 和 `crates/app-server/src/server/connector_operations_tests.rs` 覆盖授权前、待 callback／轮询时取消、打开浏览器失败、关闭／切换入口、重复取消、取消与完成并发及旧结果晚到；确认停止新轮询、callback 释放、按钮与焦点恢复、不误报成功或覆盖新连接。正常成功、重新授权、过期及普通 MCP OAuth 保持回归；不承诺撤回外部浏览器已完成的授权。

## Git 推送 · TODO

- [ ] **修复候选 · 推送拒绝的稳定分类与恢复提示**：当前 `crates/app-server/src/server/request_processors/git.rs` 已保留有界 Git 命令诊断，`extensions/git/src/api.rs`／`commands.rs` 已提供单行错误、打开 Git 日志及只读命令输出，不能再列为“只能显示泛化失败”；参考 [Ash 诊断接线](https://github.com/chogng/ash/commit/e17eb2d3c9116cf9b45c4a569727f8b6ea3307d0)与[输出查看入口](https://github.com/chogng/ash/commit/e20fc992a2013b42e79f2257acd3e7be7fdd90c1)。剩余候选是 `crates/git/src/remote.rs` 的 reviewed push 仍未提供经核实的 non-fast-forward／fetch-first 类型化结果；参考 [非快进推送拒绝提示](https://github.com/zed-industries/zed/pull/47296)（2026-10-27 已合并，已包含于 [Zed v1.27.0](https://github.com/zed-industries/zed/releases/tag/v1.27.0) 稳定版），先确认机器可读结果契约，再由执行 owner 窄分类，沿既有协议补充先获取、审阅并整合远端变更后再推送的恢复方向。本轮仅静态复核，不标为完成。
  - 范围与风险：保留现有一般诊断及用户选择的日志／只读输出入口，不重做通用错误展示层；类型化判断不依赖任意自然语言子串，不把认证、网络、hook 或 lease 拒绝误认作分支落后。未知结果保持既有回退，新分类与本地化恢复提示不增加原始 stderr、含凭据 URL 或路径披露；检查现有诊断边界但不扩大输出采集或持久化范围。不自动 fetch／pull／rebase／force-push／重试，保持 reviewed commit／upstream、权限、取消及失败后状态刷新。
  - 验收：在 `crates/git/src/remote_tests.rs`、`crates/app-server/src/server_tests.rs` 与 `extensions/git/tests/host.rs` 扩展受控 remote 的 diverged／fetch-first、成功、认证／hook／lease 拒绝、取消、未知格式和部分 ref 成功场景；核对分类与本地化恢复提示不泄露新增敏感信息，目标远端／ref 不变且无额外自动操作。复用现有扩展进程反馈测试，保持状态先落定、取消静默、只提示一次、日志与只读输出查看可用，并覆盖本地／SSH 及适用平台；现有合成一般错误测试不等同于推送拒绝分类验收。

## Git 未合并状态识别与解决入口 · TODO

- [ ] **修复候选 · AA／DD 冲突识别**：`crates/git/src/working_copy.rs` 的 `parse_unmerged` 读取 porcelain-v2 的 `u` 记录后，仅保留 XY 两列；`is_conflicted()` 只判断是否含 `U`，因此 `AA`／`DD` 被判为非冲突。`crates/app-server/src/server/git_runtime.rs` 将此结果写入状态 DTO，`extensions/git/src/scm.rs` 与 `extensions/git/src/changes.rs` 据此分组和选择解决入口，App Server 的冲突读取／完成接口也要求该判断为真。参考 [Zed 未合并状态解析回归](https://github.com/zed-industries/zed/pull/66648)（2026-11-11 已合并 main，稳定 v1.28.1 尚不包含），在现有 Git 状态 owner 保留权威未合并身份并接回既有解决流程；Ash 的问题是冲突身份丢失，不是照搬上游 `DD` 两侧元数据修正。本项由静态调用链确认，尚无 Ash 运行时复现。
  - 范围与风险：保留两侧 Added／Deleted 等状态，不把所有双列变化都判为冲突；同时核对 `crates/git/src/working_copy/content.rs` 对 stage 2／3 同时缺失的拒绝，合法 `DD` 可只有 stage 1，不能仅修分组后仍无法读取。沿既有显式解决操作、仓库锁、stage ID／结果版本校验处理删除结果，不新增自动解决、暂存、提交或恢复文件行为，不宣称已发生数据丢失。
  - 验收：扩展 `working_copy_tests.rs`、冲突内容／App Server 测试及 Git 扩展与 Desktop SCM 场景，覆盖全部七种未合并 XY（DD／AU／UD／UA／DU／AA／UU）、普通双列变化、add/add 与双向重命名产生的 `DD`；核对状态 DTO、Merge 分组、打开／刷新、stage 1-only 的合法缺侧与索引已清空的区别，以及显式解决后的 index 状态。保留脏编辑、外部 Git 改写、旧 stage ID／结果版本、取消和部分暂存保护，确认未解决时不落入普通变更动作；真实 Git／Desktop 通过前不标完成。

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

## Ash Code · `/fork` 拒绝时保留草稿

- [ ] **修复候选 · `/fork` 本地校验拒绝不消耗草稿**：`crates/tui/src/thread/composer/input/state.rs` 的普通提交和活动任务队列入口，对本地命令先清空输入及附件，再交给 `crates/tui/src/app/state.rs` 校验；运行中拒绝 `/fork` 或 `text_arguments()` 拒绝图片等非文本参数时，当前草稿已不再可编辑。纯文本虽进入输入历史，带附件的提交不会记录到该历史，不能以历史恢复替代保留完整草稿。参考 [Codex 在消耗草稿前校验 fork](https://github.com/openai/codex/pull/58767)（2026-11-01 已合并；尚未包含于当前稳定版 [0.167.2](https://github.com/openai/codex/releases/tag/rust-v0.167.2)），先闭合本地校验与草稿消耗的顺序。本项为静态调用链确认，未运行端到端复现，不将其描述为持久文件或历史会话丢失。
  - 范围与风险：仅修现有 `/fork` 提交链，复用 composer 的完整 draft／附件绑定；本地拒绝后保留文本、光标、附件占位及后续编辑能力，校验通过后仅消耗一次。保持运行中禁止 fork 和只接受文本参数的现有规则，不顺带允许图片／Skill、放宽状态门禁或移植 Codex 的 MCP／side-conversation 产品语义。不要把已发出的 RPC 失败自动恢复为可重试 fork，避免结果未知时重复创建会话；其他 slash 命令及普通 queue／steer 行为保持回归。
  - 验收：扩展 `crates/tui/src/app/state_tests.rs` 的 `fork_rejects_image_arguments_before_session_creation`，并在 composer submission 测试覆盖空闲非法附件、运行中纯文本／带附件拒绝、修正后再次提交和成功清空；断言拒绝不产生 SessionCommand、不调用 fork RPC、草稿和附件绑定保持且可继续编辑，纯文本历史不重复。覆盖 Inline／Fullscreen 与取消任务后再次提交；保留 `crates/tui/src/sessions/completion_tests.rs` 中成功 fork 不切换当前会话、无 prompt 不启动任务、有 prompt 仅启动一次的既有语义。

## Ash Code · 粘贴路径的图片探测

- [ ] **修复候选 · 非普通文件路径粘贴不阻塞输入**：`crates/tui/src/thread/composer/input/state.rs` 在粘贴处理中同步调用 `attachments.rs` 的图片探测；后者先 `File::open` 再检查已打开文件的 `is_file`，无写入端的 FIFO 可在检查前等待。参考 [粘贴图片路径的普通文件门禁](https://github.com/openai/codex/pull/57774)（2026-10-28 已合并，已包含于 [Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)），在打开探测前排除已知非普通文件，使其仍作为可编辑文本粘贴。本项为静态调用链确认，未运行 Ash FIFO 复现；不泛化为所有慢文件系统均不会阻塞。
  - 范围与风险：仅调整现有图片探测 owner，不改变纯文本、路径引号／转义、图片签名、16 MiB 限制或附件原子编辑语义；保留打开后的类型校验。明确符号链接的目标文件语义，不能将路径预检声称为消除检查与打开之间的替换竞争；若要保证该竞争下也不等待，须另核实适用平台的安全打开方式。非普通文件不读取内容、不升级为图片错误提示，不引入后台任务或全局文件读取重构。
  - 验收：在 `crates/tui/src/thread/composer/input/attachments_tests.rs` 及真实粘贴事件链补隔离、带硬超时的 Unix FIFO（无写入端）、目录、普通非图片和图片场景，覆盖带引号／空格／非 ASCII 路径、符号链接、缺失与不可读路径；FIFO 路径应保持文本且可 Backspace／继续输入，正常图片仍生成相同附件，超限与失败提示保持原约定。记录 Unix 平台范围；不使用真实串口或用户文件做破坏性测试，Windows 保持现有普通文件行为并核实对应特殊路径策略。

## Ash Code · 终端兼容性

- [ ] **修复候选 · 旧 VTE 的终端状态输出门禁**：`crates/tui/src/terminal/session.rs` 对交互终端直接调用 `program_status.rs` 输出 OSC 7501，尚未区分已知不兼容的 VTE 后端；`crates/terminal-detection/src/host.rs` 优先识别 GNOME 等应用身份，不能可靠保留同时存在的 `VTE_VERSION`。参考 [旧 VTE 状态协议门禁](https://github.com/openai/codex/pull/57612)（2026-10-28 已合并，已包含于 [Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)），为已知低于 0.54 的 VTE 后端禁用该状态序列，减少旧 Linux 终端误解析为可见文本的风险。本项为静态兼容缺口，未在真实旧 VTE 复现；不是所有未知终端均安全的保证。
  - 范围与前提：在现有 terminal-detection owner 保留独立于应用身份的后端版本信息，明确 VTE_VERSION 的优先级与空／畸形值规则，不以 GNOME 应用版本冒充 VTE 版本；仅门禁 Ash 已有 OSC 7501，不引入上游 OSC 21337、不全局关闭语音或扩张终端架构。较新／未知版本保持现有策略，未知值不伪造支持结论；保留内置终端的状态与 dictation 能力、非 TTY 抑制和现有失败重试行为。
  - 验收：在 `crates/terminal-detection/src/host_tests.rs`、`crates/tui/src/terminal/program_status_tests.rs` 与 session 测试覆盖 GNOME／其他应用身份同时有 VTE_VERSION、5399／5400 边界、空值／畸形／缺失、应用版本冲突及 multiplexer；已知旧 VTE 的 set／clear／挂起／退出均不写状态序列，较新／未知版本保持约定输出，flush 失败后的重试与刷新不失效。补真实旧 VTE 无状态乱码及受支持终端的状态／dictation 回归，记录 Linux 范围并确认 macOS／Windows 不受误判。

## AgentHost · TODO

- [ ] **修复候选 · 保留 Provider 流错误的稳定分类**：沿 `crates/ash-api/src/requests.rs`、endpoint decoder、`crates/app-server/src/model_provider_error.rs` 到 `crates/core/src/turn/executor.rs` 核对以下独立缺口，避免将可诊断的失败降为通用无效响应。既有配置／认证／限流提示已存在，不重复建设错误展示层；以下依据静态调用链，尚未运行真实端点验收，各出处的合并与发布状态分别标注。
  - **Chat Completions 错误帧**：`crates/ash-api/src/sse/openai_chat_completions.rs` 未识别 `error` envelope，无 `choices` 时直接忽略；若随后结束或只有 `[DONE]`，错误会变为缺少终态的 `InvalidResponse`。参考 [流错误分类保留](https://github.com/zed-industries/zed/pull/66038)（2026-10-23 已合并 main，已包含于 [Zed v1.27.0](https://github.com/zed-industries/zed/releases/tag/v1.27.0) 稳定版），在普通 chunk／usage 处理前识别经确认的错误帧并接回已有分类入口，不照搬上游类型装箱修复。Core 对无效响应只立即重试一次，而 transient 有等待及独立重试预算；须让额度／认证错误终止并给出正确恢复方向、过载沿原 transient 策略处理，而非一概关闭重试。
  - **Responses 模型不可用代码**：`requests.rs` 仍按正文子串识别，裸 `model_not_found` 从 `error`／`response.failed` 落为 `InvalidResponse`，同样可能多发一次请求；HTTP 403 则在读取该代码前归为认证错误。参考 [模型不可用终态错误](https://github.com/openai/codex/pull/56445)（2026-10-23 已合并，已包含于 [Codex 0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0)），优先识别可信协议结构中的精确 code，并沿现有稳定错误契约给出更换模型／检查模型访问的恢复方向，不凭自然语言子串推断、不自动切换模型。HTTP 400／404 与含 `invalid_request_error` 的现有路径本已不可重试，不能把所有模型不存在都描述为重试缺陷；未知 403 仍保留原认证语义。
  - **Responses 预算耗尽代码**：当已配置的 Responses 端点实际返回精确 `budget_reached` 流错误且未同时命中现有额度／无效请求正文分类，也会沿 `error`／`response.failed` 落为 `InvalidResponse` 并立即重试一次。参考 [预算耗尽终态分类](https://github.com/openai/codex/pull/59228)（2026-11-03 已合并；尚未包含于 [Codex 0.167.2](https://github.com/openai/codex/releases/tag/rust-v0.167.2)），在同一精确 code 分类入口保留不可重试结果与有界提示，不新增错误架构、不自动换模型或推断额度恢复时间。HTTP 400 的现有路径本已不可重试；含 `usage_limit`／`insufficient_quota`／`invalid_request_error` 等已命中分类的正文不算本缺口。此项为静态协议与调用链核对，未断言真实端点已发生故障。
  - **Responses 内容策略拒绝代码**：当已配置的 Responses 端点实际返回精确 `content_policy_violation` 流错误，且正文未命中现有认证／额度／无效请求等分类时，`requests.rs` 仍将其降为 `InvalidResponse`，Core 会立即再调用一次。参考 [内容策略拒绝终态分类](https://github.com/openai/codex/pull/60479)（2026-11-10 已合并 main，尚未包含于 [Codex 0.167.2](https://github.com/openai/codex/releases/tag/rust-v0.167.2)），在同一精确 code 分类入口保留不可重试终态并给出有界、脱敏的拒绝提示，避免自动重发相同请求；不自动改写输入、换模型或绕过端点策略。HTTP 400 的现有路径本已不可重试，不算本缺口。本项为静态协议与调用链核对，未断言真实端点已发生故障。
  - **范围与验收**：在 `crates/ash-api/src/sse/openai_chat_completions_tests.rs`、`crates/ash-api/src/endpoint/responses/events_tests.rs` 和 `crates/app-server/src/model_provider_error_tests.rs` 补受控错误帧与完整 Core 调用次数断言；覆盖错误出现在首帧／部分输出之后、缺少／附带 `[DONE]`、普通 usage-only 帧、嵌套 `response.failed`、SSE／WebSocket 共用解码、400／403／404、取消、未知或畸形错误。额度／认证／已确认模型不可用不额外调用，过载仍按预算等待，终态与历史恢复提示一致；保留既有上下文溢出处理、错误正文截断和脱敏，不把原始 provider 正文直传 UI 或新增账号／provider 抽象。补精确 `budget_reached` 的顶层／嵌套错误帧、部分输出后失败、携带 retry-after 后跟 completed、已有额度／无效请求正文命中及 HTTP 400 场景，断言终态不多调用模型；未知 code 与正常 transient 的原重试策略不变。补精确 `content_policy_violation` 的顶层／嵌套错误帧、部分输出后失败、携带 retry-after 后跟 completed、空／缺失提示及 HTTP 400 场景，断言一次请求即清晰终止，不自动换模型或重写输入；未知 code、正常 transient 及既有认证／额度分类保持原策略。

- [ ] **修复候选 · 兼容 Chat Completions 的结构化流内容**：`crates/ash-api/src/sse/openai_chat_completions.rs` 仍把 `delta.content` 限定为字符串，已启用 native streaming 的 OpenAI-compatible 端点遇到 text/thinking 数组会报错；参考 [Zed 混合流适配](https://github.com/zed-industries/zed/pull/65915)（已合并 main，已包含于 [Zed v1.26.2](https://github.com/zed-industries/zed/releases/tag/v1.26.2) 稳定版），沿现有 decoder 与 terminal assembly 支持经确认的结构化内容，保持思考与正文分离。不新增 provider 抽象或账号接线。
  - 兼容与验收：记录的 string／thinking-array／text-array 交替流应完整结束，实时事件顺序与最终输出一致；覆盖空 thinking、可选 closed、usage、tool-call 分片、取消和严格 DONE。同步参照 [推理字段选择](https://github.com/zed-industries/zed/pull/65926)（已包含于 [Zed v1.26.2](https://github.com/zed-industries/zed/releases/tag/v1.26.2) 稳定版）验证 reasoning／reasoning_content 的明确优先级与空值回退，不按全局文本去重；Ash 当前只读后者，不把上游双发缺陷误写成已复现 Ash 问题。保留原有 DeepSeek／Kimi／GLM 行为，对未知内容类型明确报错；本条依据静态核对，真实 provider 回归待实施时验收。

- [ ] **修复候选 · Responses 推理文本兼容性**：`crates/ash-api/src/endpoint/responses/events.rs` 仅消费 `response.reasoning_summary_text.delta`，`responses.rs` 的最终推理项也只读取 `summary`；已配置 Responses 的兼容端点若只提供 `reasoning_text`，实时思考与最终推理文本均可能缺失。参考 [Responses 推理文本适配](https://github.com/zed-industries/zed/pull/65938)（2026-10-22 已合并 main，已包含于 [Zed v1.27.0](https://github.com/zed-industries/zed/releases/tag/v1.27.0) 稳定版），沿现有 decoder 与最终解析补齐经确认的事件和内容类型，不新增 provider 抽象或账号入口。本项为静态核对的兼容缺口，尚未复现真实端点故障，与上方 Chat Completions 协议不同。
  - 范围与验收：先明确 summary 与 reasoning content 共存时的选择规则，不盲目拼接或按全局文本去重；保留加密 `ReasoningState` 的回放边界，不能把密文当作展示文本。在 `crates/ash-api/src/endpoint/responses/events_tests.rs`、`responses_tests.rs` 覆盖空／非空 delta、done 不重复发全文、`output_item.done` 与终态合成、非流式 content、未知内容项、仅 summary、两类共存、工具交错、usage、取消与 WebSocket 共用 decoder；实时事件和最终结果保持一致，既有终态／身份校验不放宽。真实兼容端点回归通过后才关闭本项。

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

- [ ] **边界验收 · Chat 回复的相对文件链接**：[按回复工作目录解析](https://github.com/chogng/ash/commit/4ed9c4593a965328b520cd0dc2d956b0dff78f82) 已记录并持久化每个 Turn 的执行目录，经 `src/ash/sessions/common/agentHostSessionWorkspace.ts`、`chatViewModel.ts` 与 `ChatListItemRenderer` 传入 `chatContentParts/chatMarkdownFileReferences.ts`，完成回复中的显式相对文件链接已可解析并沿既有 `openChatMarkdownLink` 打开；不再将缺少 `baseUri` 等同于功能缺失。参考 [相对回复链接解析](https://github.com/microsoft/vscode/pull/344087)（已合并，已包含于 [VS Code 1.144.0](https://github.com/microsoft/vscode/releases/tag/1.144.0)）。现有实现同时识别唯一的普通文本文件名，缺文件或同名歧义不激活；不扩大本项范围。
  - 已有依据与边界：源码测试覆盖两个真实 Git worktree 的同名文件、显式相对链接与行号、缺文件、歧义文件名及流式未完成时不激活；提交记录报告 macOS Electron 重开窗口后的双 worktree 点击、60 项 Chat／文件搜索测试，以及协议和 SQLite 目录历史测试通过，本轮未重跑。文件搜索 API 测试已有 SSH／中文 URI 映射及取消后晚到结果隔离，不能重复列为缺失。解析使用记录的目录与 authority、既有文件服务和打开边界；目录缺失不猜测当前工作区，外部 Web 回复保留独立策略，越出记录根目录的相对路径仍拒绝，不全局放宽 file scheme 或信任模型 Markdown。
  - 剩余验收：沿现有 Chat 集成链补齐尚未证实的历史回复缺目录、本地／SSH 同名文件的真实点击、切换线程或目录时的异步解析取消／过期结果、空格／Unicode 路径；重复利用已覆盖的本地 worktree 和行号用例，不重建另一套状态。保留外链、已有会话链接、脚本及未信任 command 拒绝的回归，核实恢复与流式重渲染不会将旧结果绑定到新回复；上述边界通过前不标记整项完成。

- [ ] **可做 · Chat 表格单元格换行**：`src/ash/workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.ts` 的普通助手 Markdown 未开启 HTML，表格里的 `<br>` 当前会显示为字面文本。参考 [VS Code 表格换行](https://github.com/microsoft/vscode/pull/342956)（2026-10-20 已合并，已包含于 [VS Code 1.144.0](https://github.com/microsoft/vscode/releases/tag/1.144.0)），仅在 Chat 的 table header／body 内递归处理 inline token，将严格无属性的 `<br>`、`<BR/>`、`<br />` 转为原生换行 token，改善模型多行表格的可读性；复用现有 marked token walk、数学扩展和 sanitizer，不打开通用 HTML，也不改变共享基础 Markdown 的默认策略。
  - 风险与验收：在 `src/ash/workbench/contrib/chat/test/browser/widget/chatContentMarkdownRenderer.test.ts` 覆盖完整渲染、逐字流式与前缀纠正输出一致，包含表头／单元格、嵌套强调／链接、未闭合及长表格。代码字面量和表格外 HTML 仍按原语义显示，带属性标签和脚本不放行；保留数学、代码块与 sanitizer 回归。当前依据源码核对，未运行新行为测试；Ash 已通过 parser 执行 token walk，不照搬上游另一条 lexer 旁路修补。

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
- [ ] **Windows 首窗与 Rust 冷启动** · 分别记录系统加载、Main 入口、Renderer 首批脚本、carrier 选包与摘要、端点发布和首个业务响应。验证能否在同一已验证安装代次复用身份结果，覆盖更新、替换和校验失败。Git 首次发现已完成普通目录与单仓对照，多仓工作区和开窗后立即进入 SCM 的成本待测。
- [ ] **首文件与首次保存尾段** · 配对记录启动文件交付、首读 RPC、编辑器构造、焦点到首个输入、备份检查点、首写 RPC 和落盘确认。分开队列等待、后端处理和测试轮询。保留曾拒绝草稿写入的 `ServerOverloaded` 样本，记录请求阶段和并发负载后复现。
- [ ] **统一基准探针** · 两个应用用同一个 Windows 输入与磁盘观察器跑同一份本地文本，记录首窗、首个被接受的键盘输入、首次落盘。Ash 另测首个 F1 命令和授权后打开目录。原生新装、新配置首次授权、已授权停后端、复用后端、Git 工作区分组，基线和候选各至少五轮，保留每轮数据和失败。

复测命令与基线见[启动测量](docs/desktop-startup.md)；新优化先证明收益，再决定是否保留。

## 数据链路性能 · TODO

测量入口与约束见[审计与测量](docs/ash-app-server-data-path-audit.md)。以下先量化，再决定方案，不能把隔离 microbenchmark 当成整条 Desktop 收益。

- [ ] **测量** · 量化 receive／assemble／decode／parse／schema／adapter／apply／paint 阶段、队列 bytes／elapsed 与真实 task yield；核对 ACK 跟随消费和跨进程时钟关系。
- [ ] **具体消费者测量 · 长 Chat 历史首次解析**：[长历史虚拟化](https://github.com/chogng/ash/commit/f45230bb2adb9a53229ce20886cd4bffeb880290)及[渲染修复](https://github.com/chogng/ash/commit/2a73c6cd733cc9317afee24bc989da9956512734)后，`src/ash/workbench/contrib/chat/browser/widget/chatListWidget.ts` 已通过 `chatVirtualRows.ts` 选择视口缓冲区与交互保留行，再创建 `ChatListItemRenderer` 和 Markdown，不再一概为全部已加载条目首次解析。`chatViewPane.ts` 默认从 48 项启用，ChatGPT 回复页在滚动优化开启时从 100 项启用；[媒体行虚拟化](https://github.com/chogng/ash/commit/fa015b0dd8027a7c5a66a0ccd51449cf2fb57532)已取消图片生成与 MCP App 导致的整段历史回退，按需挂载图片批次并保留已访问媒体，播放中媒体与活动／交互工具行按行保留。屏幕阅读器模式仍回退，未配置阈值的入口保持原策略。参考 [按需首次解析 Markdown](https://github.com/zed-industries/zed/pull/65470)（2026-10-21 已合并，已包含于 [Zed v1.27.0](https://github.com/zed-industries/zed/releases/tag/v1.27.0) 稳定版），剩余工作是测量既有实现及回退场景，不重复提出全列表虚拟化。提交记录报告长历史回归、Desktop smoke、渲染类型检查和定向测试；本轮未重跑，也未取得可比较的首次解析／内存收益数据。
  - 验收与测量：用相同普通文本、代码、工具 Markdown 及图片／MCP App 长历史，分别记录阈值内外、视口缓冲区／交互保留行及回退入口的首次解析次数、主线程时间、峰值内存和首次可读绘制；区分已获准挂载的屏幕外行与意外全量解析，不把减少 DOM 行数等同于整条性能通过。复用已有工具展开恢复和聚焦代码选区测试，核对阅读锚点、异步高度、流式尾部、复制／搜索／导出、辅助阅读与焦点；仅在剩余成本有实测依据时调整现有 owner，保留完整原文与唯一 transcript，不另建缓存、不移用上游收益，收益及行为门禁均通过前不标记整项完成。
- [ ] **测量** · 把后端结果构造和 writer／producer 等待纳入资源准入测量，评估有界数据／控制输出契约与同连接队头阻塞；不靠降低既有文件上限掩盖成本。

- [ ] **测量 · 消息文件检查点的提交与完成成本**：`crates/core/src/thread_controller.rs` 在含 `ItemCompleted` 的批次同步捕获一次检查点并供批内条目共享；`crates/app-server/src/server/message_checkpoints.rs` 经 `crates/git-turn-changes/src/ledger.rs` 等待各仓库捕获，`crates/git/src/objects.rs` 创建临时索引并执行 `read-tree`／`add --all`／`write-tree`，普通目录则由 `crates/worktree/src/directory_checkpoint.rs` 完整复制与散列后才按 digest 去重。参考 [消息检查点成本反馈](https://github.com/zed-industries/zed/pull/65989)（2026-10-26 已合并，已包含于 [Zed v1.27.0](https://github.com/zed-industries/zed/releases/tag/v1.27.0) 稳定版），先量化大目录或无文件变化时的排队、复制／Git 捕获、持久提交与首次模型调用时间；没有 Ash 实测，不能移用上游卡顿结论或删除恢复能力。
  - 范围与前提：记录文件／字节量、仓库数和重复样本，分别覆盖本地与 SSH 执行 owner；保留事件／文件恢复顺序、写租约、目录身份、真实 Git index、私有 ref 生命周期及外部编辑冲突语义。不预设跳过捕获、增加开关／缓存或改变异步边界；只有捕获成本确有实质占比才选择保持同一快照语义的窄优化，否则记录结果并停止。
  - 验收：复用 `crates/core/src/thread_controller/restore_tests.rs`、`crates/git/src/objects/tree_tests.rs`、`crates/git-turn-changes/src/turn_changes_tests.rs`、`crates/worktree/src/worktree_tests.rs` 及 `crates/app-server/src/checkpoint_live_tests.rs`，覆盖大仓库无变更／已修改、未跟踪／忽略文件、多仓库、普通目录与符号链接、活动写入时不可用、捕获中断清理、重启／fork／恢复及私有 ref 释放；记录 Windows／macOS／Linux 各自真实测量边界，不能用局部耗时替代整条提交体验或恢复正确性。

- [ ] **测量 · 流式文件路径索引的重复存储**：`crates/file-search/src/lib.rs` 的 `walker_worker` 为每条路径同时保存 `Arc<str>` 与 Nucleo 的 `Utf32String` 列，`build_snapshot` 再从原路径计算排名与高亮。参考 [Codex 减少路径索引副本](https://github.com/openai/codex/pull/55351)（2026-10-19 已合并，已包含于 [Codex 0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0)），先量化 TUI `@file` 与独立文件搜索 CLI 所用 `Service::start` 在大目录的分配字节、峰值内存、扫描和连续查询耗时，再决定是否让纯 ASCII 路径复用匹配列；尚无 Ash 收益测量，不泛化到使用 tgrep 的 Desktop 搜索。
  - 范围与风险：保留单根、仅普通文件、目录准入、取消和 `query_revision` 契约，不引入多根索引或第二份缓存。Unicode 匹配列并非原路径的无损表示，组合字符与 emoji 不能由该列重建；非 ASCII 路径仍须保留可精确返回的原串。
  - 验收：在 `crates/file-search/src/file_search_tests.rs`、`ranking_tests.rs` 及 TUI／CLI 消费链覆盖 ASCII、中文、组合字符、emoji、同分排序、截断、快速改查询和取消；对比原路径、分数、顺序与高亮索引，并记录相同目录与查询的重复样本。仅在内存确有下降且延迟及行为不退化时采用，不把局部测量当作整条 IDE 性能结论。

- [ ] **测量 · Git 扩展安装的历史传输成本**：`src/ash/workbench/services/extensionManagement/browser/appServerPluginManagementService.ts` 经现有 Git 服务克隆后，只复制目标包且递归排除 `.git`；`crates/git/src/client.rs` 的 `clone_reserved` 仍获取完整历史。参考 [插件来源浅克隆](https://github.com/microsoft/vscode/pull/343514)（2026-10-22 已合并，已包含于 [VS Code 1.144.0](https://github.com/microsoft/vscode/releases/tag/1.144.0)），先在固定多提交仓库测量安装下载字节、临时目录峰值和耗时，再评估仅此安装入口的显式浅克隆选项；不把上游收益当成 Ash 实测结果，不改变普通工作区 clone 的完整历史默认值。
  - 前提与范围：沿现有 `git/cloneTo` 领域契约传递窄范围选项，并在服务端校验；默认分支、指定 branch／tag 与完整 commit ID 分别处理。旧 pin 必须精确获取并核对最终 HEAD；服务端不支持获取该提交时明确失败或采用已定义的保真回退，不能静默改取最新分支。保留目标目录原子占用、取消、现有权限、包子路径校验、元数据排除和安装 authority，不新增克隆缓存或来源信任。
  - 验收：扩展 `crates/git/src/client_tests.rs` 与 `src/ash/workbench/services/extensionManagement/test/browser/pluginGitInstallation.test.ts`，用能实际传输对象的受控 Git remote 覆盖默认分支／branch／tag／旧 SHA、拒绝未知 pin、现存目录、取消和错误清理；检查包内容及 digest 与完整克隆一致，普通 clone 历史不变。仅在下载／落盘成本确有下降且兼容及生命周期回归通过后采用，不先承诺速度倍数。

## 发展候选（未排期）

保留后续发展方向，不作为当前交付缺口或已承诺范围。选中一项后，按实际用户入口、唯一 owner、依赖和验收场景转入上面的功能待办。下表中的前置条件尚未完成，不能据此宣称已有对应能力。

| 方向                                       | 用途与进入实施的条件                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一诊断包导出                             | IDE 与 Agent Window 已有 [Agent Host 调试日志包](docs/chat.md#调试日志导出)，包含客户端日志、Session 所属本地／SSH 宿主的进程日志与现存轮转文件、当前会话执行证据，以及当前 Chat／子 agent 已录制的请求和响应正文。manifest 记录录制状态、范围、限额和收集问题。更广的通用诊断包仍未排期：`feedback/prepare` 的构建、活动统计、响应诊断和指标快照尚未接入该入口，新增来源须沿其 owner 的真实收集契约接入。 |
| Sessions 跨客户端审阅与 provider changeset | 当前 read marker 只属于窗口并绑定 revision。需要跨客户端 reviewed-file、transient/provider changeset、隔离或反馈评论时，先确定共享领域契约和真实消费者，不因上游身份模型不同新增 facade。                                                                                                                                                                                                                  |
| Configuration 其他契约                     | configuration variables、Remote User、缓存默认值／实验覆盖、跨 profile 规则，以及 registry／schema、typed parse/serialize、控件描述与 `ashBinding` 均按具体调用需求复核，不按上游成员表整体补齐；Rust `config.toml` 的编辑入口仍归其宿主。设置呈现与接入规则见 [Settings 接入边界](src/ash/workbench/contrib/preferences/README.md#当前实现)。                                                             |
| 托管策略强制新鲜度门禁                     | 当前生产账户映射仅 `ChatDefaultModel`；未接入 `forceRemoteSettingsRefresh`、跨重启的刷新要求或执行端门禁。若纳入企业治理，先确定 Ash 管理来源、作用域、启动／重载要求及 App Server 执行 owner，再贯通 pending／blocked／satisfied、显式恢复和跨端校验；普通网络失败不自动升级为全产品 AI 禁用，Renderer 禁用输入不作为执行端强制保证。                                                                     |

### TUI 剪贴板图片文件的显示方向

- [ ] **修复候选 · TUI 剪贴板图片文件的显示方向**：`crates/tui/src/keymap/bindings.rs` 的 `Attach clipboard image` 经 `host.rs` 调用 `host/clipboard.rs`；该入口优先读取剪贴板 `file_list`，用 `image::open` 解码后重新编码为 PNG。当前锁定的 image 0.25.10 不自动应用 EXIF 方向，`DynamicImage::write_to` 也不保留该元数据，因此依赖方向标记的文件会按原始像素方向进入附件。参考 [图片解码应用显示方向](https://github.com/openai/codex/pull/60455)（2026-11-09 已合并 main，尚未包含于 [Codex 0.167.2](https://github.com/openai/codex/releases/tag/rust-v0.167.2)），在现有剪贴板文件解码 owner 内应用方向后再计算尺寸／指纹并编码；这是静态链路确认的候选，尚未执行 Ash 剪贴板复现。
  - 范围与风险：仅限实际从系统剪贴板文件列表取得并重编码的图片，保留文件优先级、失败回退、附件目标及异步结果代次检查。普通文本路径粘贴经 `attachments.rs` 保留原始 bytes，不列为同一缺口；系统剪贴板原生 RGBA 已是像素数据，不能猜测或重复旋转。现有共享图片处理已能保留方向元数据，不重构它、不扩大到 Desktop，也不一并引入 macOS 专属 pasteboard 或 TIFF 性能改造。按当前解码限制处理，不为修方向放宽资源上限；不复制不必要的 EXIF 隐私字段。
  - 验收：在 `crates/tui/src/host/clipboard_tests.rs` 用不对称合成 JPEG／PNG 覆盖八种 EXIF 方向、无方向、无效元数据和解码失败，断言输出 PNG 的像素排列、旋转后宽高及指纹一致，不仅检查文件头。沿 `app/state_tests.rs` 复用附件落入目标线程与旧结果拒绝测试，保留普通路径粘贴、原生 RGBA 和非图片回退。再于支持文件列表的真实终端／系统剪贴板走一次复制文件 → 附图流程，明确实际平台；不把 macOS 上游验证当作 Ash Windows／Linux 已通过。

### Chat 粘贴完成后再发送

- [ ] **修复候选 · Chat 发送等待正在应用的粘贴**：`src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.ts` 的 `acceptInput` 等待听写与已登记的附件准备，但在捕获草稿前未等待 `src/ash/editor/contrib/dropOrPasteInto/browser/copyPasteController.ts` 的 `currentPaste`。`input/editor/chatPasteProviders.ts` 的 HTML／复制引用 provider 会异步读取或准备粘贴结果；已有非空草稿可在该编辑落入模型前进入发送，已登记附件的等待不能替代这段操作。参考 [VS Code 等待粘贴再发送](https://github.com/microsoft/vscode/pull/347212)（2026-11-10 已合并 main，稳定版 [1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 尚不包含），在现有粘贴 owner 与 Chat 提交入口间闭合完成结果及取消契约；本项为静态时序缺口，尚未运行 Ash 快速粘贴后发送的行为复现，不声称已发生内容丢失。
  - 范围与风险：区分成功应用、失败和取消；现有 `finishedPaste(): Promise<void>` 不能证明编辑成功，不只盲等后继续发送。等待期间若草稿、编辑器模型、会话／线程或提交权限改变，应取消此次发送并保留当前草稿，不能把新编辑并入旧提交；粘贴自身正常写入与用户随后编辑须区分。复用现有 revision／lifecycle、附件准备和重复发送门禁，明确普通发送、客户端命令、队列／后台发送及显式文本调用的适用边界；不增加第二份草稿或绕过已有 provider 取消与授权。
  - 验收：在 `src/ash/workbench/contrib/chat/test/browser/chatInputPart.test.ts`、`chatInputEditor.test.ts` 与粘贴控制器测试用可控延迟的真实 provider 链覆盖非空草稿粘贴后立即发送、文本／HTML／复制引用成功、失败／取消、期间编辑或切会话及连续发送。断言实际提交载荷只包含最终获准的文本与引用，取消时没有请求、草稿可继续编辑；保留现有文件附件等待、普通同步粘贴、命令与队列语义。补真实 Desktop 键盘粘贴后发送场景，不能用手工先 await `finishedPaste` 的测试替代发送入口门禁。

### Overview Ruler 分数缩放边缘绘制

- [ ] **修复候选 · Overview Ruler 分数缩放边缘绘制**：`src/ash/editor/browser/viewParts/overviewRuler/decorationsOverviewRuler.ts` 对装饰画布设置 `contain: strict`，位图宽高按逻辑尺寸乘像素比向下取整，CSS 仍保留原逻辑尺寸；该层背景承担遮住滚动轨道下方文字的职责。参考 [VS Code 分数缩放边缘绘制修复](https://github.com/microsoft/vscode/pull/346835)（2026-11-08 已合并 main，已包含于 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 稳定版），核实 paint containment 在分数缩放下裁掉末列设备像素的相同风险，并在现有 owner 内调整 containment；这是匹配到相同绘制前提的静态候选，尚未在 Ash 复现可见漏绘，不把上游截图当作 Ash 结果。
  - 范围与风险：先限定装饰 Overview Ruler，不全局移除编辑器 containment、不顺带修改 Minimap 或另一种 `OverviewRuler`。保留尺寸隔离、画布背景／主题透明度、装饰 lane、光标、滚动条位置和点击行为；若 Ash 真实场景不复现且没有可观察收益，不仅为源码一致性改变绘制策略。
  - 验收：扩展 `src/ash/editor/test/browser/codeEditorPresentation.test.ts` 的轨道对齐场景，在整数与分数 DPR／Electron 缩放组合中记录逻辑宽度、位图宽度、有效像素比及右缘像素；用长行横向滚动与静止／纵向滚动对照，确认默认实色主题下末列不透出正文且 lane／光标／边框未裁掉。覆盖亮暗与高对比主题、Minimap 关闭／左右布局及缩放后重绘，复用已有几何与主题测试；补真实 Desktop 观察并明确平台，不能用几何相等或改 CSS 属性代替像素验收。

### Minimap 相邻区段标题可读性

- [ ] **修复候选 · Minimap 相邻区段标题重叠**：`src/ash/editor/contrib/sectionHeaders/browser/sectionHeadersController.ts` 已将 region／MARK 标题交给现有 Minimap；`src/ash/editor/browser/viewParts/minimap/minimap.ts` 仍逐条按源行位置绘制完整字号的标题与背景，没有处理相邻标题的占用区域。行距小于标题高度时，后绘制的标题会覆盖前一条。参考 [VS Code 区段标题防重叠](https://github.com/microsoft/vscode/pull/346190)（2026-11-05 已合并 main，已包含于 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 稳定版），在现有绘制 owner 内按源行顺序处理标题碰撞，保留每个标题的可读性；这是静态绘制链确认的修复候选，尚未完成 Ash 实机复现。
  - 范围与风险：只调整标题标签的布局，不新增扫描器或第二份文档模型，不隐藏冲突标题；非冲突标题、分隔线、标记及点击／拖动导航保持既有源行语义。密集标题堆叠可能占用更多缩略图区，须明确视口底部裁切与滚动时的稳定行为；不顺带导入上游 fill 模式缩放或编辑器边框改动。
  - 验收：扩展 `src/ash/editor/test/browser/editorDecorationViewport.test.ts` 的 Canvas 绘制记录及 Minimap 定向测试，覆盖相邻／嵌套 region、长标题后紧邻另一标题、分散标题、空标签与分隔线，并在真实编辑器核对字体大小、DPI、滚动、折叠、换行与紧凑采样场景。断言每个应显示标签均保留且绘制区域不互相覆盖，原有导航与非标题装饰不退化；不得把上游截图或测试数量当作 Ash 验收。

### Minimap MARK 区段标题的注释结束符

- [ ] **修复候选 · MARK 标题排除块注释结束符**：`src/ash/editor/contrib/sectionHeaders/browser/sectionHeaders.contribution.ts` 将默认 MARK 正则交给 `SectionHeadersController`；`src/ash/editor/common/services/findSectionHeaders.ts` 直接使用 label 捕获，控制器虽检查注释 token，却未传入语言的块注释起止符。因此 `/* MARK: Section */`／`<!-- MARK: Section -->` 的结束符仍随标题进入现有 Minimap。参考 [VS Code MARK 标题清理](https://github.com/microsoft/vscode/pull/346189)（2026-11-05 已合并 main，已包含于 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 稳定版），在现有语言配置与标题提取链内，只去除已确认属于当前块注释的尾部结束符；保留原文、装饰 owner、导航和用户自定义正则，不以全局字符串替换清理标签。静态调用链已确认，尚无 Ash 真实编辑器复现。
  - 验收：扩展 `src/ash/editor/test/common/services/findSectionHeaders.test.ts` 与 `src/ash/editor/test/browser/sectionHeadersController.test.ts`，覆盖 HTML／C 风格、同形起止符、空标签／仅分隔线、结束符跨 separator 与 label 捕获、正则自行消费注释符，以及行注释或已闭合注释后标签中的字面 `*/`；保持自定义／多行匹配范围与缓存失效正确。在真实编辑器核对语言切换后的标签及 Minimap 显示；不把相邻标题防重叠候选或上游测试当作本项通过。

### 网络目录上的状态数据库策略

- [ ] **验证 · 网络目录上的状态数据库策略**：ASH_HOME 可落在 NFS，当前 state.sqlite3 的共享连接策略仍固定 WAL；[数据库迁移整理](https://github.com/chogng/ash/commit/46fb022f42805cd225a7e037f3b8be608b320b53)后，automation 已复用 `crates/state/src/sqlite_runtime.rs`，`crates/ext/queue/src/store.rs` 仍独立指定 WAL。参考 [Codex 按数据库目录选择初始化 journal](https://github.com/openai/codex/pull/56552)（2026-10-23 已合并，已包含于 [Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)），先核实支持范围及实际 NFS 启动／重开行为；统一每个数据库实际目录的探测和 owner 策略，避免仅改共享连接后被其他 owner 改回。若不支持此布局，启动时明确诊断；若纳入支持，再评估新库 DELETE，已有库不自动切换或搬迁。
  - 前提与验收：适配 rusqlite 而非照搬 SQLx；保持 Durable 至少现有 FULL 耐久性，DELETE 评估 EXTRA，不将 WAL 改为上游 NORMAL。覆盖本地新库、NFS 新库、已有 WAL／DELETE、初始化中断、目录探测失败、多个 owner 重开和持锁并发，确认实际 pragma 返回值与错误可诊断；对回滚 journal 的读写竞争及吞吐做基线测量。是否正式支持多主机共用 profile 属单独产品决定，不由此候选授权。
  - 上游后续已合并[已有库迁移与初始化门禁](https://github.com/openai/codex/pull/57225)及[迁移权限说明](https://github.com/openai/codex/pull/57226)（2026-10-26，已包含于 [Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)）：迁移要求所有主机的客户端停用、跨客户端锁有效，并保留 WAL 备份和中断恢复；替换文件仅保留 mode bits，不继承原 owner／group／扩展 ACL。此处仍不授权 Ash 自动迁移或照搬 unsafe 开关；若之后单独批准迁移，再将锁竞争、恢复、权限变化披露与失败不触发损坏重建纳入验收，不能把初始化 journal 选择等同于已有数据安全转换。

  - 目录判定补充：参考 [本地与网络目录 journal 区分](https://github.com/microsoft/vscode/pull/345014)（2026-10-29 已合并，已包含于 [VS Code 1.145.0](https://github.com/microsoft/vscode/releases/tag/1.145.0)），把 Windows UNC／映射网络盘、Linux 网络挂载／FUSE、目录解析或探测失败，以及既有 WAL 库移到另一类目录后的重开加入上述验证矩阵；仅看路径形式或新库初始化不足以确认实际模式。按数据库实际目录核实各平台探测能力，不能把上游 macOS 默认视为本地直接当作 Ash 保证。保持现有 Durable FULL，不采用上游 NORMAL 或自动切换旧库；被连接锁阻止时保留原库并明确诊断实际 journal，不能宣称目录已适配。此补充仍是支持范围与失败诊断验证，不批准网络 profile、多主机共用或迁移实现。

### 共享登录记录格式兼容（前提变化，暂缓）

2026-10-30 核对当前生产接线后，将原“共享 Codex 登录记录兼容性”移为暂缓复核，不标为已实现：`crates/app-server/src/local.rs` 与 `crates/chatgpt/src/oauth.rs` 的外部 Codex 登录固定为只读复用，缺少或过期时要求在 Codex 完成登录；独立 ChatGPT Web 登录经 `web_auth.rs`／`storage.rs` 写入 Ash profile 私有凭据，显式选择来源并保留 generation／revision 校验，不再以补写共享文件为当前缺口。

保留 [Codex 登录来源与登录标识](https://github.com/openai/codex/pull/55397)（已包含于 [Codex 0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0)）作为格式演进依据。只有明确出现当前只读消费者与上游新记录不兼容，或另行批准共享写入／新增可信登录来源时，再用合成记录核对 `oauth_provenance`／`login_owner_id` 的实际需要；不得仅因字段缺失扩张接口，不从 token 声明推断可信 issuer，不改变外部凭据不刷新、不覆盖的边界。保留来源切换、旧回调晚到、同账户重登、刷新提交失败、登出和错误脱敏验收；本轮仅静态复核生产入口与测试定义，未运行真实登录或凭据迁移。

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

未排期的新工作流增强。2026-10-23 的独立 Search 已由 `src/ash/sessions/contrib/search/browser/searchModel.ts` 按会话／线程标题与 provider label 过滤，最新侧栏 `src/ash/sessions/contrib/sessions/browser/views/sessionsList.ts` 已通过 `SessionsListSearch` 恢复局部查找，并保留分组与已有 `IGitHubService.getSessionPullRequests()` 的 PR 标记；局部查找已消费含 `#number` 的 PR label，不能继续列为侧栏缺失；它采用子串匹配，不等同本候选拟议的精确号码语义。关联 PR 的 number 已存在，但独立 Search 结果尚未消费它，不需要新增后端发现服务。参考 [VS Code Sessions PR 号查找](https://github.com/microsoft/vscode/pull/338904)，让用户能从 PR 号找回标题不含该号码的会话。

- 进入条件与范围：先确认 `#N` 与纯数字 `N` 精确匹配关联 PR 号的产品语义，再由独立 Search model 消费现有 GitHub 关联 owner 并响应关联变更，保留精确 session／thread 导航；仅消费已有分支关联／手动附加 PR 数据，不新增网络请求、第二份关联状态或通用搜索层。
- 风险与验收：在 `src/ash/sessions/contrib/search/test/browser/searchModel.test.ts` 和真实搜索对话框场景覆盖两种输入、同号跨仓库的全部匹配、多个 PR、无 PR、关联解除／刷新以及不存在的号码；标题、provider、分类、多个活动 thread、关闭／重开、焦点与清空查询行为保持可用；侧栏已有局部查找与分组保持原样，不自动把本候选扩展为两个搜索入口同步改造。PR-only 命中不能伪造标题高亮；仅有现有关联数据的会话可按 PR 查找，不承诺尚未提供元数据的外部 provider。

### Workbench 模型选择器容错搜索

未排期的查找体验增强。`src/ash/platform/actionWidget/browser/actionList.ts` 目前按空格拆词、匹配名称与详情的连续子串并保留目录顺序；Workbench `modelPickerItems.ts` 经 `modelPickerItemPrimitives.ts` 已包含 provider 与模型 ID，`modelPickerTabbedWidget.ts` 已将所有启用模型交给同一列表并支持跨 provider 搜索（[Ash 统一列表改动](https://github.com/chogng/ash/commit/90df1306b4fff532eb6161d101a20a1ef8f55f74)），不能把这些搜索能力列为缺失。参考 [Zed 模型选择器搜索](https://github.com/zed-industries/zed/pull/64147)（2026-10-20 已合并，已包含于 [Zed v1.26.2](https://github.com/zed-industries/zed/releases/tag/v1.26.2) 稳定版），补充 `gpt6.1` 对 `GPT-6.1 Sol` 这类非连续匹配，并让名称命中优先于仅详情命中；现有 `GPT 6.1` 分词查询本就可用。

- 进入条件与范围：先确定查询及排序语义，再在 `src/ash/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerTabbedWidget.ts` 的弹出层 owner 内接入，`modelPickerWidget.ts` 仅保留现有触发职责；可评估既有 `src/ash/base/common/fuzzyScorer.ts`，但 ActionList 尚无领域专用评分入口，须先提供窄范围的可选接入，不全局替换通用列表语义、不新建平行 picker、不顺带扩张到独立 Sessions picker 或后端模型目录。
- 风险与验收：保留 provider／模型 ID、跨字段及不同词序的既有查询；名称和详情分别评分、同分稳定、空查询恢复原顺序，元数据命中不伪造名称高亮。保持现有跨 provider 统一列表范围、详情返回时同一查询的保留，以及 Auto 时隐藏列表与筛选框的行为，不恢复 provider tabs 或引入每 tab 缓存。由 `src/ash/workbench/contrib/chat/test/browser/modelPickerWidget.test.ts`、`modelPickerTabbedWidget.test.ts` 与真实输入场景覆盖精确名称、紧凑输入、非拉丁文字、同名跨 provider、目录刷新／移除、已选身份、禁用项、Auto、键盘与焦点；通用 ActionList 行为保持不变。不移植上游 GPUI 任务模型或把其基准当作 Ash 性能收益。

### Desktop 文件粘贴路径回退

- [ ] **候选／链路补齐（未排期）· Desktop 文件粘贴的路径回退**：现有 `src/ash/editor/browser/controller/editContext/clipboardUtils.ts` 在无文本、无编辑器元数据而有文件时只插入 `File.name`；EditContext 与 TextArea 共用此入口。补齐文件管理器复制文件后在普通文本编辑器粘贴可定位路径的操作链路，参考 [VS Code 文件粘贴路径回退](https://github.com/microsoft/vscode/pull/342695)（2026-10-19 已合并，已包含于 [VS Code 1.144.0](https://github.com/microsoft/vscode/releases/tag/1.144.0)）。这是现有文件名回退的增强，不是已复现的文件内容丢失缺陷。
  - 范围与前提：复用 `src/ash/platform/dnd/browser/dnd.ts` 的既有宿主 File 路径解析边界，保持 editor → platform 依赖方向，不直接引入 Electron；不让浏览器读取本地路径，不读取文件内容、不自动打开文件、不改变 URI-list provider、普通文本及编辑器元数据的优先级。无宿主路径时仍回退文件名。
  - 验收：扩展 `src/ash/editor/contrib/dropOrPasteInto/test/browser/copyPasteController.test.ts`，覆盖单／多文件、空格与非 ASCII 路径、宿主无路径或异常、文本与元数据优先，并保留“不读取文件内容”断言；分别走 EditContext／TextArea，补真实 Electron 文件管理器复制粘贴与 Web 回退验收，记录平台差异。

### SCM 文件拖入终端

- [ ] **候选／链路补齐（未排期）· SCM 文件拖入终端**：`src/ash/workbench/contrib/scm/browser/scmViewPane.ts` 的变更树尚未提供 drag policy，共享 Tree／List 仅在消费者提供 `dnd.getDragURI` 时启用行拖动；终端已接入 URI-list 文件拖放和 `sendPath(resource, false)`。参考 [Zed Git 面板文件拖放](https://github.com/zed-industries/zed/pull/66423)（2026-11-02 已合并 main，已包含于 [Zed v1.28.1](https://github.com/zed-industries/zed/releases/tag/v1.28.1) 稳定版），补齐从已显示的 SCM 工作文件到现有终端的路径输入，减少先定位 Explorer 或复制路径的步骤。本项是静态确认的入口缺口，不是执行失败或数据丢失缺陷。
  - 前提与范围：先限定单个文件行，沿现有 `TreeDragAndDrop` 和 Explorer 的 `text/uri-list` 契约导出权威 `sourceUri`，终端继续使用既有宿主 URI 转换及 shell 引号；只允许可确认的本地／同连接远端工作文件，分组、目录、已删除项、Git 历史／虚拟资源不伪装为工作文件。拖放只填入路径，不附加回车、不执行命令，不增加文件读写、上传或 provider 动作。当前终端只消费首个 URI，不能把上游多选行为直接照搬或静默截断成“多文件支持”；本候选不扩张到批量拖放。
  - 风险与验收：在 `src/ash/workbench/contrib/scm/test/browser/scmViewPane.test.ts` 与 `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts` 补来源／接收链测试，并走真实 Desktop SCM → 终端拖放；覆盖 staged／unstaged 同一工作文件、删除与重命名、列表／树视图、刷新后旧行、空格／中文／引号／shell 元字符、本地与 SSH 同名路径。异连接、只读或已退出终端、未知 shell、控制字符及转换期间进程重启仍拒绝；点击预览、键盘打开、inline actions 和文件菜单不退化。沿用现有取消与执行主机检查，不绕开 `sendPath`。

## Chat accessibility · 缺失宿主入口

- [ ] **前置** · `src/ash/workbench/contrib/chat/browser/accessibility/` 已接入消息标签、响应纯文本视图和 Chat 信号 owner；37 项定向测试与 1 项 Desktop 自托管场景通过。上游对应的 `chatTerminalOutputAccessibleView.ts`、`chatBackgroundShellOutputAccessibleView.ts`、`chatPetJumpGameAccessibleView.ts` 尚无 Ash 生产入口：缺少终端工具输出的焦点／内容契约、后台 Shell 输出视图和宠物游戏 owner。先闭合各自真实宿主及焦点恢复契约，再在对应路径接入 Accessible View 并验证键盘、内容更新和释放；不提前创建无调用方文件。
