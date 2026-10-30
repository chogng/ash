# Ash 测试结构

测试跟随被验证职责存放。Desktop 模块单测放在 `src/ash/<owner>/test/<runtime>`，扩展包单测放在 `extensions/<owner>/test/<runtime>`；本目录保存共享运行器、跨模块集成、应用场景及独立分发验收。

## 运行冒烟测试

在仓库根目录运行：

```bash
# Electron 与真实 App Server
pnpm run smoketest

# 使用已准备好的构建，筛选一个场景
pnpm run smoketest-no-compile --grep "<test title>"

# Web 与真实 App Server
pnpm test:desktop:smoke:browser:full

# Electron UI
pnpm test:desktop:smoke:ui
```

## 测试结构

| 职责                                   | 放置位置                            | 运行入口                                                                  |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Desktop 模块单元与组件契约             | `src/ash/<owner>/test/<runtime>`    | `pnpm test:unit`                                                          |
| 扩展包单元与组件契约                   | `extensions/<owner>/test/<runtime>` | `pnpm test:unit --runGlob 'extensions/*/test/**/*.test.js'`               |
| 仓库级架构约束                         | `test/architecture`                 | `pnpm test:unit`                                                          |
| Mocha 运行器、loader 与运行器回归      | `test/unit`                         | `pnpm test:unit`、`pnpm test:unit:runner`                                 |
| 浏览器跨运行时集成                     | `test/integration/browser`          | `pnpm test:browser:integration`；Editor 子集用 `pnpm test:editor:browser` |
| 组件 fixture 浏览、截图与样式顺序检查  | `test/componentFixtures`            | `pnpm component-explorer`、`pnpm test:component-fixtures`                 |
| 完整应用场景                           | `test/smoke/areas/<area>`           | 下文列出的 `test:smoke:*` 目标                                            |
| 应用启动、隔离、清理及功能驱动         | `test/automation`                   | 由 smoke 和 scenario 共享                                                 |
| 一次性产品场景与录制                   | `test/scenario`                     | `pnpm scenario <scenario>`                                                |
| Stanza 独立分发契约                    | `test/stanza`                       | `pnpm test:stanza`                                                        |
| Remote 发布包的 Desktop bootstrap 验收 | `test/sanity`                       | `build/release/verify_remote.py`                                          |
| Agent 任务质量评测与独立评分器         | `test/agent-eval`                   | [Agent 任务评测](agent-eval/README.md)                                    |
| 跨套件 fixture                         | `test/fixtures`                     | 由所属测试显式引用                                                        |
| 浏览器与服务端共享类型的编译契约       | `test/types`                        | `pnpm typecheck:common`                                                   |
| 构建、打包和测试启动工具回归           | `build/**/*.test.ts`                | `pnpm test:build-tools`                                                   |

`pnpm test:main` 依次运行样式检查、构建工具测试、全部单元测试和单测运行器回归。仓库根 `package.json` 直接调用这里的公开测试命令。`test/unit/` 使用 Mocha，逐文件启动独立进程，并提供 `--run`、`--runGlob`、`--grep` 筛选。`pnpm test:unit` 编译并发现 Desktop、扩展包与架构测试；汇总执行数量不包含跳过项，没有执行任何用例时返回失败。运行器自己的筛选、发现和失败行为由 `pnpm test:unit:runner` 单独验证。清理、reporter 与 loader 也归此目录，由 `pnpm typecheck:test-unit` 检查。`pnpm test:extensions` 运行宿主的扩展注册、协议与消费契约，扩展包自己的测试随包存放并由 `test:unit` 发现。

模块与组件测试跟随源码 owner，使用 Mocha `.test.ts`。布局、样式、焦点和组件输入通过 `test/unit/browser/context.ts` 使用真实 Chromium，仍由 `pnpm test:unit` 发现和执行；每个用例使用独立 BrowserContext。页面及 `.page.ts` harness 随组件存放，共享页面与 helper 放在 `test/fixtures/browser`。根目录 `test/integration/browser` 的 Playwright spec 保留进程、扩展包、传输、Worker、iframe 及宿主生命周期边界；同一文件混合的组件断言归回源码 owner。共享浏览器构建配置位于 `test/fixtures/browser/vite.config.ts`，运行器负责资源构建、服务及进程清理。组件可视化 fixture 跟随源码 owner，根目录的 `test/componentFixtures` 只负责发现与执行。`pnpm test:editor` 依次运行 Editor 单测、Editor 浏览器集成和 Stanza 分发测试；筛选用例时使用各自入口。

Browser 和连接后端的 Electron smoke 入口共用 `test/smoke/run.ts`；入口为每次运行编译同一个语言服务器 fixture，每个场景在自己的配置目录中启用它，运行结束后清理。`pnpm test:smoke:browser` 启动 disconnected Browser Workbench；`pnpm test:smoke:browser:full` 为每个场景在独立端口启动生产 Web 服务和真实 App Server，使用该场景的工作区与配置目录。`pnpm test:smoke:ui` 启动禁用 App Server 的 Electron，适合快速验证 Renderer 和 Workbench；`pnpm test:smoke:desktop` 会额外组装 Rust 开发包并启动真实 App Server。仓库根目录 `pnpm run smoketest` 准备并运行完整 Electron + App Server 冒烟测试，`pnpm run smoketest-no-compile` 运行已准备好的同一套测试；`pnpm test:desktop:smoke:ui` 显式运行 Electron 快速模式，也可通过 `pnpm test:desktop:smoke:browser` 和 `pnpm test:desktop:smoke:browser:full` 运行 Browser 模式。CI 先运行对应的 `pretest:smoke:*` 准备步骤，再用 `test:smoke:*:no-compile` 运行已准备好的测试，便于重复排查偶发失败。

新增测试时先选择拥有被验证 contract 的最窄源码模块或扩展包，再按真实运行时选择 `common`、`browser`、`node`、`electron-browser` 或 `electron-main`。例如 Settings 绑定属于 preferences，Git 的 manifest 与翻译属于 Git 扩展。只有没有单一源码 owner 的全仓库约束才进入 `test/architecture`；完整应用流程进入 `test/smoke`；最终分发包验收与开发构建场景分开。

连接后端的 Code 场景在 Browser 和 Electron 中实际执行语言服务测试，覆盖补全、诊断随编辑更新、格式化及撤销、参数提示、内联提示和联动编辑。Memories 读写依赖桌面宿主权限；Browser 验证明确的权限拒绝和禁用状态。

应用场景复用 `test/automation/test.ts` 的 fixture：它负责工作区、配置、启动、重启、全窗口错误收集和退出清理。不同场景使用独立数据，同一场景重启保留数据。Explorer 导航复用 `workbench.openExplorer()`，设置导航复用 `workbench.settingsEditor`，终端输入复用 `workbench.terminal`，工作区搜索复用 `workbench.search`，系统和网页菜单复用 `workbench.menus`，消息与确认对话框复用 `workbench.dialogs`，常规 Sessions 入口复用 `workbench.openAgentsWindow(target.kind)`；专门验证快捷键、菜单或窗口入口的场景保留对应真实操作。工作台和 Sessions 的启动入口均等待自身状态恢复完成；导航辅助代码等待操作结果，功能断言留在用例中。

`referenceManager.integration.spec.ts` 使用真实 Rust 文献管理、Academy 与 PDF Viewer 进程及独立客户端，覆盖 RIS／库持久化、引用插入与更新／撤销、中英文、冲突、停用恢复及可选 PDF 阅读。签名安装路径由 `signed_installed_reference_manager_uses_product_launcher_and_exact_revocable_consent` 使用测试分发验收；构建和环境变量见 [Reference Manager](../extensions/reference-manager/README.md)。

Frontend CI 运行全部单元测试、Chromium 浏览器集成测试，以及 Browser、Electron UI 和连接真实 App Server 的完整 smoke suite；连接测试不再通过文件白名单或 grep 缩小范围。Academy Workbench 使用独立项目。需要联网下载出版社 PDF 的语料测试使用 `electron-pdf-corpus-app-server` 独立项目，不进入普通 smoke suite。PDF 查看器是可选扩展；该项目通过测试签名源安装并显式授权，必须提供 `ASH_PDF_VIEWER_DISTRIBUTION` 与 `ASH_PDF_VIEWER_TRUSTED_ROOT`，不复用用户 profile；前置与构建见 [PDF Viewer](../extensions/pdf-viewer/README.md)。

真实 App Server 场景运行文件保存、BOM/CRLF、外部修改后的撤销，以及手动保存、未保存、延迟自动保存、切换编辑器自动保存后的重启恢复；Browser 还验证未保存内容在页面重载后的恢复。终端覆盖输入、工作区目录、面板关闭再打开、多实例输出隔离和 shell 退出后的重新启动。Search 验证大小写、正则、包含与排除条件及清除结果；Tasks 验证发现、执行、重跑、取消和实际输出；Settings 验证即时生效、重启保存和恢复默认。CI 配置覆盖 Linux Browser、macOS Electron 和 Windows Electron；终端进程在窗口重启后的恢复尚未实现，不属于当前覆盖。

Electron 自动化普通测试在本地和 CI 都隐藏窗口，`--debug` 显示并激活窗口。普通模式禁止系统窗口焦点，但 Playwright 仍可输入和验证页面内焦点；这项策略也覆盖新窗口和重新启动。确实依赖系统焦点、全屏或真实系统菜单输入的用例使用 `test.extend({ electronWindowMode: 'active' })`；直接调用启动器时传入 `windowMode: 'active'`。active 必须限定到需要它的用例和平台，注明依赖原因，不在整个文件启用；混合场景应拆开普通操作与系统焦点验证。读取窗口状态使用 `application.browserWindow(page)`，不为取得窗口对象而依赖 `BrowserWindow.getFocusedWindow()`。限制由测试启动器的预加载脚本安装，正常应用启动保持原行为。

测试声明通过 Playwright `tag` 指定适用目标：`@browser-ui`、`@browser-app-server`、`@electron-ui`、`@electron-app-server`，同一维度的标签表示可选目标；没有目标标签时覆盖所有目标。`@darwin`、`@linux`、`@win32` 限定操作系统，与目标标签同时生效。项目在采集阶段过滤不适用用例，自动 fixture 在工作区和应用启动前检查自定义配置。仅可从实际运行获知的条件继续使用正文 `test.skip`。

组件布局和输入在源码 owner 的 `.test.ts` 中通过真实浏览器验证；Sessions Activity Bar、设置、画布、标题栏与 SCM history hover 使用隔离的浏览器页面，保留主题、辅助功能和非默认语言覆盖。Smoke 保留真实启动、跨窗口 IPC、宿主剪贴板、编辑器内容、配置持久化和重启链路。Academy workbench 与 document editing 已包含在常规 Electron 项目，CI 不额外重复运行。

## 发布成品检查

`.github/workflows/platform-checks.yml` 先构建、签名和公证，上传 Actions 产物，再调用 `release-sanity.yml`；所有成品检查通过后才向 GitHub Release 上传安装包和更新描述。Desktop 检查 macOS arm64/x64 和 Windows x64；Code 与独立 App Server 分别在 macOS、Linux、Windows 的 arm64/x64 机器运行，Windows ARM64 的交叉编译结果也必须在 ARM64 机器通过运行验证。

检查入口为 `node build/release/sanity.ts verify --product <ash-desktop|ash-code|ash-app-server> --version <版本> --target <目标> --output <报告目录>`。默认下载对应版本的 GitHub Release；`--artifacts-dir <目录>` 消费同目录的最终发布包和 `.update.json`。入口验证更新描述的 Ed25519 签名、产品、目标、版本、下载地址及包的大小和 SHA-256。Code 和 App Server 复用包布局、系统签名与真实 stdio RPC 搜索检查；Desktop 的 `electron-release` 项目安装最终 EXE 或解压已公证 ZIP，然后使用包内后端验证文件编辑保存、终端命令、重启和卸载后的数据保留。Windows 安装器会修改当前用户的应用注册，只允许在一次性 CI 主机运行；本地成品验证使用 `package:win32:verify`，直接启动现有 bundle。

三个 stable 晋级工作流都会重新检查已发布成品，下载通过的报告，并在签署 stable 更新信息前核对报告里的包哈希。Desktop 晋级还必须指定 `previous-version`：先安装旧版，再在同一安装位置安装候选版，共用配置和工作区，验证版本切换、重启及数据保留。该场景覆盖安装包升级；应用内自动检查、下载和安装更新的完整调用链，以及 Code/App Server 的更新选择与数据迁移，不在此场景覆盖范围内。首次 Desktop stable 晋级也需要一个可用于升级验证的旧发布版本。

Desktop 成品检查还会在候选版及后续重启中打开 Markdown 预览并确认相对路径图片加载，覆盖包内 webview 启动资源、扩展脚本和工作区资源读取。启动资源 HTTP 错误、请求失败和 webview 致命启动错误会立即中断预览等待；资源诊断的 URL 会去掉凭据、查询参数和片段。失败时会保留 JSON 报告、DOM/控制台/资源诊断和 Playwright trace；排查不依赖截图。构建工具回归测试位于 `build/release/sanity.test.ts`。
