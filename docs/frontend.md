# Ash TypeScript 前端

本文面向修改 Ash 界面、编辑器和桌面宿主的开发者，说明启动方式、热更新、进程边界和验证入口。前端源码位于 `src/`，通过 App Server 使用 Rust 后端。环境安装、仓库通用命令及清理见[构建指南](build.md#构建入口)，职责划分见[产品与宿主边界](product-lines.md)。

## 启动项目

完成 [环境初始化](build.md#初始化) 后，在仓库根目录选择启动方式：

| 用途                                                 | 命令                          | F5 配置                                                                    |
| ---------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| 完整 Electron 桌面端，监听前后端变化                 | `pnpm dev`，等同于 `just ash` | `Ash`                                                                      |
| 直接开发 Agents 窗口，监听前后端变化                 | `pnpm dev:agents`             | `Ash Agents`                                                               |
| 完整 Electron 桌面端，仅监听前端和 Electron 宿主变化 | `pnpm dev:ui:connected`       | `Ash (Hot Reload)`                                                         |
| Electron 界面，不构建或启动后端                      | `pnpm dev:ui`                 | —                                                                          |
| 浏览器工作台、本地文件编辑，不构建或启动后端         | `pnpm dev:web`                | `Ash Web (Chrome)` / `Ash Web (Edge)`                                      |
| 浏览器与真实 App Server，监听前后端变化              | `pnpm dev:web:full`           | `Ash Server (Web)` / `Ash Server (Web, Chrome)` / `Ash Server (Web, Edge)` |
| 直接开发 Sessions Web，监听前后端变化                | `pnpm dev:web:agents`         | `Ash Agents Server (Web, Chrome)` / `Ash Agents Server (Web, Edge)`        |
| Sessions Web 界面，不构建或启动后端                  | `pnpm dev:web:agents:ui`      | `Ash Agents Web (Chrome)` / `Ash Agents Web (Edge)`                        |
| 独立 Stanza 编辑器                                   | `pnpm dev:stanza`             | `Stanza Editor (Chrome)` / `Stanza Editor (Edge)`                          |

`Ash (Hot Reload)` 专用于前端热更新和 Electron 宿主监听，仍连接 Rust 后端，但不监听后端源码变化；`Ash` 和 `Ash Agents` 同时监听前后端，也支持前端热更新。Web 模式可通过浏览器授权直接打开本地文件夹，使用 Explorer、编辑器、新建文件和保存；聊天、Git、终端、后端搜索及语言服务需要 App Server。Electron 仅 UI 模式的文件操作也需要后端。

`Ash Server (Web)` 只启动完整 Web 服务并输出认证链接，可手动在浏览器打开；带 `Chrome` 或 `Edge` 的配置在服务就绪后自动打开对应浏览器调试器。Ash 的 Agent 执行由 Rust App Server 承担，没有 VS Code 的独立 Node Agent Host 入口。Chrome 和 Edge 配置分别要求本机安装对应浏览器。

浏览器仅前端模式打开 `http://127.0.0.1:5173/`。完整 Web 模式使用 5174 端口，须打开终端输出的认证链接。Stanza 页面为 `http://127.0.0.1:5199/`，仅启动编辑器，可通过 `globalThis.stanza.editor` 检查模型和编辑器。

### 日常 Web 开发

1. 执行 `pnpm dev:web`，打开 5173；也可用 F5 的 `Ash Web (Chrome)` 启动和调试。
2. 通过 File → Open Folder 选择并授权项目目录。浏览器文件服务直接读写目录，页面 URL 的 `folder` 参数保存工作区身份；刷新恢复目录、编辑器和已持久化的未保存内容。再次选择同一目录会复用身份，Close Folder 清除当前目录。
3. 保存 TypeScript 或 CSS 后由 Vite 更新。另开终端运行 `pnpm typecheck:web:watch`，持续检查类型；`pnpm typecheck:web` 执行一次完整检查。
4. 开发过程中执行 `pnpm test:web:dev --grep '<场景标题>'`，通过现有 Playwright Browser UI 项目直接验证 Vite 开发入口。
5. 提交前执行 `pnpm build:web` 和 `pnpm test:web --grep '<场景标题>'`，验证生产资源。已有构建时用 `pnpm test:smoke:browser:no-compile`；`pnpm start:web` 启动生产资源预览。

F5 先准备生成资源，再由 VS Code 调试器直接启动 Vite；服务就绪后启动 Chrome 调试。Vite 输出显示在“调试控制台”，F5 配置关闭输出颜色，保证 VS Code 的 `serverReadyAction` 能匹配就绪地址。停止 Vite 或 Chrome 调试会一起结束这两个会话并释放服务端口。手动执行 `pnpm dev:web` 或运行 `Run Ash Web` 任务时，服务由对应终端或任务管理，需要用 `Ctrl+C` 或“终止任务”停止。F5 和手动启动共用 5173，选择一种启动方式；已有服务占用端口时启动会报错。

F5 生命周期回归测试使用已安装的 VS Code 和 Playwright。设置 `ASH_VSCODE_EXECUTABLE` 为 VS Code 可执行文件的绝对路径，再执行 `pnpm --dir build exec node --test desktop/launch/webDebug.test.ts`；它使用独立配置目录，验证停止任一调试会话、进程退出、端口释放、再次启动和端口占用失败。未提供该环境变量时，构建工具测试会跳过这一项。

Web 构建只包含浏览器 Workbench 与 Sessions 页面，输出到 `.build/desktop/web/ash`，不会覆盖 Electron 的 `.build/desktop/renderer/ash`。本地文件夹能力依赖 Chrome/Edge 等浏览器提供的 File System Access API 和安全上下文；本机回环地址满足该要求。测试使用真实浏览器文件句柄，文件选择器由场景提供授权目录。浏览器撤销授权后，需要再次通过 Open Folder 授权。

后端集成使用 `pnpm dev:web:full`，生产构建与启动分别使用 `pnpm build:web:full`、`pnpm start:web:full`。两种 Web 构建使用同一输出目录，预览和测试应匹配最后一次构建模式。

连接后端的 Web 和 Electron 源码启动器在选取可执行文件前检查并准备当前源码对应的开发包；这一顺序也适用于直接调用启动器或 Vite 的入口。输入未变化时复用开发包，准备失败则停止启动。Web 启动日志输出实际使用的后端文件路径，便于核对联调版本。

Sessions Web 使用 `pnpm dev:web:agents`，直接打开终端输出的 Sessions 认证链接；F5 选择 `Ash Agents Server (Web, Chrome)`，准备前后端后自动打开该链接并连接 Chrome 调试器。只开发界面时使用 `pnpm dev:web:agents:ui` 或 `Ash Agents Web (Chrome)`，5173 根地址直接进入 Sessions。两种 Sessions 入口复用相同的浏览器页面、Vite 热更新和 Web 构建。切回 Workbench 后可继续使用同一浏览器会话。

完整 Web 开发由 Vite 管理 Rust 监听器和 Web 启动进程。保存 Rust 或 Cargo 文件后按变更范围同步协议，再编译并发布含独立 Node 的开发包；成功后通过 `ensure-selected` 切换受管后端。编译失败保留当前后端。Web 启动进程持续持有原入口，使重启后的监听地址和浏览器授权继续有效；页面重连时保留会话选择和未发送输入。停止 Vite 会释放监听器和入口授权；其他客户端共用的后端仍按共享生命周期管理。连接后端的 F5 配置通过 `serverReadyAction` 打开动态认证链接，停止服务器调试会同时停止其 `Browser Debug`；只停止浏览器调试时服务器继续运行，可在调试工具栏停止服务器。仅界面 F5 配置保留服务器与浏览器双向停止。

F5 配置见 [launch.json](../.vscode/launch.json)。完成 [环境初始化](build.md#初始化) 后，F5 和手动启动共用仓库的 Python 环境，macOS 无需额外的 `uv run` 包装。

当前使用 Code 工作台，共同装配代码与 Academic 文档编辑器；打开论文不需要切换模式，旧 Academic 模式数据在启动时迁移，见 [工作台与文档贡献](workbench-modes.md)。停止开发启动器使用 `Ctrl+C`；退出 Web 启动器会撤销该入口的浏览器授权，不终止其他客户端正在使用的后端。

### 开发态热更新

| 改动                    | 更新方式                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Renderer 与 CSS         | Vite 热更新；符合条件的 UI 方法修改保留现有实例                                       |
| Electron Main / Preload | 编译和 preload 沙箱依赖校验通过后重启 Electron                                        |
| Rust 后端               | 完整桌面开发命令监听后端，增量编译后发布开发运行目录，所有本地窗口共用一次后端重启    |
| Web Rust 后端           | 完整 Web 开发命令监听后端，编译并发布独立 Node 开发包后切换后端，保留页面与浏览器授权 |

Renderer 中，`Part`、`ViewPane`、`Widget` 的普通方法和 getter/setter 可修改现有实例；构造器、字段、静态状态、模块副作用或继承关系变化会重载页面。其他仅修改原型方法的 UI 类可用 `@ash-hot-reload patch-prototype` 加入。运行时实现见 `base/common/hotReload.ts`、`hotReloadHelpers.ts`，开发转换见 `build/desktop/vite/hotReloadPlugin.ts`。

需要重建 DOM 的组件可以继承 `platform/domWidget/browser/domWidget.ts` 的 `DomWidget`，提供稳定的 `element` 根节点，并由宿主通过 `createObservable(scope, ...args)` 创建。需要构造注入的组件通过 `instantiateObservable(instantiationService, scope, ...args)` 创建，每次替换都由原服务容器解析依赖。开发转换按模块路径和类名注册版本；修改构造器或实例字段后，宿主收到新组件，在旧根节点仍存在时替换 DOM、恢复组件内的焦点，随后释放旧实例。传入的 scope 拥有实例和热更新订阅，关闭组件时一起释放；业务状态和输入草稿继续由原 model/service 或宿主持有。静态状态、继承和模块注册副作用变化仍重载页面。

聊天输入提示、模型详情卡片、Workbench/Code 与 Cowork 聊天消息列表和 Sessions 侧栏会话列表已接入此机制。提示的关闭状态仍由 `ChatTipService` 管理；模型卡片从当前目录条目恢复描述；聊天列表恢复阅读位置、折叠状态和操作焦点，输入编辑器继续保留原实例；侧栏恢复搜索词、滚动位置和按会话身份定位的焦点，选中会话仍由 `ISessionsService` 管理。这些接入覆盖各区域的上述组件，其他组件仍按各自的创建路径逐步接入。

Workbench 与 Sessions 的 Web、Electron 开发页面通过 `platform/cssDev/node/cssDevService.ts` 获取源码相对路径的 CSS 清单；清单在开发宿主内扫描一次并缓存，新增 CSS 文件后需要重启宿主。现有 HTML 宿主只负责将路径解析为模块和样式 URL，`code/browser/workbench/workbench-dev.html` 在模块执行前安装 import map，按组件的 CSS import 创建 stylesheet link。发现服务和浏览器加载器均不依赖 Vite；当前 Vite 适配负责 URL 解析、源码转换和 stylesheet link 的热更新。发布构建不扫描或注入开发清单，继续打包 CSS。独立 Stanza 开发入口保持原有 Vite CSS 加载。

需要重新执行初始化的可释放贡献，由注册入口通过 `platform/observable/common/wrapInReloadableClass.ts` 包装构造函数。开发模式下，模块替换会先释放旧贡献，再通过编辑器原有的服务容器创建新贡献；编辑器和模型由宿主继续持有。占位文本贡献已接入这条链路，修改其构造器、字段或方法可以更新现有编辑器。注册模块应与实现模块分开，避免重新执行注册副作用。注册处保存的是释放句柄，需要访问贡献实现时使用 `hotClassGetOriginalInstance`。这些热更新只用于开发 Ash 自身；发布构建不注入 Vite 热更新边界。

Electron 启动前并行准备键盘模块、前端生成资源和后端资源；输入未变化时复用已有结果。运行期间 Rust 保存只增量编译并发布程序，复用准备好的资源文件，不走完整包验证和发布。Electron 与 Web 后端监听器按 Cargo 的协议生成器依赖图判断变更：普通业务源码保存跳过协议生成，协议及其共享契约源码保存先生成协议再构建后端；Cargo 清单变化时刷新依赖图并生成协议。生成失败会阻止后端构建，下一次保存仍会先重试生成。`ASH_DEV_RUNTIME_ROOT` 由启动器提供，统一定位搜索工具、语言服务、内置 Skills 和辅助程序。Workbench 与 Agents 共用一个重启协调者：先停连接，重启一次后端，再连接仍打开的窗口。新窗口在重启期间等待；关闭窗口会注销监听。Main/Preload 编译或校验失败会保留当前进程，Rust 构建失败不切换运行版本；启动失败会报告错误。监听器忽略 Cargo 输出，避免构建再次触发自己。

开发启动器使用 `.build/desktop/dev/profile` 和 `.build/desktop/dev/user-data`，Workbench 与 Agents 共享开发数据；设置 `ASH_HOME` 可以指定其他开发配置。资源或运行工具锁文件修改后执行 VS Code 任务 `Prepare Ash Backend`，或 `pnpm prepare:backend`，准备完成后已运行的完整开发窗口会切换到新版本。

需要单独监听桌面后端时，先执行 `pnpm prepare:backend`，再在仓库根目录执行 `pnpm dev:rust`。仅 UI、`dev:ui:connected`、`dev:web` 和 `dev:web:agents:ui` 不监听后端。后端开发包和下载规则见 [共享包构建](../build/README.md)。

### 打开工作区

构建完成后可通过启动参数打开目录或工作区：

```powershell
pnpm start -- C:\path\to\project
pnpm start -- --folder C:\path\to\project
pnpm start -- --workspace C:\path\to\team.ash-workspace
pnpm start -- --reuse-window --goto C:\path\to\project\main.ts:12:4
pnpm start -- --new-window C:\path\to\project\main.ts
pnpm start -- --wait C:\path\to\project\main.ts
```

`--new-window` 强制新建窗口，`--reuse-window` 复用当前 Workbench 窗口，两者不能同时使用。`--goto` 支持 `文件:行:列`；`--wait` 让第二个启动进程等待所有请求文件关闭，关闭所属窗口也会结束等待。参数中的 `--` 后面按文件路径处理，可以打开名称以连字符开头的文件。

文件读写需要连接 App Server。只指定文件时，如果当前窗口的工作区包含所有文件，就沿用该工作区；否则使用这些文件的共同父目录，并按现有流程确认目录权限。跨磁盘文件需要显式指定包含这些目录的多根工作区。仅 UI 模式可验证窗口选择，但不能读取磁盘业务文件。

Electron 的 `open-file`、`open-url` 和第二实例参数统一进入 `platform/launch/electron-main/launchMainService.ts`。支持 `--file-uri`、`--folder-uri` 和 `ash://file` 文件请求；系统协议关联属于安装包配置，本次未验证。窗口选择与 Renderer 就绪由 `platform/windows` 管理，文件打开和关闭完成通知由 Workbench 的 `ElectronWindow` 管理。

不传路径时按已有窗口恢复策略启动。工作区模型由 `platform/workspace` 定义，工作区管理由 `platform/workspaces` 负责；资源身份约定见 [资源身份](resource-identity.md)。

## Electron 启动门禁

`src/main.ts` 先执行 bootstrap，再进入 `code/electron-main/main.ts`。应用在 Electron Ready 后启动；入口模块不在顶层等待 `app.whenReady()`，避免模块加载与 Ready 互相等待。

连接 App Server 后校验初始化结果、服务端身份、协议主版本、生成协议指纹及必需能力可用性。门禁通过后创建业务窗口，窗口在 `ready-to-show` 后显示。失败时对话框提供重试或退出；重试先恢复连接组件的 stopped 状态。启动测量方法见 [Desktop 启动测量](desktop-startup.md)。

Electron 将当前可执行文件提供给后端的 JavaScript LSP 启动器，只有对应子进程使用 `ELECTRON_RUN_AS_NODE=1`；Renderer 和普通 App Server 不进入 Node mode。完整 Web 模式使用随包的独立 Node。进程与连接职责见 [前端连接边界](frontend-app-server-boundary.md)。

## Browser Workbench

Browser 和 Electron 各使用一个 `workbench.html` 入口。`web.factory.ts` 管理 Web 自动启动与页面释放，`web.api.ts` 定义嵌入方输入；产品入口直接提供标题；存储服务按 application、profile、workspace 作用域管理状态，不读取工作台模式参数。

完整 Web 模式通过认证 WebSocket 直接连接 App Server。一次性票据在当前页签兑换会话后从 URL 移除，刷新复用 `sessionStorage` 中的会话。启动器仍运行时，后端重启会重新认证和连接，不重发旧写请求。授权过期或被撤销后需打开新的认证链接；当前入口仅用于本机单用户，未提供公网认证和 TLS。

嵌入方可在产品入口执行前设置 `globalThis.ashWebWorkbenchHost = { api, workspace }`，这是进程内能力契约，不接受不可信 JSON。未配置宿主的普通 Web 入口使用 disconnected API。认证和连接生命周期见 [前端连接与浏览器能力](design/app-server-connection.md)。

### 开发浏览器扩展

开发受信任的浏览器扩展时，将 `ASH_WEB_EXTENSION_PATHS` 设置为扩展包目录；多个目录用当前平台的路径分隔符连接。例如在 PowerShell 中：

```powershell
$env:ASH_WEB_EXTENSION_PATHS = (Resolve-Path test/fixtures/web-extension).Path
pnpm dev:web
```

扩展包的 `browser` 字段指向打包后的 ES module，导出 `activate({ register })` 等 Ash Host API v1 入口。模块运行在页面持有的 Worker 中；Vite 监听包资源并更新快照。此入口用于受信任的开发输入，不代表已提供第三方扩展安装、完整 VS Code Extension API 或扩展沙箱。能力和限制见[编辑器扩展](editor-extensions.md)。

### 独立调试 Stanza

运行 `pnpm dev:stanza`，打开终端输出的地址；也可在 VS Code 选择 `Stanza Editor (Chrome)` 后按 F5。页面通过 `globalThis.stanza` 暴露 API，可在浏览器控制台检查 `stanza.editor.getEditors()` 和 `stanza.editor.getModels()`。

## Electron sandbox 边界

主窗口唯一的 preload 入口为 `base/parts/sandbox/electron-browser/preload.cts`，运行于 `sandbox: true` 和 `contextIsolation: true`，只加载 `electron`，通过 `ISandboxGlobals` 暴露限定的 IPC 和只读进程元数据。

Renderer 通过 `createElectronRendererApi()` 适配桥接，由组合入口注册领域 Service；contrib 不直接持有聚合宿主 API。Main 校验消息发送者、主 frame、入口 URL 和参数。修改 preload、频道或 API 组装时，验证 `pnpm build` 与 `pnpm test:main`；职责见 [沙箱桥接与 Renderer API](ash-desktop-architecture.md#5-沙箱桥接与-renderer-api)。

## 嵌入式浏览器边界

`platform/browserView` 提供窗口内的 `WebContentsView` 能力。Workbench 通过 `IBrowserViewService` 管理布局和导航，Main 管理页面、Session 和关闭释放。用户 Session 按工作区持久保存，Agent Session 按窗口和 Thread 隔离。第三方页面不加载 Ash preload；权限和下载默认拒绝，弹窗由 Workbench 打开为新页签。

Agent 浏览器操作复用同一组目标：Rust 管理工具、批准、超时和资源权限，独立 Playwright 进程通过窗口 MessagePort 与 Thread Group CDP 操作 Main 的可见页面。产品协议不开放任意 CDP 调用，也不开放调试端口。关闭 Group 只解绑自动化，页面仍由 Main 持有。

界面命令为 `Browser: Open Browser`，网页中用 F6 或 Ctrl+L 返回地址栏。Agent 创建的目标也显示为页签；Renderer 重载接回现存页面，应用重启恢复用户页签与工作区登录。页面分享、权限交互和远程 Session 网络策略尚未完成。详细边界见 [浏览器能力](ash-desktop-architecture.md#7-浏览器能力)。

## iframe Webview

`workbench/contrib/webview/browser/webview.ts` 提供统一的 `IWebviewService`，用于创建容器、登记存活实例和跟踪当前焦点；Markdown 预览、富文本编辑器和发布说明页共用该服务，创建者负责释放。内容在 `srcdoc` sandbox iframe 中运行，不包含 `allow-same-origin`；固定 CSP 禁止网络子资源、嵌套 frame 和表单提交。

iframe 通过 `acquireAshWebviewApi().postMessage()` 通信，宿主校验来源窗口和每次文档独立的频道；宿主消息等待页面就绪再发送，替换页面或释放容器会取消未发送的消息，相同 HTML 保留页面状态。内容没有 Electron IPC 或 Node 能力。资源 URI 映射和持久化 webview state 尚未提供，见 [iframe Webview](ash-desktop-architecture.md#62-iframe-webview)。

## Markdown

短内容和文档预览共用 Marked 解析与 DOMPurify 清理。`base/browser/markdownRenderer.ts` 提供短内容渲染，`MarkdownDocumentView` 将完整预览适配到 Editor Part；解析器输出不能直接写入 DOM 或 iframe。

渲染支持 GFM、流式未完成语法、提示块、主题图标以及调用方注入的解析扩展和代码块 renderer。HTML 始终清理，命令链接需明确授权，文件链接需资源上下文或完全信任，远程图片可由调用方策略限制。默认语法着色、Mermaid、KaTeX 尚未提供。详细边界见 [Markdown](ash-desktop-architecture.md#63-markdown)。

## 常用命令

以下命令均在仓库根目录执行；仓库通用 Rust、Python 和构建工具验证见 [构建指南](build.md#测试)。

| 命令                            | 覆盖范围                                       |
| ------------------------------- | ---------------------------------------------- |
| `pnpm build`                    | Electron Main、Preload 和 Renderer             |
| `pnpm build:stanza`             | 独立编辑器                                     |
| `pnpm typecheck:renderer`       | Renderer 类型检查                              |
| `pnpm test:main`                | 构建工具和前端单测                             |
| `pnpm test:integration`         | 浏览器集成测试                                 |
| `pnpm test:web`                 | 浏览器生产资源与本地文件操作，无 App Server    |
| `pnpm test:web:dev`             | 同一 Browser UI 项目，运行 Vite 开发资源       |
| `pnpm test:web-integration`     | 浏览器与真实 App Server                        |
| `pnpm test:desktop:smoke:ui`    | Electron UI，无 App Server                     |
| `pnpm run smoketest`            | 准备并运行 Electron 与真实 App Server 冒烟测试 |
| `pnpm run smoketest-no-compile` | 运行已准备好的同一套冒烟测试                   |
| `pnpm test:desktop:app`         | Code 模式的 Electron 编辑器应用测试            |

测试入口会准备对应输入；完整 Web 测试不构建 Electron Main/Preload。Electron UI、Browser UI 和真实后端测试使用各自的 Playwright 项目，失败时查看报告和 trace。

Academic 文件打开与保存已纳入 `pnpm test:desktop:app`，直接在 Code 工作台验证。旧模式迁移见 [工作台与文档贡献](workbench-modes.md)。

### UI 场景录屏

[test/scenario](../test/scenario) 的 Playwright 运行器保存步骤截图、trace、录屏、字幕 MP4 和 HTML 报告；FFmpeg 要求见 [构建指南](build.md#ui-场景录屏)。

先执行 `pnpm run scenario:compile`。已有开发构建时运行 `node test/scenario/out/runScenario.js <scenario.cjs> --dev`，Web 场景增加 `--web --headless`。需要从构建开始准备时使用 `pnpm run scenario -- <scenario.cjs> --dev`。临时场景和证据放在 `.build/ash-playwright-mcp/`，证据位于 `evidence/` 子目录。

## 安装失败时

遇到 `ERR_PNPM_ENOENT`、`electron_tmp` 或 Electron 目录 rename 错误时，关闭本项目的 Electron、Vite 和相关 Node 进程，再在仓库根目录重建依赖：

```powershell
Remove-Item -LiteralPath .\node_modules -Recurse -Force
pnpm install
pnpm dev
```

这里只删除生成的依赖目录。Electron 安装脚本由 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 的 `allowBuilds` 管理。

## 继续阅读

| 内容                                     | 文档                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| 前端领域 Service、协议客户端与 Main 分工 | [前端连接边界](frontend-app-server-boundary.md)      |
| Desktop 进程、窗口与 Renderer 架构       | [Desktop 架构](ash-desktop-architecture.md)          |
| Workbench 模式和 contribution 装配       | [Workbench 模式](workbench-modes.md)                 |
| DOM 与通用浏览器组件                     | [Browser foundation](browser-foundation.md)          |
| 控件、Part 与 CSS 所有权                 | [UI 样式职责](ui-styling-ownership.md)               |
| Pane、CompositeBar 与生命周期            | [Workbench 面板](workbench-pane-composite-design.md) |
| Command、MenuId、Context Key 与 Toolbar  | [菜单系统](menu-system.md)                           |

## 第三方许可证

直接运行依赖及其源码许可证见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。发布包必须包含该清单和 `licenses/` 中的直接依赖许可证，从组件所属路径复制 Seti、Typst 许可证，并保留 Electron 和所选运行时的上游 notices；源码树不维护第二份发布副本。
