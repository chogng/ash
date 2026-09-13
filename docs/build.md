# 构建系统、仓库脚本与输出目录

> 本文拥有 Ash 构建入口、开发者脚本、受版本控制的构建逻辑与本地可删除产物之间的目录边界。产品线与宿主选择由 [`product-lines.md`](product-lines.md) 维护。

## 快速理解

Ash 使用根 `Justfile` 提供跨语言、跨产品入口，使用 `build/` 保存产物构建、生成、下载和发布机制，使用 `scripts/` 保存作用于仓库和开发环境的命令，使用根 `.build/` 保存常规本地产物。文件是否能被直接执行不决定归属；判断标准是它构建产品产物，还是操作、检查或运行仓库。日常构建、测试和开发不再向 `ash-ts/` 或仓库根散落 `dist`、`output`、`target` 和 Bazel 便捷链接。文档站由独立的 `ash-docs` 仓库构建和清理。

| 看到的路径 | 它是什么 | 是否受版本控制 | 能否整体删除 |
| --- | --- | --- | --- |
| `build/` | 产物构建、生成、下载、监听、打包、签名及其共享实现 | 是 | 否 |
| `scripts/` | Cargo 环境、格式化、测试、诊断和维护等仓库操作 | 是 | 否 |
| `.build/` | Cargo、Desktop、测试和 Bazel 本地产物 | 否 | 是，运行 `corepack pnpm clean` |
| `ash-ts/generated/` | 协议和图标生成后参与编译的源码 | 部分文件按生成规则管理 | 否，必须由对应同步命令更新 |
| `ash-ts/docs/`、`ash-ts/licenses/` | Desktop 的文档和打包输入 | 是 | 否 |
| `node_modules/` | pnpm workspace 的依赖链接和虚拟依赖树；内容寻址 store 使用用户级默认缓存 | 否 | 可通过 `corepack pnpm install` 重新安装 |
| `.ash/` | 当前目录的 Ash 配置或运行状态 | 按目录用途决定 | 不应由构建清理 |

## 构建入口

根 `Justfile` 是三个产品和根 Rust workspace 的统一入口。根 `package.json` 只提供 pnpm workspace 与 Electron、Browser、Stanza 等 Node 构建入口，不编排 Rust workspace。

Node 工具与 Desktop 单测使用仓库根 `.nvmrc` 固定的 Node 25.2.1。运行 `nvm use` 后再执行 `corepack pnpm install`、构建或测试；Node 22 已不受支持，安装和单测入口会明确拒绝它。

| 命令 | 结果 |
| --- | --- |
| `just build` | 构建 Electron Desktop 和根 Cargo workspace |
| `just build-desktop` | 构建 Electron Main、Preload 和当前 `ASH_PRODUCT` Renderer |
| `just build-rust` | 通过统一 Cargo 执行器构建根 Rust workspace |
| `just ash` | 用一次 Cargo 调用构建 Code TUI、本地 daemon 和当前平台沙箱程序，然后直接从源码开发运行目录启动 |
| `just ash-package` | 组装并发布 Desktop、Web 与 Code TUI 共用的完整不可变开发包 |
| `just ash-package-run` | 组装完整开发包，并让 Code TUI 连接该包中的 daemon 与产品服务 |
| `just fmt` / `just fmt-check` | 格式化或检查 Just、Rust 和第一方 Python 源码 |
| `just test-python [ash-code|build|release]` | 运行全部 Python 单元测试，或只运行指定 owner 的测试 |
| `corepack pnpm build` | 构建 Electron Main、Preload 和当前 `ASH_PRODUCT` Renderer |
| `corepack pnpm build:desktop` | 构建 Electron Main、Preload 和当前 `ASH_PRODUCT` Renderer |
| `corepack pnpm test:build` | 运行构建工具自身的单元测试 |
| `corepack pnpm test` | 直接运行构建工具检查和 Desktop 单元测试 |
| `corepack pnpm test:integration` | 直接运行 Editor 浏览器集成测试 |
| `corepack pnpm test:web-integration` | 直接运行带 App Server 的完整 Web 集成测试 |
| `corepack pnpm test:desktop:smoke` | 直接运行 Electron Desktop smoke tests |
| `corepack pnpm typecheck:build` | 严格检查整个 `build/` 中的 TypeScript 构建代码 |
| `corepack pnpm --dir ash-ts typecheck:test-unit` | 检查 Desktop 单测入口及其辅助代码 |
| `corepack pnpm clean` | 删除 `.build/` 和已知旧输出，不删除依赖、目录状态或源码生成物 |

Desktop 的 `code` 与 `academic` 仍通过同一个 `build:desktop` 入口构建；`ASH_PRODUCT` 只选择矩阵项，不创建另一套命令。

## 输出布局

```text
.build/
├── cargo/                       # Cargo target-dir
├── ash-development/<digest>/   # 源码开发所需的少量可执行文件；不含资源副本和包清单
├── desktop/
│   ├── main/                    # Electron Main TypeScript
│   ├── preload/                 # sandbox Preload TypeScript
│   ├── renderer/<product>/      # Vite Renderer bundle
│   ├── node_modules/            # link to the single Desktop dependency install
│   ├── test/                    # compiled Node tests
│   ├── editor-browser/          # editor browser-test bundle
│   ├── playwright/              # Playwright results and reports
│   └── dev/
│       ├── app-server/          # backend hot-reload generations
│       └── web-profile/         # full Web development profile
├── ash-package/dev/store-v1/<target>/<javascript-runtime>/<build-profile>/
│   ├── manifests/<sequence>.json # immutable package selection history
│   └── packages/<version>/<build-id>/ # immutable complete Ash packages and process leases
└── bazel-*                      # Bazel convenience links
```

`.cargo/config.toml` 把默认 Cargo `target-dir` 固定为 `.build/cargo`；显式 `CARGO_TARGET_DIR` 仍可覆盖它。`.bazelrc` 只把工作区便捷链接放入 `.build/`，Bazel 自己的输出用户根仍由 Bazel 管理。

根 Cargo profile 在 `dev` 与 `test` 中对完整依赖图使用轻量优化，并对 `app`、`ash-app-server` 与 `ash-app-server-client` 的超大最终链接单元使用 size optimization；debug assertions、各 profile 既有的调试信息与增量编译仍然保留。该配置把 macOS 产物的 `__eh_frame` 控制在 compact-unwind 的 16 MiB 编码上限内，不能用关闭 `linker_messages` 代替。

## 构建源码与仓库脚本边界

`build/` 沿用 VS Code 的机制分类，而不是按产品复制工具链。只为已经存在的构建职责创建目录：

| 路径 | 单一职责 |
| --- | --- |
| `build/lib/` | 构建输出路径、Desktop 输出准备等共享基础设施 |
| `build/lib/ash_build/` | Cargo 依赖选择、目标识别和校验下载 V8 输入等共享 Python 构建能力 |
| `build/lib/watch/` | Electron TypeScript 与 Rust Server Host 的增量监听和重启协调 |
| `build/pnpm/` | pnpm 版本约束、安装入口和单锁文件 workspace 校验 |
| `build/desktop/` | Desktop 资源生成、Electron 启动和打包校验 |
| `build/ash-package/` | Desktop、Web 与 Code TUI 共用的完整开发包组装和代发布 |
| `build/vite/` | Renderer 入口、Vite 配置、开发桥接与热重载插件 |
| `build/download/` | 受锁文件约束的第三方构建运行时下载器 |
| `build/release/` | Python/Shell 发布打包、签名、验证以及 Bazel 入口 |
| `build/clean.ts` | 根清理入口 |
| `build/package.json` | 构建工具自身的依赖、测试和类型检查入口 |
| `build/tsconfig.json` | 构建工具 TypeScript 边界 |

发布脚本按实际产物分目录；文件名只写操作，共享能力保留单一实现：

| 路径 | 职责与入口 |
| --- | --- |
| `build/release/package/` | 共享包的组装、内容校验和签名；入口为 `build.py`、`sign.py` |
| `build/release/app/` | App 打包、签名和发布契约；入口为 `build.py`、`signing.py` |
| `build/release/code/` | Ash Code 发布压缩包和校验和；入口为 `archive.py` |
| `build/release/remote/` | Remote 运行时压缩包和 catalog；入口为 `bundle.py` |
| `build/release/` | 共享 gzip 流、系统签名工具和公证入口；`archive.py`、`system_signing.py`、`notarize.py` |

各入口可用 `python3 -B <脚本路径>` 直接运行；模块导入统一从 `build.release` 开始。测试放在对应职责目录，`just test-python release` 统一发现并运行。

共享发布包先收集未提供预编译文件的第一方程序，再用一次 Cargo 调用构建并读取其报告的可执行文件路径。App 发布直接使用打包参数和 `signing.py sign / verify / record`；签名凭据由环境变量提供。

`scripts/` 根目录保存跨产品仓库工具：`just-shell.py` 提供 Just 的跨平台 shell，`cargo.py` 为整个 Cargo workspace 准备锁定的构建输入，`format.py` 统一已有格式化器，`test-python.py` 按 `ash-code`、`build`、`release` 分别运行 Python 测试并在不指定范围时聚合执行。

Desktop 的 Node、Browser 和 Playwright 测试入口与 loader 归 `ash-ts/test/`，根 `package.json` 直接调用 `ash-ts` 的公开测试命令。`scripts/ash-code/` 保存 Code TUI 的源码运行和完整开发包运行入口；`scripts/ash-rs/` 保存共享 Rust 后端的开发环境操作。`app` 当前没有独立脚本，因此不创建空占位文件。

`scripts/ash-code/run.py` 用一次 Cargo 调用构建 Code TUI、本地 daemon 和当前平台沙箱程序，再把这些可执行文件放入按内容区分的 `.build/ash-development/` 目录后启动；这个小目录避免 Windows 上仍在运行的程序阻塞下一次构建，不是产品包。技能、扩展和产品服务直接读取源码。`scripts/ash-code/run_package.py` 只服务于显式的完整开发包运行。只有形成真实、可运行的操作契约时才新增入口；当前没有独立的远端 SSH 端到端测试，因此不提供空入口。

`scripts/ash-rs/setup-windows.ps1` 是 Windows Rust 开发环境的独立初始化入口。它可以在 `just` 可用前直接运行，因此不依赖根 `Justfile`；它安装源码开发所需的 `rg`，产品包仍从锁文件组装自身的 `rg.exe`。

完整开发包仍由 `build/ash-package/prepareDevPackage.ts` 拥有。它在一次 Cargo 调用中构建全部第一方程序，然后复制并校验受管资源、计算整包摘要，最后通过 Package Store 发布不可变代次。日常 `just ash` 不执行这些组装与发布步骤；只有验证包布局、跨产品交付、回滚或远端运行时边界时才使用 `just ash-package` 或 `just ash-package-run`。Cargo 并发由 Cargo 自己决定；开发者仍可按需显式设置 `CARGO_BUILD_JOBS`。

`scripts/` 可以调用 `build/` 公开的构建准备能力，`build/` 不得依赖或调用 `scripts/`。普通构建和仓库命令不得依赖 `build/release/` 的包实现；共享目标识别和 V8 输入解析由 `build/lib/ash_build/` 拥有，日常 Cargo 命令与发布构建器都依赖这一层。测试内容和 fixture 仍归对应产品目录拥有，仓库脚本只负责入口、进程编排和临时测试输出生命周期。

根 `Justfile` 只声明稳定命令并委托到 `build/`、`scripts/` 或产品自身的构建入口，不保存构建机制。根 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 必须留在仓库根，因为它们是 pnpm 发现 workspace 和执行 Node 命令的协议文件；安装策略与校验实现由 `build/pnpm/` 拥有。`build`、`scripts` 和 `ash-ts` 共用根锁文件与 TypeScript 版本，pnpm 内容寻址 store 使用用户级默认缓存，子项目不得再声明独立 `packageManager`、`pnpm` 策略或 npm 锁文件。

同理，`.bazelrc`、根 `BUILD.bazel`、`.cargo/config.toml` 和 `tsconfig.base.json` 是对应工具从仓库根发现的协议文件，不能为了让 `build/` 看起来更大而移动。文档站框架配置、内容生成、打包和验收全部归独立的 `ash-docs` 仓库。

Node 构建工具和测试编排使用可擦除语法范围内的 TypeScript（`.ts`），由当前 Node.js 直接执行，不生成中间 JavaScript。跨语言仓库命令、归档和下载流程可以使用 Python；平台发布工具要求 Shell 时保留 Shell。语言由操作依赖决定，不由所在目录强制统一。`build/tsconfig.json` 检查构建工具，`ash-ts/test/unit/tsconfig.json` 检查 Desktop 单测入口；`scripts/pyproject.toml` 和 `scripts/uv.lock` 锁定 Python 仓库工具，`just install` 通过 uv 准备它们。

平台专属构建流程只有在出现实际实现时才新增 `build/win32/` 或 `build/linux/`，不创建空分类。`ash-ts/` 只保存产品源码、测试内容和产品清单；构建、资源生成、下载与发布逻辑由根 `build/` 拥有，跨产品测试和维护编排由根 `scripts/` 拥有。Renderer、Workbench 和平台服务不得拥有构建工具配置或仓库操作入口。

旧的 `target/`、`ash-ts/dist/`、`ash-ts/output/`、`ash-ts/.tmp/` 和根 `output/` 仍保留忽略规则，只为防止旧工具或旧分支重新提交这些产物；当前命令不得再写入这些路径。
