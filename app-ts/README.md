# `ash` Electron Desktop

`app-ts` 提供 Electron 桌面端和 Browser Workbench，包含 Renderer、Preload 和 Electron Main，通过 App Server 使用 Rust 后端。本 README 说明前端开发、启动和验证；环境安装、仓库通用命令及清理见 [构建指南](../docs/build.md#构建入口)。产品关系见 [产品线](../docs/product-lines.md)。

## 启动项目

完成 [环境初始化](../docs/build.md#初始化) 后，在仓库根目录选择启动方式：

| 用途 | 命令 | F5 配置 |
| --- | --- | --- |
| 完整 Electron 桌面端，监听前后端变化 | `pnpm dev:desktop`，等同于 `just ash-desktop` | `Ash (Electron)` |
| 直接开发 Agents 窗口，监听前后端变化 | `pnpm --dir app-ts dev:agents` | `Ash (Electron, Agents)` |
| 完整 Electron 桌面端，仅监听前端和 Electron 宿主变化 | `pnpm --dir app-ts dev:ui:connected` | `Ash (Electron, Frontend Watch Only)` |
| Electron 界面，不构建或启动后端 | `pnpm dev:desktop:ui` | — |
| 浏览器前端，不构建或启动后端 | `pnpm dev:web` | `Ash Web (Chrome, UI Only)` |
| 浏览器与真实 App Server | `pnpm dev:web:full` | — |
| 独立 Stanza 编辑器 | `pnpm dev:stanza` | `Stanza Editor - Standalone` |

`Frontend Watch Only` 仍连接 Rust 后端，只是不监听后端源码变化。两种仅 UI 模式中的聊天、文件、Git、终端和搜索等后端操作不可用；选择文件夹只更新界面的工作区上下文。

浏览器仅前端模式打开 `http://127.0.0.1:5173/`。完整 Web 模式使用 5174 端口，须打开终端输出的认证链接。Stanza 页面为 `http://127.0.0.1:5199/`，仅启动编辑器，可通过 `globalThis.stanza.editor` 检查模型和编辑器。

F5 配置见 [launch.json](../.vscode/launch.json)。macOS 的 Electron 入口通过 `uv run --python 3.12` 选择 Python；手动运行命令时，按 [macOS 环境要求](../docs/build.md#macos-与-linux-开发环境) 配置。

当前使用 Code 工作台，共同装配代码与 Academic 文档编辑器；打开论文不需要切换模式，旧 Academic 模式数据在启动时迁移，见 [工作台与文档贡献](../docs/workbench-modes.md)。停止开发启动器使用 `Ctrl+C`；退出 Web 启动器会撤销该入口的浏览器授权，不终止其他客户端正在使用的后端。

### 开发态热更新

| 改动 | 更新方式 |
| --- | --- |
| Renderer 与 CSS | Vite 热更新；符合条件的 UI 方法修改保留现有实例 |
| Electron Main / Preload | 编译和 preload 沙箱依赖校验通过后重启 Electron |
| Rust 后端 | 完整桌面开发命令监听后端，增量编译后发布开发运行目录，所有本地窗口共用一次后端重启 |

Renderer 中，`Part`、`ViewPane`、`Widget` 的普通方法和 getter/setter 可修改现有实例；构造器、字段、静态状态、模块副作用或继承关系变化会重载页面。其他仅修改原型方法的 UI 类可用 `@ash-hot-reload patch-prototype` 加入。运行时实现见 `base/common/hotReload.ts`、`hotReloadHelpers.ts`，开发转换见 `build/app_ts/vite/hotReloadPlugin.ts`。

需要重新执行初始化的可释放贡献，由注册入口通过 `platform/observable/common/wrapInReloadableClass.ts` 包装构造函数。开发模式下，模块替换会先释放旧贡献，再通过编辑器原有的服务容器创建新贡献；编辑器和模型由宿主继续持有。占位文本贡献已接入这条链路，修改其构造器、字段或方法可以更新现有编辑器。注册模块应与实现模块分开，避免重新执行注册副作用。注册处保存的是释放句柄，需要访问贡献实现时使用 `hotClassGetOriginalInstance`。这些热更新只用于开发 Ash 自身；发布构建不注入 Vite 热更新边界。

Electron 启动前并行准备键盘模块、前端生成资源和后端资源；输入未变化时复用已有结果。运行期间 Rust 保存只增量编译并发布程序，复用准备好的资源文件，不走完整包验证和发布。`ASH_DEV_RUNTIME_ROOT` 由启动器提供，统一定位搜索工具、语言服务、内置 Skills 和辅助程序。Workbench 与 Agents 共用一个重启协调者：先停连接，重启一次后端，再连接仍打开的窗口。新窗口在重启期间等待；关闭窗口会注销监听。Main/Preload 编译或校验失败会保留当前进程，Rust 构建失败不切换运行版本；启动失败会报告错误。监听器忽略 Cargo 输出，避免构建再次触发自己。

开发启动器使用 `.build/app-ts/dev/profile` 和 `.build/app-ts/dev/user-data`，Workbench 与 Agents 共享开发数据；设置 `ASH_HOME` 可以指定其他开发配置。资源或运行工具锁文件修改后执行 VS Code 任务 `Prepare Ash Backend`，或 `pnpm --dir app-ts prepare:backend`，准备完成后已运行的完整开发窗口会切换到新版本。

需要单独监听后端时，先执行 `pnpm --dir app-ts prepare:backend`，再在仓库根目录执行 `pnpm dev:desktop:rust`。仅 UI、`dev:ui:connected` 和普通 Web 模式不监听后端。后端开发包和下载规则见 [共享包构建](../build/ash_rs/README.md)。

### 打开工作区

构建完成后可通过启动参数打开目录或工作区：

```powershell
pnpm --dir app-ts start -- C:\path\to\project
pnpm --dir app-ts start -- --folder C:\path\to\project
pnpm --dir app-ts start -- --workspace C:\path\to\team.ash-workspace
pnpm --dir app-ts start -- --reuse-window --goto C:\path\to\project\main.ts:12:4
pnpm --dir app-ts start -- --new-window C:\path\to\project\main.ts
pnpm --dir app-ts start -- --wait C:\path\to\project\main.ts
```

`--new-window` 强制新建窗口，`--reuse-window` 复用当前 Workbench 窗口，两者不能同时使用。`--goto` 支持 `文件:行:列`；`--wait` 让第二个启动进程等待所有请求文件关闭，关闭所属窗口也会结束等待。参数中的 `--` 后面按文件路径处理，可以打开名称以连字符开头的文件。

文件读写需要连接 App Server。只指定文件时，如果当前窗口的工作区包含所有文件，就沿用该工作区；否则使用这些文件的共同父目录，并按现有流程确认目录权限。跨磁盘文件需要显式指定包含这些目录的多根工作区。仅 UI 模式可验证窗口选择，但不能读取磁盘业务文件。

Electron 的 `open-file`、`open-url` 和第二实例参数统一进入 `platform/launch/electron-main/launchMainService.ts`。支持 `--file-uri`、`--folder-uri` 和 `ash://file` 文件请求；系统协议关联属于安装包配置，本次未验证。窗口选择与 Renderer 就绪由 `platform/windows` 管理，文件打开和关闭完成通知由 Workbench 的 `ElectronWindow` 管理。

不传路径时按已有窗口恢复策略启动。工作区模型由 `platform/workspace` 定义，工作区管理由 `platform/workspaces` 负责；资源身份约定见 [资源身份](docs/resource-identity.md)。

## Electron 启动门禁

`src/main.ts` 先执行 bootstrap，再进入 `code/electron-main/main.ts`。应用在 Electron Ready 后启动；入口模块不在顶层等待 `app.whenReady()`，避免模块加载与 Ready 互相等待。

连接 App Server 后校验初始化结果、服务端身份、协议主版本及必需能力版本，schema hash 用于诊断。门禁通过后创建业务窗口，窗口在 `ready-to-show` 后显示。失败时对话框提供重试或退出；重试先恢复连接组件的 stopped 状态。启动测量方法见 [Desktop 启动测量](docs/desktop-startup.md)。

Electron 将当前可执行文件提供给后端的 JavaScript LSP 启动器，只有对应子进程使用 `ELECTRON_RUN_AS_NODE=1`；Renderer 和普通 App Server 不进入 Node mode。完整 Web 模式使用随包的独立 Node。进程与连接职责见 [前端连接边界](docs/frontend-app-server-boundary.md)。

## Browser Workbench

Browser 和 Electron 各使用一个 `workbench.html` 入口。`web.factory.ts` 管理 Web 自动启动与页面释放，`web.api.ts` 定义嵌入方输入；产品入口直接提供标题；存储服务按 application、profile、workspace 作用域管理状态，不读取工作台模式参数。

完整 Web 模式通过认证 WebSocket 直接连接 App Server。一次性票据在当前页签兑换会话后从 URL 移除，刷新复用 `sessionStorage` 中的会话。启动器仍运行时，后端重启会重新认证和连接，不重发旧写请求。授权过期或被撤销后需打开新的认证链接；当前入口仅用于本机单用户，未提供公网认证和 TLS。

嵌入方可在产品入口执行前设置 `globalThis.ashWebWorkbenchHost = { api, workspace }`，这是进程内能力契约，不接受不可信 JSON。未配置宿主的普通 Web 入口使用 disconnected API。认证和连接生命周期见 [前端连接与浏览器能力](docs/design/app-server-connection.md)。

## Electron sandbox 边界

主窗口唯一的 preload 入口为 `base/parts/sandbox/electron-browser/preload.cts`，运行于 `sandbox: true` 和 `contextIsolation: true`，只加载 `electron`，通过 `ISandboxGlobals` 暴露限定的 IPC 和只读进程元数据。

Renderer 通过 `createElectronRendererApi()` 适配桥接，由组合入口注册领域 Service；contrib 不直接持有聚合宿主 API。Main 校验消息发送者、主 frame、入口 URL 和参数。修改 preload、频道或 API 组装时，验证 `pnpm --dir app-ts build` 与 `pnpm --dir app-ts test:main`；职责见 [沙箱桥接与 Renderer API](../docs/ash-desktop-architecture.md#5-沙箱桥接与-renderer-api)。

## 嵌入式浏览器边界

`platform/browserView` 提供窗口内的 `WebContentsView` 能力。Workbench 通过 `IBrowserViewService` 管理布局和导航，Main 管理页面、Session 和关闭释放。用户 Session 按工作区持久保存，Agent Session 按窗口和 Thread 隔离。第三方页面不加载 Ash preload；权限和下载默认拒绝，弹窗由 Workbench 打开为新页签。

Agent 浏览器操作复用同一组目标：Rust 管理工具、批准、超时和资源权限，独立 Playwright 进程通过窗口 MessagePort 与 Thread Group CDP 操作 Main 的可见页面。产品协议不开放任意 CDP 调用，也不开放调试端口。关闭 Group 只解绑自动化，页面仍由 Main 持有。

界面命令为 `Browser: Open Browser`，网页中用 F6 或 Ctrl+L 返回地址栏。Agent 创建的目标也显示为页签；Renderer 重载接回现存页面，应用重启恢复用户页签与工作区登录。页面分享、权限交互和远程 Session 网络策略尚未完成。详细边界见 [浏览器能力](../docs/ash-desktop-architecture.md#7-浏览器能力)。

## iframe Webview

`platform/webview/browser/webviewElement.ts` 提供用于 Markdown 预览和受控 HTML 的 `WebviewElement`，创建者负责释放。内容在 `srcdoc` sandbox iframe 中运行，不包含 `allow-same-origin`；固定 CSP 禁止网络子资源、嵌套 frame 和表单提交。

iframe 仅通过 `acquireAshWebviewApi().postMessage()` 通信，宿主校验来源窗口和实例频道；内容没有 Electron IPC 或 Node 能力。扩展宿主、资源 URI 映射和持久化 webview state 尚未提供，见 [iframe Webview](../docs/ash-desktop-architecture.md#62-iframe-webview)。

## Markdown

短内容和文档预览共用 Marked 解析与 DOMPurify 清理。`base/browser/markdownRenderer.ts` 提供短内容渲染，`MarkdownDocumentView` 将完整预览适配到 Editor Part；解析器输出不能直接写入 DOM 或 iframe。

渲染支持 GFM、流式未完成语法、提示块、主题图标以及调用方注入的解析扩展和代码块 renderer。HTML 始终清理，命令链接需明确授权，文件链接需资源上下文或完全信任，远程图片可由调用方策略限制。默认语法着色、Mermaid、KaTeX 尚未提供。详细边界见 [Markdown](../docs/ash-desktop-architecture.md#63-markdown)。

## 常用命令

以下命令均在仓库根目录执行；仓库通用 Rust、Python 和构建工具验证见 [构建指南](../docs/build.md#测试)。

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm build:desktop` | Electron Main、Preload 和 Renderer |
| `pnpm build:stanza` | 独立编辑器 |
| `pnpm --dir app-ts typecheck:renderer` | Renderer 类型检查 |
| `pnpm --dir app-ts test:main` | 构建工具和前端单测 |
| `pnpm test:integration` | 浏览器集成测试 |
| `pnpm test:desktop:smoke:browser` | 浏览器 UI，无 App Server |
| `pnpm test:web-integration` | 浏览器与真实 App Server |
| `pnpm test:desktop:smoke:ui` | Electron UI，无 App Server |
| `pnpm run smoketest` | 准备并运行 Electron 与真实 App Server 冒烟测试 |
| `pnpm run smoketest-no-compile` | 运行已准备好的同一套冒烟测试 |
| `pnpm test:desktop:app` | Code 模式的 Electron 编辑器应用测试 |

测试入口会准备对应输入；完整 Web 测试不构建 Electron Main/Preload。Electron UI、Browser UI 和真实后端测试使用各自的 Playwright 项目，失败时查看报告和 trace。

Academic 文件打开与保存已纳入 `pnpm test:desktop:app`，直接在 Code 工作台验证。旧模式迁移见 [工作台与文档贡献](../docs/workbench-modes.md)。

### UI 场景录屏

[test/scenario](../test/scenario/) 的 Playwright 运行器保存步骤截图、trace、录屏、字幕 MP4 和 HTML 报告；FFmpeg 要求见 [构建指南](../docs/build.md#ui-场景录屏)。

先执行 `pnpm run scenario:compile`。已有开发构建时运行 `node test/scenario/out/runScenario.js <scenario.cjs> --dev`，Web 场景增加 `--web --headless`。需要从构建开始准备时使用 `pnpm run scenario -- <scenario.cjs> --dev`。临时场景和证据放在 `.build/ash-playwright-mcp/`，证据位于 `evidence/` 子目录。

## 安装失败时

遇到 `ERR_PNPM_ENOENT`、`electron_tmp` 或 Electron 目录 rename 错误时，关闭本项目的 Electron、Vite 和相关 Node 进程，再在仓库根目录重建依赖：

```powershell
Remove-Item -LiteralPath .\node_modules -Recurse -Force
Remove-Item -LiteralPath .\app-ts\node_modules -Recurse -Force
pnpm install
pnpm dev:desktop
```

这里只删除生成的依赖目录。Electron 安装脚本由 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 的 `allowBuilds` 管理。

## 继续阅读

| 内容 | 文档 |
| --- | --- |
| 前端领域 Service、协议客户端与 Main 分工 | [前端连接边界](docs/frontend-app-server-boundary.md) |
| Desktop 进程、窗口与 Renderer 架构 | [Desktop 架构](../docs/ash-desktop-architecture.md) |
| Workbench 模式和 contribution 装配 | [Workbench 模式](../docs/workbench-modes.md) |
| DOM 与通用浏览器组件 | [Browser foundation](docs/browser-foundation.md) |
| 控件、Part 与 CSS 所有权 | [UI 样式职责](../docs/ui-styling-ownership.md) |
| Pane、CompositeBar 与生命周期 | [Workbench 面板](../docs/workbench-pane-composite-design.md) |
| Command、MenuId、Context Key 与 Toolbar | [菜单系统](../docs/menu-system.md) |

## 第三方许可证

直接运行依赖及其源码许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。发布包必须包含该清单和 `app-ts/licenses/` 中的直接依赖许可证，从组件所属路径复制 Seti、Typst 许可证，并保留 Electron 和所选运行时的上游 notices；源码树不维护第二份发布副本。
