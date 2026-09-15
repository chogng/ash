# `ash` Electron Desktop

`ash` 是 Ash 的 Electron Desktop 产品线。它由 Renderer、Preload 和 Electron Main 组成，
通过 App Server 使用 Rust 后端；三条公开产品线的关系见
[`docs/product-lines.md`](../docs/product-lines.md)。

`code` 与 `academic` 两种内置 Workbench 模式的窗口重载、统一 Renderer 和 contribution 所有权以 [`docs/workbench-modes.md`](../docs/workbench-modes.md) 为准；本 README 只记录 Desktop 实现、运行与验证入口。

## 启动项目

首次运行时，先在仓库根目录 `ash` 下安装依赖：

```bash
pnpm install
```

安装完成后，在仓库根目录执行下面的命令启动桌面端：

```bash
pnpm dev:desktop
```

只开发桌面界面、但需要检查 Electron 特有的窗口、标题栏、菜单和原生交互时，运行：

```bash
pnpm dev:desktop:ui
```

该命令只同步前端生成资源，并启动 Vite、Electron 主进程、预加载脚本和 Electron 窗口；不会构建 Rust 开发包，也不会启动 App Server。窗口中的 App Server 状态会保持为已停止，依赖后端的聊天、文件、Git、终端和搜索操作会明确不可用；选择文件夹仅更新界面的工作区上下文，方便检查前端布局和状态。可以在 Settings 的 Workbench Mode 中切换并重载当前窗口；需要覆盖启动初始模式时设置 `ASH_WORKBENCH_MODE` 环境变量。

只开发 Browser Workbench 界面时，在仓库根目录运行：

```bash
pnpm dev:web
```

该命令只同步生成资源并启动监听 `127.0.0.1:5173` 的 Vite 开发服务器；打开
`http://127.0.0.1:5173/` 即会进入当前产品版本的 Browser Workbench。该模式不编译或启动 Rust。
Browser Workbench 使用 disconnected API，因此 UI 可以独立开发；Chat、Explorer、Git、
Terminal 等依赖后端的操作会明确报告不可用。

只调试 Stanza 编辑器和它的 standalone services 时，在仓库根目录运行：

```bash
pnpm dev:stanza
```

打开 `http://127.0.0.1:5199/build/vite/stanza/index.html`。VS Code 的
`Stanza Editor - Standalone` 启动配置会自动执行同一条命令。调试页使用
`globalThis.stanza.editor.create/createModel`，因此可以直接在浏览器控制台检查模型、编辑器和
生命周期事件，不会启动 Workbench 或 App Server。

需要真实 App Server 能力时运行完整 Web 开发模式：

```bash
pnpm dev:web:full
```

完整模式监听 `127.0.0.1:5174`，根地址同样会进入当前产品版本。Browser 通过 Vite 已认证的 HMR WebSocket 连接本地开发
桥接器；桥接器为每个浏览器连接启动 `ash-app-server-daemon connect`
子进程，浏览器连接关闭时对应子进程也会被回收。Electron 产品改用 `app-server connect`，与
TUI、app 连接同一 profile-scoped local App Server。Browser 命令同样通过设置或 URL 参数选择内置模式；`ASH_WORKBENCH_MODE` 只覆盖开发进程的初始模式，不维护模式后缀命令。

`dev:desktop` 与 `dev:web:full` 会先通过 Node 开发组装器生成
`.build/ash-package/dev/store-v1/<target>/<javascript-runtime>/dev-small/packages/<version>/<build-id>`；其中包含 product-neutral `ash-app-server` backend host、锁定版本的
ripgrep 与平台 sandbox helper。编号清单选择当前包，进程租约保护正在运行的包，存储固定保留当前与回滚包。Electron 默认生成 `hostProvidedNode` variant，
不再下载或复制 standalone Node；`dev:web:full` 显式生成 `packagedNode` variant，因为 Browser bridge
没有 Electron runtime。开发态和发布态 Electron 都从相同的
`<package>/bin/ash-app-server-daemon[.exe] connect` 入口连接共享 App Server，区别仅在编译 profile 和 package root。
准备流程只使用仓库已要求的 Node、Rust 和 host archive utility，不安装或调用
Python。`dev:desktop` 随后启动 Vite、主进程、预加载脚本和 Electron；`dev:web:full` 只启动
Vite，并按浏览器连接管理 App Server。启动后不要关闭终端，停止服务可以按 `Ctrl+C`。

### 开发态热更新

热更新分为两个单向依赖层：`src/ash/base/common/hotReload.ts` 定义 Renderer realm 内通用的
export-handler runtime，`src/ash/base/common/hotReloadHelpers.ts` 在其上提供
`readHotReloadableExport`、`observeHotReloadableExports` 和 `createHotClass`；两者都不依赖 Vite 或
Workbench。根 `build/vite/` 拥有开发入口、语法分析、HMR 边界注入和完整 Vite 配置。Workbench 产品
源码不启用或配置开发工具。

Renderer 开发服务器使用 Vite HMR。`build/vite/setup-dev.ts` 在产品入口前启用 runtime。CSS 由 Vite
直接替换；一般运行时导出会交给 helper 注册的观察者决定是否接受更新。名称以 `Part`、`ViewPane` 或
`Widget` 结尾的持久 UI 类由 `build/vite/hotReloadPlugin.ts` 建立稳定身份，方法修改会补丁到
现有实例，因此 Workbench 状态和当前窗口不需要重建。其他确实只修改原型方法的派生 UI 类可以用
`@ash-hot-reload patch-prototype` 显式加入同一机制。

Vite 插件会在模块执行前比较 TypeScript 语法结构。只有普通实例方法、getter 和 setter 的变化进入
原型热替换；构造器、实例字段、静态状态、装饰器、模块声明/副作用或继承关系变化都会自动执行完整
页面重载，并在开发服务器日志中说明原因。这样旧实例不会静默保留过期的初始化状态。Electron Main
与 Preload 仍会重启整个 Electron 进程。`build/desktop/watch/electron.ts` 分别保留两个 TypeScript
watch program，但只在两边都完成当前编译且为 0 errors 后重启 Electron；任何编译失败都会保留当前
进程，避免加载同一轮增量编译中的半成品模块图。

完整 Electron 开发命令还会运行 `build/desktop/watch/appServer.ts`。Rust 源码或 Cargo manifest 变化后，它先完成
`ash-app-server` 的 `dev-small` profile 构建，再发布一个不可变 generation；每个本地 Workbench window 随后通过现有 App
Server supervisor 停止旧连接并启动新 generation。构建失败时当前 App Server 继续运行，初始化失败
时自动回滚到上一 generation。Host 构建遵循 `CARGO_TARGET_DIR`，并直接读取 Cargo JSON artifact 报告的
executable 路径，不依赖默认 target layout；generation 以 executable 内容摘要命名，内容未变化时不会重复发布，只保留当前版本
和一个回滚版本。Watcher 只接受 `ash-rs` 源文件与根 `Cargo.toml`、`Cargo.lock`，明确忽略默认
`.build/cargo` 以及解析后的自定义 `CARGO_TARGET_DIR` 内生成的 Rust 文件，避免一次构建再次触发自己。可以单独运行
`pnpm dev:rust` 启动同一 watcher；`dev:ui` 和
不启动 Rust 的 disconnected Web 模式不会监听后端。

不带项目路径启动时，Ash 使用空窗口上下文。构建完成后，可以通过启动参数打开一个项目目录：

```powershell
pnpm --dir ash-ts start -- C:\path\to\project
```

也可以显式声明目标类型：

```powershell
pnpm --dir ash-ts start -- --folder C:\path\to\project
pnpm --dir ash-ts start -- --workspace C:\path\to\team.ash-workspace
```

单目录启动时，当前版本会把目录作为 App Server 的 canonical `Dir`，并通过
`fs/getMetadata`、`fs/readDirectory` 为 Renderer 的 Explorer 提供按需目录枚举，并通过
`fs/readFile` 把不超过 10 MiB 的 UTF-8 文件打开到已注册的文本编辑器。编辑目前只保留在
内存模型中；保存、写入/重命名、文件监听与自动刷新、多根 Workspace 配置解析尚未实现。
Explorer 使用的 Seti 主题 JSON 和 WOFF 由 `platform/theme/browser` 直接拥有。TypeScript 从主题 JSON 推导所需结构，不维护额外的 Schema、生成类型或构建时资源副本。

代码中 `platform/workspace` 定义当前窗口的 Workspace 模型与上下文，
`platform/workspaces` 负责启动目标解析和后续工作区管理能力。两者不是同一服务的单复数别名。

## Electron 启动门禁

Electron 启动统一经过 `src/main.ts` 和 `code/electron-main/main.ts`；它们先执行 bootstrap，打包应用从共享 profile 的 `workbench.mode` 读取初始模式 ID，非打包应用允许 `ASH_WORKBENCH_MODE` 覆盖，然后在 Electron `ready` 事件后启动应用，不在 ESM 顶层等待 `app.whenReady()`。应用运行后由 Workbench Mode Service 持久化模式选择，并通过带新 Mode URL 的窗口重载完成 Code/Academic 切换；Electron Main 不再按 Product 或静态 Mode 分派。`AshApplication.startupAfterReady()` 会断言 Electron 已进入 Ready，从结构上避免入口模块和 `ready` 生命周期互相等待。

本地 Electron 调试使用统一命令：

```sh
pnpm dev
pnpm dev:ui
pnpm start
```

需要直接以 Academic 作为开发初始模式时仍使用相同命令，例如 `ASH_WORKBENCH_MODE=academic pnpm dev`。无论初始模式为何，Vite 都把 Code、Academic 和 Code Sessions 入口输出到同一个 `.build/desktop/renderer/ash` 目录。

Ready 后在后台启动 App Server，并完成 initialize、server identity、protocol version
与 schema hash 校验；门禁通过后才创建业务 Workbench 窗口。主窗口初始保持隐藏，
在 `ready-to-show` 后恢复窗口模式并显示，启动过程不创建额外的 splash 窗口。
门禁失败时使用 Electron 原生对话框提供 Retry/Quit，重试会先把 supervisor 恢复到
stopped 状态。

Electron Main 通过 allowlisted `ASH_ELECTRON_RUN_AS_NODE_PATH=process.execPath` 把当前 exact host executable
声明给 Rust App Server。CSS provider 仍由 Rust 直接监督，只在启动该 LSP child 时设置
`ELECTRON_RUN_AS_NODE=1`；Renderer 和普通 App Server 进程都不会进入 Node mode。Browser、CLI、
remote/headless 形态没有 Electron，因此继续使用 package 中的 standalone Node。

## Browser Workbench

Browser 与 Electron 现在各自只有一个 `workbench.html` 入口。`workbench/browser/web.factory.ts` 拥有自动启动与 `pagehide` 释放，`web.api.ts` 定义 embedder 输入；入口通过 `ash-workbench-mode` URL 参数选择一个模式 contribution，Workbench runtime 和 session profile 保持共享。设置切换先以 `reload` 原因完成 lifecycle shutdown，再由 Browser URL 或 Electron Main 重载当前窗口。

Renderer 控件、Workbench Part 与 CSS 状态的 canonical 所有权规范见
[`docs/ui-styling-ownership.md`](../docs/ui-styling-ownership.md)。
Pane-like Part 的标题槽位、CompositeBar、命名与生命周期规范见
[`docs/workbench-pane-composite-design.md`](../docs/workbench-pane-composite-design.md)。
Command、MenuId、Context Key 与菜单型 Toolbar 的 canonical 组合规范见
[`docs/menu-system.md`](../docs/menu-system.md)。

普通 `dev:web`、`dev:renderer` 和静态 Browser 构建未配置 host 时由
`platform/app-server/browser/rendererApi.ts` 提供 disconnected API：UI 正常启动，状态栏显示
App Server 不可用，产品操作明确失败。`dev:web:full` 则由 `build/vite/webAppServerPlugin.ts`、
`ViteDevAppServerConnection` 与 `connectViteDevRendererApi()` 组成仅限本机开发的 host，并在
Workbench 启动前注入同一份 `IRendererHost` contract。嵌入方若已实现受认证的远程 transport，必须在产品入口
执行前注入：

```ts
globalThis.ashWebWorkbenchHost = {
  api: authenticatedRendererApi,
  workspace,
};
```

该对象是进程内 capability，不是可直接从不可信 JSON 反序列化的配置。Rust local host 支持
`app-server connect` broker 与 `--listen stdio://` direct mode。`dev:web:full` 的 WebSocket 只属于 loopback Vite
开发宿主，不是 Rust listener，也不是可部署服务；生产级 HTTP/WebSocket listener、认证、
origin policy 和远程部署尚未实现，因此静态 Browser 构建不能描述为已连接的 Web 客户端。

## Electron sandbox 边界

`base/parts/sandbox/electron-browser/preload.cts` 是主窗口唯一的 preload 入口。它在
`sandbox: true` 与 `contextIsolation: true` 下运行，运行时只能加载 `electron`，并通过
`ISandboxGlobals` 暴露受 `ash:` 前缀约束的 IPC 与只读进程元数据。

普通 Renderer 中的 `createElectronRendererApi()` 是该底层桥接的唯一产品适配器；Workbench
只在 composition root 消费它生成的 `AshElectronRendererApi`，再注册按领域划分的 Workbench Service；
contrib 不直接持有聚合 Renderer Host。Electron Main 的 `registerTrustedIpcRoutes()`
继续负责 sender、main frame、入口 URL 和参数验证。若修改 preload、频道或 API 组装，必须同时
运行 `pnpm --dir ash-ts build` 与 `pnpm --dir ash-ts test:main`。跨进程
所有权与安全取舍以 [`docs/ash-desktop-architecture.md`](../docs/ash-desktop-architecture.md)
为准。

## 嵌入式浏览器边界

`platform/browser` 提供当前窗口的 `WebContentsView` 平台能力。Workbench 只能通过
`AshElectronRendererApi.browserView` 创建、布局、导航、隐藏和关闭目标；Electron Main 中的
`BrowserViewMainService` 持有真实 `WebContentsView`，`browserViewIpcRoutes()` 对每条命令做
exact-shape validation。第三方页面使用独立的临时 partition，默认拒绝权限、下载和 popup，
并且不会加载主窗口的 Ash preload。

Agent 浏览器能力复用同一目标权威源：Desktop 在 App Server initialize 中声明 browser host，
`BrowserAutomationMainService` 处理 `browser/create`、`browser/observe`、`browser/perform` 和
`browser/close` 反向 JSON-RPC。Rust 保留 Tool、批准、连接 owner、超时和截图 Resource authority；
Electron Main 只执行有界语义 CDP 动作。实现直接使用 Electron 的 Node runtime，不启动 Node
sidecar、不开放调试端口，也不接受任意 CDP method。App Server 连接退出时只回收通过宿主能力
创建的目标，不影响 Renderer 自己持有的目标。

浏览器编辑器、地址栏、标签页、DOM 容器自动布局绑定、Playwright 进程内代理和高级 locator
尚未实现。跨进程所有权与后续演进以
[`docs/ash-desktop-architecture.md`](../docs/ash-desktop-architecture.md) 的 Browser
Capability 章节为准。

## iframe Webview

`platform/webview/browser/webviewElement.ts` 提供 Renderer 内的 `WebviewElement`，用于
Markdown Preview、受控 HTML UI 和后续自定义编辑器。创建者持有并释放该对象，宿主按需挂载
其 `element`；内容通过 `srcdoc` 运行在不含 `allow-same-origin` 的 sandbox 中，并由固定 CSP
禁止网络子资源连接、嵌套 frame 和表单提交。

iframe 内容只能通过一次性获取的 `acquireAshWebviewApi().postMessage()` 向宿主发送数据；
宿主同时校验消息来源窗口和实例频道。该组件不获得 `AshElectronRendererApi`、Electron IPC
或 Node 能力。当前尚无扩展宿主、独立 webview origin、资源 URI 映射和持久化 webview state；
这些不能视为已实现能力。架构边界见
[`docs/ash-desktop-architecture.md`](../docs/ash-desktop-architecture.md)。

## Markdown

DOMPurify 作为 `ash-ts/package.json` 的运行时依赖安装，源码中的唯一直接适配器是
`base/browser/domSanitize.ts`。`base/browser/markdownRenderer.ts` 提供用于 Workbench
标签、Hover 和消息等短内容的 `MarkdownElement`，采用 `marked` 解析后再由 DOMPurify
统一清洗。
`platform/markdown/browser/markdownPreview.ts` 提供完整文档 `MarkdownPreview`，采用
`markdown-it` 解析、同一套 DOMPurify allowlist 清洗，再交给 `WebviewElement` 的
opaque-origin sandbox iframe。解析器输出不能直接写入 DOM 或 iframe。

`workbench/contrib/markdown/browser/markdownDocumentRenderer.ts` 提供产品层
`MarkdownDocumentView`，将平台预览适配为 Editor Part 可持有的视图，并接管链接打开回调。
`markdown.contribution.ts` 由 Workbench contribution 入口静态加载，负责该功能的产品样式，
不重复 platform 的解析与安全实现。

Workbench 静态装配按 host 分层：`workbench.common.main.ts` 加载 Browser 与 Electron
共享的 contribution，`workbench.web.main.ts` 与 `workbench.desktop.main.ts` 只加载各自
host 的 adapter 和 contribution。Mode 入口在 host main 之外独立选择 editor bundle 与不可变的
`WorkbenchSession` 初始 composition；可选的专用 Sessions renderer 由
`WorkbenchModeRegistry` 中的 `dedicatedSessions` 定义和模式自己的 `SessionsProfile` 装配。新增功能时不得从
共享 `Workbench` 构造实现反向导入 Mode 或 Sessions 入口。

Chat 的运行中普通文本 Send 由 `ChatPaneModel` 路由到生成协议中的 `steerTurn` Session operation；
running 或交互等待期间输入工具栏同时显示 Send 与 Stop。Renderer 不自行排队或判定消息已生效，
最终 transcript、delivery 和错误始终以 App Server 的 canonical Thread projection 为准。

当前链接只允许 HTTP、HTTPS 和页内 fragment，并交由宿主处理；图片只允许内嵌的 PNG、
JPEG、GIF 与 WebP。语法高亮、Markdown 插件、Mermaid、KaTeX 和工作区相对资源映射尚未实现。
详细边界见
[`docs/ash-desktop-architecture.md`](../docs/ash-desktop-architecture.md#63-markdown)。

## 安装失败时

如果出现 `ERR_PNPM_ENOENT`、`electron_tmp` 或 Electron 目录 rename 错误，请先关闭正在运行的 Electron、Vite 和 Node 进程，然后在仓库根目录重建依赖：

```powershell
Remove-Item -LiteralPath .\node_modules -Recurse -Force
Remove-Item -LiteralPath .\ash-ts\node_modules -Recurse -Force
pnpm install
pnpm dev:desktop
```

这里只会删除 pnpm 生成的依赖目录，不会删除源码或 `pnpm-lock.yaml`。如果仍然失败，请暂时关闭占用 Electron 文件的杀毒软件实时扫描后重试。

## 常用命令

以下命令均可在仓库根目录执行：

```bash
# 构建桌面端
pnpm build:desktop

# 运行默认 Code 模式的 Electron 应用测试
pnpm test:desktop:app
# 以 Academic 作为测试启动模式
ASH_WORKBENCH_MODE=academic pnpm test:desktop:app

# 只运行桌面端主进程测试
pnpm --dir ash-ts test:main

# 检查 renderer 类型
pnpm --dir ash-ts typecheck:renderer
```

如果 Electron 的依赖安装被 pnpm 拦截，请确认安装提示中的 `electron` 构建脚本已被允许。

## 第三方许可证

Desktop 直接运行时依赖及其源码内保留的许可证文本见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。发布打包必须包含该清单及
`ash-ts/licenses/` 中的直接依赖许可证，并从清单引用的组件权威路径复制 Seti 与 Typst 许可证材料；同时保留 Electron 与所选原生运行时随附的上游 notices。源码树不保存这些组件许可证的第二份发布副本。
