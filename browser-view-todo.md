# BrowserView 双语导航可用性

基线：`origin/main` @ `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`，于 2026-10-08 从远端 fetch。当前实现已拥有地址栏导航、Back/Forward、Reload/Stop、加载状态、失败状态、帮助与标签关闭；但导航工具栏、地址输入框和网页 viewport 的可访问名称、按钮文案、Loading/Stop 状态、可访问性提示与帮助标题仍有英文硬编码。现有 `browser-view.spec.ts` 已覆盖 Electron 页面导航/历史、slow-load 停止、帮助 Escape 后焦点恢复与关闭标签清理，但只验证英文界面。

初始目标：在 BrowserEditor 中用 `localize({ bundle: 'ash.workbench', key })` 提供完整英文与简体中文的导航控件/ARIA、加载与失败状态、无障碍提示和帮助标题；不触碰 BrowserView 模型、网络授权、权限或其他贡献。

验证：扩展 `test/smoke/areas/windows/browser-view.spec.ts` 的真实 Electron 浏览器导航链，对 en 与 zh-CN 都检查导航→Loading/Stop→Back/Forward→加载失败提示→帮助→Escape 焦点恢复→关闭标签清理；云端只做轻量 TypeScript/unit 验证，不把未运行的 Electron 场景报作通过。

## 落地与云端验证状态

- 已完成：BrowserEditor 导航按钮、工具栏/输入/网页 ARIA、Loading/Stop、失败与进程停止消息、焦点提示、Help 标题均改用独立 NLS 键；英文与简体中文词条同步更新。
- 已完成：新增 en/zh-CN Electron smoke 场景，覆盖导航、history、Stop、失败提示、Help、无障碍视图关闭后的焦点恢复，以及关页释放。
- 云端已通过：本树 `pnpm run protocol:generate`；`pnpm run localization:generate`（zh-CN 缺项 0）；`pnpm run typecheck:renderer`；`pnpm exec tsc -p test/automation/tsconfig.json --noEmit`；`git diff --check`。
- 尚未验收：未运行 Electron smoke 或 Mac Electron UI。云端没有用浏览器模拟来替代此验收。

## 本机落地状态（2026-10-08）

- 独立工作树：`/Volumes/1t/ash-browser-view-20261008`，分支 `codex/browser-view-bilingual-20261008`；fetch 后基线仍为 `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`。未改原始 checkout，未提交或推送。
- 准确云端补丁为 20,954 字节，SHA256 `09b01271bf40ecd007861b223667327b1066daf54eea7f4cf6697dc00d29d46a`。结构化消息正文只缺终止 LF；显示层另含 49 个 `&gt;` 与 9 个 `&lt;` 编码。原样版本与准确补丁均保存在 `.build/handoff/`，未手工重写云端 patch。准确补丁和最终五文件 diff 均通过独立基线 apply-check，最终 diff 反向检查通过。
- 已通过：独立锁定依赖安装；本树正常 `protocol:generate`（`CARGO_BUILD_JOBS=1`）；`localization:generate`（zh-CN 缺项 0）；正常 `typecheck:renderer`、`typecheck:protocol`；`pnpm exec tsc -p test/automation/tsconfig.json --noEmit`；双语 smoke `--list`（准确选出 2 个 Electron UI 场景）；正常 `pnpm run build`（键盘模块、Main、Preload、Renderer）；定向 TS 格式和 `git diff --check`。协议、生成词条、类型检查及前端构建日志未发现 warning。
- 初次 automation 类型检查和 smoke 列表因缺少本树协议失败；正常协议生成后均已通过。保留初次失败和最终成功日志以供核对，没有伪造或跨树复制 protocol/Cargo/runtime。
- Mac smoke 已静态审阅：`electron-ui` 禁用 App Server，从本树解析 Electron 44.4.5 macOS arm64；fixture 使用独立临时 profile，macOS 启动带 `-ApplePersistenceIgnoreState YES`。中文重启后重新获取 application/workbench；Alt+F1、Help、Escape 与关闭释放沿现有驱动和生命周期断言。HTTP 端口自动分配。
- 在云端 smoke 的既有行为断言后补了成功导航、无障碍帮助的截图附件；截图不作为行为判定。
- 已运行真实 Mac Electron UI：en、zh-CN 两个新增场景均通过（2 passed，8.6 秒），覆盖导航/history/Stop/失败/Help/Escape 焦点恢复/关闭释放；四张导航和帮助截图保存在 `.build/handoff/`。fixture 已关闭自有实例，没有遗留本树 Electron 进程；UI 槽已释放给后续任务。协议与前端构建及 UI 期间内存空闲约 77%–80%。运行日志仅出现 `NO_COLOR`/`FORCE_COLOR` 环境冲突 warning，未由代码变更引入。
- 后续可直接运行 `pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/browser-view.spec.ts --grep 'BrowserView navigation and accessibility'`。缓存和本树产物保留，完成验收后等待串行发布许可，不推送。

- 截图审阅发现工具栏可用性缺口：地址栏宽度几乎为零，中文导航按钮发生断行；既有行为断言可以对很窄的地址栏填值，尚未覆盖该布局问题。后续需补真实几何回归断言、修复布局并在另一个授权 UI 窗口重验。当前仅报告双语行为链通过，不宣称整体布局验收完成。

## 地址栏布局补充与本机验收（2026-10-08）

- 已保全原有改动并 fast-forward 到 `721e4297e9982c8fab4e3df4c87ebfe41466efff`，恢复改动无冲突。之前超时的布局编辑未落盘。原始 checkout 未修改。
- 准确布局补丁为 14,726 字节，SHA256 `d4d3d31f5dc75f59642657a183f5218e235f53526c0ee64859342555418406e7`。显示层 HTML 解码后字节与 hash 完全一致，无需补换行；先保存现有差异及文档，apply-check 通过后应用。原样补丁在 `.build/handoff/layout-cloud/browser-view-layout.patch`。
- 原工具栏的三个长页面操作移入已有 WorkbenchToolBar secondary 菜单，导航按钮保持现有行为、名称及顺序。BrowserView CSS 仅约束自己直接拥有的控件和 toolbar 宿主，不覆盖共享 toolbar 内部；未修改共享 InputBox。
- 同步迁移已有 Electron smoke 的下载取消、权限重置及分享操作到菜单入口。新增 Chromium Renderer 集成 fixture 对 Main 页面服务和分享对话使用明确 stub；导航、布局与菜单采用生产组件。补充无重叠和中心点无遮挡断言，并保存几何 JSON 与截图。
- 本轮已通过正常入口：`pnpm run typecheck:renderer`（含本树正常生成前置链、zh-CN 缺项 0）；automation types；定向 CSS lint（0 errors、0 suggestions）；定向 TS 格式；BrowserEditorInput 模型单测（5 passed）；`pnpm run test:browser:integration browserView.integration.spec.ts --project=chromium`（4 passed）；正常 `pnpm run build`（含正常前置步骤）。
- 真实 Chromium 在 en/zh-CN 各 1000px/500px 四场景通过：地址栏可编辑、宽度至少 120px；控件单行、无溢出、重叠或遮挡；分享、权限重置、下载取消可键盘执行，菜单关闭回焦。地址栏实测依次为 714.109375、214.109375、720、220px。四张新截图已检查，保存在 `.build/handoff/layout-cloud/`；原 Electron 问题截图未覆盖。
- 本轮未启动 Electron，UI 槽仍归 AgentHost；前述 2 passed 属于修复前的真实 Electron 行为结果，不代表本轮布局及菜单改动已获 Electron 验收。需要在 UI 槽获准后重跑双语导航与菜单相关 smoke。未提交、未推送，保留本树依赖和缓存。
- 本轮代码检查及正常构建没有新增 warning；Chromium 日志只有既有 `NO_COLOR`/`FORCE_COLOR` 环境冲突 warning。中途执行通道短暂断开，恢复后只归档本任务报告与检查结果。

## 完整功能补齐与真实布局回归（2026-10-08，继续进行）

- 当前实现使用已有 WorkbenchToolBar 与 compact InputBox：导航与 Go/Help 保留本地化名称和 tooltip；三个长页面操作在 More Actions 中使用现有行为。只调整 BrowserView 自有宿主样式，没有修改共享 InputBox 或 Toolbar 内部。
- 云端最小布局补丁在真实 800px 窗口仍失败，地址栏不足 120px；修复后补 240px Renderer 用例和实际窗口 1200/800px 几何检查。窄工具栏将地址栏放到独立一行并让按钮组换行，地址栏不再塌缩。首次真实权限场景发现 ResizeObserver 循环，已改由编辑器根节点宽度决定 compact，避免观察子节点高度反馈。
- 当前 Chromium Renderer 集成六场景通过：en/zh-CN 各 1000/500/240px。地址栏分别为 842/342/230px，控件无重叠、遮挡、溢出，按钮保持单行。Main 服务和分享对话仍是明确 stub，不能替代 Electron。
- 当前真实 Mac Electron 五场景通过（13.9 秒）：双语导航/history/Stop/失败/Help/Alt+F1/Escape/关闭释放，以及下载取消、权限重置、分享权限。双语场景通过实际 More Actions 键盘菜单及真实分享对话调用；对话驱动在 OS 弹出边界采集并取消。窗口 1200/800px 的工具栏宽度为 542/142px，地址栏为 384/132px；几何断言均通过。截图和几何在 `.build/handoff/layout-cloud/accepted-*`，报告在 `.build/handoff/electron-complete-1/`。Playwright renderer 截图展示工具栏布局，不包含 Main WebContentsView 的网页像素。
- Enter 导航成功后由产品将焦点交给网页，异步完成会检查同一模型、可见性、URL 和原焦点，避免抢走之后的用户操作。新增 en/zh-CN 独立 Electron 键盘场景在 Enter 后不执行测试 focus/click，断言网页获得焦点、Tab 进入网页输入、输入文本以及命令快捷键回到 Workbench。
- Main 既有页面键盘入口仅处理 F6 和 Ctrl/Cmd+L；新增定向回归确认 Ctrl/Cmd+Shift+P 未转交（1 failed，command-routing-before.log）。现已在同一入口转交该按键给 Workbench 自己的快捷键解析，不引入 Workbench 依赖或跨层命令调用。修复后 Main 模块 19 项单测通过（含所有权、生命周期、取消和网络权能），runner 自测五项通过；最后 Main 快捷键改动后的正常 Main/Preload/Renderer 构建已通过，格式和 diff-check 通过，日志没有 warning。
- 最新 renderer/automation 类型、CSS lint、格式及正常前端构建均通过。最后两个实际 OS 焦点键盘场景尚未运行，等待短独占焦点资源窗口；前述五场景不能算作这条链通过。父线程通信三次 read-only 探测均返回 Transport closed，不代表权限撤销。执行通道短暂断开后恢复，核对未落盘的文档操作与已完成的单测，继续独立工作。
- 不推送，不整合原始 checkout；本树依赖、协议、Cargo、runtime 和测试缓存继续保留。最终整合候选需包含最后键盘链实际结果，串行发布由父任务协调。

## 最终本机验收结论（2026-10-08）

- 取得短时 OS 焦点窗口后，开跑前 ps 确认无竞争 Ash Electron 或 Playwright；沿用同一已构建产物和独立临时 profile，没有重编译。
- `pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/browser-view.spec.ts --grep 'Enter hands keyboard input'`：en、zh-CN 两项真实 Mac Electron 场景均通过（2 passed，6.4 秒）。Enter 后无测试 focus/click；实际网页 WebContents 获得焦点，Tab 进入网页输入框，输入 `page text` 成功，Command+Shift+P 转交 Workbench 后命令面板可见且输入框有焦点，Escape 和关页完成。双语键盘截图及报告位于 `.build/handoff/electron-keyboard-1/` 与 `.build/handoff/layout-cloud/accepted-electron-browser-keyboard-*.png`。
- 自有实例已由 fixture 关闭，ps 无本树 Electron/Playwright 遗留；2026-10-08 10:32:23 UTC 确认 OS 焦点窗口已释放。该阶段日志只有既有 NO_COLOR/FORCE_COLOR 环境 warning，没有产品 runtime 错误。
- 完整验收包括先前五个真实 Electron 导航/页面操作场景、最后两个真实键盘场景、六个 Chromium 布局场景、19 项 Main 模块单测和五项模型单测；最后快捷键修复后的正常构建通过，renderer/automation 类型、格式、CSS lint、diff-check 已通过。早期失败与云端准确补丁仍保留，未覆写成成功。
- 功能已完成；候选只包含本任务 12 个文件，等待父任务串行 main 整合，不推送。独立工作树、依赖、协议、Cargo 和测试缓存继续保留。
