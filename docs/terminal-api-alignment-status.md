# Terminal API 对齐状态

## 本轮验证结果（2026-10-12）

剩余 54 项中新增 16 个实际使用的生产文件，当前同路径 51、缺失 38、仅 Ash 0。编辑区往返保留同一 PTY/屏幕，标签关闭释放进程；Clear/Relaunch/Kill 直接作用于编辑区实例。中英文 Rename/Icon 选择及关闭目标取消通过；用户元数据跨 PTY 替换保留。屏幕标记跨进程 ID 隔离、中文 ARIA/tooltip 与原命令导航通过；marker 淘汰即时释放监听。水平列表宽度重建和页面重载恢复，非法持久化数值使用默认尺寸。扩展 PTY 从 MainThread 内嵌类迁入标准代理文件，通用事件端口由 BasePty 拥有；原注册、实例和后端 owner 保持，关闭时丢弃晚到 frame，opaque handle 恰好发送一次释放。

最终 common 2387 文件与 renderer 3744 文件类型检查通过；正常 unit 入口 8 文件 139 项通过（含 24 项装载/架构检查、2 项 marker 生命周期和 3 项 provider PTY 边界），runner 自测 9 项通过；正常 Chromium 全套 74 项通过。曾被共享 Chat 修改阻塞：chat.json 顶层翻译值不是 bundle，chatListWidget.ts 的缺失 Symbol.dispose、chatListWidget.test.ts 的 implicit-any；期间保留外部修改、按原 compiler options 定向编译成功，并使用原 runners 验证。外部修复后最后正常入口重新通过，未把较早失败抹掉。终端 3 个 CSS 的 scoped stylelint 零错误（1 条原有 font-size 建议），精确 TS 格式、Markdown/NLS/CSS Prettier 与本批 whitespace 检查通过。全工作树 whitespace 曾另有范围外 task-agent.spec.ts 的 trailing whitespace，未修改。无 Electron/真实 SSH/Windows/Linux 运行声明。

38 个剩余路径仍待闭合消费链与前置契约，不按数量创建空壳；准确分类见下文当前差集。没有发起 commit/push；共享工作树期间其他操作提交了本批部分变化，未撤销这些提交或外部改动。

## 扩展 PTY 代理本批准入（2026-10-12）

真实 extension profile → 原 MainThreadTerminalService → 原自供 PTY 的 create/open/input/resize/read/close → 新上游同路径 browser/terminalProcessExtHostProxy.ts → 原 ITerminalChildProcess/TerminalInstance。原 MainThread 的内嵌 PTY 类退出，由对应代理唯一拥有 opaque handle、轮询/输入队列、取消、事件响应边界与释放；新 common/basePty.ts 仅拥有原 child-process 的 typed output/ready/property/exit 事件端口，被代理实际消费。注册/扩展 incarnation 属于原 MainThread；PTY 和 screen 仍属于原实例/后端，没有第二份 profile 或 Shell state。

准确新增（仅 VS Code）：browser/terminalProcessExtHostProxy.ts、common/basePty.ts。准确修改（双方已有）：src/ash/workbench/api/browser/mainThreadTerminalService.ts（只移出原 ExtensionProfilePseudoterminal，更新真实 factory import/名称，注册/配置校验保留）；既有 test/browser/terminalConfigurationService.test.ts（真实 profile→原实例的 start/input/reuse/withdraw lifecycle）；新增同路径 test/browser/terminalProcessExtHostProxy.test.ts（同步 open 输出、关闭中晚到 frame、opaque handle 恰好一次释放）、README、本台账。生产调用边已经存在，Core/API implementation 消费贡献的具体代理，公共契约/registry 不反向导入 contribution；服务层 EmbedderTerminalProcess 不迁入贡献。平台的现有 callback/JsonValue 是外部 provider 边界，不是生成 transport DTO。内部 typed payload 不重复校验，插件响应每条边界只解码一次。BasePty 的当前支持限于真实 string-output child-process 端口，不伪称 Rust byte-stream replay/persistence 完整支持。

## 统一装载本批准入（2026-10-12）

现有 Sessions Desktop/Web 入口 → 新同路径 `terminal.all.ts` → 核心 terminal.contribution 与实际存在的 per-instance contributions；核心 contribution 专注终端注册，不再反向装载独立增强。准确范围：terminal.all.ts（仅 VS Code）、browser/terminal.contribution.ts（只迁移现有 7 条副作用 imports）、src/ash/sessions/sessions.common.main.ts（现有真实消费者，仅增加统一装载 import、原 registerTerminalView 保留）、既有 integration terminal fixture（相同装载链）、README、本台账。双方都有的入口沿用当前服务组装；不生成未安装增强、不增聚合导出/注册桥。采用 sessions skill；Desktop/Web 类型检查、全终端 Chromium/装载既有 unit 覆盖。

## 面板列表宽度持久化本批准入（2026-10-12）

用户鼠标/键盘调整现有实例列表 sash → 原 TerminalTabbedView/SplitView → 新同路径 `common/terminalStorageKeys.ts` 的标准水平宽度 key → 原 StorageService 工作区机器状态 → 再建视图/重载恢复宽度。唯一几何 owner 仍为现有 SplitView；存储边界拒绝非法、超范围数值，单实例隐藏列表不覆盖用户宽度；不保存第二份运行中 layout state。

准确新增路径仅 VS Code：common/terminalStorageKeys.ts，仅导出真实使用的 TabsListWidthHorizontal。准确局部路径双方已有：browser/terminalTabbedView.ts（StorageService 构造注入/读取/保存）、test/browser/terminalTabsLayout.test.ts（实际 storage owner 的 fixture/重建断言）、test/browser/terminalTitleActions.test.ts（若 DI 需要只补 storage fixture）；现有 integration terminal fixture/spec（页面重载与非法 storage 值边界）、README、本台账。原 StorageService 是已批准跨宿主基础设施，无新持久化 backend 或自造 key；不创建未消费的垂直 orientation 和 layout serializers。

## 标题与图标本批准入（2026-10-12）

Rename / Change Icon 命令和实例菜单 → 新同路径 `browser/terminalEditingService.ts`（Quick Input 的编辑中实例和取消 lifetime）/`browser/terminalIconPicker.ts`（实际产品 icon registry 的搜索/选择）→ 原 TerminalInstance 的 rename/changeIcon → 原 TerminalService 刷新 labels → 面板列表和编辑器标签。标题/图标只由原实例拥有，Quick Input 不保存第二份 title；关闭目标取消选择，修改活动实例不会把选择写到另一个实例；Relaunch 保持用户元数据。

Ubuntu 自动图标不依赖配置名或终端标题。参照 VS Code 的职责划分，`BrowserTerminalProfileResolverService` 使用执行端已解析的启动程序和参数选择默认图标；配置菜单调用既有 `resolveIcon`，创建后的实例保存解析结果，显示层只消费图标。识别 Ubuntu launcher 及 `wsl.exe -d/--distribution` 的实际发行版名，保留显式图标优先级；Windows 原始命令行仅为识别读取，原启动字符串不被拆写，子命令里的 `-d Ubuntu` 不当作 WSL 参数。VS Code 在执行端自动发现 WSL 发行版时赋图标；Ash 的自定义 WSL 参数推断是本次用户要求的补充，不表示已实现 WSL 自动发现或读取无参数 WSL 的默认发行版。

本次图标验证：原 unit runner 的两项定向回归通过，覆盖配置改名、启动程序、两种 WSL 发行版参数、Windows 引号/反斜杠、子命令隔离、变量解析与显式覆盖；正常 Chromium 入口的三项场景通过，验证改名前后菜单和实例图标以及中文配置/原始命令行回归。

随后修复 PTY 类型与生命周期阻塞：保留上游 `string | IProcessDataEvent` 输出契约，实例转换字符串而保留结构化事件及其提交承诺。`AgentHostTerminalService` 的普通 Map 仅索引句柄，原实例 lifetime 是 PTY 的唯一 disposable owner；PTY 本地释放时立即注销，延迟关闭仅在索引仍指向自己时删除，不能删掉同 ID 的替代 PTY。后端窗口关闭仍请求剩余句柄 shutdown，原异步关闭结果、失败传播、重启和晚到进程释放由现有 owner 保持。自定义 PTY 在创建工厂返回前绑定到实例，窗口在异步发布前关闭时也能释放未打开的宿主句柄。导航夹具使用真实 addon，嵌入式终端测试等待可观察生命周期，扩展宿主夹具补齐真实环境变量服务的单一注册。

剩余五处类型错误已按原 owner 的契约闭合：App Server 适配层将 artifact 的二进制传输数组转换为领域字节，并保留合法 JSON 的原始字符串和空值内容；Chat 按内容联合类型区分 artifact 与 attachment；Sessions 服务夹具使用领域 `ThreadSubscription`，扩展目录夹具补齐元数据。完整运行暴露的夹具问题也已修正：终端布局和标题测试注册真实 `EnvironmentVariableService`，singleton 只由容器持有；只读资源测试分别验证 FileService 的能力检查、provider 的只读拒绝和拒绝后的原始字节。新增工具资源请求参数在 Rust 生成源注册，不手改生成文件。

运行器自测复制完整编译快照到自己的独立目录，并通过已有 `ASH_UNIT_TEST_OUTPUT_DIRECTORY` 将该目录交给子运行器，避免另一轮编译清理其夹具；测试资源预加载也读取同一快照，结束后由本轮清理。此前定向入口五文件 277 项和 `just verify ash-external-ext-protocol` 的 41 项测试通过。最终不带筛选的标准 `pnpm test:unit` 全部通过，退出码 0：资源、协议、语言和图标准备、类型编译、10 项运行器自测及 838 文件的 6353 项单测均通过。相关九个 TypeScript 文件格式检查通过；`just generate-protocol`、`pnpm typecheck:protocol` 和 `just verify ash-app-server-protocol` 的编译、129 项主测试、2 项兼容性测试、1 项生成一致性测试及警告检查通过。

准确新增路径仅 VS Code：上述 2 文件。准确局部路径双方已有：terminalInstance.ts（用户元数据）、terminalService.ts（已有 title callback 先刷新原组名，再发布 labels）、terminalActions.ts/terminalMenus.ts/common/terminal.ts（命令/菜单）、terminal.contribution.ts（delayed 注册）、terminalEditorInput.ts（已用原 label event）、terminalAccessibilityHelp.ts（发现性）；已批准服务契约 services/terminal/browser/terminal.ts；现有 integration fixture/spec、新 test/browser/terminalEditor.test.ts（元数据/资源回归）、terminalService.test.ts（复用）；zh-CN/workbench.json、README、本台账。采用现有 Quick Input 的键盘/焦点/取消路径，不添加无消费者 inline editing API 或其他新 owner；测试双语重命名、取消、图标搜索、关闭目标期间选择与复用。

## xterm 标记与布局本批准入（2026-10-12）

编辑区最小真实行为切片已通过：Chromium 5 项包含分屏、两种语言往返移动与失效资源恢复。继续下一批：原后端命令事件 → XtermTerminal → 新同路径 `browser/xterm/decorationAddon.ts` 唯一拥有屏幕 marker/decoration 及其监听生命周期 → 新 `markNavigationAddon.ts` 只读取已有屏幕 marker 导航 → 标准焦点命令。标记淘汰时立即释放事件监听，不再把已淘汰标记的 listeners 留到整屏 dispose。新 `decorationStyles.ts` 独立生成有 NLS 的状态说明供 tooltip/ARIA；新 `browser/media/xterm.css` 承接既有 Ash 屏幕几何/命令状态样式。没有 Shell parser、第二份 command history/capability store；这些 addons 的当前支持是显示/导航已提交后端事件，不声明完整上游 capability API。

补充验证准入：新增 `test/browser/xterm/decorationAddon.test.ts`，用可观察的 marker/render 事件订阅测试 xterm 淘汰后的即时释放与屏幕关闭，沿用原 marker owner，不访问私有实现字段。

准确路径：上述 4 个缺失同路径文件（仅 VS Code）；双方已有 `browser/xterm/xtermTerminal.ts`（移出屏幕标记/导航 hunk）、`browser/media/terminal.css`（仅移出同一屏幕所拥有样式）、现有 integration fixture/spec（状态、trim/clear、跨 PTY 重用、双语/主题/焦点）。新增 `common/terminalStrings.ts`（仅 VS Code）集中真实消费的编辑区命令和导航 label；现有 terminalActions.ts/terminalEditorInput.ts/terminal.contribution.ts 仅迁移这些 label import。zh-CN/workbench.json、本台账、README 记录结果。标记对象继续属于同一屏幕，xterm 负责缓存淘汰，addons lifetime 跟随屏幕；不复制上游实现或私有结构。

## 编辑区终端本批准入（2026-10-12）

移动到编辑区/面板 → terminalActions → TerminalEditorService + 现有 EditorService/Groups → TerminalInstance 的 target、稳定 URI 与原 xterm → 面板组过滤并迁移同一屏幕 → 关闭编辑器释放原 PTY、移动保留实例。序列化只恢复资源身份，不执行或复活已失效进程；资源含本次实例的随机身份，旧工作集不会绑定新 Shell。

准确新增路径（仅 VS Code）：`browser/terminalUri.ts`、`browser/terminalEditorInput.ts`、`browser/terminalEditorSerializer.ts`、`browser/terminalEditor.ts`、`browser/terminalEditorService.ts`。唯一 owner：TerminalService/Instance 拥有 PTY、屏幕及 target；EditorPart 拥有编辑器成员/生命周期；编辑区服务仅拥有输入值和订阅，不保留第二份活动实例。准确局部修改（双方都有）：`browser/terminalInstance.ts`（URI/target/event）、`browser/terminalGroupService.ts`（target 订阅和面板过滤）、`browser/terminalView.ts`（只附着面板实例）、`browser/terminalTabsList.ts`、`browser/terminalTabbedView.ts`（面板成员过滤）、`browser/terminalActions.ts`、`browser/terminal.contribution.ts`、`common/terminal.ts`（命令/DI/注册）、`browser/media/terminal.css`（编辑区几何）；已批准 Ash 契约 `services/terminal/browser/terminal.ts`（target/editor 服务契约）；`platform/terminal/common/terminal.ts`（标准 TerminalLocation enum）。验证文件：现有 terminal integration fixture/spec，新增同路径 `test/browser/terminalEditor.test.ts`；既有 terminalTabsLayout/terminalService tests，terminal 无障碍帮助、zh-CN/terminal.json、README 与本台账。平台范围参照 platform reference。所有其他变化保持；无上游私有结构或代码复制。

## 文件清单批处理（2026-10-12）

按文件清单覆盖现有消费链，不创建无消费者的剩余文件。第一批准入：新建上游同路径 `browser/xterm/{xtermAddonImporter.ts,terminalFontRendering.ts,terminalFontRendering.css}` 与 `browser/{terminalIcons.ts,terminalTooltip.ts}`。Find → XtermTerminal → importer 的 search 构造加载；配置 fontRendering → 原 xterm 字体策略/atlas refresh；菜单/列表 → terminalIcons 与 getShellProcessTooltip → 当前实例只读 PID/cwd/profile/state。所有 screen、Shell 状态和 PTY 仍归原 owner；不构建第二个 capability store。Decoration/MarkNavigation 的完整上游端口需要下层 capability 契约，不能把当前状态 facade 当成已完成的 capability owner。

第一批准入修改路径：上述 5 个新文件、现有 xtermTerminal.ts、terminalMenus.ts、terminalTabsList.ts、common/{terminal.ts,terminalConfiguration.ts}；现有 terminalConfigurationService.test.ts 与 integration terminal fixture/spec；中文语言包、Terminal README、本台账。CSS 使用 Ash class 与主题，无上游复制。定向验证包括 Find、实时配置、字体模式、atlas 清理、tooltip 目录更新、中文说明与既有主题/焦点/释放。

第二批准入：Split / 焦点命令 → 原 View/profile resolver → 原 TerminalService 创建独立 PTY → 新 `browser/terminalGroupService.ts` 唯一拥有组成员 → 新 `browser/terminalGroup.ts` 使用现有 SplitView 拥有组内几何与 screen attach/visibility → 原实例/进程管理器 resize；新 `browser/terminalCommands.ts` 接标准按序号焦点命令。组服务从原 TerminalService 派生活动组，不保留第二份 active instance。关闭由原实例服务负责，移动成员不会重启/释放 PTY；View 释放仅 detach 屏幕和组 DOM，服务保持结构。

第二批准入范围：上述 3 个缺失同路径文件，现有 `services/terminal/browser/terminal.ts` 仅 group 领域契约，terminal.contribution.ts 的注册/装载；terminalView.ts 的 attach、visibility 与 split create hunk，terminalActions.ts、terminalMenus.ts、common/terminal.ts 的标准 Split/FocusNextPane/FocusPreviousPane/Unsplit 命令与菜单；terminal.css 的组容器几何、无障碍帮助、中文语言包；terminalInstance.ts 与既有 terminalService.test.ts 补只读标准 shellLaunchConfig，从原启动快照派生供 Split 复用原 Shell；现有 terminalTabsLayout.test.ts 的组服务行为测试，terminalTitleActions.test.ts 仅补新增的组服务 DI 和生产图标解析 fixture与 terminal integration fixture/spec。Group 仅承接已创建实例，不提前补同步 Shell 创建的 InstanceService API；Shell backend/实例生命周期仍由现有 owner 负责。当前支持组内水平分屏，未声明垂直 orientation/editor/group persistence 完整对齐。

第三批准入：既有 TerminalProcessManager 的真实 read/write/resize 失败 → TerminalInstance 的原 error 状态，同时交给新上游同路径 `browser/terminalStatusList.ts` 保存显示原因 → 已补 terminalTooltip 与 Tabs 行监听显示具体原因；替换 PTY 时清除旧显示消息。状态列表仅拥有 UI 消息，不保存 Shell 命令、连接或进程状态，原状态 owner 不变。准入路径：terminalStatusList.ts、terminalInstance.ts、services/terminal/browser/terminal.ts、terminalTooltip.ts、terminalTabsList.ts、既有 terminalService.test.ts / terminal integration fixture/spec、中文 NLS、本台账与 README。验证真实输入拒绝后的消息、Relaunch 清理、tooltip 与中文文本。

本轮结果：9 个缺失生产文件已落在准确上游路径并接入真实消费者：`terminalIcons.ts`、`terminalTooltip.ts`、`xterm/xtermAddonImporter.ts`、`xterm/terminalFontRendering.ts`、`xterm/terminalFontRendering.css`、`terminalGroup.ts`、`terminalGroupService.ts`、`terminalCommands.ts`、`terminalStatusList.ts`。两个 Shell 的输入和尺寸确认仍分别进入原 PTY；组内 pane 的 mouse/focus、焦点命令与 sash 只更改原 TerminalService 活动实例和原屏幕尺寸。Unsplit/移动只迁移 DOM 与结构，不新建/关闭进程。Kill 保留仍有实例的 panel 并回到剩余 pane，最后一个关闭才隐藏。组服务使用标准 delayed singleton，View 仍只附着和释放实例屏幕；更新不重复 append 已在正确 parent 的 screen，保留显式焦点。失败原因作为 UI status 显示在 tooltip，Relaunch 清除旧原因。

验证：正常 `pnpm test:unit` 四个终端文件共 105 项通过，runner 自测 9 项通过；正常 Chromium Terminal 全套 66 项通过（新字体模式、分屏输入路由/几何/关闭焦点、中文 sash/Unsplit/序号命令，以及中文失败 tooltip/重启清理）。Renderer 3720 文件、common 2339 文件和完整浏览器/test 编译通过。初次全 test 编译被共享工作树 chatViewPane.test.ts 的重复 import 阻塞，按原 compiler options 定向编译和原 unit runner 验证后，共享修改修复了该重复 import，最终正常入口通过。浏览器 fixture 补上产品拥有的动态 icon resolver、SplitView CSS、执行端 OS、speech/Views/group DI；未修改产品主题或基础 widget 来掩盖 fixture。全仓 stylelint 当前在范围外 sessionChangesEditorInput.css 的 class substring selector 上失败；终端相关 CSS 单独验证，不能把全仓样式记为通过。本机为 macOS Chromium，未运行 Windows/Linux/真实 SSH 或 Electron 产品验证。

当前完整 terminal 生产 TS/CSS 审计：同路径 51、缺失 38、仅 Ash 0（排除 tests 与 README），本轮在上一轮 54 项中完成 16 个缺失文件。新增编辑区的 URI/Input/Serializer/Pane/Service、重命名 UI owner、图标 picker、decoration/mark navigation/styles、屏幕 CSS、共享 labels/宽度 key 与统一装载入口均有真实消费者；仍不表示各文件完整公开 API 已对齐。编辑区持久化只恢复资源身份，失效实例显示不可用，不保存/恢复 PTY；分屏目前只在面板内提供水平窗格。后文旧审计按历史批次记录，当前差集以本节为准。

当前准确剩余 38 项（相对 `src/ash/workbench/contrib/terminal`）：

- 实例与事件（3）：`browser/terminalEscapeSequences.ts`、`browser/terminalEvents.ts`、`browser/terminalInstanceService.ts`。
- widgets 与 xterm（8）：`browser/media/widgets.css`、`browser/terminalTabsChatEntry.ts`、`browser/terminalTestHelpers.ts`、`browser/widgets/terminalHoverWidget.ts`、`browser/widgets/widgetManager.ts`、`browser/widgets/widgets.ts`、`browser/xterm-private.d.ts`、`browser/xterm/lineDataEventAddon.ts`。
- backend、remote 与 Agent（11）：`browser/agentHostOutputChannel.ts`、`browser/agentHostPty.ts`、`browser/agentHostTerminalService.ts`、`browser/ahpTerminalCommandSource.ts`、`browser/baseTerminalBackend.ts`、`browser/chatTerminalCommandMirror.ts`、`browser/detachedTerminal.ts`、`browser/environmentVariableInfo.ts`、`browser/remotePty.ts`、`browser/remoteTerminalBackend.ts`、`browser/terminal.web.contribution.ts`。
- common 与 Electron（16）：`common/environmentVariable.contribution.ts`、`common/environmentVariable.ts`、`common/environmentVariableService.ts`、`common/remote/remoteTerminalChannel.ts`、`common/remote/terminal.ts`、`common/terminalEnvironment.ts`、`common/terminalExtensionPoints.contribution.ts`、`common/terminalExtensionPoints.ts`、`electron-browser/localPty.ts`、`electron-browser/localTerminalBackend.ts`、`electron-browser/terminal.contribution.ts`、`electron-browser/terminalNativeContribution.ts`、`electron-browser/terminalProfileResolverService.ts`、`electron-browser/terminalRemote.ts`、`terminalContribChatExports.ts`、`terminalContribExports.ts`。

剩余清单不作完成声明：Electron/local/remote/AHP backend 要先闭合共享 child-process/backend 与 Rust transport owner；同步 InstanceService 不能用当前异步 create 的转发壳冒充。环境集合/extension points 需先有真实插件域契约；widgets、lineData、private xterm、事件 multiplexer 与 Chat exports 需有实际消费边。已有平台适配器、Rust Shell parser/nonce/history 和 services/terminal 的领域契约继续保持唯一 owner；没有创建空模块、重复注册或假 capability store。

## Send Sequence 本批准入（2026-10-12）

用户 keybindings.json 的 Send Sequence 或命令面板 → 既有 Terminal contribution 装载 sendSequence → 当前窗口 TerminalService 的运行实例 → 原 ConfigurationResolverService 与该实例所属 Workspace folder → 原 TerminalInstance.sendText(false) → TerminalProcessManager 输入队列与后端确认。实例/服务仍拥有进程与屏幕；新 contribution 只拥有一次调用的取消订阅，不保存业务状态或创建 PTY。

准确路径：双方已有的 `terminal/browser/terminal.contribution.ts` 只装载入口，`terminal/common/terminal.ts` 只补标准命令 ID；VS Code 有而 Ash 缺失的 `terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.ts` 独立实现命令入口；双方已有的 `terminalContrib/accessibility/browser/terminalAccessibilityHelp.ts` 补帮助。现有 `terminal/test/browser/terminalService.test.ts` 覆盖真实实例输入、确认、失败、异步解析与生命周期；既有 `test/integration/browser/terminal.integration.ts` / `terminal.integration.spec.ts` 补产品 keybinding 与 Quick Input 场景。浏览器 fixture 准入补充：原 history contribution 需要的 StorageService 尚未装配，导致屏幕创建失败；仅在既有 setupTerminalFixtureServices 中装配真实 BrowserStorageService，不改变产品 owner。另仅更新中文 NLS、Terminal README 和本台账。现有仅 Ash 的 README/行为测试沿用此前台账确认职责；不修改其他缺失文件、CSS、Rust、protocol 或 HistoryService。

上游公开行为证据：标准命令接受 `{ text: string }`，无文本时提示输入，提示文本支持反斜线 n/r 与两位十六进制，经配置变量解析后发送而不追加执行回车。Ash 使用既有实例的 folder ID 选择变量上下文，不向尚无该 API 的 HistoryService 增加替代公开端口。参数是命令边界；变量解析、提示与后端确认期间一旦 active instance、实例状态/退出、成员或 workspace 发生变化，该调用失效。订阅在完成/失败时释放，原屏幕保留自己的 DOM、焦点与布局；没有新的 UI surface 或样式。

本批结果：标准 Send Sequence 命令已通过原 Terminal contribution 装载，可从命令面板输入或 keybindings.json 传入 text；只对提示输入单次解码 n/r/xNN，不重解码参数或十六进制生成的反斜线。原 resolver 使用实例 folder ID 解析变量，原 sendText 保留 LF/CRLF 到 CR 的既有输入语义，不追加 Enter、不使用 bracketed paste，并等待原后端输入确认。运行实例与 active instance/进程 PID 检查阻止旧解析写入复用 Shell；状态、退出、关闭、切换和 workspace 事件取消该调用。变量仍未完成时取消立即结算，晚到失败仍被观察，订阅由该次调用释放。

验证：正常 `pnpm test:unit --run .../terminalService.test.ts` 的 67 项通过（本批新增 12 项，包括原真实实例、multi-root folder、后端确认/拒绝、prompt 解码、无终端、无效参数、延迟结果、复用、取消与晚到失败）；runner 9 项自测通过。正常 `pnpm test:browser:integration terminal.integration.spec.ts --project=chromium` 的 Chromium 62 项全部通过，包括新增的真实用户快捷键、Quick Input Enter/Escape、终端焦点恢复、英文/中文提示与无障碍帮助，以及原 Find/clipboard/实例/配置/布局场景。common 2331、Renderer 3696、浏览器 3501 文件类型检查与 test TypeScript 编译通过；7 个相关 TS 文件格式、文档/语言包 Prettier 和 diff whitespace 检查通过。初次测试暴露 fixture 重复注册 resolver 和缺少 StorageService，现已改为可配置的单一测试 resolver 和真实存储装配；multi-root 输入断言保留真实 dirId 路由。本批不声称补齐 Shell 专属默认控制快捷键、完整 sendSequence keybinding 注册端口、服务器 flow control、group/editor/Agent owner；未运行真实 Windows/Linux/SSH Shell。共享工作树同期的 Session route、Tasks 和 Rust 改动保留；本 agent 未提交或推送。

## 命令导航与跨重启历史本批准入（2026-10-12）

用户运行 Shell 命令 → 现有 resolver 与 TerminalInstance → 执行端 Rust tracker 校验 nonce 并发布完成命令 → TerminalProcessManager 在 xterm 输出提交后派发状态 → xtermTerminal 为该 PTY 命令保留可导航 marker；同一完成事件由 Terminal History contribution 过滤 Task 与非可信文本后写入应用级 StorageService → Recent Command Quick Pick 仅按当前 profile 读取 → 用户选择后通过原 TerminalInstance.sendText 启动。

VS Code 公开行为：终端提供上一/下一命令滚动导航，以及按 Shell 类型过滤的最近命令 picker；最近命令跨窗口重载保存，历史条数由 `terminal.integrated.shellIntegration.history` 控制，0 禁用。Ash 以稳定 profile ID 隔离 Shell 命令，历史归应用级机器本地可重建状态，不随工作区或执行主机切换；Rust tracker 仍是当前 PTY 唯一状态 owner，StorageService 只保存已完成的跨会话历史。只有 nonce 匹配的文本可进入历史；恢复和显示不执行命令，picker 接受是唯一执行入口。P;Task、未可信文本、空命令和禁用设置均不写入。

准确范围：双方已有的 `src/ash/workbench/contrib/terminal/{browser/terminalActions.ts,browser/terminal.contribution.ts,browser/xterm/xtermTerminal.ts,common/terminal.ts,common/terminalConfiguration.ts}` 只补本批导航/注册/历史设置；`src/ash/workbench/services/terminal/browser/terminal.ts` 只扩展已有 `IXtermTerminal` 屏幕端口；双方已有的 `src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibilityHelp.ts` 更新帮助。VS Code 有而 Ash 缺失的 `src/ash/workbench/contrib/terminalContrib/history/{common/terminal.history.ts,common/history.ts,browser/terminal.history.contribution.ts,test/common/history.test.ts}` 按已到达的生产链原路径建立并独立实现。新增回归覆盖 `terminalContrib/history/test/{common/history.test.ts,browser/terminal.history.contribution.test.ts}` 与 `terminal/test/browser/xterm/xtermTerminal.test.ts`：PowerShell/Bash/Zsh profile 隔离、Task/nonce 过滤、同一实例复用后的重复 command ID、marker 导航和重新创建 StorageService 后的恢复。同步更新英文/简体中文 NLS、Terminal README 和本台账；不改 Rust/protocol/PTY/resolver/Task owner，不创建新服务或没有调用方的 API。

本批结果：上一/下一命令导航使用原 xterm 中按 PTY 与 command ID 关联的 live marker，忽略滚出缓冲区的 marker，并在 alternate screen 不移动；Terminal History contribution 只接收现有 TerminalInstance 已由 nonce tracker 标记可信的完成事件，沿用 Shell integration Task storage opt-out。命令只进入 `StorageScope.APPLICATION` 的 machine-local StorageService，按稳定 profile ID 筛选，受 `terminal.integrated.shellIntegration.history` 上限与总字节预算约束。重启恢复只显示文本；只有用户接受当前 Quick Pick 的一项，且原终端仍在前台并运行时，才调用原 `TerminalInstance.sendText`。

验证：定向 history common/browser 与 xterm 套件 8 项通过；再跑现有 `TerminalService` 生命周期套件 54 项通过，其中包含 Bash/Zsh/PowerShell 实际实例复用、旧 PTY 元数据隔离和解析确认时序。前一组覆盖 PowerShell/Bash/Zsh profile 隔离、nonce 缺失或不匹配、Task opt-out、复用 command ID、显式 picker 接受和重建 StorageService 后恢复。common 2331 文件类型检查与 test TypeScript 编译通过；13 个相关 TS 文件精确格式检查、文档/语言 JSON Prettier 检查及 `git diff --check` 通过。语言包生成仅报告已有的 `ash/color.editorGutter.itemBackground` 缺译；本批新增的简体中文条目齐全。Rust 端真实 Bash/Zsh/PowerShell nonce、Task opt-out 与 PTY 复用回归由相邻 Shell integration 批次覆盖。

## 命令文本、历史和 capability 本批准入（2026-10-12）

用户执行 Shell 命令 → 原 resolver/TerminalInstance/ShellIntegration → 原 Rust TerminalCommandStatusTracker 解码 E 和 nonce、保留有界完成历史及检测 capability → 原 PTY drainer/read/protocol adapter → 原 TerminalProcessManager 在屏幕解析确认后发布 snapshot → TerminalContext 使用命令历史与 capability → nonce/真实 Shell/复用/解析确认回归。

VS Code 公开事实：E 的转义文本可在 C 前或 D 前发送；nonce 匹配才 isTrusted，缺省/不匹配仍有文本但不可信。Cwd 的 nonce 独立校验；HasRichCommandDetection 表示完整协议支持，Task 禁用命令存储。只补 Ash 当前 tracker、领域契约与真实消费者，不引入另一套 capability store、parser、历史 owner 或自动重执行。

准确范围：Rust 的既有 terminal.rs、command_status.rs/tests、shell_integration.rs、profiles_tests.rs、service_tests.rs；exec-server-protocol terminal.rs/protocol_tests.rs；App Server protocol terminal.rs/registry.rs 与既有协议测试；app-server/server/terminal_operations.rs（均沿用用户明确保留的 owner）。双方有对应路径的 TS platform/terminal/common/terminal.ts、contrib/terminal/browser/terminalProcessManager.ts、terminalInstance.ts 与其 TerminalService 测试；此前批准的 Ash services/terminal/browser/terminal.ts、platform/terminal/browser/appServerTerminalProcessService.ts 及 local/SSH adapter 测试、contrib/chat/browser/actions/chatContext.ts（当前终端上下文消费者）。已有 test/integration/browser 的 terminal.integration.ts/spec、chatInput.integration.ts、chatContextActions.integration.spec.ts，以及本台账与 contrib/terminal/README.md；只改本批契约、snapshot 消费和回归 hunk，其他共享修改保留。新增准入：双方已有的 contrib/terminal/browser/xterm/xtermTerminal.ts，仅修复既有命令 decoration 的进程身份 key；原 TerminalInstance 事件是生产调用方，xterm 继续拥有渲染标记，验证复用后同名命令 ID 各有标记。没有 CSS/主题或新 UI label。

本批结果：原 tracker 消费转义 E（C 前或 D 前）、按每个注入 PTY 的随机 nonce 标记文本及 cwd 来源，错误/缺省/旧 nonce 均不可信；不是执行授权。nonce 不导出为子进程环境或客户端字段。完成历史保存原命令 ID、文本、cwd、状态/退出码与可信标记，最多 256 条且命令记录按文本/cwd 的 JSON 编码预算限制为 512 KiB；事件环使用同一预算，淘汰后报告 gap。实际消息驱动 command/cwd/rich detection，P;Task 禁用文本存储并清空历史；显式 Task execution 继续不解析 Shell OSC。Bash 用新的历史项，忽略输入/禁用 history 时不记录陈旧文本；Zsh preexec 与 PowerShell readline 保留完整输入，Unicode、多行与控制字符转义由原 wrapper 完成。

新增字段在原 App Server/exec-server 协议可选，旧 frame round-trip 保持；生成器拥有绑定/schema。TerminalProcessManager 等原 xterm commit 再发布只读领域 snapshot，不在浏览器重建 Shell 协议历史；TerminalContext 实际消费历史与 capability，附件保留接受时的原快照。重连维持原 PTY；复用刷新 nonce、清空原进程管理器的历史/capability 并隔离旧读取。没有平行 resolver/Task/Terminal/PTY owner、前端 parser、自动重执行或新的视觉组件。本批另接入只读命令 marker 导航和独立的已完成命令跨重启历史。

验证：终端/原 local+SSH adapter 62 项通过；包含解析前隐藏 history/capability、解析后发布文本和信任标记、重连不追加重复历史、Bash/Zsh/PowerShell 三种复用丢弃旧 snapshot。Terminal/Chat Context/AppTools/Testing Chromium 136 项通过，新增同名 command ID 的原 xterm decoration 跨 PTY 复用回归；沿用原样式与 ARIA 状态标签。全浏览器 3497、Renderer 3692、common 2329、协议 1441 文件类型检查通过。Rust `just verify`：exec-server terminal 44（真实 macOS Bash 3.2/Zsh/PowerShell 7.6.6，包括 Unicode、多行、旧/缺省/错误 nonce、子程序伪造 E、login/用户 hooks、忽略输入/关闭 history、Task storage opt-out、长 cwd/控制字符转义的元数据 wire 预算、当前 cwd 与退出码）、App Server terminal 16、exec-server 协议 8、App Server 协议 128 + 3 项集成测试通过，并完成四包 check/test/all-targets deny-warnings。隔离 Bash 5.2.37 的 PS0、login、DEBUG trap 与 history opt-out 真实 PTY 回归另行通过。Windows MSVC exec-server all-targets deny-warnings 和 Linux 测试目标编译通过；未实跑 Windows ConPTY。13 个 TS、12 个 Rust 文件精确格式、两份 Markdown 和当前 diff whitespace 检查通过。

完整前端/架构回归执行 288 项，286 项通过、2 项失败：共享工作树在本批期间移除 `workbench.common.main.ts` 的 Tasks contribution 装载，触发 editor-architecture 的两条既有断言。本批保留该外部修改，没有把完整架构记为通过。共享工作树在处理中由其他操作更新到 d88cc1695，本 agent 没有发起 commit/push；其余外部变更保留。

## Shell integration 本批准入（2026-10-12）

先 rebase origin/main，保留远端三个提交和原 Windows raw 参数提交，合并 Tasks/Output 的单注册入口；装配类型检查发现重复 MarkerService import/实例注册，收敛到已有唯一注册。当前 Shell 行为 → 原 resolver/TerminalService/TerminalInstance → exec-server 的既有 profile/ShellIntegration 与 TerminalCommandStatusTracker → 原 PTY drainer → 原 protocol adapter/TerminalProcessManager 解析确认 → 命令状态、当前 cwd 与 Chat terminal attachment → 定向 unit/真实 Bash/Zsh/PowerShell PTY/浏览器与复用回归。

VS Code 公开协议事实：633 A/B 是 prompt/input 区域，C 是实际执行，D 的状态缺省保留未知；P;Cwd 使用反斜线与 xHH 转义。PowerShell prompt 上报 $? 的 0/1，不能用陈旧 LASTEXITCODE 代替；Bash/Zsh 保留实际状态。本批按这些事实独立实现；不复制上游脚本、addon 或 capability 状态，Rust tracker 继续拥有命令与 cwd，屏幕/解析确认/Task 完成仍由原 owner 承接。

准确范围（TS 同路径局部变更；services/terminal 和 Chat context 是此前批准的领域契约/消费者归属；Rust 与协议为用户明确保留的既有 owner）：

- `src/ash/sessions/browser/workbench.ts`（rebase 装配去重）
- `src/ash/workbench/services/tasks/test/browser/taskService.test.ts`（共享工作树重复 mock import 只做编译去重，其余保留）
- `crates/exec-server/src/terminal/command_status.rs`
- `crates/exec-server/src/terminal/command_status_tests.rs`
- `crates/exec-server/src/terminal/shell_integration.rs`
- `crates/exec-server/src/terminal/profiles.rs`
- `crates/exec-server/src/terminal/profiles_tests.rs`
- `crates/exec-server/src/terminal/service_tests.rs`
- `crates/exec-server/src/terminal.rs`
- `crates/exec-server-protocol/src/terminal.rs`
- `crates/exec-server-protocol/src/protocol_tests.rs`
- `crates/app-server-protocol/src/protocol/terminal.rs`
- `crates/app-server-protocol/src/protocol/registry.rs`
- `crates/app-server/src/server/terminal_operations.rs`
- `src/ash/platform/terminal/common/terminal.ts`
- `src/ash/platform/terminal/browser/appServerTerminalProcessService.ts`
- `src/ash/workbench/services/terminal/browser/terminal.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProcessManager.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalInstance.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`
- `src/ash/platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts`
- `src/ash/workbench/contrib/chat/browser/actions/chatContext.ts`
- `test/integration/browser/terminal.integration.ts`
- `test/integration/browser/terminal.integration.spec.ts`
- `test/integration/browser/chatContextActions.integration.spec.ts`
- `test/integration/browser/chatInput.integration.ts`（terminal context cwd 数据，以及 rebase 后 AnythingQuickAccess 所需的既有 Search/Path 领域服务 fixture 装配）
- `src/ash/workbench/contrib/terminal/README.md`

本批结果：按真实 executable 为自定义 PowerShell/Bash/Zsh profile 注入；633 A/B 仅表示 prompt/input，C/D 由原 Rust tracker 产生执行记录与状态，缺省 D 保留未知完成。P;Cwd 解码反斜线和 xHH，支持 BEL/ST 与任意分块，非法/未知 OSC 保留原字节并限制未终止缓存。命令保存开始时的 cwd；最新 cwd 与输出序号通过原协议 adapter 和进程管理器传递，原屏幕解析完成后才更新，Chat terminal context 使用当前目录。进程信息保留退出前最后检测目录，未检测到时继续使用 OS 查询。复用重建原进程管理器、等待旧 PTY 释放，保留原实例/屏幕并隔离旧 cwd、事件和游标。

Bash/Zsh 保留用户 prompt/startup、真实数值状态、多行与输入程序；Bash 登录配置由 wrapper 加载，已有 3.2 DEBUG trap 保留。PowerShell 仍以 $? 上报 0/1，保留用户 prompt/PSReadLine，不使用陈旧 LASTEXITCODE，真实 OS 退出单独报告。显式命令和 raw Windows 参数不改写；独立 Task 执行不消费 shell OSC，任务生命周期仍由 Task/PTY owner 完成。协议新增可选字段，旧 frame 可读，不迁移 resolver/PTY owner；cwd 不授予路径权限。命令文本/历史、nonce 可信命令文本与 Shell capability 仍未声明完成。

验证：标准前端 unit/架构 8 文件 288 项通过；Terminal/AppTools/Testing Chromium 89 项与 Chat Context 44 项通过，包含真实 xterm 解析 gating、当前 cwd 附件及中英文既有消费者。rebase 后补齐 Chat fixture 的 Search/Path 领域服务依赖、保留结构化命令参数，并让异步 child picker 的键盘回归显式定位目标结果，继续验证 Ctrl+Enter。全浏览器 3496 文件、Renderer 3691、common 2328 与协议 1440 文件类型检查通过。`just verify` 的 exec-server terminal 40 项（真实 macOS Bash 3.2/Zsh/PowerShell 7.6.6，包含 login、自定义配置、set -u、用户 hooks、多行/空输入/Read-Host/中断、旧 LASTEXITCODE、退出 19 与转义目录）、App Server terminal 16 项、App Server 协议 128 项及其 3 项集成测试、exec-server 协议 8 项通过，四个包 check/test/all-targets deny-warnings 均通过。Windows MSVC exec-server all-targets deny-warnings 与 Linux exec-server 测试目标编译通过；本机 macOS，没有实跑 Windows ConPTY 或 Windows Bash/Zsh。协议/绑定由原生成器生成；本批 TS 13 文件与 Rust 12 文件精确格式、两份 Markdown 与当前工作树 `git diff HEAD --check` 通过。共享工作树的 Tasks/App Tools 与 UI scenario 其他修改保留，未 commit/push。

## Windows 原始 CommandLine 本批准入（2026-10-12）

Windows profile/automation/Agent/Debug/Task → 原 profile resolver / TerminalTaskSystem → string 或 argv 的领域与生成传输契约 → 原 App Server/exec-server → 原 PTY/ConPTY owner → argv 正常引用，raw string 原样追加至已引用 executable。原实例 reuse/Relaunch 保存字符串而不按字符复制，数组保留不可变 argv 快照；非 Windows 在配置/resolver/执行边界拒绝 raw string。

VS Code 公开 IShellLaunchConfig.args 与 ITerminalProfile.args 为数组或 Windows-only 原始字符串；Task shell options.args 仍是数组，可单独覆盖默认 profile，显式 executable 不注入默认 shell flags。Windows cmd/PowerShell/WSL/Nu Task 使用完整 CommandLine；Windows Bash/Zsh/Fish 的数组保持 argv。只取公开契约与上述最小调用行为，独立实现，不迁移状态 owner。

准入路径：既有 TypeScript 同路径文件只改参数契约/实际消费者，services/terminal 为已批准 Ash 契约归属；现有 platform adapters、protocol、Rust PTY/ConPTY 与 typed fixtures 由原 owner 承接。WezTerm 本地改动保留许可证，仅补 Windows raw 参数 tail 和验证；不改 Unix upstream 实现。生成物只由生成器产生。准确范围：

- `src/ash/platform/terminal/common/terminal.ts`
- `src/ash/workbench/services/terminal/common/terminal.ts`
- `src/ash/workbench/contrib/terminal/common/terminalConfiguration.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProfileResolverService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProfileService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalInstance.ts`
- `src/ash/platform/terminal/browser/appServerTerminalProcessService.ts`
- `src/ash/platform/terminal/browser/reconnectableTerminalProcessService.ts`
- `src/ash/workbench/contrib/tasks/browser/terminalTaskSystem.ts`
- `src/ash/workbench/services/tasks/common/workspaceTasks.ts`
- `src/ash/workbench/api/browser/mainThreadTerminalService.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalConfigurationService.test.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`
- `src/ash/workbench/services/tasks/test/common/workspaceTasks.test.ts`
- `src/ash/workbench/services/tasks/test/browser/taskService.test.ts`
- `src/ash/workbench/services/debug/test/browser/debugTerminalLauncher.test.ts`
- `src/ash/workbench/services/debug/test/browser/debugService.test.ts`
- `src/ash/platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts`
- `test/integration/browser/terminal.integration.ts`
- `test/integration/browser/terminal.integration.spec.ts`
- `test/integration/browser/appTools.integration.ts`
- `crates/app-server-protocol/src/protocol/terminal.rs`
- `crates/app-server-protocol/src/protocol/registry.rs`
- `crates/app-server/src/server/terminal_operations.rs`
- `crates/exec-server-protocol/src/terminal.rs`
- `crates/exec-server-protocol/src/lib.rs`
- `crates/exec-server-protocol/src/protocol_tests.rs`
- `crates/exec-server/src/terminal.rs`
- `crates/exec-server/src/terminal/profiles.rs`
- `crates/exec-server/src/terminal/profiles_tests.rs`
- `crates/exec-server/src/terminal/service_tests.rs`
- `crates/exec-server/src/terminal/shell_integration.rs`
- `crates/utils/pty/src/pty.rs`
- `crates/utils/pty/src/lib.rs`
- `crates/utils/pty/src/windows_tests.rs`
- `crates/utils/pty/src/tests.rs`
- `third_party/wezterm/portable-pty/src/cmdbuilder.rs`
- `third_party/wezterm/README.md`
- `crates/external-js-ext/src/vscode.js`
- `crates/external-js-ext/src/node.test.mjs`
- `src/ash/workbench/contrib/terminal/README.md`
- `extensions/language-pack-zh-cn/translations/workbench.json`

本批结果：Windows 原始字符串由配置/扩展 TerminalProfile、原 resolver、TerminalArguments 领域契约、本地与 SSH adapter、生成协议和内部 exec-server 协议传到现有 PTY/ConPTY。数组维持 argv 引用；原始字符串保留引用、首尾空格和空值，不拆词、不按字符展开，不再经过 argv 二次转义。真实 CreateProcessW executable 继续单独引用；最终命令行以 UTF-16 长度（包含 NUL）限制，拒绝 NUL/混合 argv；非 Windows 在配置、resolver 和执行边界拒绝字符串。Task 的 shellArgs 仍为数组，可独立覆盖默认 profile；显式 executable 不添加默认命令标志。Windows 原生 Shell task 拼接完整命令行，Bash/Zsh/Fish 保留数组语义，raw prefix 的完整 command 则引用成一个 Windows 参数。复用保存完整不可变启动快照，沿用原实例、屏幕、Task 状态与旧 PTY 释放确认。内部 exec-server wire 版本 4→5，App Server 更新 schema/hash 和生成声明，旧数组表示保持；没有迁移执行 owner。

验证：标准 unit 10 文件 380 项通过（Task/Terminal/profile/parser/local+SSH adapter、Debug 启动/服务、Editor/分层/App Server 架构）。随后补强引号内转义引用的命令标志检测，TaskService 整文件 138 项再次通过，workspace/parser 27 项包含 Shell 参数上限的中文验证；新增覆盖 raw→argv→raw/relaunch、旧 PTY release gating、空字符串、变量整体解析、路径/空值/空格/双引号/尾随反斜线/PowerShell 与 cmd Shell 引用、显式与 args-only Shell 覆盖、配置的三种 profile 策略、扩展 bridge、非 Windows 拒绝、中文错误、SSH 恢复不重放 command。标准 Browser Terminal/AppTools/Testing Chromium 82 项全部通过，包含 Windows raw profile 的中文键盘 picker/resolver/默认选择；全浏览器 3494、Renderer 3692、协议类型检查通过。Rust terminal 35、PTY 26、App Server 协议 127、exec-server 协议 7 与真实 Node Extension Host 22 项通过。macOS 原有包的 all-targets deny-warnings 通过；Windows MSVC 的 exec-server/PTY all-targets 与 vendored ConPTY lib/tests deny-warnings 通过，Linux exec-server/PTY 测试目标也交叉编译通过。本机为 macOS，新增 Windows ConPTY 执行/退出码用例尚未在 Windows 上实跑。vendored all-targets 会编译未声明 futures/smol 的上游 whoami_async 示例，保持上游 manifest，实际 product lib/tests 已单独通过；全库 format:config 存在 49 个既有格式失败，本批精确 Markdown/JSON 范围通过 Prettier，未批量改动其他文件。TS/JS 精确 24 文件格式与 git diff --check 通过，保留共享工作树其余变化，未 commit/push。

## Tasks 全局终端环境本批准入（2026-10-12）

运行/复用 Task → TaskService / TerminalTaskSystem → 原 IConfigurationService 有效设置、ITerminalProfileResolverService profile 选择、IConfigurationResolverService 变量解析与 platform mergeEnvironments → 原 TerminalService/TerminalInstance → 原执行端环境和 PTY owner。基础环境仍由执行端拥有；窗口全局 env、实际所选 profile env、任务 env 按顺序覆盖，null 继续作为删除指令传到执行端。Task 变量已解析的值保持字面量，复用重新读取并替换完整 env，不保存第二份配置状态。

准确准入：`src/ash/workbench/contrib/tasks/browser/terminalTaskSystem.ts`（双方同路径，环境准备和配置 DI）；`src/ash/workbench/contrib/tasks/browser/taskService.ts`（双方同路径，只补显式配置依赖）；`src/ash/workbench/services/tasks/test/browser/taskService.test.ts`（现有真实执行链测试）；`src/ash/workbench/contrib/terminal/README.md` 与本文。平台环境合并、resolver、Terminal 实现只读；没有新公开 API、DOM、CSS、协议或执行 owner。目录审计：Tasks 生产同路径 4、上游缺失 17、已存在 Ash 专属 taskActions/tasks.contribution/tasksViewPane/tasks.css 4；Terminal browser 同路径 22、上游缺失 43、Ash 专属 0。仅修改上述闭合切片。

本批结果：默认 Shell、显式 Shell 与 Process task 继承执行端 OS 对应的全局 env，所选 profile 与任务 env 按顺序覆盖。共用原 mergeEnvironments 的 Windows 键合并和 null 删除指令，Linux/macOS 保留大小写区别；变量读取执行端环境，不复制本机基础环境到启动覆盖。全局/profile 值经原 ConfigurationResolverService 解析，Task 值在它原有交互/嵌套变量解析完成后合并，保留已有字面量与 rerun 语义。没有环境覆盖且不选 profile 的 Process/显式 Shell task 保持原准备路径；CustomExecution 不解析全局进程环境。共享终端每次准备读取当前设置，旧全局/profile 项在下一轮快照中移除；清除设置使用原配置服务的 undefined 删除入口，不将整个 env 设置写为 null。实例、屏幕和旧 PTY 释放规则未改。

验证：标准 unit 4 文件 205 项通过（Tasks 123、TerminalService 49、profile/configuration 20、架构 13）。新增 9 项覆盖三种执行 OS 的全局→profile→任务优先级、Windows 单键大小写覆盖、基础/全局/profile 的 null 删除及恢复、变量解析、不可变启动快照、设置替换/清除和原实例复用、显式 Shell/Process 不选择 automation profile、CustomExecution 原 owner、环境准备取消/工作区变化/读取失败；收尾后 Task profiles 套件 18 项再次通过，包含通过 rerun 清除旧环境。所有新测试沿真实 TaskService、resolver、TerminalService、TerminalInstance 到 typed process boundary，启用 disposable 泄漏检查。

Renderer 3691 文件、全浏览器 3490 文件类型检查通过；App Tools/Testing Chromium 25 项通过（20+5，包含中文及 Agent task Run ID/输出/取消与原 Task/Terminal owner 联动）。3 个 TS 文件格式检查和 git diff --check 通过；目录关系未变。全量回归发现无覆盖 Process task 的额外异步准备影响既有实例策略时序，已将 OS/环境准备限定到实际需要的情形，原 terminateOldest/terminateNewest 测试通过，未改实例准入 owner 或放宽断言。Windows/Linux 是前端执行端契约验证，未执行相应 OS 的真实 PTY/SSH 场景。保留共享工作树其他改动，未 commit/push。

## Testing 浏览器 Tasks fixture 验证收尾（2026-10-12）

`test/integration/browser/testing.integration.ts` 的 typed Tasks fixture 补齐 `runs`、`start`、`describe`、`getRun`：无已拥有执行时返回空列表/undefined；场景未使用的启动与描述入口明确报错，原 `run` 的脚本调用计数和 Testing 执行分离行为保持。TaskService、TerminalService、resolver 与 PTY owner 沿用现有实现。

标准 `pnpm test:browser:integration testing.integration.spec.ts appTools.integration.spec.ts --project=chromium` 的全浏览器类型检查通过，随后 25 项 Chromium 回归全部通过（Testing 5、App Tools 20），包含键盘/最小面板布局、脚本与测试分离、取消/断连、调试、中文，以及 Agent task Run ID/输出/取消与 Tasks/Terminal 共用 owner。fixture 格式检查和 git diff --check 通过。此前记录的全浏览器 Tasks fixture 类型阻塞已解除；未 commit/push。

## Extension Host → Terminal 领域契约本批准入（2026-10-12）

扩展注册/调用 → ExtensionHostServiceRegistration 与 MainThreadTerminalService → services/terminal 的唯一领域契约 → 原 TerminalProfileService、BrowserTerminalProfileResolverService、TerminalService 与 TerminalInstance → 原进程端口/Rust PTY 或 incarnation-owned 扩展 PTY → 注册/创建/输出/撤销行为测试与架构检查。

新增 `workbench/services/terminal/common/terminal.ts` 和 `browser/terminal.ts` 属于 Ash 专属路径：上游仍将这些契约放在 contribution，但 Ash 已要求 services 不反向依赖 contributions，本次用户明确要求按正确分层收敛领域契约。两文件只承接有实际调用方的 profile/resolver 与浏览器 instance/service 契约，不移动实现、配置状态、注册入口或 PTY owner。浏览器屏幕公开 `IXtermTerminal` 端口，实际 XtermTerminal 仍在原 contribution；common 不导入 DOM/browser。原 contribution 契约文件保留屏幕配置、命令和 view ID，不做服务契约 re-export 或第二份服务 ID。

精确准入路径（其余既有 TS 文件为同路径消费者/实现，services extensionHost 注册文件为既有 Ash 专属 owner；测试只调整真实装配与验证）：

- `docs/editor-extensions.md`
- `src/ash/sessions/contrib/appTools/browser/appToolsHost.ts`
- `src/ash/workbench/api/browser/mainThreadTerminalService.ts`
- `src/ash/workbench/contrib/accessibilitySignals/browser/accessibilitySignal.contribution.ts`
- `src/ash/workbench/contrib/accessibilitySignals/test/browser/accessibilitySignal.contribution.test.ts`
- `src/ash/workbench/contrib/chat/browser/actions/chatContext.ts`
- `src/ash/workbench/contrib/debug/browser/debugService.ts`
- `src/ash/workbench/contrib/panel/test/browser/panelViewTitleActions.test.ts`
- `src/ash/workbench/contrib/tasks/browser/taskService.ts`
- `src/ash/workbench/contrib/tasks/browser/tasksViewPane.ts`
- `src/ash/workbench/contrib/tasks/browser/terminalTaskSystem.ts`
- `src/ash/workbench/contrib/terminal/README.md`
- `src/ash/workbench/contrib/terminal/browser/terminal.contribution.ts`
- `src/ash/workbench/contrib/terminal/browser/terminal.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalActions.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalContextMenu.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalExtensions.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalIcon.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalInstance.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalMainContribution.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProcessManager.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProfileQuickpick.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProfileResolverService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalProfileService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalService.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalTabbedView.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalTabsList.ts`
- `src/ash/workbench/contrib/terminal/browser/terminalView.ts`
- `src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`
- `src/ash/workbench/contrib/terminal/common/terminal.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalConfigurationService.test.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalTabsLayout.test.ts`
- `src/ash/workbench/contrib/terminal/test/browser/terminalTitleActions.test.ts`
- `src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminal.accessibility.contribution.ts`
- `src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibilityHelp.ts`
- `src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibleBufferProvider.ts`
- `src/ash/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts`
- `src/ash/workbench/contrib/terminalContrib/find/browser/terminal.find.contribution.ts`
- `src/ash/workbench/contrib/terminalContrib/find/browser/terminalFindAccessibilityHelp.ts`
- `src/ash/workbench/contrib/terminalContrib/find/browser/terminalFindWidget.ts`
- `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts`
- `src/ash/workbench/contrib/testing/browser/testingViewPane.ts`
- `src/ash/workbench/services/debug/test/browser/debugService.test.ts`
- `src/ash/workbench/services/debug/test/browser/debugTerminalLauncher.test.ts`
- `src/ash/workbench/services/extensionHost/browser/extensionHostServiceRegistration.ts`
- `src/ash/workbench/services/extensionHost/test/browser/appServerExtensionHostService.test.ts`
- `src/ash/workbench/services/tasks/test/browser/taskService.test.ts`
- `src/ash/workbench/services/tasks/test/browser/tasksViewPane.test.ts`
- `src/ash/workbench/services/terminal/README.md`
- `src/ash/workbench/services/terminal/browser/terminal.ts`
- `src/ash/workbench/services/terminal/common/terminal.ts`
- `src/ash/workbench/services/terminal/test/common/embedderTerminalService.test.ts`
- `src/ash/workbench/services/testing/test/browser/testingService.test.ts`
- `test/architecture/layer-boundaries.test.ts`
- `test/integration/browser/appTools.integration.ts`
- `test/integration/browser/chatInput.integration.ts`
- `test/integration/browser/terminal.integration.ts`
- `test/integration/browser/testing.integration.ts`
- `test/integration/browser/viewpaneLayout.integration.ts`

本批结果：ExtensionHostServiceRegistration 和 MainThreadTerminalService 不再依赖 Terminal contribution 契约。三项服务标识字符串与原安装依赖保持一致，所有生产/测试消费者迁到唯一服务契约；旧路径无服务声明、alias 或 re-export。`IXtermTerminal` 只声明现有屏幕消费者使用的端口，真实屏幕初始化仍由 TerminalInstance 负责，测试从实例的 xtermReadyPromise 等待它；未开放具体实现的内部初始化或写入方法。配置、provider 注册、resolver、窗口实例、进程管理器以及 Rust/扩展 PTY 的业务状态和释放仍在原 owner。

目录复核：services/terminal 生产同路径 1、Ash 专属 2、上游缺失 0；contrib/terminal/browser 同路径 22、Ash 专属 0、上游缺失 43；common 同路径 4、Ash 专属 0、上游缺失 11。公开 API 是当前消费者使用的切片，未声称完成完整 VS Code terminal/xterm 契约。

验证：正常 `pnpm test:unit` 入口 9 文件 270 项通过，含架构 13、Extension Host 42、profile/configuration 20、TerminalService 49、DAP 19、Tasks 110、标题 5、Tabs 4、embedder 8。新增 2 项经过真实 ProfileService/resolver/TerminalService/TerminalInstance，从扩展创建 Shell/PTY 到输出、退出、原实例 Relaunch 和准确关闭；原工作区失效与扩展撤销场景保持通过，套件启用 disposable 泄漏检查。架构检查同时覆盖 type import、dynamic import、re-export 的分层方向、服务契约的传递依赖及唯一 service identifier/contract owner，未加例外。收尾后 DebugService 77 与架构 13 再次通过；本批共验证 347 项不同单测。57 个 TS 文件格式检查与 git diff --check 通过；未 commit/push。

Renderer 3675 文件类型检查通过；Terminal Chromium 56 项通过，含中文与无障碍、查找/剪贴板/链接、配置、picker、resolver 和实例装配。浏览器定向编译继承原配置，2136 文件通过，并使用原 browser runner 构建/运行。全浏览器编译曾被共享工作树范围外 `test/integration/browser/testing.integration.ts` 的 Tasks fixture 新接口缺口阻塞；未改其 Tasks 行为或放宽编译选项。最初全 unit/Renderer 编译也遇到同一共享 Tasks/App Tools 迁移未同步的类型，后续完整 unit/Renderer 已通过；当前验证分别记录，不把定向通过记为全浏览器类型检查通过。

## Debug／Agent 启动策略本批准入（2026-10-12）

DAP runInTerminal → DebugService → ITerminalProfileResolverService 的 automation 策略 → 原 TerminalService / Rust PTY owner → 实际 shell 的引用规则、profile argv/env 与 DAP literal env/cwd、输入确认及失效清理 → 真实 DAP reverse request 测试。

Agent openTerminal App Tool → 现有 AppServerAppToolsHost → AppToolsHost → 同一 resolver 的 agentHost 策略 → 原 TerminalService / Rust PTY owner → 当前执行端的 argv/env/cwd、终端显示及取消／工作区／连接失效清理 → 既有 App Tools browser integration。用户本请求确认沿用已有 Agent 入口和 owner；AppToolsHost 为既有 Ash 专属窗口执行适配器，仅承接该入口，不新建协议、执行宿主或 backend shell-session owner。

准入路径：workbench/contrib/debug/browser/debugService.ts（双方同路径，仅启动策略、显式 DI 依赖和当前请求的失效检查）；sessions/contrib/appTools/browser/appToolsHost.ts（Ash 专属，用户请求沿用的既有 Agent 窗口执行 owner，仅 openTerminal 策略与寿命）；services/debug/test/browser/{debugTerminalLauncher,debugService}.test.ts、test/integration/browser/appTools.integration{,.spec}.ts（现有行为测试及 typed 装配）；中文 workbench.json（必要 NLS）、Terminal README 和本文。其他路径只读；前一批 Tasks/TerminalInstance 未提交变化保留。

只读范围：debug/browser 双方同路径 6、上游缺失 53；Ash 专属 debugActions、debugConsoleViewPane、debugViewPane 和三个 CSS 均不修改。appTools 的既有 Host/CSS、服务契约与 App Server adapter 均为 Ash 专属；只更改已请求的 Host 启动职责，CSS／契约／transport adapter 不变。没有新 DOM、样式、命令或持久状态；继续现有终端无障碍帮助及焦点链。

本批结果：Debug runInTerminal 采用 automationProfile，Agent openTerminal 采用 agentHostProfile，空配置均沿 resolver 回到交互式默认 shell。两条链共用原 ProfileService、resolver、TerminalService 与 Rust PTY，保留 executable/argv/env/cwd 和 profile metadata。Debug 不再额外偏好 PowerShell，也不依据自定义 profile ID 判定引用规则；配置先解析，再以 DAP 字面量 env/cwd 覆盖，Windows 环境键忽略大小写，null 保留删除语义。stdin 确认后才返回真实 shellProcessId。Session／Host／工作区／执行连接失效使 pending resolution/create/input 失效；晚到 PTY 被关闭，Agent 无法打开 View 时也释放对应实例。连接／工作区订阅由原 owner 的 disposable store 释放，没有新执行 registry 或请求状态副本。

验证：标准 unit 入口的 DebugService 77、真实 DAP terminal 19、Tasks 110、TerminalService 49、profile/configuration 18 共 273 项通过；DAP terminal 收尾后 19 项再次通过，新增生命周期套件启用 disposable 泄漏检查。Chromium Terminal 56 项通过，App Tools 最终 18 项通过（新增 12 项，含三种执行端 OS、Agent 优先与交互回退、取消／Host／工作区／连接失效、晚到 PTY 和 View 失败释放）；Windows fixture 的 initialize OS 与 userHome 使用对应目标的路径格式。Renderer 3673 文件、完整 unit/browser 编译与 6 个修改 TS 文件格式检查通过，git diff --check 通过。Debug 默认标题新增 NLS 键并补中文，中文 DAP 标题和 Agent 未就绪错误经过行为测试。

架构检查实际运行 test/architecture/layer-boundaries.test.ts：10 项通过、1 项失败，失败列出 services/extensionHost/browser/extensionHostServiceRegistration.ts → contrib/terminal/browser/terminal.ts 与 contrib/terminal/common/terminal.ts 两条既有依赖；已核对 HEAD 同样存在，该批未修改该文件或放宽检查。此依赖已在本文顶部的后续领域契约批次修复。Workbench → Sessions 检查通过，没有新反向依赖。Windows/Linux 是前端执行端契约验证，未执行相应 OS 的真实 PTY／SSH 产品场景。保留前一批未提交修改；未 commit/push。

## Tasks 自动化 Shell 本批准入（2026-10-12）

运行 Shell task → TaskService / TerminalTaskSystem → 既有 ITerminalProfileResolverService.getDefaultProfile（allowAutomationShell）→ ProfileService / 执行端 resolve owner → 按执行端 shell 引用参数、继承 profile 环境并创建或复用原 PTY → TaskService 真实派发及 TerminalInstance 复用测试。

本批生产路径均为双方同路径：contrib/tasks/browser/terminalTaskSystem.ts 只改 Shell 选择、执行参数、环境和复用启动数据；contrib/tasks/browser/taskService.ts 只声明 resolver 注册依赖；contrib/terminal/browser/terminalInstance.ts 只让复用启动数据中的 executable/args 成为新 profile 快照，并在等待旧进程关闭前冻结调用方数组与环境。测试路径 services/tasks/test/browser/taskService.test.ts 与 contrib/terminal/test/browser/terminalService.test.ts 为 Ash 既有测试 owner，覆盖真实 TaskService → resolver → TerminalService → process boundary 与等待释放时的不可变启动快照，不增加生产 API。文档只更新 Terminal README 和本文。没有 DOM、CSS、焦点或新命令变化，复用现有任务/终端无障碍链。

只读目录审计：tasks 生产 TS/CSS 双方同路径 4、上游缺失 17；仅 Ash 的 tasks.css、taskActions.ts、tasks.contribution.ts、tasksViewPane.ts 不在本批修改范围。terminal/browser 双方同路径 22、上游缺失 43、仅 Ash 0。没有新增文件或删除操作。Debug/Agent 策略与全局终端环境的 Tasks 接入仍属后续切片。

本批结果：Shell task 和仅 command 的 provider task 进入现有 automation resolver；执行端 OS、实际 executable 的引用规则、profile argv/env、任务环境覆盖与 null 删除语义已到达真实 TerminalService 创建边界。显式任务 executable 和 Process/CustomExecution 的策略保留。任务复用替换当前解析结果，移除旧 profile 环境；automation 清空后回到交互默认 shell。TerminalInstance 在等待旧进程释放前冻结 path、argv、execution argv 与环境，复用保留实例和屏幕。没有新增运行宿主、协议或公开 API。

验证：标准 `pnpm test:unit` 定向入口 177 项通过（Tasks 110、TerminalService 49、configuration/profile 18），新增 9 项覆盖三种执行端 OS 的选择／参数／环境／复用、显式优先、按 executable 引用、自定义默认、command-only provider、取消／工作区切换／解析失败；生命周期测试启用 disposable 泄漏检查。标准 Renderer 检查 3671 文件通过；标准 Chromium Terminal 回归最终全量 56 项通过，含中文命令和无障碍帮助。首轮浏览器 resize/dispose 场景出现一次 xterm 异步 dimensions 错误；该场景随后独立重复 3 次与完整重跑均通过，没有据此修改样式或放宽断言。5 个修改 TS 文件格式检查和 git diff --check 通过。本批复用既有 NLS 文案，中文无 shell 错误经过真实 TaskService 验证；没有新增译文键。Windows/Linux 为前端执行端契约测试，未运行对应 OS 的真实 PTY 或 SSH 场景。未 commit/push。

## 自定义 / 扩展 Profile 与 Resolver 本批准入（2026-10-11）

用户选择自定义 profile → 现有配置系统、ProfileService / Quickpick / View → terminalProfileResolverService.ts → 执行端 terminal/profile/resolve 验证并选择 executable，原 TerminalService/Rust PTY owner 创建 → 保留 argv/env/cwd、准确 profile 身份、Relaunch 原启动快照 → 后端 profile/实际 PTY 与前端 resolver/创建行为测试。创建授权、私有环境过滤、输出/尺寸/恢复沿原 owner，不将 custom profile 假装成 task process。

第一闭合切片允许精确路径：crates/exec-server-protocol/src/terminal.rs，crates/exec-server/src/terminal.rs 与 terminal/{profiles.rs,profiles_tests.rs,service_tests.rs}；crates/app-server-protocol/src/protocol/{terminal.rs,registry.rs} 与 crates/app-server/src/{server.rs,server/terminal_operations.rs} 只补正式 resolve 方法、custom selection 和安全环境读取。TypeScript platform/terminal/common/terminal.ts 及已批准的三个 browser adapter 对接正式契约；terminal/common/{terminal.ts,terminalConfiguration.ts}、browser/{terminal.ts,terminalProfileService.ts,terminalProfileResolverService.ts,terminalProfileQuickpick.ts,terminalView.ts,terminalActions.ts,terminal.contribution.ts,terminalService.ts} 补 profile 定义、resolver、配置与真实创建。resolver 为上游同路径缺失，其他贡献文件双方同路径；只改本职责 hunk。配套测试 terminal/test/browser/{terminalConfigurationService.test.ts,terminalService.test.ts}、platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts、test/integration/browser/terminal.integration{,.spec}.ts、中文 workbench.json、README 和本文。生成物只由生成器产生。

补充准入：browser/terminalInstance.ts（双方同路径）保存 custom profile 的首次启动快照，Relaunch 沿原实例路径重用。已存在的 TerminalProcessService typed fixtures 只补新 resolveProfile 端口；精确路径 services/tasks/test/browser/taskService.test.ts、services/debug/test/browser/{debugTerminalLauncher.test.ts,debugService.test.ts}、services/terminal/test/common/embedderTerminalService.test.ts、contrib/terminal/test/browser/terminalTitleActions.test.ts、test/integration/browser/chatInput.integration.ts。

扩展切片追加准入：platform/terminal/common/terminal.ts 承接扩展 profile 元数据，extensions/common/{extensionService.ts,extensionManifest.ts} 与 extensions/browser/appServerExtensionService.ts（既有扩展归属）解析并发布声明；terminalProfileService 只拥有 provider 注册与调用寿命。api/browser/mainThreadTerminalService.ts 为上游同路径缺失，api/browser/mainThreadExtensionApi.ts 接入现有注册 batch；platform/agentHost/common/extensionHostApi.ts 与 browser/extensionHostProtocol.ts 只接有界注册 DTO。Rust external-ext-protocol/src/{lib.rs,validation.rs,protocol_tests.rs}、app-server-protocol/src/protocol/{extension_host.rs,extension_packages.rs}、app-server/src/server/extension_host_runtime/{source.rs,projection.rs}、external-js-ext/src/{host.mjs,vscode.js,node.test.mjs,runtime.rs,package.rs} 接入原宿主 capability/调用/取消/撤权，禁止新执行宿主。配套 api/test/browser/mainThreadExtensionApi.test.ts、services/extensions/test/common/extensionService.test.ts 与 platform/agentHost/test/browser/extensionHostProtocol.test.ts；终端现有 accessibility 帮助追加本批命令说明并更新中文。仅实际依赖需要的 paths 才写入，其他路径仍只读。

补充准入：platform/terminal/common/terminalEnvironment.ts（上游同路径缺失）由 resolver 调用，拥有环境覆盖合并与 Windows 大小写语义；terminal/browser/terminalIcon.ts 与 terminalTabsList.ts 仅消费 profile 的现有主题图标/颜色端口。

补充准入：crates/plugin/src/manifest/editor_extension.rs、crates/app-server/src/{extension_packages_editor_extensions.rs,server/extension_host_runtime.rs,server/extension_host_operations.rs} 与 services/extensionHost/browser/appServerExtensionHostService.ts 接入精确 onTerminalProfile 激活和 provider capability，不扩大既有任意操作白名单。api/browser/extensionHostWorkflowBridge.ts 仅将现有 PTY handle 操作归为共享伪终端机制，不新增 Task 执行副本。

补充准入：crates/plugin/src/manifest/validation.rs 的闭合 activation enum 校验同步新变体，保持 capability ceiling 验证。

扩展宿主由 `api/browser/extensionHost.contribution.ts` 组合注册并显式声明 Terminal 领域依赖，保证 API bridge 的安装顺序。`services/extensionHost` 不再反向依赖 Terminal contribution。

补充准入：services/extensionHost/common/extensionHostService.ts 的注册 kind 闭合枚举同步 terminalProfileProvider；测试入口为实际存在的 services/extensionHost/test/browser/appServerExtensionHostService.test.ts。

补充准入：contrib/folding/test/browser/folding.contribution.test.ts 的 typed IExtensionService fixture 同步只读 terminalProfiles 空列表，不改变 folding 行为。

验证补充准入：base/common/jsonSchema.ts（双方同路径）仅补已有 patternProperties 的验证执行。settings.json → ConfigurationRegistry → 唯一 JSON schema 校验器 → profile 名称和 env 键命中规则后验证对应值，未命中的键仍受 additionalProperties 约束；由现有 terminalConfigurationService.test.ts 从真实配置写入入口验证接受有效定义、拒绝无效名称/混合定义/参数。不增加配置旁路。

验证补充准入：crates/app-server/src/server/extension_host_runtime/source_tests.rs 在现有 ActivationPlan owner 上验证精确 onTerminalProfile 匹配与能力按需激活；debugTerminalLauncher.test.ts 只补 rebase 后 DebugService 所需的真实 FileService/UriIdentityService 装配，保持原 DAP 断言。

扩展 provider 后续切片先核对已有 extension runtime 注册/激活/调用/撤权 owner，再锁定准确 paths；不提前添加空 registry 或虚构 provider。完整 browser 差异清单沿上一批台账，按当前入口依赖闭合推进，不以缺失文件清单作为空模块创建队列。共享工作树的 Chat/Sessions rebase 冲突保持不动。

本批实现结果：自定义 profile 进入正式 `terminal/profile/resolve` / `terminal/create` 协议，Rust 在原目录授权与环境 owner 上验证名称、path 候选、argv 并挑选真实 executable；执行端解析不启动 PTY。Renderer 不使用本机路径或环境代替远端事实。`terminalEnvironment.ts` 与 `terminalProfileResolverService.ts` 已有实际消费者，覆盖变量、全局/profile/调用方 env 覆盖、cwd、默认/automation/agentHost shell、图标和异步失效；默认/扩展选择、工具栏与实例创建走同一 profile owner，首次启动数组/环境快照不可由调用方后续修改，Relaunch 保留它们。

扩展沿现有 Plugin/VSIX → capability ceiling → `onTerminalProfile:{id}` 激活 → 原宿主 `window.registerTerminalProfileProvider` / `TerminalProfile` → MainThread 注册 batch → ProfileService / TerminalService。普通 shell 与自定义配置共用 resolver 和原 Rust PTY；Pseudoterminal 复用现有有界 opaque handle，不保存 Tasks 业务状态。注册绑定当前包 digest、runtime incarnation 和 activation generation，注销关闭活动的扩展 PTY；关闭移除实例引用，Relaunch 再调用 provider 获取新 handle，工作区变化释放晚到 handle。标准 API 可省略 shellPath/argv 使用执行端默认配置。主题图标/颜色进入实例列表并保留到 Relaunch，无效图标使用终端默认图标。

验证期间修正配置底座中已声明但未执行的 `patternProperties`，有效自定义/扩展配置现在可写入，无效名称、env 键、混合定义和无 path 参数被配置边界拒绝。补齐中文配置/错误/帮助文案，并保留原无障碍视图、键盘选择与 Escape 取消链。Rebase 已完成：当前 `5e1472793` 包含 `origin/main` 的 `fba2c6c44`，没有冲突；未提交修改及其他工作继续保留。未执行 commit/push。

本批验证：正常前端 unit 7 文件 224 项通过；收尾后 configuration/profile 与 extension-host 两套 60 项通过（18+42），含真实 batch 绑定/撤销、晚到 handle 的关闭、旧 PTY 退出后获取新 handle、不可变 custom Relaunch 快照，新增生命周期套件启用 disposable 泄漏检查。Chromium Terminal 全量 56 项通过，最后 profile 三项再次通过；自定义和扩展从真实 Quick Input/默认命令经过真实 resolver，断言 backend 请求的 argv/env/cwd、主题 SVG 和中文 UI。真实 Node 宿主 21 项通过，包含标准 API、默认 shell、省略 argv、同步 open/input 输出、幂等关闭和重建 handle。Rust exec-server 的 terminal 32 项、external-ext-protocol 40 项、App Server profile/激活 2 项、App Server protocol terminal 4 项通过；相关六个 crate 的全 targets deny-warnings 检查通过。生成协议成功，Renderer 3671 文件、protocol 1438 文件类型检查通过。本批 42 个 TS/JS 文件格式检查通过；本批中文缺词为零，全仓仍缺范围外 color.editorGutter.itemBackground。没有新增依赖。

首次校验发现 patternProperties 未执行、独立 assembly fixture 先创建 resolver 导致缺依赖报错入口改变，以及 rebase 后 Debug fixture 缺 UriIdentityService。均在实际 owner/fixture 装配中修正，保留原创建/输出/关闭/输入确认断言。扩展真实注册测试校验实际 manifest digest、使用既有 realm CommandRegistry 并启用泄漏检查，未绕过包校验或忽略泄漏。

当前 browser 生产 `.ts`/`.css` 同路径 22、上游缺失 43、仅 Ash 0；platform/terminal 同路径 2、已批准 Ash 专属适配器 3、上游缺失 44。数字只描述文件关系。Windows 原始命令行字符串、URI 图标、完整自动发现/集成、分组/分屏、编辑区及其他剩余 browser/xterm/backend 链仍待补；argv 数组已真实执行。automation/agentHost resolver 策略端口已实现，但不将 Tasks/Debug/Agent 业务 owner 的后续接入记为完成。本机 macOS / Chromium 与 Node 宿主验证不等于 Windows/Linux 或真实 SSH 场景通过。

## 配置与 Profile 本批准入（2026-10-11）

更改终端设置 → settings.json / IConfigurationService → common/terminalConfiguration.ts 与 browser/terminalConfigurationService.ts → 配置服务拥有有效值，实例屏幕订阅派生配置 → 字体、光标和回滚参数实时生效且输出保留 → 配置边界单测与真实浏览器场景。

交互式新建 / 默认 Profile / 命令面板 → TerminalViewPane 与 terminalActions → terminalProfileService.ts、terminalProfileQuickpick.ts → Profile service 拥有可用列表的前端快照与设置派生的默认选择，Rust 继续拥有可信 profile 与进程 → 使用执行端 OS 的默认设置，取消不创建，配置变化刷新工具栏 → 非本机 OS、过期列表、释放与快捷选择测试。现有 TerminalService.getProfiles 是无状态后端读取端口，Tasks / Debug 保留调用；不建立第二份可编辑 profile 定义。默认交互 profile 是显式创建参数，已有实例重启保留原 profile。

准入路径：common/{terminal.ts,terminalConfiguration.ts}、browser/{terminal.ts,terminalConfigurationService.ts,terminalProfileService.ts,terminalProfileQuickpick.ts,terminal.contribution.ts,terminalActions.ts,terminalView.ts,xterm/xtermTerminal.ts}。其中 terminalConfiguration.ts 和三个 browser 服务/选择器为上游同路径缺失，其余为双方同路径；既有文件只改设置契约、DI、配置订阅和 profile 入口。platform/terminal/common/terminal.ts 补执行端 OS 只读契约；已批准保留的 browser/{appServerTerminalProcessService,reconnectableTerminalProcessService,disconnectedTerminalProcessService}.ts 仅映射现有初始化 OS，不改 Rust/生成协议。允许测试 terminal/test/browser/{terminalConfigurationService.test.ts,terminalTitleActions.test.ts}、platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts、test/integration/browser/{terminal.integration.ts,terminal.integration.spec.ts,chatInput.integration.ts}、中文 workbench.json，以及本文和 Terminal README。

settings.json 继续由现有配置系统保存与合并；外观和 defaultProfile.{linux,osx,windows} 使用对应 WINDOW scope，不写 legacy configuration.json；先消费已验证有效值，无额外值仓库或迁移。profile 的 path/args/env、自定义和扩展 profile、自动化 shell、完整 resolver API 尚未闭合，不创建空模块。

本批实现结果：三个缺失 browser 文件与 common/terminalConfiguration.ts 已进入真实生产链；配置/schema owner、连接适配器、实例屏幕、命令面板、View 与工具栏均已接线。屏幕消费 10 项外观设置，空终端字体继承 editor.fontFamily；line 光标映射 xterm bar。有效配置变化原地更新并 fit，不替换屏幕或复制输出。相应默认值为 macOS 字号 12／其他平台 14、回滚 1000、光标不闪烁。小于现有缓冲区的回滚值按 xterm 语义移除超限旧行。

ProfileService 合并并发发现请求；工作区/连接变化撤回可用列表，旧请求与释放后的结果不能重新发布；已有选择器同步移除失效项。默认 profile 设置按执行端 OS 读取，储存 title/name 并在新建前解析为可信 ID；不可用名称使用后端 default。选择/写入失败保留配置系统错误，不伪造成功；Escape、关闭选择器或释放 owner 都不创建进程、不写默认值。交互式新建显式传入选定 profile；Tasks/Debug 的无状态读取和原实例 Relaunch 行为保留。

公开契约仍为当前消费者闭合的切片：TerminalConfigurationService 的 config/onConfigChanged 已生效，font metrics、默认位置、跳过 shell 命令等端口未实现；ProfileService 的 availableProfiles/refresh/getPlatformKey/default 与事件生效，profilesReady、扩展 provider 和自定义配置未实现；Quickpick 已消费 createInstance/setDefault，返回 Ash 可信 ID 或已保存名称，未声称完成上游 executable/modifier/extension 结果契约。完整 terminalProfileResolverService 仍没有可闭合的 executable/profile 定义下层，不添加空实现。

验证：Chromium Terminal 正常全量入口 54 项通过（含新增配置实时更新和中文 profile 命令场景）。Terminal configuration/profile、实例、列表/尺寸、标题/上下文与 reconnectable adapter 共 72 项单测通过，配置/profile 11 项均启用 disposable 泄漏检查；使用原 unit runner 读取当前编译产物。20 个修改的 TS 文件格式检查通过。中文新增 33 条文案齐全；全仓本地化尚缺范围外 ash/color.editorGutter.itemBackground。旧 display-history 截断用例显式设置 scrollback=5000，使其继续独立验证 4096 行显示历史上限；未弱化原截断标记及进程观察者输出断言。Reconnectable 测试 mock 记录 JSON-RPC 实际序列化参数，修正既有 adapter 可选 execution=undefined 与无字段 wire 对象的假差异，所有 adapter 场景通过。

初期正常 Renderer（3657 文件）、全浏览器类型检查、普通 unit 类型检查均通过。最后共享工作树的 checkpoint 协议新增 directory，但范围外 appServerAgentService.ts:141 / IMessageCheckpoint 枚举未同步，阻塞最新全仓 Renderer、全浏览器与 unit tsc；未修改这些业务文件或放宽类型选项。最终 Terminal 浏览器定向类型检查（2111 文件）通过；unit 定向编译曾报告该范围外错误，之后从原 tsconfig.test.json 继承的定向 tsc 检查已通过，原 runner 执行当前产物 72 项全部通过。不能将当前全仓类型检查记为通过。随后共享工作树另一项 rebase 在 Chat/Sessions 文件产生冲突标记与缺失 import，浏览器重建被这些范围外文件阻塞；未修改或解除该 rebase。额外未跑通的测试断言已仅撤销本批自己的新增，保留已验证的 54 项场景。最后 View 的发现失败分支改为读取 ProfileService 当前列表，防止旧失败覆盖新工作区的有效菜单；该修改后的 Terminal 定向 unit 编译与 72 项测试通过，浏览器重建仍受上述范围外冲突阻塞。

当前 browser 生产同路径文件为 21，上游缺失 44，仅 Ash 0；common 本轮补 terminalConfiguration.ts。以下旧批次目录数字是该批次时的快照。仅在 macOS Chromium 上验证交互，未验证真实跨 OS SSH 或 VoiceOver 实际读出。

## Browser 列表、菜单与尺寸调度（2026-10-11）

用户切换／拖动终端列表、打开实例菜单或调整面板 → `TerminalViewPane` → `TerminalTabbedView`／`TerminalTabList`、当前窗口命令、`XtermTerminal` → 实例身份与原 `TerminalService`／进程管理器 → 指定实例操作与最终屏幕／PTY 尺寸。实例集合、活动项和进程状态仍只有原服务／实例 owner；本批独立实现三个缺失 browser 文件，未新建 backend、分组或配置状态。

| 准确路径（相对 `src/ash`）                                                                   | 存在关系与本批动作                                                            | 生产入口／可观察结果                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `workbench/contrib/terminal/browser/terminalTabsList.ts`                                     | 上游同路径缺失；迁入现有 TabList 的终端行渲染、监听、激活、关闭、拖动与窄模式 | Tabbed View 经 DI 创建；保留原实例身份与键盘导航，列表菜单支持鼠标和 Shift+F10    |
| `workbench/contrib/terminal/browser/terminalContextMenu.ts`                                  | 上游同路径缺失；实例上下文只保存数值身份，命令转发与菜单执行生命周期独立实现  | 实例列表菜单；活动项变化后仍操作捕获目标，异步动作结束后释放 runner               |
| `workbench/contrib/terminal/browser/terminalResizeDebouncer.ts`                              | 上游同路径缺失；一份待调度尺寸负责屏幕重排，使用原 scheduler／idle 基础能力   | xterm fit；大 normal 缓冲区即刻调整行数，合并列重排，focus 前 flush，dispose 取消 |
| `workbench/contrib/terminal/browser/terminalTabbedView.ts`                                   | 双方已有；退出列表交互／行监听 owner，只保留 SplitView 几何、可见性与宽度吸附 | View → 唯一列表；旧列表实现和重复事件订阅退出                                     |
| `workbench/contrib/terminal/browser/terminalActions.ts`、`terminalMenus.ts`                  | 双方已有；新增目标实例菜单及既有 Focus/Clear/Kill/Relaunch 的目标上下文解析   | 原标题命令不带上下文的行为保留；带上下文的命令直接定位原实例，失效或非法身份拒绝  |
| `workbench/contrib/terminal/browser/{terminal.ts,terminalInstance.ts}`、`common/terminal.ts` | 双方已有；只增加被菜单使用的标准 instanceId 与序列化上下文                    | instanceId 从原实例编号派生，不是 OS PID，也不另存身份状态                        |
| `base/common/marshallingIds.ts`、`platform/actions/common/actions.ts`                        | 双方已有；只补 `TerminalContext` 标识及 `TerminalInstanceContext` MenuId      | 现有命令序列化与 MenuService；下层不导入贡献                                      |
| `workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`                                  | 双方已有；fit 提议尺寸交给新调度器，最终 resize 仍由原实例／管理器执行        | 解析后的屏幕与 scrollback 保留，未改变输入确认、读取或后端租约                    |

配套准入范围为终端 Tabs／标题动作单测、Tasks 的 FakeTerminalInstance（仅增加数值身份）、`test/integration/browser/terminal.integration{,.spec}.ts`、Chat 输入的实例 fixture（仅身份字段）、既有终端无障碍帮助、中文 `workbench.json`、本台账与 Terminal README。保护共享工作树的其他修改。没有批量复制上游代码、DOM、CSS 或创建没有本地消费者的文件。

列表继续使用 Ash 已有 TabList 的 roving focus、滚动与拖动基础部件；不为名称一致换掉其 DOM。`TerminalTabList` 当前不具备完整上游 WorkbenchList 的多选、行编辑、分组标记、hover 与所有列表 hooks，因此只记录已迁移的真实职责。菜单上下文可序列化为 `$mid: 15` 与 `instanceId`；用户／插件命令边界验证身份，执行时只查当前窗口的实例服务。MenuService 的作用域反映所指终端的状态，不修改窗口活动项。运行／重连中的实例不提供 Relaunch；关闭的目标上下文不能转而操作其他终端。

屏幕调度器使用一份待处理的列／行请求与原 RunOnceScheduler、可取消 idle 任务。显式 immediate 或短缓冲区同步更新；长缓冲区的可见屏幕先更新行数，横向重排在 100 ms 窗口中合并；隐藏请求在 idle 执行。focus 显式 flush，实例屏幕释放取消定时／idle 请求，回调内释放同样不能再调度。屏幕只调用既有 `instance.resize`，后端确认与尺寸请求取消仍归 `TerminalProcessManager`。

验证：正常 `pnpm test:unit` 的 Terminal 实例、Tabs／resize、标题／context 与 Tasks 共 158 项通过（48+4+5+101），runner 自测 9 项通过。Chromium Terminal 全量 52 项通过，新增 5 项覆盖固定菜单目标、中文／键盘焦点恢复、异步 Relaunch、长 scrollback 重排及 focus／dispose。Renderer 与终端定向浏览器类型检查通过。18 个本批 TS 文件格式检查通过；Tasks 文件在范围外的既有 search fixture 对象格式上仍未通过整文件检查，格式化差异不涉及本批新增身份字段，未清洗该无关区域。

初次真实鼠标测试发现旧独立 Pane fixture 没有提供生产宿主负责的 flex 分配与 Pane.layout；新 `browser` 场景补上宿主几何，并绑定真实主题，不放宽 click 或尺寸断言。单屏幕 fixture 同样按宿主高度分配给屏幕，避免自动高度使行数变化断言无效。首轮中文菜单使用陈旧生成语言包，正常本地化准备恢复后用新产物验证。正常命令曾被范围外 `ash.extensions/languageFilter` 未知翻译阻塞，后续准备成功；正常浏览器全套类型检查最后被 `chatEditing.integration.ts:78` 的隐式 any 阻塞，终端以继承原 noEmit 配置的定向检查后运行原 runner，未修改该错误。未修改 Rust、协议或产品 CSS；运行环境为 macOS Chromium，未验证其他 OS 或真实 SSH。

释放复核：菜单为每次展示创建独立 DisposableStore，取消立即释放，已开始的异步动作等结果通知送达宿主后释放 runner 和监听；列表释放清空拖动实例引用并关闭自己打开的菜单。新增 resize／context 测试套件启用 `ensureNoDisposablesAreLeakedInTestSuite`，菜单测试使用自己拥有的独立 Window 与 ModifierKeyEmitter，避免把窗口基础设施误当作菜单资源。取消、异步完成、原始错误返回与 timer／idle 释放均已通过；资源包装完成后新增 5 项浏览器场景再次通过。

### Browser 目录剩余文件

本批后生产 `.ts`／`.css` 同路径文件 18 个，上游缺失 47 个，仅 Ash 0 个。下面是完整路径调查；文件存在不表示公开 API 完整，调查项也不是无调用方文件的创建队列。

| 职责链                              | 仍缺的准确路径（相对 terminal/browser）                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实例创建／分组分屏                  | `terminalInstanceService.ts`、`terminalGroupService.ts`、`terminalGroup.ts`                                                                                                                                                                                                                                                               |
| 配置／profile／命令基础（最新剩余） | `terminalCommands.ts`、`terminalEscapeSequences.ts`、`terminalEvents.ts`                                                                                                                                                                                                                                                                  |
| 编辑区承载／身份                    | `terminalEditingService.ts`、`terminalEditorService.ts`、`terminalEditor.ts`、`terminalEditorInput.ts`、`terminalEditorSerializer.ts`、`terminalUri.ts`                                                                                                                                                                                   |
| 状态、提示与图标                    | `terminalStatusList.ts`、`terminalTooltip.ts`、`terminalIcons.ts`、`terminalIconPicker.ts`、`terminalTabsChatEntry.ts`、`widgets/terminalHoverWidget.ts`、`widgets/widgetManager.ts`、`widgets/widgets.ts`、`media/widgets.css`、`media/xterm.css`                                                                                        |
| xterm 扩展职责                      | `xterm-private.d.ts`、`xterm/decorationAddon.ts`、`xterm/decorationStyles.ts`、`xterm/lineDataEventAddon.ts`、`xterm/markNavigationAddon.ts`、`xterm/terminalFontRendering.css`、`xterm/terminalFontRendering.ts`、`xterm/xtermAddonImporter.ts`                                                                                          |
| 后端／运行环境／Agent               | `baseTerminalBackend.ts`、`remoteTerminalBackend.ts`、`remotePty.ts`、`terminalProcessExtHostProxy.ts`、`detachedTerminal.ts`、`environmentVariableInfo.ts`、`terminal.web.contribution.ts`、`agentHostTerminalService.ts`、`agentHostPty.ts`、`agentHostOutputChannel.ts`、`ahpTerminalCommandSource.ts`、`chatTerminalCommandMirror.ts` |
| 上游浏览器路径测试辅助              | `terminalTestHelpers.ts`（尚无本地生产消费者，不能按缺失数预建）                                                                                                                                                                                                                                                                          |

后续沿现有入口分别闭合：创建／profile 选择先补配置和可信 profile 契约；分屏先确定实例创建与分组 owner，再接列表和屏幕几何；编辑区终端接现有 Editor 服务；状态／提示和 xterm 贡献从真实实例状态、解析与命令事件接入。现有分页轮询适配器与三处已批准 Ash 专属适配器不等于完整上游 backend／child-process 事件契约；Agent／remote 文件也不因路径缺失而提前创建。

## Clipboard 本批准入（2026-10-11）

用户复制／粘贴终端文本 → 当前窗口命令和 `TerminalClipboardContribution` → 实例唯一 xterm 选区／`sendText` → 既有进程管理器与平台输入确认。屏幕仍拥有选区；剪贴板服务仍拥有宿主访问；贡献只拥有异步操作的实例身份与失效代次，不新建进程或输出副本。

准确修改范围：新增上游同路径 `src/ash/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts`；双方已有的 `terminal/browser/terminal.contribution.ts` 只增加装载，`terminal/common/{terminal.ts,terminalContextKey.ts}` 只补被命令消费的标准 ID 和焦点选区键；`terminalContrib/accessibility/browser/terminalAccessibilityHelp.ts` 只增加剪贴板说明。配套范围为中文 `workbench.json`、既有 `test/integration/browser/terminal.integration{,.spec}.ts`、本台账与 Terminal／TerminalContrib README。其他代码只读；没有移动或删除文件。

复制读取解析后的屏幕选区；没有选区时不写空剪贴板，Ctrl+C 继续进入 Shell。macOS 使用 Command+C，Windows/Linux 使用 Ctrl+Shift+C；Windows 另在选区存在时将 Ctrl+C 绑定为复制并清除。清除只在剪贴板写入成功且原选区仍未改变时执行。`terminalTextSelectedInFocused` 在 xterm textarea 的子作用域绑定，继承既有终端焦点上下文，失焦和贡献释放时退出。

粘贴命令由当前宿主剪贴板服务读文本，再使用实例 `sendText(text, false, true)`，保留现有换行归一、child bracketed paste 与后端确认语义；读取拒绝及输入失败返回原始错误。读取期间关闭、退出、连接状态变化或切换活动实例会使旧操作失效，切换回来也不发送旧文本。只读、已退出、隐藏或未附着的屏幕不发送命令粘贴。Linux 的 selection clipboard 使用已有 `readText('selection')` 契约与 Shift+Insert；本轮 macOS 验证未覆盖 Linux 系统 selection clipboard。

注册入口、公开契约和快捷键只参考上游公开声明与用户行为；贡献实现沿用 Ash 的实例注册、DOM 作用域和 Promise 输入队列。没有引入上游私有实现、配置服务、HTML 复制、资源粘贴、copy-on-selection 或多行粘贴确认；这些仍是后续完整 Clipboard 能力的待补项，浏览器原生粘贴继续由现有 xterm 输入链处理。

验证：正常 `pnpm test:unit` 的 Terminal 实例、Tabs 与标题动作共 51 项通过，runner 自测 9 项通过。Chromium Terminal 全量 47 项通过，其中新增剪贴板 9 项。首次 Renderer 类型检查及最终终端浏览器定向类型检查通过；7 个修改的 TS 文件格式检查通过。中文命令标题与剪贴板帮助有真实浏览器断言，新增 5 条翻译；首次全仓本地化检查的 `ash/color.editorGutter.itemBackground` 缺词位于本轮范围之外；随后共享工作树的其他能力改动增加缺词，本轮新增剪贴板词条均齐全。

正常浏览器入口的全套类型检查被未修改的 `test/integration/browser/diff.integration.ts:340` 阻塞：菜单联合类型存在没有 `group` 的成员。终端使用继承原配置且禁止输出的 `.build/desktop/terminal-browser-check.json` 完成定向检查，再运行原 `test/integration/browser/run.ts`；未放宽类型规则或修改该错误。追加中文命令标题断言后，Find、Terminal 标题动作与 Clipboard 的中文场景共 3 项独立重跑通过。共享工作树随后发生范围外的编辑器／键绑定契约变动，正常浏览器入口曾另报 11 个 fixture 的 `visibleEditorPanes`／`enableKeybindingHoldMode` 缺项；未改这些消费者，终端定向检查继续通过。最后 Renderer 复查另受范围外 `scrollLocking`／`snippets` 的 10 项契约错误阻塞，不能将当前共享工作树的全仓检查记为通过。初次拒绝读取用例在启动设备查询应答尚未发送时清空记录，现已等待真实输入队列应答；没有弱化断言。全量测试发现两个旧隐藏终端 fixture 先销毁实例屏幕后又写入旧引用，已仅修正 fixture，使 existing 实例随 View 接管保留原屏幕，原输出、延迟加载和焦点断言保持。

当前生产文件调查：`platform/terminal` 4/46（双方 1、已批准 Ash 专属适配器 3、上游缺失 45）；`services/terminal` 1/1；`contrib/terminal` 18/89（全为同路径）；`terminalContrib` 12/170（全为同路径）。数字只记录路径关系，不代表完整 API 或行为完成率。现有 accessibility 贡献已经装载，本轮只扩展并验证剪贴板帮助，不将其完整输出能力记为本轮实现。

## Find 本批准入

用户在终端执行 Find → 当前窗口命令与 `ITerminalInstance.getContribution` → `TerminalFindContribution` / `TerminalFindWidget` → 该实例唯一 `XtermTerminal` 的 SearchAddon → 匹配选区、高亮、结果数与焦点恢复 → 浏览器真实输入断言和 Web / Electron 产品场景。实例拥有贡献，屏幕拥有搜索插件，Find 控件拥有查询与选项；不复制上游私有结构、DOM 或 CSS。

当前行为：Find 搜索解析后的屏幕和回滚内容，支持大小写、整词、正则、跨屏幕换行匹配、上下一个与结果数读出。无效正则不执行搜索；查询期间到达的新输出更新匹配。Ctrl/Command+F 只在终端或 Find 焦点生效，搜索文字不进入 stdin；Escape 清除匹配并恢复终端焦点。切换实例、隐藏面板保留各自查询和选项；关闭实例先释放贡献，再移除屏幕，取消首次加载插件时尚未生效的查询。Find 使用已有 `accessibility.verbosity.find` 与独立的 Alt+F1 帮助，中文文案已接入；这不代表终端输出 Accessible View 与帮助已经补齐。

允许路径：双方同路径的 `terminal/browser/{terminal.ts,terminalInstance.ts,terminal.contribution.ts,xterm/xtermTerminal.ts}`、`terminal/common/terminalContextKey.ts` 与平台 `accessibility/browser/accessibleView.ts` 只补贡献挂载、搜索端口、焦点上下文和帮助标识。上游同路径缺失文件 `terminal/browser/terminalExtensions.ts`、`terminalContrib/find/{common/terminal.find.ts,browser/terminal.find.contribution.ts,browser/terminalFindWidget.ts,browser/terminalFindAccessibilityHelp.ts,browser/media/terminalFind.css}` 承接实际调用链。注册上下文只传当前实例，不预建尚无消费者的进程／布局管理器。

配套允许路径：`package.json` / `pnpm-lock.yaml` 仅增加与 xterm 6 配套的 SearchAddon；`extensions/language-pack-zh-cn/translations/workbench.json` 增加可见文案；`test/integration/browser/{terminal.integration.ts,terminal.integration.spec.ts,chatInput.integration.ts}`、`terminal/test/browser/terminalTabsLayout.test.ts`、`services/tasks/test/browser/taskService.test.ts` 同步真实链验证和实例 fixtures；`test/smoke/areas/windows/terminal.spec.ts` 验证真实 PTY 查找、实例隔离、关闭释放。本文与两个 Terminal README 同步职责和结果。未列路径只读；旧迁移和用户改动已保存于本批基线之外，不回退。

本批验证：正常 `pnpm test:unit` 执行 Terminal 实例／Tabs、Tasks、Debug launcher 与两项架构检查，共 82 项通过；Chromium Terminal 全量 35 项通过。正常 `test:smoke:desktop` 与 `test:smoke:browser:full` 均完成构建与准备，Terminal / Tasks / Debug 的真实 App Server 场景各 7 项通过。`typecheck:renderer` 通过，17 个触及 TS 文件 formatter 通过，新 Find CSS 的 stylelint 通过，本批本地化缺词为零。

验证修复了两个生命周期问题：新屏幕的早到焦点必须在贡献就绪时同步；实例关闭必须先移除贡献监听，再释放屏幕，避免 `focusout` 访问已释放的渲染器。另修正 SearchAddon 在同一查询改变选项时沿用旧匹配缓存的问题。四种主题、中文标签／帮助、原始 stdin 不接收 Find 按键、Tab／Escape、回滚区、跨屏幕换行、输出更新与首次搜索尚在加载时关闭均由真实浏览器状态断言覆盖。测试主题只绑定新增 Find fixture，避免改变旧 pane fixture 的几何基线。

以上运行环境为 macOS；未验证 Windows/Linux、真实 SSH 或实际 VoiceOver 读出。本批不改 Rust／生成协议，不新增第二个进程后端，不删除文件。Find 的查询历史与工作区搜索、完整标准贡献 hooks、终端输出专属无障碍贡献、分组分屏和 Agent 会话接管仍未完成。

终端基座的文件归属与 DI 接线已迁移：平台契约位于 `platform/terminal/common/terminal.ts`，实例契约与实例管理位于 `workbench/contrib/terminal/browser/terminal.ts`、`terminalService.ts`。Shell 的 `terminalProcessManager.ts` 已接管输入队列、尺寸合并、读取游标、命令排序、分页排空与 xterm 解析等待；实例生命周期迁入 `terminalInstance.ts`，它创建并保留唯一 xterm、绑定原始输入；程序消费者使用 `sendText`，管理器的输入和尺寸请求等待后端确认，取消不回放旧输入。屏幕与 Tab 分别迁入 `xterm/xtermTerminal.ts` 和 `terminalTabbedView.ts`。Workbench 与 Sessions 注册所选进程能力，由共同的 Terminal contribution 创建窗口实例服务。SSH 宿主直接选择完整适配器；本地和 SSH 的字节、退出码转换已收回协议边界。完整 VS Code Terminal API、SSH backend 契约及 terminalContrib 尚未完成。

## 职责与调用链

| Owner                                                                     | 当前职责与状态                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [platform/terminal](../src/ash/platform/terminal/README.md)               | 前端进程契约与 DI 标识；现有 Rust 协议适配、SSH 租约管理继续接入同一后端                                        |
| [contrib/terminal](../src/ash/workbench/contrib/terminal/README.md)       | 服务拥有实例集合与活动项；实例拥有连接/生命周期；管理器拥有输入/尺寸/读取；View、Tab 与 xterm 各自拥有 UI       |
| [services/terminal](../src/ash/workbench/services/terminal/README.md)     | 宿主输出 PTY 创建通知与生命周期已接入 Web API 和 Terminal contribution；不保存 Shell 实例服务                   |
| `contrib/tasks/browser/taskService.ts`                                    | 任务发现、执行与终端命令状态；稳定依赖经构造 DI 注入，注册仍由 Code 模式选择                                    |
| `contrib/debug/browser/debugService.ts`                                   | Debug 执行编排与 DAP `runInTerminal`；稳定依赖经构造 DI 注入，工厂源仍指向同一个共享 registry                   |
| `services/tasks/common/taskService.ts`                                    | 共享任务契约只公开 UI `terminalId`；Tasks/Testing View 自行定位当前终端实例，不向共享契约引入 contribution 类型 |
| [terminalContrib](../src/ash/workbench/contrib/terminalContrib/README.md) | 现有 links、voice 的部分能力；本批只迁移实例契约 import，未添加其他贡献                                         |
| `crates/app-server-protocol`                                              | `terminal/*` 请求、结果、错误与生成 decoder；本批未修改协议                                                     |
| `crates/app-server/src/server/terminal_operations.rs`                     | 解码、连接身份、目录授权路由与 DTO 转换                                                                         |
| `crates/exec-server/src/terminal.rs`                                      | 真实 PTY session、可信 profile、授权工作目录、输出 ring、命令状态与 30 秒重连租约                               |
| `crates/utils/pty`                                                        | 操作系统 PTY/ConPTY、原始字节、尺寸、进程终止与句柄释放                                                         |

用户创建终端 / Tasks 或 Debug 请求终端 → `ITerminalService` → 唯一 `TerminalService` → 容器注入的 `ITerminalProcessService` → 当前 Rust 协议适配器 → `terminal/create|read|write|writeBinary|resize|close` → PTY。定向测试观察实例创建、字节输出、命令状态、输入、尺寸与关闭；浏览器测试还通过真实 contribution 注册入口验证两个窗口作用域的独立性及缺失依赖。

本地 Electron 与已连接 Web 由 `platform/agentHost/browser/webRendererApi.ts` 选择普通适配器。SSH Electron 由 `platform/native/electron-browser/rendererApi.ts` 直接选择完整重连适配器，不再拼接普通服务与租约管理的方法。两个适配器共享一个读取结果转换入口，生成 DTO 的 base64 与 nullable 退出码不进入实例服务。Main 只建立连接并透明转发 frame；token 保存在 Renderer，runtime replacement 通知使旧租约退出。xterm 只拥有屏幕，不成为 PTY 进程 owner；后端 ring 与前端 scrollback 用途不同。

本地断线进入 `disconnected`，连接恢复不自动创建 Shell。SSH `reconnectable` 实例首次续读成功后才从 `reconnecting` 回到 `running`。后端重启、租约过期或换代不能恢复原进程，需 Relaunch；输入不重放。隐藏 Panel 保留实例，进程退出保留屏幕，显式关闭释放后端资源。

## 已批准并退出的旧入口

用户于本批明确回复“同意”下面九个准确路径的退出。路径相对 `src/ash`，对应调用方与测试已同批迁移，旧文件不存在、旧模块 import 为零；文件均由 Git 跟踪，可恢复。

| 旧路径                                                             | 当前落位                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `platform/terminal/common/terminalProcessService.ts`               | `platform/terminal/common/terminal.ts`                                                  |
| `workbench/services/terminal/common/terminal.ts`                   | `workbench/contrib/terminal/browser/terminal.ts`                                        |
| `workbench/services/terminal/browser/terminalService.ts`           | `workbench/contrib/terminal/browser/terminalService.ts`                                 |
| `workbench/services/terminal/test/browser/terminalService.test.ts` | `workbench/contrib/terminal/test/browser/terminalService.test.ts`                       |
| `workbench/services/tasks/browser/taskService.ts`                  | `workbench/contrib/tasks/browser/taskService.ts`                                        |
| `workbench/services/tasks/browser/taskServiceRegistration.ts`      | 合入上述实例实现的 Code 服务注册；UI contribution 不注册该服务                          |
| `workbench/services/debug/browser/debugService.ts`                 | `workbench/contrib/debug/browser/debugService.ts`                                       |
| `workbench/services/debug/browser/debugTerminalLauncher.ts`        | 合入上述执行实现；`runInTerminal` 测试从 DAP 反向请求入口验证，没有保留测试专用生产导出 |
| `workbench/services/debug/browser/debugServiceRegistration.ts`     | 合入上述实例实现的服务注册，由 `debug.contribution.ts` 加载，窗口容器创建和释放实例     |

用户随后要求删除 `code/browser/workbench/codeWorkbenchServices.ts` 并按 VS Code 的职责组织装载：该文件在 VS Code 无同路径对应，只汇总五项注册，没有状态或独立生命周期。其唯一生产调用方已迁移，文件由 Git 跟踪，可恢复。Extension Host、Codebase Symbols 由 `workbench.common.main.ts` 加载；Tasks 由 Web、Desktop 入口选择；Debug、Testing 由各自的功能 contribution 加载服务注册，窗口容器仍按依赖安装。未新增替代汇总文件。

用户进一步确认删除 `code/browser/workbench/modes/code.ts`、`code/browser/workbench/modes/code.contribution.ts`、`code/electron-browser/workbench/modes/code.ts`。三者在 VS Code 无同路径对应，职责已回到现有入口，生产模块引用为零，均可通过 Git 恢复。共同装配回到 `workbench.common.main.ts`，两端 `code/*/workbench/workbench.ts` 在本地化完成后加载 Workbench 和 Sessions 贡献，再直接调用启动函数；单项 `modeLoaders` 已退出。

调用方包括两个 Workbench 创建入口、Code 服务装载、Renderer host/适配器类型、Terminal View/Widget/标题动作/profile 图标、Tasks View、Testing View、voice、对应单测及浏览器 fixtures。共享 Task、Debug、Testing 和 Extension Host 契约没有反向导入 Terminal contribution。标准缺失服务在创建时失败；Debug 宿主明确不提供 DAP 时仍可装配配置服务，启动 Debug 前报告不可用，不创建另一套执行实现。

## 目录调查（2026-10-07，迁移后）

比较 `src/ash` 与只读 `../vscode/src/vs` 的生产 `.ts`、`.css`，排除 `test` 目录及 `.test.ts`。只表示文件路径，不表示完整行为完成率。

| 目录                                | Ash | VS Code | 双方都有 | 仅 Ash | 仅 VS Code |
| ----------------------------------- | --: | ------: | -------: | -----: | ---------: |
| `platform/terminal`                 |   4 |      46 |        1 |      3 |         45 |
| `workbench/services/terminal`       |   1 |       1 |        1 |      0 |          0 |
| `workbench/contrib/terminal`        |  17 |      89 |       17 |      0 |         72 |
| `workbench/contrib/terminalContrib` |   3 |     170 |        3 |      0 |        167 |

新增同路径 owner 承接已有 Ash 调用契约。公开名称与参数仍有差异：平台继续使用进程 ID、分页读取和命令游标；进程管理器已接入 Shell 输出事件与解析等待；完整事件型 child process/backend、process manager 的其他公开能力、profile/configuration、分组、编辑区终端和扩展自供 PTY 尚未对齐。本批不把文件迁移或 DI 标识计为完整公开 API 对齐。

## 后续归属与能力

### 第二批准入：Rust 协议边界与 SSH 装配

用户确认“看看有没有对应 vscode 的职责文件，没有就保留”。上游 `platform/terminal/common/terminal.ts` 的 `ITerminalBackend`、`ITerminalChildProcess` 以及 `contrib/terminal/browser/terminalProcessManager.ts` 承担通用 backend、进程事件和实例进程管理；没有 Rust `terminal/*` DTO 转换、bearer token 旋转或无后端 Ash 宿主的同职责文件。三处现有适配器保留这些专属职责，不把它们记为上游 backend 已对齐。

本批行为链：用户创建和输入终端 → 已有 `TerminalService` → `ITerminalProcessService` → 所选本地或 SSH 适配器 → 同一 Renderer protocol client → Rust PTY；返回原始字节、前端退出码和命令状态。SSH 适配器直接实现完整现有进程服务契约，宿主不再手工拼接普通服务与重连服务。协议解码只有一个转换入口；token 与连接代次仍只由 SSH 适配器拥有。实例继续拥有当前读取游标、输入队列和屏幕事件，本批不声称已完成事件型 child process。

| 准确路径（相对 `src`，文档除外）                                                                                                                                                                      | 文件关系 / 本批动作                                                                                          | 验证                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `src/ash/platform/terminal/common/terminal.ts`                                                                                                                                                        | 双方都有；输出改为字节，退出码采用前端 `undefined`，不新增协议端口                                           | 平台到实例的字节与命令顺序                         |
| `src/ash/platform/terminal/browser/appServerTerminalProcessService.ts`                                                                                                                                | 已确认保留；转换生成读取结果，不向消费者暴露 base64 和 nullable 退出码                                       | 真实 protocol client 与 Web host 创建入口          |
| `src/ash/platform/terminal/browser/reconnectableTerminalProcessService.ts`                                                                                                                            | 已确认保留；公开参数改用前端契约，完整提供 profile、连接状态与读取转换，保留 token/attach owner              | 同一服务对象的读写、连接代次、token 旋转与租约退出 |
| `src/ash/platform/native/electron-browser/rendererApi.ts`                                                                                                                                             | Ash 产品宿主；直接选择 SSH 适配器，退出手工终端对象拼接，不更改连接创建                                      | Renderer 编译；实际 Electron 入口在生产构建后验证  |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                                                                                                                                       | 双方都有；消费已解码字节和前端退出码，保留当前轮询与实例状态                                                 | 既有实例生命周期、命令与输出顺序测试               |
| `src/ash/platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts`                                                                                                               | 保留测试路径；同步创建参数并验证完整进程契约，不迁移文件                                                     | 定向单测                                           |
| `src/ash/platform/agentHost/test/browser/webRendererApi.test.ts`                                                                                                                                      | 现有 host 行为测试；新增从真实装配入口观察终端 DTO 转换；既有反向请求 fixture 同步生成契约要求的 Thread 身份 | 定向单测                                           |
| `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`                                                                                                                             | 双方都有；同步前端字节和退出码 fixtures                                                                      | 定向单测                                           |
| `test/integration/browser/terminal.integration.ts`                                                                                                                                                    | 既有浏览器 fixture；同步前端进程结果，不改界面                                                               | Terminal / Testing Playwright                      |
| `docs/terminal-api-alignment-status.md`、`src/ash/platform/terminal/README.md`、`src/ash/workbench/contrib/terminal/README.md`、仓库 `docs/ash-desktop-architecture.md`、`docs/remote-development.md` | 更新决定、实际装配边界与验证状态                                                                             | 文档链接与 diff 检查                               |

`disconnectedTerminalProcessService.ts` 的拒绝操作与现有契约兼容，本批无需改写。没有文件移动或删除；其余八处 UI 载体与旧重连测试路径仍未取得退出决定。

下表仍没有上游同路径，不在本批移动/删除范围。前三处保留专属协议职责；其余载体须沿实际 UI 行为继续核对，不能因为 Rust 已经提供执行能力就长期保留通用职责的错位文件。

| 路径（相对 `src/ash`）                                                  | 尚待处理                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `platform/terminal/browser/appServerTerminalProcessService.ts`          | 已确认保留 Rust 协议转换职责；不是上游通用 backend 的替代 owner                                        |
| `platform/terminal/browser/reconnectableTerminalProcessService.ts`      | 已确认保留 Renderer SSH bearer 租约与连接代次职责                                                      |
| `platform/terminal/browser/disconnectedTerminalProcessService.ts`       | 已确认保留无后端 Ash 宿主的明确拒绝行为                                                                |
| `workbench/contrib/terminal/browser/instance/alternateScroll.ts`        | 随真实 xterm 滚动入口核对归属                                                                          |
| `workbench/contrib/terminal/browser/instance/terminalInstanceWidget.ts` | 对应 `browser/terminalInstance.ts` 与 `browser/xterm/xtermTerminal.ts`；仍需核对公开对象和屏幕生命周期 |
| `workbench/contrib/terminal/browser/instance/terminalTheme.ts`          | 随真实主题转换切片处理                                                                                 |
| `workbench/contrib/terminal/browser/view/media/terminal.css`            | 核对本地 DOM、样式 owner 与上游 `browser/media/terminal.css`                                           |
| `workbench/contrib/terminal/browser/view/terminalProfileIcon.ts`        | 随 profile 选择入口处理                                                                                |
| `workbench/contrib/terminal/browser/view/terminalTabsLayout.ts`         | 随分组与布局入口处理                                                                                   |
| `workbench/contrib/terminal/browser/view/terminalTitleActions.ts`       | 随真实命令和菜单入口处理                                                                               |
| `workbench/contrib/terminalContrib/voice/browser/terminalVoice.css`     | 随语音界面样式职责处理                                                                                 |

重连测试旧路径 `platform/terminal/test/electron-main/reconnectableTerminalMainService.test.ts` 实际测试 Renderer 租约管理；本批没有取得它的准确退出确认，保留原测试路径与覆盖。

Terminal 输出专属无障碍帮助、输出 Accessible View、terminal verbosity、历史、Quick Fix、Sticky Scroll、Suggest、剪贴板、完整 links provider、分屏和持久化仍未接通。Find 的当前行为与独立帮助见本文开头；查找历史和工作区搜索仍待补。Node PTY Host 的执行职责由 Rust 后端承担，不能创建第二套执行后端；没有真实消费者的扩展 PTY 能力不创建空实现。

标准 `ITerminalChildProcess` 还要求完整属性查询/更新、signal、binary input、数据确认等真实操作。第五批已经补齐创建/attach 的真实 pid 与启动 cwd、当前进程目录和尺寸查询、原始字节输入，以及 Unix 前台进程组中断。当前目录查询在 macOS/Linux 可用；其他平台返回 `null`，不以启动目录代替。Windows 的显式进程中断返回结构化 `TerminalUnsupported`，不注入伪装成信号的输入。通用属性集合、解析后数据确认、进程列表和跨窗口 detach/恢复仍未完成；不能给这些标准方法填空实现。现有 30 秒连接租约也不等同于上游 backend 的持久化。

### 第三批准入：窗口与实例释放

本批闭合已有调用链：Terminal View 的 Close / Relaunch、任务与调试消费者、窗口容器释放 → `ITerminalService` / `ITerminalInstance` → 现有 `terminalService.ts` → 平台进程服务 → PTY 创建与关闭。上游公开实例契约支持释放，生产服务通过实例释放事件移出实例；本地仍由同一个窗口服务拥有实例顺序与活动项，屏幕、输入尺寸和 DOM owner 不变。

当前缺陷是异步创建晚于窗口释放、重启晚于实例关闭、并发重启重复创建，以及已关闭实例仍登记在窗口的释放集合内。独立实现采用按实例 ID 管理的可释放集合；close 立即停止输入和读取，等待后端完成后撤销实例持有；同步 dispose 立即撤销持有并开始关闭。并发 close 共享后端结果，同一重启只允许一次创建，晚到的创建结果必须关闭后才结束操作。测试通过真实 DI 服务入口观察创建、关闭请求、列表、事件与输出，不比较私有成员。

准确写入范围仅为 `src/ash/workbench/contrib/terminal/browser/terminalService.ts`、同目录的 `../test/browser/terminalService.test.ts`、`src/ash/workbench/contrib/terminal/README.md`、本台账及仓库 `docs/ash-desktop-architecture.md`。没有新增、移动或删除文件，也不修改平台适配器和 Rust 协议。标准 process manager 所需的 pid/cwd、属性、signal、binary input 等下层能力仍未闭合，不创建部分服务外壳。

### 第四批准入：列表事件与创建后的连接状态

本批行为链是已有 Terminal View / voice 订阅 `onDidChangeInstances`，以及 View、Tasks、Debug 发起创建或 Relaunch → `ITerminalService` → `TerminalService` 的列表与连接状态 → 实例列表事件、断线状态、是否读取或发送输入。标准同路径服务与实例宿主公开列表变化事件，上游 View 依赖该事件更新内容；本地只在移动时触发，创建和关闭遗漏。平台连接事件也可能先于异步创建结果到达，当前实例却仍以 running 启动读取。

连接状态仍由窗口 `TerminalService` 唯一拥有。实例开始读取时查询该 owner 的当前状态，创建与重启走同一个检查：本地断线进入 disconnected，不自动恢复；SSH 进入 reconnecting，在 ready 后续读成功才恢复 running。实例不新增连接快照、协议请求或重连 owner。列表变化在列表、标题、活动项和初始状态完成更新后通知，不改变创建事件先于输出订阅的约定。屏幕、DOM、焦点与尺寸 owner 不变。

| 本批准入的准确路径                                                                         | 文件关系 / 动作                                                                  | 验证                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                            | 双方都有；补齐创建与释放的列表通知；创建和 Relaunch 开始读取前检查唯一连接 owner | DI 服务入口的事件快照、延迟创建与连接变化、无多余读写 |
| `src/ash/workbench/contrib/terminal/browser/terminal.ts`                                   | 双方都有；注释说明现有列表事件的触发与状态约定，不新增公开端口                   | 契约编译与服务测试                                    |
| `src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`                  | 双方都有；在已有生命周期 suite 增加回归测试，复用可控创建与读取边界              | 正常单测入口和 disposable tracker                     |
| `src/ash/workbench/contrib/terminal/README.md`、本台账、`docs/ash-desktop-architecture.md` | 已有职责文档；同步列表通知与晚到创建的连接语义                                   | 文档链接和 diff 检查                                  |

重新准入：从列表事件和连接状态继续向真实命令消费者追踪，发现 Tasks / DAP 在创建返回后不检查实例状态便写入命令，可能错报启动并一直等待。这是本切片的必要调用方闭合，因此增加以下准确路径：`src/ash/workbench/contrib/tasks/browser/taskService.ts`、`src/ash/workbench/contrib/debug/browser/debugService.ts`（双方都有；写入前检查终端 running，失败时关闭自己创建的实例，不发布 TaskRun / DAP success）；既有 `src/ash/workbench/services/tasks/test/browser/taskService.test.ts`、`src/ash/workbench/services/debug/test/browser/debugTerminalLauncher.test.ts`（保留已确认测试归属；从真实 DI 服务和 DAP reverse request 链路观察未发送命令、未启动任务与关闭）；`src/ash/workbench/services/tasks/README.md`、`src/ash/workbench/services/debug/README.md`（更新失败语义）；`extensions/language-pack-zh-cn/translations/workbench.json`（已有词条 owner；新增错误接入 NLS 并验证中文）。实现不等待恢复后重放命令，用户可以重新运行。

词条更新由现有 `localization:generate` 生成 `src/ash/workbench/services/localization/common/localizationCatalogs.ts`，该已有生成文件也列入准确范围，只允许生成器写入。

其余路径只读。本批没有新增、移动、删除文件，不修改 UI 载体、平台适配器和 Rust 协议；完整 child process/backend 的下层能力缺口不变。

### 第五批准入：Rust 进程信息与真实控制

用户授权先补 Rust PTY 基座。当前行为链：Terminal 创建/Relaunch 与 xterm 输入 → 已有 TerminalService / 平台进程服务 → Renderer protocol client → App Server terminal dispatch → exec-server TerminalService → utils-pty。DAP reverse request 是 shell PID 的实际消费者；xterm `onBinary` 是原始输入的实际入口。进程信息由 Rust 返回，前端不从 Workspace 猜测；窗口仍拥有实例、标题和屏幕。

本批独立实现先闭合创建/attach 的实际 PID 与启动目录、进程属性查询（当前目录与尺寸）、有界原始输入和已有中断信号的协议出口。属性尺寸由实际 resize 更新；不增加无效通用属性写入。当前目录只返回实际查询结果，平台不支持时明确报告，不把启动目录当作当前目录。数据确认需要连接 xterm 的解析完成回调；当前字节事件只说明已交给前端，不能提前当作解析确认。跨窗口恢复还需要实例恢复身份、进程列表、屏幕重播与明确 detach/attach；当前生产实例在窗口释放时关闭 PTY、SSH adapter 的 token 也只在内存中。上述消费者与生命周期尚未闭合，本批不增加无调用方的 ACK 或持久化端口，不把 bounded ring 或 30 秒租约称为完整标准能力。

准确写入清单保存在本批基线 `.build/desktop/terminal-rust-baseline/paths.txt`：Rust 现有 utils-pty process/pty/pipe 与测试、exec-server 终端 DTO/实现/测试、App Server 协议 terminal/registry/error/schema fixtures、terminal dispatch/server dispatch/server tests；前端已有平台 terminal 契约与两个协议适配器、Terminal 契约/实例服务/xterm widget、DAP reverse request 与相关 fixtures；既有职责文档。平台与 Terminal/Debug 服务的同路径 owner 为双方都有；三个协议适配器继续按用户确认保留 Ash 专属职责；widget 本批仅接入原始输入，不移动、删除或重写屏幕 owner。生成目录 `crates/app-server-protocol/schema/` 与 `src/ash/platform/agentHost/common/generated/` 仅由现有生成器更新。其余路径只读。

定向验证从 Rust 公共服务和 App Server typed dispatch 观察真实 PID、目录变化、resize、字节、信号、错误连接拒绝与关闭；从前端真实装配观察 PID 传播、DAP 回复和文本/二进制输入顺序；通过正常构建、生成物检查以及 Playwright Terminal/Tasks/Debug 产品场景验证没有退化。保留全部既有工作区变化，不新建执行后端或标准 child process 空壳。

| 第五批能力             | 唯一 owner 与当前结果                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建/attach ready      | utils-pty 在 child 交给回收任务前捕获 OS PID；exec-server 保存启动时实际使用的规范目录；attach 返回同一身份。前端实例公开 processId/initialCwd，Relaunch 才更新；DAP `runInTerminal` 成功回复携带 `shellProcessId`。                                                       |
| `terminal/processInfo` | exec-server 检查 connection 和目录授权后查询 root shell 的实际 cwd，返回启动信息和最后一次成功应用的字符尺寸；resize/attach 成功后才更新尺寸。macOS/Linux 查询目录，其他平台和已退出进程返回 null。此出口是 Rust 公开进程契约，尚未接入前端完整属性集合。                  |
| `terminal/writeBinary` | App Server 检查 base64 编码上限并解码；exec-server 检查 64 KiB 原始字节上限与所有权；走与文本相同的有界 writer channel，不进行 UTF-8 转换或 command-status 文本推断。xterm onBinary 已沿两个 Renderer adapter 接入；实例按同一队列发送所有先前文本批次、二进制、随后文本。 |
| `terminal/sendSignal`  | exec-server 校验所有权及授权，再委托 utils-pty。Unix PTY 从 tcgetpgrp 找到前台 job，发送 SIGINT；pipe 保留原进程组语义，hard close 保留原 kill-tree 行为。Windows 显式报告不支持。尚未把这个 Rust 出口扩成无当前调用方的前端通用 signal facade。                           |
| 关闭与断线             | 沿用现有 connectionOwned / reconnectable 身份、token 旋转、租约过期及授权撤销清理；不改变 Main/Renderer 的连接拓扑，不重放输入。                                                                                                                                           |

### 第六批：宿主输出 PTY 基座

用户要求补齐基座文件，范围包含建立缺失的 Web 宿主创建入口及其下层契约。生产链路是 `IWebWorkbench.window.createTerminal` → `IEmbedderTerminalService.createTerminal` → `TerminalMainContribution` → `ITerminalService.createTerminal` → 宿主 PTY 打开、输出、改名、退出与释放 → 现有 Terminal View/xterm。服务拥有 contribution 就绪前的创建请求，实例拥有接入后的进程和早到事件；窗口仍只有一个实例列表和一份屏幕。

| 准确路径（相对 `src`）                                                                                      | 关系与本批动作                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/ash/platform/terminal/common/terminal.ts`                                                              | 双方都有；补宿主输出所需的 launch config、进程事件、标题属性和启动/关闭契约                        |
| `src/ash/workbench/services/terminal/common/embedderTerminalService.ts`                                     | 仅 VS Code，原路径新增；宿主 PTY 契约、窗口级创建通知、启动请求队列与进程释放                      |
| `src/ash/workbench/contrib/terminal/browser/terminalMainContribution.ts`                                    | 仅 VS Code，原路径新增；订阅创建通知、接入现有实例服务并显示 View                                  |
| `src/ash/workbench/contrib/terminal/browser/terminal.contribution.ts`                                       | 双方都有；BlockStartup 注册宿主接入 contribution                                                   |
| `src/ash/workbench/contrib/terminal/browser/terminal.ts`                                                    | 双方都有；创建选项区分 Shell profile 与自供 PTY，实例公开只读能力                                  |
| `src/ash/workbench/contrib/terminal/browser/terminalService.ts`                                             | 双方都有；现有实例 owner 接入宿主事件、保留界面订阅前的输出与退出、处理关闭和 Relaunch             |
| `src/ash/workbench/browser/web.api.ts`、`src/ash/workbench/browser/workbench.ts`                            | 双方都有；Web 返回接口与窗口实现提供 `window.createTerminal`                                       |
| `src/ash/workbench/contrib/terminal/browser/terminalView.ts`                                                | 双方都有；无 folder 的宿主输出终端不显示 Shell 的打开目录提示                                      |
| `src/ash/workbench/contrib/terminal/browser/instance/terminalInstanceWidget.ts`                             | 已记录的 Ash 屏幕 owner，本批只按实例只读能力禁止 xterm 输入，不移动或改写 DOM/CSS                 |
| `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts`                                  | 双方都有；只读宿主实例不启动语音输入                                                               |
| `src/ash/workbench/services/terminal/test/common/embedderTerminalService.test.ts`                           | 宿主链路回归测试；从真实 DI 服务和 contribution 观察创建、输出、退出、改名、跨窗口隔离、失败与释放 |
| `test/integration/browser/terminal.integration.ts`、`test/integration/browser/terminal.integration.spec.ts` | 现有 Playwright 入口增加宿主 PTY，验证生产注册、真实 xterm 的早到输出、只读、焦点与清理            |

同步现有 `src/ash/platform/terminal/README.md`、`src/ash/workbench/services/terminal/README.md`、`src/ash/workbench/contrib/terminal/README.md`、本台账及仓库 `docs/ash-desktop-architecture.md`。没有删除、移动文件，没有修改 Rust 协议或生成 DTO，没有新增执行后端或屏幕 owner。

宿主契约与上游同样只提供 open/close、输出和可选退出/改名，不提供输入、signal 或尺寸回调。已退出实例保留屏幕，退出码 0 原样保留；宿主 PID 为 -1、cwd 为空，不能用来代替真实 Shell 身份。平台新增的 `ITerminalChildProcess` 当前仅覆盖此输出链的事件和生命周期，公开成员仍是完整上游契约的子集；完整 Shell child process/backend、属性与解析后 ACK 尚未完成。本批没有通过空方法制造这些能力。

第六批验证：新增回归先复现了宿主同步输出与退出在界面订阅前丢失的问题，修复后通过真实 DI 与 contribution 观察早到事件。正常 `test:unit` 入口的 Embedder、Terminal、Tasks、DAP terminal 和服务装配五个文件共 46 项通过，runner 自测 4 项通过；新增的 8 项 Embedder 用例启用 disposable tracker。Chromium Terminal Playwright 19 项通过，其中新增 2 项验证真实 xterm 的只读宿主输出、焦点与释放；既有中文动作、文本/二进制输入和语音场景保持通过。生产 `pnpm build`、automation 编译、`prepare:backend` 与真实 Electron + App Server Terminal 3 项通过。后端构建无 warning；stylelint 为 0 错误、1 条未修改 Sessions CSS 的建议，Playwright 有既有颜色环境提示。未修改 Rust 或协议，未运行 Rust 单测；未验证 Windows/Linux 和真实 SSH transport 的产品场景。

### 第七批准入：Shell 输出管理与解析确认

用户继续要求补基座。生产链路：Terminal View/Tasks 创建 Shell → TerminalService 公布实例 → 新增同路径 TerminalProcessManager 增量读取 → 实例输出事件 → 现有 TerminalInstanceWidget 的 xterm write 回调 → 解析 promise → 下一批读取及命令完成/退出。进程管理器唯一拥有读取游标、尚未发出的命令事件与读取取消；实例仍拥有成员身份、输入、连接状态和创建/关闭，widget 仍拥有屏幕。实现来自 Ash 的字节 DTO、双游标和窗口生命周期，不复制上游进程后端或屏幕实现。

准确范围：`src/ash/platform/terminal/common/terminal.ts`（双方都有，增加 data/trackCommit/writePromise 事件，data 保留 Ash 原始字节）；`src/ash/workbench/contrib/terminal/browser/terminalProcessManager.ts`（仅 VS Code，原路径补读取、分页排空、事件排序、解析等待与取消）；同目录 `terminalService.ts`、`terminal.ts`（双方都有，迁移读取 owner 与输出事件消费者）；已确认屏幕 owner `browser/instance/terminalInstanceWidget.ts`（仅接解析完成回调，无 DOM/CSS/交互调整）；既有 `test/browser/terminalService.test.ts`、`workbench/services/terminal/test/common/embedderTerminalService.test.ts`、`test/integration/browser/terminal.integration.ts` 及 `.spec.ts`（同步事件与真实入口回归）；三个 Terminal README、本台账和 `docs/ash-desktop-architecture.md`（同步职责与限制）。其余文件只读，无删除或移动。

验证须观察慢解析期间停止续读、完成状态/退出在最后字节解析之后、已退出进程超过一页仍读取尾部、未来输出对应的命令事件不提前发出、关闭/断线取消等待且旧回调不污染新进程、真实 xterm 分块 UTF-8 与早到数据。已有 Shell 首次输出加载解析器，隐藏实例也能完成后台任务，不显示面板或改变焦点；没有进程的隐藏面板仍保持延迟加载。Rust bounded ring 继续拥有后端历史上限；本批解析确认约束 Renderer 读取，不增加虚假的服务器 ACK，也不声称阻塞 OS PTY 读取。完整 Shell child process 属性与跨窗口恢复仍待补。

第七批验证：正常单测入口的 Terminal、Embedder、Tasks、DAP terminal 与服务装配五个文件共 53 项通过，runner 自测 4 项通过。新增 7 项实例回归均启用 disposable tracker，覆盖解析完成/失败、分页尾部、未来命令、关闭、同一 Shell 恢复及旧回调与替换进程隔离。既有重连测试改为等待初始命令事件已消费，避免用“请求已发出”推断游标已更新，仍断言两次恢复的精确游标。

Chromium Terminal Playwright 22 项通过，新增 3 项经过生产服务注册与真实 xterm，覆盖加载期间停止续读、分块中文/emoji、完成与退出、关闭取消和隐藏解析不抢焦点。生产 `pnpm build`、`typecheck:renderer`、automation 编译通过；当前产物的真实 Electron + App Server Terminal 3 项通过。构建无 warning/error；stylelint 为 0 错误、1 条未修改 Sessions CSS 的建议，Playwright 保留既有颜色环境提示。目录审计仅增加上游同路径进程管理器，旧实例读取 owner 已退出；46 个文档相对目标及 `git diff --check` 通过。未修改 Rust 或生成协议，未运行 Rust 单测；Windows/Linux 和真实 SSH transport 产品场景未验证。

### 当前批准批：实例、屏幕与终端界面职责（2026-10-07）

用户明确选择“迁回对应职责文件”，批准八处旧 UI 文件退出；保留 Ash 的实现、DOM、样式与 Rust 适配器。输入、尺寸请求和取消首先迁至 `TerminalProcessManager`，实例负责进程身份与连接状态，服务负责实例集合。此切片的既有 33 项实例单测通过后，开始屏幕迁移；屏幕迁移的 26 项 Chromium 场景通过后，再迁移 Tab 与命令。不能把同路径落位计为完整 VS Code API 或功能对齐。

| 准确路径（相对 `src/ash/workbench/contrib/terminal/`）                                                         | 关系与本批职责 / 生产调用方 / 验证                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/terminalProcessManager.ts`、`browser/terminalService.ts`                                              | 双方都有；现有服务→实例→管理器→PTY，将输入队列、UTF-8 分块、二进制顺序、尺寸合并和停止后的丢弃收敛到管理器；实例生命周期单测                                                     |
| `browser/terminalInstance.ts`                                                                                  | 仅 VS Code；从服务迁回实例身份、创建/关闭、连接状态及输出事件；服务创建它，实例单测及真实 PTY smoke                                                                              |
| `browser/xterm/xtermTerminal.ts`                                                                               | 仅 VS Code；View→屏幕，将 widget、主题转换与 alternate scroll 迁入唯一屏幕 owner；保留独立算法及既有 Ash helper 契约，原有测试改 import，Chromium 验证真实解析和输入             |
| `browser/terminalTabbedView.ts`                                                                                | 仅 VS Code；View→Tab/分栏，迁入现有列表渲染、选择、拖动与尺寸状态；实例集合仍由服务拥有；分栏单测及 Chromium Tab 行为                                                            |
| `browser/terminalIcon.ts`                                                                                      | 仅 VS Code；Tab/标题→profile 图标，迁回既有可信 profile 映射；保持 Ash profile 契约，未声称完成上游 profile 服务                                                                 |
| `browser/terminalView.ts`                                                                                      | 双方都有；迁移屏幕/Tab 依赖，将既有标题 UI 归入 View，保留可见性、初始化、焦点和失败状态；浏览器及 Electron                                                                      |
| `browser/terminalActions.ts`、`browser/terminalMenus.ts`、`common/terminalContextKey.ts`、`common/terminal.ts` | 前三者仅 VS Code、后者双方都有；标题按钮→窗口 CommandService→当前窗口 View，命令定义与菜单静态注册，View 只拥有 toolbar/context；迁移真实使用的标准命令 ID，验证多窗口及标题动作 |
| `browser/terminal.contribution.ts`                                                                             | 双方都有；只加载动作/菜单，退出其 Focus 命令实现，不改变服务或 View 装配                                                                                                         |
| `browser/media/terminal.css`、`browser/media/terminalVoice.css`                                                | 仅 VS Code；原有 Ash 样式原样迁回屏幕 owner，View/voice 加载；计算样式、主题和焦点的浏览器验证                                                                                   |

批准的准确旧路径为 `browser/instance/alternateScroll.ts`、`browser/instance/terminalInstanceWidget.ts`、`browser/instance/terminalTheme.ts`、`browser/view/media/terminal.css`、`browser/view/terminalProfileIcon.ts`、`browser/view/terminalTabsLayout.ts`、`browser/view/terminalTitleActions.ts`，以及 `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.css`。旧文件均由 Git 跟踪；同批迁移全部生产与测试引用，不保留另一套实现。

必要调用方/验证范围为 `src/ash/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts`、`src/ash/workbench/contrib/chat/browser/attachments/chatAttachmentWidgets.ts`，既有 Terminal 四个 UI 单测和 `terminalService.test.ts`，`test/integration/browser/terminal.integration.ts`、`.spec.ts`、`chatInput.integration.ts`、`test/architecture/ui-styling-ownership.test.ts`，Terminal 与 terminalContrib README、`docs/ash-desktop-architecture.md` 与本台账；`extensions/language-pack-zh-cn/translations/workbench.json` 同步迁移 Tab 标签与命令失败提示。浏览器编译另需在 `test/integration/browser/files.integration.ts` 的离线 API fixture 补现有必填 `connectionGeneration`；不改文件夹产品实现。实际 Electron trace 另证明 `test/automation/terminal.ts` 与 `test/smoke/areas/windows/terminal.spec.ts` 使用了旧 Panel 标签；同步为现有生产按钮的 “Toggle Panel Visibility” 与 “Close Panel”，保留所有执行、焦点和输出断言。其他来源不明的 Rust 与脚本变化保留，不属于本批。

实现依照 Ash 当前生命周期：屏幕保留延迟加载与隐藏解析；Tab 组件只订阅服务状态，释放时取消订阅；命令从调用窗口的 accessor 取 View，不保存某个窗口的回调。完整 child process/backend、group、profile/configuration、编辑区终端、服务器 ACK 与 Agent 会话接管仍待后续闭合。

本批准入后的验证：新增创建回调输入回归先失败，管理器改为在实例公布前就绪后，正常单测入口的 11 个受影响文件共 81 项通过，runner 自测 5 项通过。新增回归启用 disposable tracker，覆盖读取启动前的文本与尺寸请求；既有用例继续覆盖断线丢弃、二进制顺序和 UTF-8 边界。Chromium Terminal 29 项通过，新增三项验证实际 View 的窗口命令路由与释放、四种 xterm 主题的参数及计算样式、child 控制和保存/恢复 alternate scroll。真实 Electron 与 Web + App Server 的 Terminal 三项各自通过，覆盖 Shell 输入执行、焦点与隐藏/恢复、多实例输出隔离、实际工作目录写盘和退出后 Relaunch。

Desktop 正常构建、完整 Web 构建和 automation 编译通过，Renderer 类型检查通过。两份 CSS 与 Git 中迁移前的内容逐字相同；定向 stylelint 为 0 错误，保留原有终端状态字号的 1 条设计建议。全仓 stylelint 当前被本批未修改的 `contrib/trace/browser/agentTraceEditor.css` 六个未知变量阻塞，未放宽规则或修改该界面。Playwright 保留既有 NO_COLOR/FORCE_COLOR 环境提示。旧生产/测试 import 为零，仅 Ash 的生产文件目前剩已确认保留的三处平台 Rust 适配器；目录数量只描述落位，不表示功能完成率。Rust 后端为端到端测试完成构建，本批未编辑 Rust 实现或协议，未运行 Rust 单测，也未验证 Windows/Linux 或真实 SSH transport。

## 验证

受影响测试使用真实 DI 创建入口。平台重连覆盖 connection generation 与 token 旋转；实例测试覆盖空窗口、字节/命令顺序、输入、尺寸、关闭、本地断线、SSH 续读及 Relaunch；Tasks/Debug 覆盖缺失依赖、任务状态、compound 与 DAP 反向终端请求；分层检查覆盖共享服务不依赖 contribution。

第一批的完整单测编译和生产 Renderer 检查曾受到 Chat/ToolActivity 类型差异阻塞，使用继承 `tsconfig.test.json` 的定向配置编译后，同一 runner 的 9 个文件共 64 项通过。生产打包当时另被生成 decoder 的 501,969 字节 chunk 拦住（门槛 500,000）。这些是第一批的历史验证限制；第二批当前工作树的 Renderer 检查和正常 `pnpm build` 已通过，没有修改 Chat、协议生成器或放宽构建门槛。

第二批从正常单测入口编译全量测试；首次执行的 10 个受影响文件有一项既有 Web host 请求 fixture 未携带生成协议要求的 Thread 身份，decoder 拒绝请求，handler 没有执行。fixture 已同步并使用生成参数类型约束，独立重跑该文件的 27 项全部通过。最终从正常 `test:unit` 入口重跑 10 个受影响文件共 92 项，全部通过；runner 自测 4 项也通过。没有跳过测试或放宽 decoder。

第二批 `pnpm test:browser:integration terminal.integration.spec.ts testing.integration.spec.ts --project=chromium` 完整测试编译、浏览器构建及 20 项 Playwright 场景通过；含中文动作、焦点、隐藏/恢复、首次输入、语音以及真实 contribution 的双作用域装配。`prepare:backend` 成功编译并选中当前产品 runtime，automation TypeScript 编译通过；当前生产产物运行 `smoketest-no-compile test/smoke/areas/windows/terminal.spec.ts --max-failures=1`，3 项真实 Electron + App Server PTY 场景通过：Panel 焦点与隐藏/恢复、实际输入执行、多实例输出隔离、工作目录写盘、关闭及退出后 Relaunch。Electron UI 的启动与恢复标记场景另有 1 项通过。真实 SSH transport 的产品场景尚未运行，租约、token 旋转、读取与连接事件由 Renderer 平台测试覆盖。

`stylelint` 为 0 错误，1 条未修改 Sessions CSS 的设计建议；Playwright 的 NO_COLOR/FORCE_COLOR 环境提示不涉及本批实现。职责文档相对链接、旧模块引用与 `git diff --check` 均通过；仅 Ash 生产文件仍为原有 11 处，本批没有新增或删除生产文件。未修改 Rust 实现或协议，也未运行 Rust 单测；后端编译仅用于当前产品端到端验证。

第三批先运行新回归测试复现故障：窗口容器释放后的创建抛出 `DisposableStore is already disposed`，同一测试的泄漏检查发现 7 个未释放对象。修复后从正常 `test:unit` 入口运行 Terminal、Tasks、Debug、DAP reverse request、Testing 五个文件共 37 项全部通过；Terminal 最终定向复核 18 项全部通过，其中新增的 10 项生命周期测试逐项启用 disposable tracker。覆盖关闭等待、关闭失败、直接 dispose、并发重启、重启失败后重试、两种关闭时点、窗口释放和多根工作区的原始绑定清理；runner 自测 4 项也通过。

第三批最终生产 `pnpm build`、automation TypeScript 编译通过；构建日志未出现 warning/error。Terminal / Testing 的 Chromium Playwright 20 项通过；当前生产构建运行 Electron + App Server PTY 的 `terminal.spec.ts` 3 项通过，覆盖输入执行、隐藏/恢复、输出隔离、工作目录、关闭和退出后 Relaunch。stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有既有颜色环境提示；职责文档链接、目录对应关系和旧生产引用检查通过。未修改 Rust 或平台协议，也没有新建、移动、删除文件；目录文件统计与第二批相同。真实 SSH transport 的产品场景仍未运行。

第四批先运行 5 项新测试，全部复现列表事件遗漏与异步创建/重启覆盖断线状态；修复后的 Terminal 文件 23 项全部通过。Tasks / DAP 新增 4 项从真实服务装配入口执行的失败场景，覆盖 connectionOwned 与 reconnectable，并使用生成的英文/中文 catalog 核对错误。首次消费者检查中这 4 项的首项行为断言通过，但通用 Workbench 测试装配器引入的无关语言注册与资源触发泄漏检查；场景改为只装配所需依赖，保留 tracker，随后 Tasks / DAP 两文件共 10 项全部通过。其余 Debug / Testing 两文件 13 项通过；五个受影响文件累计 46 项通过，runner 自测 4 项也通过。

第四批正常前置检查一度被工作区中已失去源声明的 `workbench.editor.tabStyle.title` 中文词条阻塞；同一 `tsconfig.test.json` 的直接编译通过。当前工作区的词条已恢复一致，最终正常 `test:unit` 前置编译、`localization:check` 和生产 `pnpm build` 均通过。没有修改该 Editor 词条或其 owner。automation 全量检查曾有两处 `explorer-tree.spec.ts` 引用已移除的 `workbenchMode`；最终全量检查及继承同一编译选项的三个受影响场景检查均通过，没有修改 Explorer 测试或相关产品入口。

第四批 Terminal / Testing / Debug 的 Chromium Playwright 22 项通过；当前生产构建的 Electron + App Server Terminal / Tasks / Debug 6 项通过，覆盖真实 PTY 输入、工作目录、实例隔离、关闭、Relaunch、任务发现不执行、显式运行/重跑/取消，以及 DAP 调试交互。构建日志没有 warning/error；stylelint 为 0 错误，仍有 1 条既有 Sessions CSS 建议，Playwright 仍有颜色环境提示。职责文档链接与 diff 检查通过；Terminal 四个目录的文件统计不变。没有修改 Rust、协议或平台适配器，未运行 Rust 单测，未新建/移动/删除生产文件。真实 SSH transport 的产品场景仍未运行，不能据此声称完整 backend、child process 或 process manager 已对齐。

第五批 Rust 定向检查已在 macOS 完成：utils-pty 的 `just verify` 29 项、exec-server-protocol 的 `just verify` 6 项、App Server protocol 的 `just verify` 88 项单测及 1 项生成物一致性检查通过；exec-server 使用 `--no-default-features --profile ci-test` 的 check、19 项受影响终端测试及 warning gate 通过。App Server 的 check、12 项受影响终端测试及 warning gate 通过。首次原始输入测试误把 macOS `od` 的列间空格当作字节内容，改为断言整行的三个精确十六进制 token；首次 RPC 所有权 fixture 缺少 JSON-RPC 版本、随后重复使用 request ID，修正请求后只重跑失败的 owning test。未修改协议校验规则或削弱所有权断言。全部受影响 Rust 包最终 warning gate 均通过。

第五批正常单测前置编译通过；Web protocol host、SSH adapter、Terminal、DAP reverse request、Tasks 五个文件累计 67 项通过。三个新 Terminal 测试保留 disposable tracker，修正 fixture 的 WorkspaceContextService 归属后，Terminal 文件独立重跑 26 项通过。生成器 `just generate-protocol`、生成 TypeScript strict 检查 `typecheck:protocol`、生产 `pnpm build`、automation 编译及最终 `prepare:backend` 通过，最终正常后端构建无 warning。Chromium Terminal / Testing / Debug 的 23 项 Playwright 场景通过，包含 xterm 实际鼠标报告的高位字节；真实 Electron + App Server Terminal / Tasks / Debug 的 6 项通过。Rust 定向格式检查与 `git diff --check` 通过。

第五批未执行 Windows/Linux 构建和测试，也未运行真实 SSH transport 的产品场景；不能把 macOS 结果当作这些平台的验证。Windows 的显式 signal 不支持、cwd 查询返回 null，已在契约和平台条件测试中记录。解析后输出确认、完整属性集合和跨窗口进程恢复尚未完成；本批没有宣称完整标准 child process/backend/process manager 对齐。

### 固定产品入口

用户确认退出剩余模式注册表及其调用链。已删除 `workbench/common/workbenchMode.ts`、`workbench/common/workbenchModeMigration.ts` 与专属注册表测试；模式目录和服务聚合入口已在前一批退出。产品标题和固定 Sessions 页面由 `code/common/application.ts` 提供，两端入口只向 Workbench 传入标题，Sessions profile 仅描述页面身份与返回路径。用户进一步确认清除存储的产品维度：启动参数、IPC 与正常读写不再使用 `applicationId`；存储 owner 单向迁移旧 Code/Academic 数据，冲突沿用 Code 值并保留原始备份。构建、窗口创建与恢复不选择模式；旧设置与链接不参与启动，旧窗口记录由现有窗口状态 owner 去掉模式字段，真实 Academic 存储迁移保留在存储 owner。

### Code 启动目录与职责收敛

审计 `src/ash/code` 原有 17 个文件：与本机 VS Code 源码同路径的文件为 7 个，Ash 独有文件为 10 个。上游独有的 20 个文件包含 CLI、bootstrap 和测试；Ash 使用 Rust CLI 与 Vite 构建，缺少这些文件不能单独证明能力遗漏，也不应以空实现补齐目录。

下表覆盖原有全部 17 个文件，路径相对 `src/ash/code/`：

| 文件                                                                               | 最终职责与处理                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/application.ts`、`common/codeSessionsProfile.ts`                           | 保留产品常量和唯一的 Sessions profile；构建向 Desktop bootstrap 提供 metadata，Sessions 不反向导入 Code。                                                                                                                                                                                            |
| `electron-main/main.ts`、`electron-main/app.ts`                                    | 保留应用启动与产品装配；Main 的 renderer 检查和加载入口迁移到新 Sessions URL。                                                                                                                                                                                                                       |
| `electron-utility/sharedProcess/sharedProcessMain.ts`                              | 保留 shared-process 启动入口。                                                                                                                                                                                                                                                                       |
| `electron-browser/workbench/workbench.ts`、`workbench.html`                        | 保留 Desktop Workbench 入口。                                                                                                                                                                                                                                                                        |
| `browser/workbench/workbench.ts`、`workbench.html`                                 | 保留 Web Workbench 入口。                                                                                                                                                                                                                                                                            |
| `browser/sessions/sessions-code.ts`、`sessions-code.html`                          | 用户确认后删除两个旧文件；Web 应用入口迁移到 `src/ash/sessions/sessions.web.main.internal.ts`，由 `sessions.web.main.ts` 加载贡献、`browser/web.factory.ts` 提供 `create(container, profile)`。Vite host 生成 `/browser/sessions/sessions.html`；保留 Web Agents 能力，并迁移生产 URL 与测试调用方。 |
| `electron-browser/remote-runtime-install/remoteRuntimeInstall.ts`、`.html`、`.css` | 保留远程运行包安装窗口的产品入口和展示资源，执行与连接仍属于 Remote platform。                                                                                                                                                                                                                       |
| `electron-browser/sessions/sessions-code.ts`、`sessions-code.html`                 | 用户确认后迁移到 `src/ash/sessions/electron-browser/sessions.ts`、`sessions.html`；两个旧文件删除，目标与上游同路径，HTML、构建、Main、automation 与 smoke 消费者同批迁移。                                                                                                                          |
| `test/electron-main/workspaceLaunchArguments.test.ts`                              | 保留启动参数装配的回归测试。                                                                                                                                                                                                                                                                         |

`app.ts` 退出三个执行 owner：Shell 安装算法由现有 `platform/native/electron-main/nativeHostMainService.ts` 承接；本地/SSH Workspace 连接替换与失败回滚由 `platform/workspaces/electron-main/appServerWorkspaceTransition.ts` 承接；待交接队列、一次性确认和 reload/crash/close 中断由 `platform/windows/electron-main/windowsMainService.ts` 随接收窗口释放。共享交接 IPC 契约归 `platform/window/common/window.ts`，Sessions 保留返回 Workbench 的产品动作和草稿消费。

构建仍以 Code 为 Vite root，Workbench URL 保持稳定；现有 `workbenchEntryPlugin` 将 Desktop URL 挂载到 Sessions 的真实 HTML 与 TS 源码，正式打包输出 `sessions/electron-browser/sessions.html`。Web 产品 HTML 改由构建 host 生成，调用 Sessions 自己的公开入口；两个旧 Web 文件和两个旧 Desktop 文件均不再参与生产构建或加载。没有复制上游实现或增加缺乏调用方的层。

本批 Windows 验证：正常单测入口 9 个文件共 80 项通过，runner 自测 5 项通过；Vite 的实际开发服务/打包与配置测试 5 项通过。Desktop Main/Renderer、Web 构建、Renderer/build-tools/automation 类型检查通过；22 个受影响 TS 文件格式检查及定向 diff 检查通过。最初 HTML mount 的全模块 load hook 引入构建性能提示，改为精确输入过滤后重新打包，提示已消失。

初次真实 Playwright 验证中，Electron 草稿交接/占用拒绝、关闭 Workbench 后 Sessions 独立使用与返回重开、两个打包缺页启动场景共 4 项通过；Web 的 Sessions 打开、菜单及返回 Workbench 1 项通过。较长的 Desktop 打开/返回场景完成新路径加载、IPC、重载与窗口重开后，在末尾的尺寸恢复断言失败：预期 1002×702，实际 1003×703，位置一致。该轮没有放宽断言，也没有修改窗口尺寸实现，因此当时未报告该完整场景通过。交接 smoke 的陈旧双草稿期望已按当前 Chat/Code 共用 Session 草稿的行为同步，仍保留初次转移、占用拒绝与源/目标内容断言。Playwright 保留 NO_COLOR/FORCE_COLOR 环境提示；macOS Shell 实际安装与真实 SSH transport 未在此 Windows 环境验证。

初次全仓 stylelint 另有 3 个未知变量错误，位于当时未修改的 `sessions/browser/parts/sidebar/media/sessionsList.css`（`--ash-font-size-label1`、`--ash-font-weight-semi-bold`）和 `sessions/contrib/appTools/browser/media/appToolsHost.css`（`--ash-font-size-heading3`）；入口迁移当时没有 CSS 改动，也没有放宽 lint 规则。

用户随后要求修复这两项问题。真实 Electron 在 Windows 125% 缩放下复现：请求 1002×702 与 1001×701 都返回 1003×703，单次补偿停留在取整区间；继续累积补偿到请求 1000×700 后，返回保存的 1002×702。`CodeWindow` 现在在窗口状态跟踪前最多执行 4 次尺寸读回与累积补偿，达到目标即停止，非正请求立即退出，避免 OS 尺寸约束导致无界重试。现有 Electron 场景增加连续三次关闭/重开，仍逐次严格比较完整矩形；调查用的全局 hook 已移除。

三个 CSS 引用已回到已注册的 `--ash-fontSize-label1`、`--ash-fontWeight-semiBold` 与 `--ash-fontSize-heading3`；没有新增变量或放宽 lint。App Tools 的现有浏览器集成 fixture 接入实际主题绑定，覆盖分组标题与装饰粒子的计算样式、四种主题、键盘焦点、减少动态效果和释放，6 项 Playwright 全部通过。窗口定向单测 76 项与 runner 自测 5 项通过；正常 Desktop 构建、automation 编译通过，真实 Electron 的草稿交接和包含连续三次重开的完整打开/返回场景 2 项通过。stylelint 检查 258 个 CSS 文件，0 错误、0 设计建议。构建曾提示 Vite CSS 插件耗时占比较高，Playwright 仍有颜色环境提示；没有类型或打包错误。

### 输入确认与取消批准入（2026-10-07）

用户输入/听写、运行 Task、DAP runInTerminal → XtermTerminal/voice/TaskService/DebugService → 现有实例输入端口 → TerminalProcessManager → 平台 write/resize RPC → 后端确认或失败 → 调用者 Promise 与 Task/DAP 状态。管理器唯一拥有批次、尺寸合并、操作确认和取消；实例保留连接与进程生命周期。先闭合下层返回值与失败语义，再迁移实例 sendText 与原始键盘端口，不能把现有实例 write 的 stdin 语义计为对齐。

本批准确路径均已在 Ash 存在：terminal/browser 的 terminalProcessManager.ts、terminalInstance.ts、terminal.ts、xterm/xtermTerminal.ts（双方都有；仅输入/尺寸 Promise、关闭/恢复隔离与输入错误处理）；terminalContrib/voice/browser/terminalVoice.ts、contrib/tasks/browser/taskService.ts、contrib/debug/browser/debugService.ts（既有生产消费者；等待或处理确认，发送失败关闭资源并结束运行）；terminal/test/browser/terminalService.test.ts、services/tasks/test/browser/taskService.test.ts、services/debug/test/browser/debugTerminalLauncher.test.ts（行为回归）；test/integration/browser/terminal.integration.ts、terminal.integration.spec.ts、chatInput.integration.ts（消费契约同步及真实输入）；terminal/README.md 与本台账（职责与验证）。不新建/移动/删除文件，不修改 Rust、生成协议或 CSS，其他工作树改动保持原样。

验证目标：文本合并与 UTF-8 拆批保序；文本、二进制与尺寸调用等待真实 RPC 确认；关闭、退出、断线立即取消待发送和进行中的确认；旧连接迟到结果不污染恢复后的状态；Task 启动调用等待发送完成且失败不保留运行项，DAP 不在写入未确认时返回成功；Web/Electron 的键盘、隐藏、退出和 Relaunch 保持通过。

测试消费者追加准入：`src/ash/workbench/contrib/terminal/test/browser/terminalTabsLayout.test.ts` 只同步既有 fake 实例的 Promise 输入签名，不修改布局断言。

### sendText 与原始键盘责任批准入（2026-10-07）

下层确认批已通过 Terminal/Tab 单测与 Task/DAP 的确认、拒绝、取消入口测试，Chromium 29 项通过。下一链路：View.attachToElement → 实例唯一创建并拥有 XtermTerminal → 原始 onData/onBinary → 实例当前进程管理器；Tasks、Debug、voice → 实例 sendText → 换行/执行语义 → 同一输入队列。sendText 使用上游公开签名与注释，并由上游 voice/sendSequence/执行工具调用行为确定文本与控制字符场景；只读取最小 sendText 片段确认 CRLF/LF 归一及 bracketed-paste 行为。Ash 自行实现，原始键盘流不进入文本归一端口。

准确范围为前一批的实例、契约、屏幕、生产消费者与测试 fixture，加 `src/ash/workbench/contrib/terminal/browser/terminalView.ts`（双方都有；局部移交屏幕创建/释放给实例，View 只 attach/detach 与呈现）。公开 xterm、xtermReadyPromise、attachToElement、detachFromElement 都有上游对应且被 View 的真实调用链使用。保留屏幕构造的 Ash 子集与既有布局/CSS；没有新增专属公开端口。移除旧实例 stdin write，消费者同批转 sendText，原始输入绑定迁至实例。实例关闭释放唯一屏幕，View 释放只 detach，后续 View 可重附原屏幕保留输出。

验证新增：sendText 的执行/非执行/CRLF/不重复 Enter、bracketed-paste 只在 child 已启用时包装；键盘 Ctrl+J 字节不归一，原始鼠标不改编码；屏幕重新附着不丢输出、不重复发送输入；窗口与实例释放仍取消未完成加载/输入。

文档追加准入：`docs/ash-desktop-architecture.md` 仅同步 Terminal 章节的屏幕生命周期、输入调用链与确认语义，保护该文档其余已存在改动。

构建失败追加准入：`test/automation/tsconfig.json` 仅将仓库已有 `src/typings/css.d.ts` 纳入 include。实例公开 xterm 类型使 automation 的类型图到达屏幕动态 CSS import；正常 Renderer 构建成功后 automation 的 tsc 报 TS2307，须使用测试/Renderer 已有 CSS 声明，不新增宽泛类型或更改编译规则。

文案追加准入：`extensions/language-pack-zh-cn/translations/workbench.json` 仅补 Task 输入发送失败及清理失败两条消息。Output 是用户可见入口，新的失败日志必须使用现有 localize 并覆盖中文；不改已有其他词条。

本轮输入确认与 sendText 的当前结果：旧实例 stdin write 已移除，所有生产消费者与 fixture 已同步。程序输入使用标准 sendText 签名；原始键盘/鼠标及终端应答由实例直连唯一管理器，不做换行转换。管理器文本拆批、二进制顺序与合并尺寸返回实际 RPC 确认；断线、关闭、退出取消待发送和进行中的等待，重连不被旧 transport 的未完成写入阻塞，旧结果不污染状态。实例拥有唯一屏幕与输入监听，View detach 不销毁输出；重新 attach 不重复绑定。

生命周期复查继续限定在实例 dispose 与上述真实实例测试：TaskRun 会保留已结束实例的 metadata，因此实例关闭后清空 screen 和已解析为屏幕的 readiness promise 引用，再由原 disposable owner 释放资源；避免记录继续保留大段缓冲区。真实实例关闭测试同时断言公开 xterm 已为空，没有新增测试专用生产 helper。

本轮新增 15 项单测回归，正常入口的 11 个文件共 96 项通过，runner 自测 5 项通过；新增中文失败日志与清理失败保留原始错误后，Task 文件 9 项独立重跑通过。Chromium Terminal 31 项通过，新增真实实例的 startup DA 应答、Ctrl+J、程序粘贴和屏幕重新附着；既有鼠标场景随后改为真实 TerminalInstance→进程适配器入口，高位二进制字节用例单独通过。最后补充释放屏幕引用后，25 项实例生命周期单测和真实实例关闭/重新附着场景独立重跑通过。完整 Renderer 与 automation 类型检查、15 个文件的格式检查和职责文档 37 个相对目标通过。Desktop 与完整 Web 正常构建通过；最新产物的 Electron、Web + App Server Terminal/Tasks/Debug 各 6 项通过。后端构建没有 warning，Playwright 保留既有 NO_COLOR/FORCE_COLOR 提示。

首次新增消费者 fixture 漏了 read 结果的 terminalId/commandEventGap，完整测试编译指出后已补齐；screen-only fixture 过早初始化破坏其延迟加载断言，已恢复 fixture 的显式初始化边界，真实实例由生产服务装配测试覆盖。automation 类型图到达动态 CSS import 后出现 TS2307，已纳入仓库现有 CSS 声明，编译及正常产品场景通过；没有绕过类型检查。

该输入批次没有修改 Rust、生成协议、CSS 或新增/移动/删除文件。后端为产品测试完成构建，未运行 Rust 单测；运行验证为 macOS，未验证 Windows/Linux 与真实 SSH transport。服务器输出 ACK/背压、完整 child process/backend、profile/configuration、编辑区终端、真正分组分屏、终端输出无障碍等 terminalContrib 与 Agent 会话接管仍待后续闭合；Find 的后续进展见本文开头。

## 剩余依赖连续批：环境集合（2026-10-12）

扩展 TerminalProfileProvider 的 ExtensionContext.environmentVariableCollection → 原 admitted provider callback 的 getTerminalEnvironment operation → MainThreadTerminalService 的 incarnation lifetime → EnvironmentVariableService → ProfileResolver → 原 Rust create.env。新 Shell 实际应用 Replace/Append/Prepend，Windows 保持执行端变量名大小写，原 Rust 继续拥有实际进程环境；集合唯一属于扩展 context，Workbench 只保留已同步的只读快照。provider 退出移除集合，调用取消不覆盖新 incarnation，persistent 集合保存 Workspace/Machine storage。当前 SDK 能力范围为获准的 terminalProfileProvider，未声称所有未获此能力的扩展均可改变终端环境。

准确新增仅上游路径：platform/terminal/common/environmentVariable.ts；terminal/common/environmentVariable.ts、environmentVariableService.ts、environmentVariable.contribution.ts、terminalEnvironment.ts；测试 terminal/test/common/environmentVariableService.test.ts。准确已有局部路径：terminal/browser/terminalProfileResolverService.ts（启动合并）、terminal/browser/terminal.contribution.ts（DI 前置依赖）、terminal/terminal.all.ts（共同注册入口）、api/browser/mainThreadTerminalService.ts（provider lifetime）、terminalConfigurationService.test.ts（真实 DI fixture）；external-js-ext/src/{host.mjs,vscode.js,node.test.mjs,runtime.rs} 与 app-server/src/server/extension_host_runtime.rs（同一 operation 的 SDK producer/admission）。新 SDK 集合为用户明确授权补齐的前置契约，无新 transport owner、协议 variant 或生成 DTO。实现根据 Ash 原 incarnation/abort/存储链独立设计。

环境 DI 测试追加准入：现有 services/{tasks,debug}/test/browser/{taskService,debugService,debugTerminalLauncher}.test.ts 与 integration/browser/{terminal,appTools}.integration.ts，仅补 resolver 新前置依赖的 fixture 注册。Task/DAP 测试使用无扩展集合的 typed fake；集合启动和持久化在真实服务专项测试覆盖。

## 连续批：屏幕 widget lifetime（2026-10-12）

Find 与实际 WebLinks hover → XtermTerminal.attachWidget → TerminalWidgetManager → 唯一屏幕 overlay container；相同 widget ID 替换立即释放原 widget，detach lease 不移除后来的 widget。TerminalHover 读取 xterm 公共 link range、屏幕 DOM 几何与 cols/rows，交给既有 HoverService 的显示/键盘/Escape/主题 owner。不使用 xterm 私有 renderer 数据、不新建第二套 hover DOM。屏幕释放关闭 widgets，实例移动保留屏幕及 widgets。

准确新增仅上游路径：terminal/browser/widgets/{widgets.ts,widgetManager.ts,terminalHoverWidget.ts}、browser/media/widgets.css。双方已有局部：xterm/xtermTerminal.ts（overlay、WebLinks callbacks、hover policy）、services/terminal/browser/terminal.ts（批准领域契约只用结构 widget port，禁止下层导入 contribution）、terminalContrib/find/browser/terminalFindWidget.ts（Find attach 移交）、terminal/common/{terminal.ts,terminalConfiguration.ts}（showLinkHover 标准设置）、integration/browser/{terminal,chatInput}.integration.ts（真实 HoverService fixture）、terminal.integration.spec.ts（hover/Find geometry/theme/Escape/移交），中文 workbench.json。DOM class 使用 Ash，Find 原控件与焦点 owner 保持。读屏用户继续通过已有 Open Detected Link 命令发现并打开链接。

## 连续批：实例创建 owner（2026-10-12）

TerminalService.createTerminal → TerminalInstanceService.createInstance → 原 execution-host create → 原 TerminalInstance。把现有单一窗口编号、不可变启动快照、两种实例构造及迟到 PTY 回收从 Service 迁入工厂；Service 保留成员、活动实例、标题编号与连接广播。工厂由原 DI container 创建，跟随 Service lifetime。保持现有 Ash create 的异步 backend-ready 行为，本批不声称已完成上游同步 Shell 创建签名；下一 backend 批依赖此创建边界。

准确新增仅上游路径：browser/terminalInstanceService.ts。双方已有局部：browser/terminalService.ts（仅创建方法移交及 ID owner 退出）；已有 terminalService.test.ts（创建/迟到结果/取消/自定义 PTY/重用全部回归）、integration fixture/spec（现有真实入口）。不改变活动模型、屏幕 owner、PTY 输送或平台路由，不新增仅 Ash 文件。

## 连续批：App Server child-process 前置契约（2026-10-12）

实例工厂批 104 项测试通过。下一链：Factory/Instance.reuse → AgentHostTerminalService（Ash App Server 执行端，当前实际 host）→ AgentHostPty → 原 TerminalProcessManager → 已批准 platform/terminal adapters/Rust；Instance 只订阅 child events、保留界面和启动配置。backend 统一拥有在途 create 取消及 client handle lifetime，child 唯一拥有 raw process identity、关闭 Promise 和原 manager；backend lease/token 保留在已有 platform adapter，Rust parser/nonce/命令历史不迁移。BaseTerminalBackend 承接 Service 现有连接缓存/初始化 revision，Service 仅广播实例状态。不会增加另一个 raw IO/channel 或伪造 AHP RPC。

准确新增仅上游路径：browser/{baseTerminalBackend.ts,agentHostPty.ts,agentHostTerminalService.ts}。双方已有局部：platform/terminal/common/terminal.ts 与 terminal/common/basePty.ts（标准 child 支持 byte event 和异步 input/resize）；terminal/{browser/terminalInstanceService.ts,terminalService.ts,terminalInstance.ts}（迁移创建/identity/关闭/连接 owner）；既有 terminalService/configuration/编辑器等测试及 terminal integration fixture/spec（原入口验证完整回归）。当前支持的是 Ash App Server host，并不声明 upstream AHP session/resource 工具契约已存在；Local/Remote transport 仍由批准的 platform adapters 负责。本批不得把相同原始通道再包装成 native/remote 两套 state owner。

## 连续批：已提交命令 source（2026-10-12）

backend/PTY 的 109 项单测通过后，沿原 read→writePromise→metadata 链继续：Manager 只拥有 IO 游标、输入队列和 commit 等待；新 browser/ahpTerminalCommandSource.ts 承接现有待提交 command/cwd/ShellIntegration 元数据及唯一只读发布快照。Rust 仍唯一解析/保存命令，source 只在对应 bytes 已提交时转换协议事件，不增加 parser、nonce 或另一份历史。现有 decoration/history/Chat consumers 继续从原实例读取这一快照。

准确新增仅上游路径 ahpTerminalCommandSource.ts，已有仅局部 terminalProcessManager.ts（将 metadata gate 移交）。现有 terminalService.test.ts 的 parse commit、分页/输出空档、断线/重连、迟到旧结果、reuse 回归直接证明可观察行为；不声明 upstream AHP session command/render API 完成。

## 环境 producer 前置契约深化（2026-10-12）

标准 marketplace VS Code SDK 的已批准 capability ceiling 已包含 terminalProfileProvider，故环境集合改为独立 terminalEnvironment registration，借用同一现有权限，不要求实际注册某个 profile；所有已激活且获准的标准扩展均可为未来 Shell 提供集合。退出原 profile callback 的 getTerminalEnvironment 端口，独立 registration 的 operation/admission/DTO/renderer decoder/transaction 同批闭合，不增加权限 ceiling 或第二条传输链。

新增准入的已有准确路径：crates/external-ext-protocol/src/{lib.rs,validation.rs,protocol_tests.rs}、crates/app-server-protocol/src/protocol/extension_host.rs、crates/app-server/src/server/extension_host_operations.rs；原已准入的两端 host/runtime/SDK files；platform/agentHost/{common/extensionHostApi.ts,browser/extensionHostProtocol.ts}、api/browser/mainThreadExtensionApi.ts 与 mainThreadTerminalService.ts（独立集合 descriptor、reconcile/rollback/lifetime）；现有 Node SDK、platform extensionHostProtocol tests 与 extensionHostService tests。按 Rust skill 的 protocol 生成及 affected client/typechecks 验证。Profile callbacks 保留原 PTY 行为；注册不含环境内容，快照只由原回调查询，工作区持久化仍由 EnvironmentVariableService 拥有。

环境 registration 追加类型路径：services/extensionHost/common/extensionHostService.ts 同步 host registration kind。原主线程扩展测试装配新增真实 EnvironmentVariableService 前置依赖，保留其 fake backend；无新权限或兼容转发。UI 全套的两项 editor move 失败是新 overlay class 的测试迁移误改了旧 panel 容器 locator；已精确恢复旧 locator，两种语言的移动测试均通过，生产 DOM/生命周期没有退化。

协议生成的共享工作树阻塞追加准入：crates/app-server-protocol/src/protocol/registry.rs 仅登记已经由另一批添加并被 ModelMessage 引用的 ToolOutputArtifact/Source/Data 导出，解决生成器的 missing declaration 断言。不改变这些 artifact 的业务模型或消费 UI；这是本批新增 terminalEnvironment DTO 生成与正常类型检查的前置编译缺口。

## 连续批：terminal extension point 的前置 registry 与唯一声明 owner（2026-10-12）

已验证 manifest → services/extensions 的 typed extension-point registry 验证与已提交声明快照 → TerminalContributionService 转成窗口 terminalProfiles → 原 TerminalProfileService 的声明/运行时 profile 合并 → QuickPick。声明验证从 hard-coded Manifest parser 回到终端注册入口；ExtensionService 只保存已验证 manifest，不再另存 terminal domain profiles。运行时 provider/internal profiles 留在原 ProfileService，Shell 创建/授权不变。common 不反向导入 browser/contribution；下层只查询注册 metadata，已验证声明从通用 domain contract 给 consumer。

准确新增仅上游路径：services/extensions/common/extensionsRegistry.ts、terminal/common/{terminalExtensionPoints.ts,terminalExtensionPoints.contribution.ts}。准确已有局部：services/extensions/common/{extensionManifest.ts,extensionService.ts} 与 browser/appServerExtensionService.ts（验证分派、canonical 已提交 manifest snapshots、退出旧 terminalProfiles owner）；services/terminal/common/terminal.ts（批准的贡献服务 domain ID）；terminal/browser/{terminalProfileService.ts,terminal.contribution.ts}、terminal/terminal.all.ts（消费/DI/装载）。测试同步原 terminalConfigurationService/terminalTitleActions、services/{tasks,debug}/test 既有 profile helpers、extensionHostService、extensions/test/common/extensionService 与 folding typed fixture、integration/browser/{terminal,appTools}。仅迁移声明依赖和 fixture；独立新增同路径 terminal/test/common/terminalExtensionPoints.test.ts 验证 manifest入口拒绝重复/非法声明与真实 source 发布/清理。其他工作树改动保护。

## 连续批：环境信息呈现（2026-10-12）

环境 collection 的已同步快照 → EnvironmentVariableInfoChangesActive → 既有终端列表 tooltip。只提示为“新终端”配置了环境的扩展，不推断正在运行实例的环境，也不保存第二份集合或自动重启 Shell。列表订阅原集合事件刷新 tooltip；空集合及 custom PTY 不显示。ITerminalStatus 从批准 browser 契约迁到 common 契约，避免 common/environmentVariable 的类型依赖反向进入 browser。

准确新增仅上游路径 browser/environmentVariableInfo.ts；已有局部 common/environmentVariable.ts、批准 services/terminal/{browser,common}/terminal.ts、terminalStatusList.ts（类型 import）、terminalTooltip.ts、terminalTabsList.ts（唯一 UI consumer/event）；terminalTabsLayout.test.ts 与 terminalTitleActions fixture、既有 env common test、integration fixture/spec，中文 workbench.json。无新的 DOM/CSS/focus 行为；验证真实变量变更后的双语 tooltip 更新、清空撤回，原 PID/cwd/失败原因仍保留。

## 连续批：Desktop 关闭窗口的 PTY 回收确认（2026-10-12）

已有 Desktop 生命周期 onWillShutdown → TerminalNativeContribution 的 final join → 原实例 close Promise → 原 backend/PTY 回收；重复 final join 直到 TerminalService 当前成员为空，覆盖等待期间出现的新实例。RPC 拒绝会记录实际诊断并继续关闭窗口，原实例 close 已移除它的 UI/model；pending create 的迟到释放仍由已验证 backend lifetime 保证。新增 electron-browser/terminal.contribution.ts 只登记此环境 owner，Desktop main 真实装载；Web 不新增重复 owner。

准确新增仅上游路径：electron-browser/{terminalNativeContribution.ts,terminal.contribution.ts} 与 test/electron-browser/terminalNativeContribution.test.ts。已有：sessions/sessions.desktop.main.ts（环境入口）、中文 workbench.json（关闭 join 与实际错误日志）、README/本台账。测试使用真实 LifecycleService 的 final-join 循环和原 TerminalService/Backend，替换只有 process IO；检查关闭确认等待、等待中创建、单个拒绝后其余释放与 contribution dispose 撤回订阅。生命周期参数、日志与存储契约已存在，无新的 CLI/Node spawn 或 process state owner。

## 连续批：只读 capability 前置契约与事件汇合（2026-10-12）

Rust committed ShellIntegration/cwd/status → 原 source → TerminalCapabilityStore 的只读视图 → createInstanceCapabilityEventMultiplexer → Terminal Host Output 的命令完成诊断。capability availability 由原快照计算，只缓存事件边沿；命令/目录通过 getter 读唯一 source，不能写入历史或解析 Shell。事件汇合监听既有/新增实例和 capability，撤回/关闭即时释放订阅。Output 是有界诊断消费者，不作为命令/环境 state owner。

准确新增仅上游路径：platform/terminal/common/capabilities/{capabilities.ts,terminalCapabilityStore.ts}，terminal/browser/{terminalEvents.ts,agentHostOutputChannel.ts}。已有局部 base/common/event.ts（生产使用的 EventMultiplexer 底座，先读 Base reference）；terminal/browser/{ahpTerminalCommandSource.ts,terminalProcessManager.ts,agentHostPty.ts,terminalInstance.ts,terminalMainContribution.ts}（commit change signal/capability/唯一装载），批准 services/terminal/browser/terminal.ts（可选 capability 只读端口，已有 host/PTy fake 可无检测）。定向新增 terminal/test/browser/terminalEvents.test.ts 与既有源/解析/生命周期测试；Frame Output fixture只补 stdout sink domain，中文语言包新增实际 channel/诊断 label。当前 capability 支持 cwd 与 committed command detection 的只读子集，不声明完整 marker/command execution/前端 parser API。
