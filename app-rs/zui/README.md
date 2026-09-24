# `zui` 开发文档

`zui` 是 Rust 桌面应用唯一需要依赖的原生 UI framework crate。它拥有 UI 内核、Application 与多窗口生命周期、任务和定时器、窗口及应用级平台事件归一化、系统服务、托盘和全局快捷键、协议 URL、资源与隔离进程、OS accessibility、应用分发工具、渲染器契约、默认 wgpu 后端与确定性 testing；这些职责在同一 crate 内按能力目录隔离，不通过 sibling crate 暴露替代入口。

产品通过 `zui::app` 启动应用，通过 `zui::window` 和 `zui::input` 接收 ZUI 自有事件，通过 `zui::ui` 构造 scene。节点树、`style!` / `ui!`、校验和自动方框绘制见 [`zui-declarative-styles.md`](../docs/zui-declarative-styles.md)，更广的 UI 编写和主题投影边界见 [`native-ui-authoring.md`](../docs/native-ui-authoring.md)。`ash-ui-components` 在它之上提供可复用组件，`ash-workbench` 负责 Workbench 界面；产品状态、Session、PTY、App Server 与业务 reducer 不得进入 `zui`。

## 1. Crate 边界

| 能力 | 规范公共入口 | 内部 owner |
| --- | --- | --- |
| Geometry、声明式 Element/style、layout、text、scene、inspection、view state 与 component lifecycle | `zui::ui`、`zui::style!`、`zui::ui!` | `ui/foundation` / `ui/layout` / `ui/text` / `ui/presentation` |
| Interaction、animation、deadline、retained lifecycle | `zui::runtime`，并由 `zui::ui` 聚合常用类型 | `runtime` |
| Application、多窗口 lifecycle、退出策略与跨线程投递 | `zui::app` | `app` |
| Application relaunch 调度 | `AppProxy` / `ApplicationHandle` / application 与 window context | `app/relaunch.rs` |
| Application name、app path 与标准用户目录 | `ApplicationPath` / app capabilities | `app/paths.rs` / `app/paths/platform.rs` |
| Application locale、system locale、country 与首选语言 | `ApplicationLocale` / app capabilities | `app/locale.rs` / `app/locale/platform.rs` |
| Application focus/active 与 macOS hide/show | `AppContext` | `app/presentation.rs` / `app/presentation/platform.rs` |
| Single-instance 协调与 second-instance lifecycle | `zui::app::{SingleInstanceOptions, SecondInstance}` / `App::second_instance` | `app/single_instance.rs` / `app/single_instance/transport.rs` |
| 后台任务、作用域取消与 event-loop timer | `zui::runtime`；`zui::task` 是兼容入口 | `runtime/task.rs` / `runtime/timer.rs` |
| Window、display snapshot、event、theme、cursor、文件拖放与 chrome capability | `zui::window` | `window` |
| Keyboard、pointer 与 IME | `zui::input` | `input`；pointer/IME 事件由 `window/event.rs` 统一拥有 |
| 基础 hover 进入、离开、延迟与 deadline | `zui::ui::{Hover,HoverPresence}` | `ui/foundation/hover.rs`；具体颜色、显隐和 active 语义由组件解释 |
| Clipboard、dialog、opener、notification、menu、tray 与 global shortcut | `zui::services` | `services` |
| OS login item | `zui::services::LoginItemHandle` / application capabilities | `services/login_item.rs` / `services/login_item/platform` |
| OS 最近使用文档 | `zui::services::RecentDocumentHandle` / application 与 window context | `services/recent_document.rs` / `services/recent_document/platform.rs` |
| OS 默认协议客户端关联 | `zui::services::ProtocolClientHandle` / application capabilities | `services/protocol_client.rs` / `services/protocol_client/platform.rs` |
| Application badge 与 desktop identity | `ApplicationBadgeHandle` / `ApplicationBuilder::with_desktop_file_name` | `services/application_badge.rs` / native window identity |
| Windows Jump List | `JumpListHandle` / application capabilities | `services/jump_list.rs` / `services/jump_list/platform/windows.rs` |
| OS file icon | `FileIconHandle` / application capabilities | `services/file_icon.rs` / `services/file_icon/platform` |
| Packaged resource 与 shell-free child process | `zui::services` | `services/resource.rs` / `services/process.rs` |
| Signed update check、staging 与 installer handoff | `zui::services` | `services/update.rs` |
| Custom protocol URL 启动与转发 | `zui::app::ProtocolScheme` / `App::open_url` | `app/protocol.rs` / `app/runtime_event.rs` |
| Bundle、协议声明与 native installer | `zui::distribution` / `zui-packager` | `distribution` |
| Bounded runtime trace 与 live snapshot | `zui::devtools` | `devtools.rs` |
| OS accessibility tree 与 action 回流 | `zui::accessibility` / `App::accessibility_action` | `accessibility.rs` |
| Renderer、factory 与 presentation target | `zui::render` | `render` |
| 默认 GPU composition | `zui::app::Application::run` | private `render/wgpu` |
| 常用最小导入 | `zui::prelude` | `prelude.rs` |
| 手动时钟、确定性 lifecycle/timer 与 headless renderer | `zui::testing`；`zui::testkit` 是兼容别名 | `testing` |
| Button、List、Dropdown | 不属于 `zui` | `ash-ui-components` |
| Workbench Titlebar、TabContainer 与交互标识 | 不属于 `zui` | `ash-workbench` |

`src/lib.rs` 只声明这些同名能力模块，不再通过 `api.rs` 拼装第二套目录。根级类型导出、`zui::task` 和 `zui::testkit` 暂时作为现有消费者兼容入口保留；新代码使用上表的规范入口。

## 2. 平台抽象

公共 API 不导出 `winit::WindowEvent`、`winit::WindowAttributes`、`winit::EventLoopProxy`、`winit::WindowId` 或 concrete window。`window/event.rs` 与 `input/keyboard.rs` 在各自 owner 内把 winit 事件转换为 ZUI 自有的 `zui::window::WindowEvent`、`zui::input::KeyEvent`、`ModifiersState`、`Ime` 和 pointer value；应用只处理转换后的稳定语义。

当前 winit `WindowEvent` 词汇由穷尽 match 转换为 ZUI-owned value：除窗口 lifecycle、keyboard、IME、pointer、文件拖放和 theme 外，还保留 cursor enter、scroll phase、touch/pressure、pinch/pan/rotation/double-tap gesture、touchpad pressure、analog axis 与 startup activation token。转换不再提供静默的 `WindowEvent::Other` fallback；升级 backend 后若出现新 native 事件，编译会要求先决定稳定 ZUI 语义。redraw 由 Application runtime 单独分派给 `App::redraw`；resize 和 scale factor 在调用产品 callback 前同步到 renderer 与 `WindowMetrics`。

`zui::window::WindowOptions` 只表达 ZUI 已形成稳定语义的窗口策略，不接受完整 native attribute bag。当前可配置初始/最小/最大逻辑尺寸、resize increments、初始逻辑屏幕位置、窗口层级、系统按钮、theme、初始 cursor、content protection、transparent/blur、validated RGBA window icon、chrome、可见与激活状态、resizable、maximized、borderless fullscreen，以及 owned/modal parent；无效尺寸/位置/图像和不存在的 product parent 在分配 native resource 前拒绝。macOS/Windows 的 parent 分别映射到真实 NSWindow child 与 Win32 owner；Windows modal 会禁用 owner，并在最后一个 modal child 关闭或 application 退出时恢复。Linux parent 以及 macOS modal 当前返回 `WindowOptionsError::Unsupported`，因为现有 backend 不能提供与 Electron 对齐的 transient/modal 语义；不会用 X11 embedded child 或普通置顶窗口伪装。关闭 parent 会按稳定的 child-first 深度顺序关闭全部 descendant，再触发 parent callback。Wayland 无法表达的初始位置、隐藏状态、per-window icon 与非普通窗口层级，Linux 无法可靠表达的非默认系统按钮、content protection 和初始 activation，以及 X11/Windows 不支持的 blur，也均返回 `Unsupported`。`WindowHandle` 是 non-owning capability：它在窗口销毁后仍保留稳定 `WindowId`、`parent_id` 和 modal 标记，通过 `is_open` 与 `state` 区分存活状态；cancelable close、force destroy、redraw、display snapshot、outer bounds/position/center、window level、cursor/title/theme/IME purpose、transparency/blur/icon/decoration、min/max/increment 尺寸约束、系统按钮、content protection、attention、pointer pass-through、可见性、focus、最小化/最大化/全屏以及 window drag/resize 都返回显式 `WindowOperationError`。Wayland 不支持的 focus、visibility、restore、position 和 level 操作，以及 backend 返回的原生 `NotSupported`，统一成为 `WindowOperationError::Unsupported`。`WindowHandle::close` 与 `ApplicationHandle::close_window` 通过私有 main-thread command 投递和原生关闭按钮相同的 `WindowEvent::CloseRequested`，override 可以不调用 `WindowContext::close` 来取消；显式 `destroy` / `destroy_window` 跳过该回调。两条路径都不把实际 window ownership 转交给 handle，event loop 已退出返回 `Disconnected`。

`DisplaySnapshot` 是一次性 topology value，保留 ZUI-owned `DisplayId`、name、physical bounds、可选 work area/rotation/internal classification、scale factor、active refresh rate 与 fullscreen modes，并可标记 primary/current display。快照支持按 identity、全局物理坐标点和最大矩形交集选屏，`changes_since` 生成稳定排序的 added/removed/metrics diff；`AppContext::display_snapshot` 可在没有窗口时查询 application topology，`WindowContext` / `WindowHandle` 的同名能力还标记窗口当前所在 display。`AppContext::cursor_screen_position` 返回与 display bounds 相同的全局物理像素坐标：macOS、Windows 与 X11 查询真实系统指针位置，Wayland 因协议不提供可信全局坐标而返回 `CursorPositionError::Unsupported`，不会把窗口内 pointer event 冒充 screen coordinate。macOS 与 Windows 报告真实 work area/rotation，macOS 还报告内建屏分类，并由 `App::display_event` 接收原生拓扑/指标变化；Linux event loop 每秒至多执行一次 monitor snapshot diff，为 added/removed/scale/bounds 等可观察变化投递相同 `DisplayEvent`，并把 poll deadline 与产品/timer deadline 合并，不依赖 winit/Wayland 未提供的专用 hotplug callback。Linux 的全局 work area/rotation 仍保持 `None`；Wayland 不报告 primary display 时同样返回 `None`，不会猜测第一块屏幕。

`zui::render::RenderWindow` 是传给自定义 `RendererFactory` 的 opaque presentation target。第三方图形后端通过标准 `raw_window_handle::HasWindowHandle` 和 `HasDisplayHandle` 读取 surface capability，不获得 winit 类型或 Application runtime ownership。

## 3. 物理目录与依赖方向

```text
src/
├── app.rs + app/                    Application、context、frame commit、lifecycle、protocol、event loop
├── window.rs + window/              window value、live capability、event、chrome、native owner、runtime registry
├── input.rs + input/                keyboard 与输入契约
├── ui.rs + ui/                      foundation、layout、text、presentation
├── runtime.rs + runtime/            interaction、animation、retained、task、timer
├── render.rs + render/              renderer contract、factory、private wgpu backend
├── services.rs + services/          可注入系统能力及默认实现
├── accessibility.rs + accessibility/ ZUI 语义到 AccessKit 的映射
├── distribution.rs + distribution/ bundle、installer、签名与 notarization tooling
├── testing.rs + testing/            deterministic runtime 与 headless renderer
├── devtools.rs + devtools/           bounded diagnostics
├── prelude.rs                       最小常用导入
├── task.rs                          旧 `zui::task` 兼容入口
└── internal.rs                      crate-private native integration bridge
```

| 模块 | 负责 | 禁止 |
| --- | --- | --- |
| `ui/foundation` | dependency-free value types、identity、geometry、color、icon asset | window、GPU、component 或产品状态 |
| `ui/layout` | 通用 Split/Grid geometry 与 resize constraints | pane 产品语义、窗口状态、绘制 |
| `ui/text` | font catalog、shaping、logical text/input geometry 与 editing | window event、GPU glyph atlas |
| `ui/presentation` | Element、computed layout、paint primitive、inspection、immutable ordered scene、view-local state/subscription 与 identity-keyed component lifecycle | event loop、surface、输入分发、产品 reducer 与业务副作用 |
| `runtime` | interaction、animation、deadline、frame invalidation 与 retained fragment lifecycle | presentation/renderer ownership、产品 reducer |
| `render` | backend-neutral renderer contract 与 factory | 产品状态、输入分发、accessibility owner |
| `render/wgpu` | physical conversion、pipeline、atlas、shader、surface recovery 与 present | 产品状态、layout、interaction/accessibility |
| `window` / `input` | winit adapter、native window owner、ZUI event conversion 与 live capability | scene、产品状态 |
| `app` | App callbacks、window registry、event-loop orchestration 与退出策略 | 产品领域状态、具体组件 |
| `services` | 可注入系统服务、进程隔离与更新 | 产品状态、发布凭证 |
| `distribution` | bundle layout、OS protocol metadata、installer plan 与 direct tool invocation | 签名密钥、发布凭证、产品更新策略 |
| `testing` | 手动 clock、headless window/renderer、确定性 event/timer queue | native event loop、真实系统服务、产品断言逻辑 |

能力根文件负责模块声明和规范 re-export，具体状态与算法进入同名目录。`internal.rs` 只能连接 crate-private native 类型，不能重新成为 `platform` 式的综合 owner；若新增代码找不到清晰能力目录，应先修正 ownership。

## 4. Feature 边界

| Feature | 提供 | 适用场景 |
| --- | --- | --- |
| 无 feature | backend-neutral UI、layout、text、scene、runtime 与 `Renderer` | 组件 crate、headless tests、替代 host |
| `native` | Application、task/timer、system services、accessibility、distribution tooling、testing、ZUI-owned input/window contracts 与 private native adapter | 自定义 renderer 的原生应用及 runtime tests |
| `wgpu`（default） | `native` + 默认 wgpu renderer composition | 开箱即用的桌面应用 |

组件库使用 `zui = { default-features = false }`。需要原生 Application runtime 但不使用默认 GPU backend 的 host 使用 `features = ["native"]`。普通桌面产品启用默认 feature。

## 5. Application 执行路径

```text
zui::app::Application::run
  → 创建 typed event loop、AppProxy、共享 task pool、timer runtime 与 injectable services
  → 首次 active：zui::app::App::ready（仅一次）
  → 每次 active：zui::app::App::resumed
      → AppContext::open_window
          → private window::NativeWindow
          → 首次显示前创建 private AccessKit adapter
          → RendererFactory::create(RenderWindow)
          → window runtime registry
      → 或 ApplicationHandle::open_window 从任意线程投递同一创建链
          → App::window_opened 返回后完成 OpenWindowFuture
  → private winit WindowEvent
      → window::WindowEvent::from_native
      → framework 同步 physical extent 与 scale factor
      → App::window_event / App::redraw
      → WindowContext::present_frame(UiFrame<InteractionFrame>, UiDispatch)
          → private WindowFramePresentation 从同一 frame 解析 scene/inspection/interaction/a11y
          → 同步 OS accessibility tree
          → dyn Renderer::render_scene
          → RenderOutcome::Retry 时重新请求 redraw
  → private raw DeviceEvent / platform memory warning
      → input::DeviceEvent + runtime-local DeviceId
      → App::device_event / App::memory_warning
  → 普通关闭使最后一个产品窗口消失：App::window_all_closed → ExitPolicy
      → App::before_exit → App::will_exit → ApplicationExitDecision::{Exit, Cancel}
  → 显式退出：App::before_exit → child-first WindowEvent::CloseRequested
      → 每个窗口调用 WindowContext::close 才继续；任一窗口拒绝则取消整次退出
      → App::will_exit；此处取消会保留 event loop，但不回滚已关闭窗口
  → force_exit(code) / fatal error：跳过全部取消点并立即进入 teardown
  → exiting
      → 取消 application/window scoped work
      → 释放每个 window 的 accessibility、renderer 与 native resources
```

`ApplicationHandle::proxy` 返回 `Send + Sync` 的 `AppProxy<T>`；worker 可以通过 `send_event` 唤醒主线程，也可以用 normal `exit`、immediate `force_exit(code)`、cancelable `close_window`、force `destroy_window` 和 `open_window` 投递 application/window control。`ApplicationHandle` 保留同名 convenience method，但它同时携带 main-thread menu/tray capability，本身不冒充 cross-thread handle。成功投递只表示主 event-loop queue 已接收命令。`ApplicationHandle::{is_ready,when_ready}` 可在 product constructor 和任意线程使用；readiness 只在首次 `App::ready` 返回后提交，`ApplicationReadyFuture` 是 owned `Send` future，event loop 若提前退出则返回 `ApplicationReadyError` 而不是永久 pending。`AppContext` 提供相同 readiness 查询/等待语义，因此 `ready` callback 内仍观察到 `false`，后续 callback 单调保持 `true`。`open_window` 返回 `Send` 的 `OpenWindowFuture`：窗口先进入 registry 并完成 `App::window_opened`，future 才返回 `OpenedWindow`；event loop 提前退出和实际创建失败分别由 `OpenWindowErrorCode::{Disconnected, Creation}` 分类，丢弃 future 不撤销已入队请求。`AppContext::{window_ids,window_handles,focused_window,parent_window,child_windows}` 提供只包含产品窗口的稳定 registry/relationship snapshot，不泄漏 framework-owned DevTools window。普通事件、exit reason 或 window ID 投递失败继续返回保留原值的 `AppDisconnected<T>`；Application 启动或运行失败返回不泄漏 winit 类型、并可通过 `ApplicationRunError::code` 分类的错误。`ApplicationError::operation` 保留稳定的失败边界标签。`ApplicationPhase` 可从 context 查询，`ApplicationExit` 分离最终产品状态、fatal `ApplicationError` 与 `ApplicationExitReason::{Requested, LastWindowClosed, Forced(code), FatalError, Platform}`；`forced_exit_code` 让 binary entry point 取得并返回强制退出码。显式请求与最后窗口策略会先调用 `App::before_exit`；返回 `ApplicationExitDecision::Cancel` 时保留当前 phase、task/timer 和再次退出能力。显式请求被接受后，runtime 按 child-first 顺序向全部存活产品窗口投递 `WindowEvent::CloseRequested`，任一 handler 不调用 `WindowContext::close` 都会取消退出；已接受并关闭的较早窗口不会回滚，且这条 app-initiated 路径不发出 `App::window_all_closed`。全部窗口关闭后，`App::will_exit` 提供与 Electron `will-quit` 对应的最后取消点；这里取消会保留 application-scoped task/timer 和 event loop，但不重建窗口。`force_exit(code)`、致命错误与平台强制终止没有可靠取消点，因此跳过这些回调并继续 teardown；`App::exiting` 只负责已确定退出后的资源释放。

`AppProxy`、`ApplicationHandle`、`AppContext` 与 `WindowContext` 都提供 `relaunch` / `relaunch_with`。调用只调度新实例，不隐式退出；如果正常退出被取消，请求会保留到 event loop 最终结束。默认请求在调用时捕获当前 executable、原生 argv（不含 index 0）与 working directory，显式 `RelaunchOptions` 可以独立覆盖 executable 或 arguments；全程使用 `OsString` 和 `std::process::Command`，不经过 UTF-8 或 shell。每次成功调用都形成一个独立请求，runtime 在 event loop 结束后先释放 single-instance listener/lock，再按 FIFO 尝试启动全部请求。捕获失败、空 executable 和过晚调度分别由 `RelaunchErrorCode` 分类；实际 spawn 失败由 `ApplicationRunErrorCode::Relaunch` 返回。多个请求中某个启动失败不会阻止后续请求继续尝试。

同一组 application capability 还提供 `application_name` / `set_application_name`、`application_version`、`application_path`、`path(ApplicationPath)`、`set_path` 与 log-path setter，对应 Electron 的 getName/setName/getVersion/getAppPath/getPath/setPath 邻域。默认 application name 来自 executable stem，默认 version 来自 Rust package version；`ApplicationBuilder::{with_application_name,with_application_version}` 可在产品构造前覆盖并校验它们。启动期 name 决定 `UserData`、`SessionData`、`Logs` 和 `CrashDumps` 的默认位置；运行期 `set_application_name` 只更新 ZUI 内部名称，不伪装成 OS display name，也不会暗中移动已经推导的目录。`application_path` 默认是当前 executable 的父目录，也可由 builder 显式指定。`ApplicationPath` 覆盖 Electron `getPath` 的 home、appData、assets、userData、sessionData、temp、exe、module、desktop、documents、downloads、music、pictures、videos、recent、logs 与 crashDumps；底层使用 XDG user dirs、Windows Known Folders 与 macOS standard directory 语义，`Assets` 只在 Windows/Linux 可用，`Recent` 只在 Windows 可用。`set_path` 要求目标是已存在的 absolute file/directory 且类型匹配；`set_app_logs_path` 才会递归创建目录，而第一次读取默认 `Logs` 也按 Electron 契约创建它。Linux/Windows 默认 logs 位于 `UserData/logs`，macOS 位于 `~/Library/Logs/<application-name>`；crash dumps 默认位于 `UserData/Crashpad`。需要在 ready 之前固定 `SessionData` 等位置时，使用 `ApplicationBuilder::with_application_path_override`，不要依赖首次 callback 之后的修改。平台不支持、系统未提供、无效 metadata/override、日志创建失败分别由 `ApplicationPathErrorCode` 分类；启动期 identity/path 配置失败进入 `ApplicationRunErrorCode::ApplicationPaths`。

`AppContext::focus_application` 对齐 Electron 的平台选择：macOS 通过 AppKit 激活 application，`ApplicationFocusOptions::with_steal` 只在显式用户动作需要抢占激活时使用；Windows 选择稳定顺序中的第一个产品窗口；Linux 和其他桌面选择第一个未被平台明确报告为隐藏的产品窗口。结果由 `ApplicationFocusOutcome` 区分 application-level activation、具体窗口和无目标，不静默伪造成功。`is_application_active` 在 macOS 查询 application activation，其他平台查询是否有产品窗口持有键盘焦点。`hide_application`、`show_application` 与 `is_application_hidden` 保留 Electron 的 macOS-only 边界；非 macOS 返回 `SystemServiceErrorCode::Unsupported`，`show_application` 使用不激活的 unhide 语义。

`ApplicationLocale` 在进入 builder 前验证并 canonicalize Unicode language identifier；`ApplicationBuilder::with_application_locale` 显式选择应用语言，未覆盖时按首选系统语言、区域 locale、内置 `en-US` 的顺序选择。`application_locale`、`system_locale`、`preferred_system_languages` 与 `locale_country_code` 保持四种语义分离，并在 `AppProxy`、`ApplicationHandle`、application context 与 window context 上返回启动时的 immutable snapshot。首选语言使用系统有序语言列表；区域 locale 在 macOS 读取 `NSLocale.currentLocale`，Windows 读取 `GetUserDefaultLocaleName`，Unix 读取 `LC_ALL` / `LC_TIME` / `LANG`，所以日期/数字格式选择不会被 Linux 的 `LANGUAGE` 翻译优先级覆盖。POSIX 编码和 modifier 被移除，`C` / `POSIX` 明确映射为 `en-US`；无法检测区域时 `system_locale` 和 country code 返回 `None`，不会借用应用语言伪装系统设置。

### Electron `app` 语义对照

ZUI 采用 Electron 的 application-host 思路，不承诺复刻 Electron/Chromium 对象表。下表是当前完成边界；`尚未完成` 代表仍可进入后续平台 capability，`委托` 和 `不适用` 不是缺失的同义词。

| Electron 能力组 | ZUI 状态 | 当前 owner / 边界 |
| --- | --- | --- |
| ready、isReady、whenReady | 已具备 | `App::ready`、`ApplicationHandle` 与 context readiness |
| window-all-closed、before-quit、will-quit、quit | 已具备 | `App` lifecycle、cancelable child-first window close 与 `ApplicationExitDecision` |
| exit、relaunch | 已具备 | `force_exit(code)` 与退出后 FIFO relaunch queue |
| getName/setName/getVersion/getAppPath/getPath/setPath/setAppLogsPath | 已具备 | application metadata 与 `ApplicationPath` |
| focus/isActive、hide/isHidden/show | 已具备 | `AppContext`；hide/show/hidden 保持 macOS-only |
| getLocale/getSystemLocale/getPreferredSystemLanguages/getLocaleCountryCode | 已具备 | validated application language 与 immutable native locale snapshot |
| request/has/release single-instance lock、second-instance | 已具备 | builder-owned single-instance lifecycle；不暴露可误释放的裸锁 |
| activate、open-url、open-file | 部分具备 | macOS native lifecycle；Windows/Linux URL 由 single-instance argv + allowlist 统一转发，文件关联仍由产品解释 argv |
| dialog、menu、clipboard、notification、tray、globalShortcut、shell opener、autoUpdater | 委托 | `zui::services` typed capability，不塞回 `app` façade |
| addRecentDocument、clearRecentDocuments、getRecentDocuments | 部分具备 | macOS 由 `NSDocumentController` 提供 add/clear/list；Windows Shell 提供 add/clear，list 显式返回 `Unsupported`；Linux 不在 Electron 此接口的支持边界内 |
| setAsDefaultProtocolClient、isDefaultProtocolClient、removeAsDefaultProtocolClient | 已具备 | 可注入 `ProtocolClientService`；macOS LaunchServices、Windows 当前用户 registry、Linux GIO set/query，Linux remove 与 Electron 一样不提供受支持语义 |
| set/getLoginItemSettings | 部分具备 | 可注入 `LoginItemService`；macOS `SMAppService` 与 Windows Run/StartupApproved 的 set/query 已具备，`wasOpenedAtLogin` 和 Windows launch-item enumeration 尚未公开 |
| setDesktopName、set/getBadgeCount | 已具备 | builder 在建窗前固定 `.desktop` identity；macOS Dock 与 Linux LauncherEntry，Windows 不在 Electron 的 badge 支持边界内 |
| setUserTasks、getJumpListSettings、setJumpList | 已具备 | Windows typed task/category/item、removed destination、atomic commit/reset 与 injectable backend |
| getFileIcon | 已具备 | async injectable service；small/normal/large 尺寸与 macOS large unsupported 边界对齐 Electron |
| about/emoji panel | 已具备 | macOS 标准 About/character panel；其他平台 About 复用可注入 message dialog，Windows 10 RS4+ Emoji 使用系统 picker |
| Dock | 部分具备 | badge、macOS 显隐/查询/图标已具备；窗口 attention 继续委托 `winit`，Dock menu 与 download-finished notification 尚未公开 |
| Handoff | 部分具备 | macOS `set/get/update/resign/invalidate` 直接映射 `NSUserActivity`；接收另一设备 activity 的 lifecycle callback 尚未公开 |
| AppUserModelId、packaged identity | 部分具备 | `BundleManifest` / installer 拥有安装期身份；尚无完整 runtime 查询或修改接口 |
| webContents/session/certificate/WebAuthn/Chromium commandLine、GPU/renderer process state、Chromium sandbox | 不适用 | ZUI 没有 Chromium renderer；对应能力不能用空实现伪装 |

默认 `Application::run` 使用私有 wgpu backend。测试或第三方 backend 实现公开的 `Renderer` 与 `RendererFactory`，再使用 `Application::run_with_renderer` 或 `ApplicationBuilder::with_renderer` 注入；组件与产品 scene 构造不改变。Clipboard、file/message dialog、opener、notification、menu、tray、global shortcut、resource 与 process 都能通过 builder 注入替代实现。`ClipboardHandle` 当前支持 text、HTML + plain-text representation、validated RGBA8 image 与全格式清空；旧的 text-only injected backend 通过 trait 默认方法对富内容返回 `ClipboardError::Unsupported`，不会因接口扩展而获得伪实现。

About、Emoji、Dock 与 Handoff 没有新增窗口或渲染中间层。`WindowHandle::request_user_attention` 继续直接映射 `winit` 的 attention capability，`wgpu` 继续只负责 surface、纹理与 frame；只有两者不提供的标准 About panel、系统 character picker、Dock activation policy/icon 和 `NSUserActivity` 进入薄平台 adapter。`AppContext::show_about_panel` 在 macOS 使用标准 AppKit panel，其他平台复用现有异步 message-dialog service；`AppContext` 与 `WindowContext` 都提供 Emoji support query/show。Dock 的 badge 继续由 `ApplicationBadgeHandle` 统一，图标直接复用 validated `WindowIcon` RGBA8，显隐只在 macOS 可用。

`UserActivityInfo` 是 JSON-compatible map。`AppContext::set_user_activity`、`current_user_activity_type`、`update_current_activity`、`resign_current_activity` 与 `invalidate_current_activity` 在 macOS 直接拥有一个 retained `NSUserActivity`；activity type 不能为空，可选 fallback webpage 只接受 Electron 要求的 HTTP(S)，update 只在 type 匹配时合并 state。非 macOS 平台返回 `SystemServiceErrorCode::Unsupported`，不会伪装跨设备 Handoff。

`BackgroundExecutor` 把 `Send` future 放到应用级命名 worker pool 执行，并把完成值投递回 `App::user_event`；它不再为每个 future 新建 OS thread。pool 初始化失败属于 `ApplicationRunError`，因此成功构造的 handle 上 `spawn` 直接返回 `Task`。`TaskScope::Window` 在窗口关闭时取消，application scope 在退出时取消；丢弃 `Task` 也会取消，显式 `detach` 才保留。`TimerScheduler` 使用 native event loop deadline，不为每个 timer 创建线程；相同 deadline 按稳定 ID 顺序投递，窗口关闭与 application 退出会清理对应 scope，window scope 同时支持 `schedule_after` 与 `schedule_at`。

## 6. 系统服务与 accessibility

产品从 `ApplicationHandle::services`、`AppContext::services` 或 `WindowContext::services` 获取 typed capability，不依赖具体 backend crate。`ApplicationBuilder::with_file_dialogs`、`with_file_icons`、`with_message_dialogs`、`with_opener`、`with_notifications`、`with_menus`、`with_application_badge`、`with_jump_lists`、`with_login_items`、`with_protocol_clients` 和 `with_recent_documents` 用于测试替身或产品定制；`RecentDocumentService` 保留 main-thread owner，入口统一拒绝相对路径，macOS 通过 `NSDocumentController` 实现 add/clear/list，Windows 通过 `SHAddToRecentDocs` 实现 add/clear 而对尚未安全解析的 shortcut list 返回显式 `Unsupported`，Linux 与其他平台同样返回 `Unsupported`。`FileIconHandle` 与 application capability 的 `get_file_icon` / `get_file_icon_with` 返回 worker-pool future 和 owned RGBA8；small 固定 16px、normal 固定 32px、large 在 Linux 为 48px、Windows 为 32px 且 macOS 显式返回 `Unsupported`，默认 backend 分别使用 GIO MIME + desktop icon theme、Windows Shell association/embedded resources 与 NSWorkspace。winit 继续只拥有 window/event contract，wgpu 只消费已解码像素，两者不伪装 OS file association lookup。file dialog trait/handle 返回可 `await` 的 `FileDialogFuture`，覆盖单/多文件、单/多目录与保存路径，默认 backend 不在 UI callback 中运行阻塞 picker。`FileDialogOptions::validate` 在 injected/native backend 前统一拒绝空标题、空初始目录、非单一文件名、无效或重复扩展名；过滤器名称、扩展名和全部 options 都有只读 getter，旧 injected backend 对新增多目录选择返回显式 `Unsupported`。`FileDialogOptions::with_parent` 与 `MessageDialogRequest::with_parent` 接收 non-owning `WindowHandle`，默认 backend 在 macOS/Windows 及 Linux XDG portal 上绑定 native parent 形成 modal/sheet；options/request 只延续稳定 `WindowId` 与 weak capability，不延长窗口生命周期，显示前 parent 已关闭会返回显式 `Backend` error。injected backend 通过 `parent_window` getter 可验证相同语义而无需 native handle。`MessageDialogHandle::show` 异步返回 typed OK/Cancel/Yes/No/custom response，支持 information/warning/error 与一至三个 validated custom label。`OpenerHandle::open`、`NotificationHandle::show`、`ProcessHandle::spawn`、`ChildProcess::wait` 和 `UpdateHandle::{check, download, install}` 同样返回 owned `Send` future；可注入的同步 opener/notification/process/update backend 只在共享 `zui-service-*` worker pool 上执行。`SystemServiceError::{service, code}` 提供稳定 capability 名称和 `InvalidInput`/`Unsupported`/`Backend` 分类。URL 与 menu identity 在进入 backend 前已转换成 ZUI-owned value。`MenuModel` 支持 normal/checkbox action、validated accelerator、nested submenu、separator 与 native role，并在 injected/native backend 前递归拒绝重复 ID；macOS 由 NSApp 处理 accelerator，Windows 把 Muda 的 HACCEL 接入 winit Win32 message hook，而不是只绘制快捷键标签。native file hover、hover cancel 和 drop 由 `zui::window::WindowEvent` 直接携带平台路径，不要求产品接触 winit。

`ProtocolClientHandle` 以及 `ApplicationHandle`、application context 和 window context 上的 convenience methods 提供 set/query/remove 三组主线程能力；`ProtocolClientOptions` 可显式指定 absolute executable、保持 OS-native 的参数边界和 Linux `DesktopFileName`，所有 NUL、相对 executable 与非法 desktop identity 都在 injected/native backend 前拒绝。macOS 使用主 bundle identifier 调用 LaunchServices，并要求 scheme 已声明在 `Info.plist`；Windows 在当前用户 `Software\Classes` 下写入和精确比较经过 Windows quoting 的 executable + arguments + URL command，remove 只删除仍与该 exact command 匹配的关联；Linux 用已安装的 reverse-DNS `.desktop` 文件或 `CHROME_DESKTOP` 通过 GIO 完成 set/query，remove 返回显式 `Unsupported`。这项 runtime capability 选择或移除默认 handler，但不会为 macOS 生成 bundle 声明、为 Linux 安装 desktop entry，或代替发布工具链的安装期 metadata。

`LoginItemHandle` 与三种 application capability context 提供 exact set/query；共用的 `LoginItemOptions` 保留 native executable/argument 边界、macOS service kind 和 Windows registry value identity，入口在 native backend 前拒绝相对 executable 与 NUL。macOS 通过 `SMAppService` 管理 main app、agent、daemon 和 login helper，并暴露 not-registered/enabled/requires-approval/not-found 状态；Windows 在当前用户 Run 与 StartupApproved registry 中安全引用 executable/arguments，只有 value name 和 exact command 同时匹配时才删除，并区分已注册但 startup-disabled 的状态；Linux 与其他不在 Electron login-item 支持范围内的平台返回 `Unsupported`。

`ApplicationBuilder::with_desktop_file_name` 接受 canonical reverse-DNS `DesktopFileName`，在创建任何 Linux window 前同时设置 Wayland application ID、X11 `WM_CLASS`、协议客户端默认 desktop entry 与 LauncherEntry badge identity，不修改进程全局环境。`ApplicationBadgeHandle` 和 application/context convenience methods 区分 hidden、numeric 与 indeterminate badge；零 count 隐藏，macOS 使用 Dock tile，Linux 发出 `com.canonical.Unity.LauncherEntry.Update` session-bus signal且 indeterminate 按 Electron 语义隐藏，Windows 与其他不受 Electron 支持的平台返回 `SystemServiceErrorCode::Unsupported`。macOS 的 count 超过 99 显示 `99+`，indeterminate 显示圆点；缓存的 badge 只在 backend 更新成功后改变，builder 注入可以在测试中验证完整 request 而不修改真实 Dock 或 launcher。

`JumpListHandle` 以及三种 application capability context 在 Windows 提供 `set_user_tasks`、完整 `set`/`set_jump_list`、`settings` 和 `reset`。ZUI-owned `JumpListTask` 保留 Windows command-line string、absolute program/icon/working-directory path、icon index、title 和 260 UTF-16 code-unit description limit；`JumpListCategory` 明确区分 Tasks、custom、Frequent 与 Recent，separator 在 native mutation 前被限制到 Tasks，重复 standard/custom category 同样被拒绝。默认 backend 使用 `ICustomDestinationList` transaction、Shell Link、file association item 与 property store，读取 Windows 返回的 minimum slots 和 user-removed destination；替换成功才 commit，generic failure 或已分类的 file-registration/privacy failure 会 abort，`reset` 恢复 Windows-managed list。非 Windows backend 返回显式 `Unsupported`，测试和产品策略可以注入 `JumpListService`。

Tray identity、RGBA artwork、pointer event、shortcut accelerator 和 shortcut event 都是 ZUI-owned value。启用 `native` 时，默认 tray backend 在 macOS/Windows 直接运行，在 Linux 由专用 GTK/AppIndicator 线程拥有 native tray；默认 global shortcut backend 在 macOS、Windows 与 X11 使用 native hotkey，在 Wayland 自动切换到 XDG GlobalShortcuts portal。portal 缺失、用户拒绝或只接受部分注册时均返回错误，不会静默降级成应用内快捷键。

`ResourcePath` 拒绝绝对路径和父目录穿越，`SystemResourceLocator` 识别 macOS bundle 的 `Contents/Resources` 与 executable sibling `resources`。`ProcessCommand` 从不调用 shell、保留参数边界、可清空继承环境，并由 `ChildProcess` 默认执行 terminate-on-drop；异步 wait 不持有 child state lock，因此仍可从另一 handle 发出 terminate。显式 `ProcessSandboxPolicy` 分别表达文件系统与网络权限；默认 backend 在 macOS 使用 Seatbelt、在 Linux 使用 Bubblewrap、在 Windows 通过随 bundle 安装的 `zui-appcontainer-runner.exe` 创建 AppContainer、ACL 与受 job object 约束的 child。受限策略如果无法建立对应 backend 就返回错误，`SystemProcesses` 也拒绝任何试图返回 `Unrestricted` 的降级实现。Windows 默认 backend 支持“只读文件系统 + 禁网”和“工作目录可写 + 禁网”；AppContainer 无法诚实表达的权限组合会 fail closed，产品仍可注入更严格的企业 backend。

`ApplicationBuilder::run_single_instance` 以 validated `SingleInstanceKey` 在 macOS、Windows 与 Linux 协调一个主进程。主进程持有 advisory file lock 和本地 domain socket；第二进程不构造产品状态，只在主进程确认接收后返回 `SingleInstanceRun::Forwarded`。`App::second_instance` 收到完整 native argv（含 index 0 executable）、启动工作目录和 `SingleInstanceOptions::with_additional_data` 提供的不透明字节。wire frame 上限为 1 MiB，保留 Unix 非 UTF-8 参数和 Windows UTF-16 参数；拿到进程锁后才清理崩溃遗留的 socket，避免并发启动把存活主进程的 endpoint 删除。协调器只接受同一桌面用户可访问的本地连接，不是跨用户 IPC 或认证边界。

启动期间收到的 invocation 先在 host 内按 FIFO 缓存，首个 `App::ready` 完成后才会调用 `App::second_instance`；该顺序不依赖底层 event-loop 对预启动 user event 的排序。

```rust,no_run
let options = zui::app::SingleInstanceOptions::new(
    zui::app::SingleInstanceKey::new("com.example.product")?,
)
.with_additional_data(b"new-window".to_vec());
let outcome = zui::app::Application::builder()
    .run_single_instance(options, ExampleApp::new)?;
```

`ApplicationBuilder::with_protocol_scheme` 只接收显式允许 scheme 的启动参数。主实例会从 second-instance argv 中再次应用同一 allowlist，在 `App::second_instance` 后按参数顺序统一进入 `App::open_url`；`AppProxy::send_open_url` 仍可供其他可信平台 bridge 显式转发。macOS runtime 在保留 winit application delegate 所有权的前提下补充 AppKit reopen/open-URL selector：Dock/Finder 对已运行应用的重新激活进入 `App::activated`，file URL 进入 `App::open_file`，非文件 URL 仍须通过 builder 的 scheme allowlist 才进入 `App::open_url`；三个 callback 都先进入 ZUI event queue，不在 Objective-C callback 内执行产品代码。Windows/Linux 文件关联启动目前保留在 second-instance argv 中，由产品解释，不伪装成原生 `App::open_file`。`BundleBuilder` 把相同的 `ProtocolScheme` 写入 macOS `Info.plist`、Linux desktop MIME handler 或 Windows 注册脚本；WiX installer 定义把 Windows scheme 写入每用户 registry。安装期声明、启动 allowlist 与 `ProtocolClientHandle` 的 runtime 默认-handler 选择是三条独立边界：runtime association 不会补写缺失的 macOS bundle declaration 或 Linux desktop entry。

`SignedHttpUpdater` 对 manifest 的原始 payload 执行 strict Ed25519 verification，再按目标平台选择 artifact；下载完成后必须通过 manifest 中的 SHA-256 才能原子进入 staging。`UpdateInstaller` 只接收已经验证的 `StagedUpdate`，默认 backend 交给操作系统打开 installer，也可注入企业部署或测试实现。HTTP transport 与 installer backend 可以阻塞，但 `UpdateHandle` 始终把它们放到 service worker pool，产品直接 await future，不占用 UI callback。

`zui::devtools::DiagnosticsHandle` 提供有界、按序的 runtime trace 和即时 snapshot。它跟踪窗口 metrics、帧数、最近 scene primitive/accessibility 数量、活跃 task/timer 以及 lifecycle、display、menu、tray、shortcut、second-instance、application activation、open-file、protocol URL 和 accessibility action；容量由 `ApplicationBuilder::with_diagnostics_capacity` 控制，`DiagnosticsSink` 可把事件流接到日志或开发工具。调用 `ApplicationBuilder::with_diagnostics_inspection` 后，最近一帧的完整 `InspectionFrame` 也会保留在 `SceneDiagnostics` 中；默认关闭以避免每帧复制节点。每个 runtime window 都提供共享的 `DevToolsHandle`，因此产品可以直接调用 `WindowContext::{open_devtools, close_devtools, toggle_devtools}` 或 `WindowHandle` 上的同名方法；这些调用会由 zui 创建/销毁一个独立的默认 DevTools 原生窗口，并把产品最近提交的 scene 作为 Inspector 数据源。快捷键、工具栏和拾取路由由 zui 统一维护，产品不需要再复制 inspector 状态。默认 Inspector 所需的通用 SVG（Pick、Close、展开/折叠 Chevron）也编译进 `zui`，其他 App 不需要提供资源；产品图标目录仍由 `ash-icons` 负责。`InspectionSelection`、`InspectorState` 与 `DevToolsHandle` 仍是 product-neutral 的会话 contract；zui 提供默认 Inspector 视图，完整显示 `InspectionFrame` 节点树，支持展开/折叠，并在 hover 或选中深层节点时自动展开祖先、滚动定位；ash-ui-components 或产品可以在此基础上提供主题和扩展。snapshot 不持有 native window、renderer 或产品状态。

`InteractionFrame::accessibility_nodes` 是语义树的唯一来源。`WindowContext::present_frame` 接收完整 `UiFrame<InteractionFrame>` 与当前 `UiDispatch`，由私有 resolver 在同一提交边界解析 scene、inspection 与 accessibility；公共 API 不再接受独立的 scene 与缓存语义快照。adapter 在窗口第一次可见前创建。ZUI 内的 `AccessibilityNode` bounds 保持逻辑像素，bridge 在边界处按当前 `WindowMetrics::scale_factor` 转换为 AccessKit 所需的窗口物理像素。OS 请求的 Focus/Click 只有在 root tree 且目标节点确实声明对应 action 时才转换成 `AccessibilityActionKind::{Focus, Activate}` 并回到 `App::accessibility_action`，产品继续通过现有 `UiDispatch` 与 reducer 处理，不产生第二套控件身份。renderer 仍只消费 `UiScene`，不拥有 accessibility。

## 7. 分发工具链

`BundleManifest` 是 library API 与 `zui-packager` CLI 的共同输入。JSON 中的 executable、icon 和 resource source 相对于 manifest 文件目录解析；`ResourcePath` 继续约束 bundle 内 destination。生成器只接受普通文件和目录，拒绝输入 symlink、路径穿越和既有输出，因此失败重试不会覆盖发布目录。

| 目标 | Bundle 产物 | 协议声明 | Installer backend |
| --- | --- | --- | --- |
| macOS | `<name>.app` | `Contents/Info.plist` 的 `CFBundleURLTypes` | `/usr/bin/pkgbuild` 生成 `.pkg` |
| Linux | `<name>.AppDir`，含 `AppRun` | 根 `.desktop` 与 `usr/share/applications` MIME handler | `appimagetool` 生成 `.AppImage` |
| Windows | `<name>-windows`，含可选 AppContainer runner | 显式 `register-protocols.ps1` | WiX 4 `.wxs` + `wix build` 生成每用户 `.msi` |

最小 manifest 见 [`examples/bundle-manifest.json`](examples/bundle-manifest.json)。Windows 产品若使用默认严格 sandbox，必须设置 `windows_appcontainer_runner`；packager 会验证并复制 helper。`bundle` 只生成可检查的目录；`installer` 先生成同一 bundle，再直接执行当前目标的外部工具，不经过 shell；`release` 在 installer 之后执行平台签名与验收：

```bash
cargo run -p zui --bin zui-packager -- bundle app-rs/zui/examples/bundle-manifest.json dist macos
cargo run -p zui --bin zui-packager -- installer app-rs/zui/examples/bundle-manifest.json dist macos
cargo run -p zui --bin zui-packager -- release app-rs/zui/examples/bundle-manifest.json dist macos
```

`InstallerBuilder::prepare` 可让发布系统先检查 `InstallerPlan`，`InstallerBuilder::execute` 再通过可注入 `InstallerTool` 执行。`ArtifactSigner` 同样把 signing plan 与 execution 分开，并通过可注入 `SigningTool` 保留确定性测试入口。默认实现不经过 shell，要求每条命令成功、声明的产物存在，并在完成后运行平台验证：macOS 使用 hardened-runtime codesign、`productsign`、`notarytool --wait`、stapling 与 Gatekeeper 验收；Windows 使用 SignTool 的 SHA-256 Authenticode、RFC 3161 timestamp 与 verify；Linux 生成并验证 armored GPG detached signature。

ZUI 拥有签名流程与验证契约，但不拥有签名身份、私钥或发布权限；缺少任何 tag-release 凭证会直接失败。

## 8. Testing

`zui::testing::TestRuntime` 不创建窗口或系统事件循环。它与 native host 复用同一个 private `LifecycleCore`，因此 first-ready/repeated-resume、readiness future、phase、cancelable close request / accepted destroy、window-all-closed、退出策略、退出取消与退出原因不是测试侧复制的近似规则。测试显式选择起始 `Instant`，再驱动 resume/suspend、second-instance、activation、open-file/open-URL、root/child/modal open、`WindowCloseRequested`、child-first close、redraw、typed event、scoped timer、normal exit 与 forced exit；`is_ready`/`when_ready` 可验证首次 resume 提交和提前退出错误，`decide_next_exit`、`decide_next_window_close`、`decide_next_will_exit` 和 `TestEvent::{ExitRequested, WillExitRequested, ExitCancelled, Exiting}` 可以验证 before-exit、指定窗口或 will-exit 取消后继续运行、app-initiated quit 的 child-first 顺序、`window-all-closed` 抑制、强制退出跳过全部取消点及后续再次退出，modal parent input 状态和多个 modal child 的恢复规则也可直接检查。`advance` 不 sleep，并按 deadline/ID 稳定投递。`present_frame` 使用与 native host 相同的 private frame resolver。`HeadlessRenderer` 实现正式 `Renderer` contract，记录 target 配置和完整 immutable scene；`TestWindow` 同时保存 relationship、input state 和从该 frame 派生的最新 accessibility snapshot。`zui::testkit` 只是迁移期兼容别名。

这套工具验证 runtime policy 和 presentation 输出，但不会伪装真实 OS 行为。窗口 chrome、系统 dialog、VoiceOver/Narrator/Orca 集成和 GPU surface recovery 仍需对应平台 smoke/integration test。

## 9. Scene 与 renderer 不变量

- 所有 geometry、font size 和 scene primitive 使用 logical UI pixels，DPI 转换只发生在 renderer；
- `UiScene` 保存 clip、composition layer 和跨 primitive 类型的精确 back-to-front 顺序；
- renderer 只消费 immutable `UiScene`，不得接收 interaction/accessibility frame；
- component 只产生 Element 与 scene primitive，不接受 device、queue、surface 或 render pass；
- backend 不重新解释产品 layout、component identity、focus 或 command；
- component/Application API 不暴露 `wgpu::*` 或 `winit::*` 对象；
- 新 backend-specific 能力只有形成稳定的跨后端语义后才能进入 `Renderer` contract。

## 10. 修改规则

- **新 public API**：放入同名能力根文件和目录，同时决定是否需要根级兼容导出；不能恢复 `api.rs` 聚合 façade 或 flat-only API。
- **新平台事件**：先在 `window` 或 `input` 定义 ZUI-owned value，再在同一 owner 内完成 private native conversion；产品不能匹配 winit variant。
- **新窗口能力**：由 `WindowOptions` 或 `WindowHandle` 暴露，不得让产品持有 native window owner。
- **新系统能力**：先在 `services` 定义可注入的 ZUI-owned trait/value，再把具体 crate 限制在该能力的默认 backend。
- **新 bundle/installer 格式**：扩展 `zui::distribution` contract 与 `distribution` owner，保持 CLI 与 library 使用同一 manifest；签名凭证不能进入源码或 runtime service。
- **新 accessibility 语义**：扩展 `AccessibilityNode` 与 AccessKit mapper；不得让 component 或产品依赖 AccessKit。
- **新 primitive 或 batch ordering**：先修改 `ui/presentation` contract，再同步所有 renderer。
- **新 layout 算法**：放入 `ui/layout`，输入必须是 caller-owned state，输出必须是 immutable geometry。
- **新 renderer**：实现 public trait，通过 factory 注入；默认 backend 实现保持 private。
- **新通用组件**：放入 `ash-ui-components`；产品专属 surface/state 留在产品 crate。
- **新 product icon artwork/语义目录**：放入 `ash-icons`，通用 icon value contract 只在 `ui/foundation/icon` 演进；仅服务于 zui 默认 DevTools 的内置 artwork 放在 `devtools/assets`，避免 zui 反向依赖 product icon crate。
- **文件规模**：production Rust module 不超过 500 行，超过时按单一职责拆出 owned submodule。

`architecture_tests.rs` 固定能力目录、同名 public root、backend-neutral dependency direction、native dependency owner、无 `mod.rs`、500 行上限、旧技术层目录不得回流，以及 public API 不导出 native backend type。修改 ownership 时同步这些测试与本文。

## 11. 当前能力与剩余边界

当前已实现单 crate 分发、能力目录与公共命名空间一一对应、同一 `UiFrame` 的提交契约、带 revision/subscription 的 `ViewState`、按稳定 `ElementId` 挂载的 `ComponentRuntime`、ZUI-owned event/window/proxy/文件拖放 contract、显式 application readiness/phase/exit reason、可取消的正常退出请求、跨平台 single-instance/second-instance、macOS application activation/open-file bridge、多窗口 lifecycle 与退出策略、产品窗口 registry/focus 查询、cross-thread application/window proxy command、异步 window creation、display topology snapshot/spatial query/diff、三平台 display event（Linux 使用有界 polling）、可查询且失败显式的 live window/geometry/policy/input capability、默认 wgpu backend、renderer/service injection、共享 worker-pool task 与 scoped timer、rich clipboard、异步 file/message dialog、opener/notification/process/update handle、三平台 tray/global shortcut、默认协议客户端 set/query/remove、OS recent documents、resource/process、严格 sandbox policy、signed updater、protocol URL lifecycle、bundle/installer/signing/notarization tooling、bounded diagnostics/devtools、AccessKit publication/action routing，以及复用 lifecycle/frame core 的 deterministic testing/headless renderer。

这些能力构成 Electron 类原生应用 framework 的一组可用基础，但当前不能声明“完整核心职责边界”。剩余状态如下：

| 边界 | 当前状态 |
| --- | --- |
| Application / Window lifecycle、readiness、registry/focus 查询、cross-thread proxy、异步窗口创建、frame commit、window state 与 operation error | 部分具备；constructor/main-thread/testing 共享 `is_ready`/owned `when_ready` contract，首次 `App::ready` 返回后才提交，提前退出显式报错；原生与程序化 `close` 统一投递可取消的 `WindowEvent::CloseRequested`，显式 `destroy` 提供无回调强制路径；正常显式退出先经过 `App::before_exit`，再按 child-first 顺序逐窗请求关闭，任一窗口可取消且不会伪发 `window-all-closed`，全部窗口关闭后由 `App::will_exit` 提供最后取消点，最后窗口策略也依次保留 before/will-exit 取消点；`force_exit(code)` 保留退出码并像 Electron `app.exit(code)` 一样跳过 application/window 取消回调，fatal/platform 退出同样不可取消；三平台 single-instance 将 second-instance argv/cwd/opaque data 和允许的协议 URL 投递给存活主实例，macOS 已接入 `App::activated`、原生 `App::open_file` 与运行期 URL forwarding；Windows/Linux 遵循 Electron 的平台契约，由产品解析启动/second-instance argv 中的文件关联路径，不伪造不存在的 native open-file callback |
| Display topology / global cursor | 部分具备；已提供 application/window scoped immutable snapshot、primary/current、mode、可选 work area/rotation/internal classification、按 identity/点/矩形查询与确定性 diff，macOS/Windows 使用原生 change source，Linux 使用有界 snapshot polling 投递 `App::display_event`；全局物理 cursor query 覆盖 macOS/Windows/X11，Wayland 显式 `Unsupported`；Linux 当前无可信全局 work area/rotation，保持 `None` |
| Parent / modal window relationship | 部分具备；macOS/Windows parent 使用真实 native relationship，Windows modal 具备 owner input 禁用/恢复、multi-modal ref-count 语义与 child-first cascade；Linux parent 与 macOS modal 显式 `Unsupported`，不伪装 |
| `Element` / `Component` composition | 已具备 row/column、固定/填充/内容自然尺寸、gap、主轴/交叉轴排列和统一 layout/inspection/interaction/paint frame，并提供 `ViewState` revision/subscription，以及按稳定 identity 保留 local state、外部 observation 和 RAII resource 的 `ComponentRuntime`；产品 reducer、业务副作用和完整 virtual DOM/effect scheduler 仍由 host 拥有或明确不提供 |
| Platform event vocabulary | 当前 backend 词汇已穷尽转换为 ZUI-owned window、keyboard、IME、pointer、touch、gesture、file、appearance 与 raw-device event；raw device 使用运行期稳定 `DeviceId`，memory warning 进入 application lifecycle；backend 新增事件会在编译期要求补 contract，不再静默折叠 |
| Async system capability | 已覆盖 task、timer、经校验且支持 non-owning window-modal parent 的单/多文件与目录 picker、save/message dialog，以及 opener、notification、process spawn/wait 与 update check/download/install；Linux parent dialog 取决于 XDG portal backend，opener/notification/process/update backend 保持同步注入面，但应用 handle 统一返回 owned `Send` future |
| Deterministic host testing | 部分具备；与 native 共用 lifecycle/frame core，但不模拟真实 OS chrome、dialog、accessibility 或 GPU surface recovery |
| Linux application menu | 尚未完成；当前 muda Linux backend 只能把 `gtk::MenuBar` 插入 `gtk::Window`/`gtk::Container`，而 ZUI 的 Linux window owner 是 winit X11/Wayland window，raw handle 不能满足该 ownership contract；完成它需要更换 Linux window owner 或引入 framework-owned client-side chrome，tray menu 已有独立 backend |
| Default DevTools | scene/runtime Inspector 已具备；不提供也不计划伪装 Chromium DOM/CSS/JavaScript debugger |
| Platform acceptance | 真实 tray、portal、screen reader、签名账户与安装验收仍依赖对应平台 CI/smoke test |

root compatibility exports 尚未进入正式移除周期；Windows AppContainer 继续只接受能够无降级表达的权限组合。后续接口必须先补 contract、错误语义和 deterministic test，再把能力列为完成。

后续能力继续采用同一准则：先形成 ZUI-owned contract 和可注入测试替身，再接具体平台 backend。资源打包、安装器、自动更新与开发工具属于 SDK/tooling 层，不能把产品组件或产品状态收进 `zui`。

## 12. 验证

```bash
cargo check -p zui --no-default-features
cargo check -p zui --no-default-features --features native
cargo test -p zui --no-default-features --features native --lib
cargo clippy -p zui --no-default-features --features native --all-targets -- -D warnings
cargo check -p zui --no-default-features --features native --bins
cargo check -p zui --no-default-features --features native --target x86_64-pc-windows-gnu --lib --bins
bazel test //app-rs/zui:zui-unit-tests
cargo test -p ash-ui-components
python3 -B scripts/cargo.py test -p app
```
