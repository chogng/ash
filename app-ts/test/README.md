# Desktop 测试结构

本目录只保存跨源码 owner 的测试基础设施和完整应用测试。单元与组件测试跟随实现放在 `src/ash/<owner>/test/<runtime>`。

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

| 测试类型 | 放置位置 | 运行入口 |
| --- | --- | --- |
| 单元与组件契约 | `src/ash/<owner>/test/common|browser|node|electron-*` | `pnpm test:unit` |
| 仓库级架构约束 | `test/architecture` | `pnpm test:unit` |
| 单测入口与 Node loader | `test/unit` | `pnpm test:unit` |
| Editor 浏览器集成测试 | `test/integration/browser` | `pnpm test:editor:browser` |
| Playwright 自动化驱动 | `test/automation` | Browser/Electron smoke tests 共享 |
| Browser Renderer 场景 | `test/smoke/areas/<area>` | `pnpm test:smoke:browser` |
| Browser + App Server 场景 | `test/smoke/areas/<area>` | `pnpm test:smoke:browser:full` |
| Electron Renderer 场景 | `test/smoke/areas/<area>` | `pnpm test:smoke:ui` |
| Electron + App Server 场景 | `test/smoke/areas/<area>` | `pnpm test:smoke:desktop` |
| 构建工具测试 | `../build/**/*.test.ts` | `pnpm test:build-tools` |

`pnpm test:main` 依次运行构建工具测试和全部单元测试。仓库根 `package.json` 直接调用这里的公开测试命令。`test/unit/` 使用 Mocha，逐文件启动独立进程，并提供 `--run`、`--runGlob`、`--grep` 筛选。`pnpm test:unit` 编译后先验证 runner 的筛选和失败行为，再执行选择的用例；汇总执行数量不包含跳过项，没有执行任何用例时返回失败。清理、reporter 与 loader 也归此目录，由 `pnpm typecheck:test-unit` 检查。编辑器浏览器集成测试位于 `test/integration/browser/`，Browser 和连接后端的 Electron smoke 入口共用 `test/smoke/run.ts`；入口为每次运行编译同一个语言服务器 fixture，每个场景在自己的配置目录中启用它，运行结束后清理。`pnpm test:smoke:browser` 启动 5173 的 disconnected Browser Workbench；`pnpm test:smoke:browser:full` 为每个场景在独立端口启动生产 Web 服务和真实 App Server，使用该场景的工作区与配置目录。`pnpm test:smoke:ui` 启动禁用 App Server 的 Electron，适合快速验证 Renderer 和 Workbench；`pnpm test:smoke:desktop` 会额外组装 Rust 开发包并启动真实 App Server。仓库根目录 `pnpm run smoketest` 准备并运行完整 Electron + App Server 冒烟测试，`pnpm run smoketest-no-compile` 运行已准备好的同一套测试；`pnpm test:desktop:smoke:ui` 显式运行 Electron 快速模式，也可通过 `pnpm test:desktop:smoke:browser` 和 `pnpm test:desktop:smoke:browser:full` 运行 Browser 模式。CI 先运行对应的 `pretest:smoke:*` 准备步骤，再用 `test:smoke:*:no-compile` 运行已准备好的测试，便于重复排查偶发失败。

新增测试时先选择拥有被验证 contract 的最窄源码模块，再按真实运行时选择 `common`、`browser`、`node`、`electron-browser` 或 `electron-main`。只有没有单一源码 owner 的全仓库约束才进入 `test/architecture`；跨多个用户操作的场景才进入 `test/smoke`。

连接后端的 Code 场景在 Browser 和 Electron 中实际执行语言服务测试，覆盖补全、诊断随编辑更新、格式化及撤销、参数提示、内联提示和联动编辑。Memories 读写依赖桌面宿主权限；Browser 验证明确的权限拒绝和禁用状态。

应用场景复用 `test/automation/test.ts` 的 fixture：它负责工作区、配置、启动、重启、全窗口错误收集和退出清理。不同场景使用独立数据，同一场景重启保留数据。Explorer 导航复用 `workbench.openExplorer()`，设置导航复用 `workbench.settingsEditor`，终端输入复用 `workbench.terminal`，工作区搜索复用 `workbench.search`，系统和网页菜单复用 `workbench.menus`，消息与确认对话框复用 `workbench.dialogs`，常规 Sessions 入口复用 `workbench.openAgentsWindow(target.kind)`；专门验证快捷键、菜单或窗口入口的场景保留对应真实操作。工作台和 Sessions 的启动入口均等待自身状态恢复完成；导航辅助代码等待操作结果，功能断言留在用例中。

Frontend CI 运行全部单元测试、Chromium 浏览器集成测试，以及 Browser、Electron UI 和连接真实 App Server 的完整 smoke suite；连接测试不再通过文件白名单或 grep 缩小范围。Academic Workbench 使用独立项目。需要联网下载出版社 PDF 的语料测试使用 `electron-pdf-corpus-app-server` 独立项目，不进入普通 smoke suite。

真实 App Server 场景运行文件保存、BOM/CRLF、外部修改后的撤销，以及手动保存、未保存、延迟自动保存、切换编辑器自动保存后的重启恢复；Browser 还验证未保存内容在页面重载后的恢复。终端覆盖输入、工作区目录、面板关闭再打开、多实例输出隔离和 shell 退出后的重新启动。Search 验证大小写、正则、包含与排除条件及清除结果；Tasks 验证发现、执行、重跑、取消和实际输出；Settings 验证即时生效、重启保存和恢复默认。CI 配置覆盖 Linux Browser、macOS Electron 和 Windows Electron；终端进程在窗口重启后的恢复尚未实现，不属于当前覆盖。

## 发布成品检查

`.github/workflows/platform-checks.yml` 先构建、签名和公证，上传 Actions 产物，再调用 `release-sanity.yml`；所有成品检查通过后才向 GitHub Release 上传安装包和更新描述。Desktop 检查 macOS arm64/x64 和 Windows x64；Code 与独立 App Server 分别在 macOS、Linux、Windows 的 arm64/x64 机器运行，Windows ARM64 的交叉编译结果也必须在 ARM64 机器通过运行验证。

检查入口为 `node build/release/sanity.ts verify --product <ash-desktop|ash-code|ash-app-server> --version <版本> --target <目标> --output <报告目录>`。默认下载对应版本的 GitHub Release；`--artifacts-dir <目录>` 消费同目录的最终发布包和 `.update.json`。入口验证更新描述的 Ed25519 签名、产品、目标、版本、下载地址及包的大小和 SHA-256。Code 和 App Server 复用包布局、系统签名与真实 stdio RPC 搜索检查；Desktop 的 `electron-release` 项目安装最终 EXE 或解压已公证 ZIP，然后使用包内后端验证文件编辑保存、终端命令、重启和卸载后的数据保留。Windows 安装器会修改当前用户的应用注册，只允许在一次性 CI 主机运行；本地成品验证使用 `package:win32:verify`，直接启动现有 bundle。

三个 stable 晋级工作流都会重新检查已发布成品，下载通过的报告，并在签署 stable 更新信息前核对报告里的包哈希。Desktop 晋级还必须指定 `previous-version`：先安装旧版，再在同一安装位置安装候选版，共用配置和工作区，验证版本切换、重启及数据保留。该场景覆盖安装包升级；应用内自动检查、下载和安装更新的完整调用链，以及 Code/App Server 的更新选择与数据迁移，不在此场景覆盖范围内。首次 Desktop stable 晋级也需要一个可用于升级验证的旧发布版本。

失败时会保留 JSON 报告、DOM/控制台诊断和 Playwright trace；排查不依赖截图。构建工具回归测试位于 `build/release/sanity.test.ts`。

# Test layout

Editor tests follow VS Code's two-layer layout with one shared editor browser suite:

| Layer | Location | Purpose |
| --- | --- | --- |
| Editor unit | `src/ash/editor/test` and editor contribution `test` folders | Code/Academic TextModel, command, controller, persistence, and projection contracts in Node/jsdom |
| Editor browser | `test/integration/browser` | Code/Academic TextModel mount points, mode bundles, pane, input, save, worker, code-block range, and accessibility contracts in Chromium |
| Editor architecture | `test/architecture/editor-architecture.test.ts` | Flat `common/browser/contrib/test` ownership, mode bundles, and synchronous-layer dependency rules |
Run `pnpm test:editor`; it runs the editor unit tests and the single browser integration suite.
