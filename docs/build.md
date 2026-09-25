# 构建系统、仓库脚本与输出目录

本文说明构建和测试入口、工具要求、输出目录，以及 `build/` 与 `scripts/` 的职责。产品选择见 [`product-lines.md`](product-lines.md)。

- [环境与命令](#构建入口)
- [输出与清理](#输出布局)
- [依赖检查、构建测量与 CI](#rust-依赖检查与构建测量)
- [构建源码与脚本职责](#构建源码与仓库脚本边界)

## 快速理解

Ash 使用根 `Justfile` 提供跨语言、跨产品入口，使用 `build/` 保存产物构建、生成、下载和发布机制，使用 `scripts/` 保存作用于仓库和开发环境的命令，使用根 `.build/` 保存常规本地产物。文件是否能被直接执行不决定归属；判断标准是它构建产品产物，还是操作、检查或运行仓库。日常构建、测试和开发不再向 `app-ts/` 或仓库根散落 `dist`、`output`、`target` 和 Bazel 便捷链接。文档站由独立的 `ash-docs` 仓库构建和清理。

| 看到的路径 | 它是什么 | 是否受版本控制 | 能否整体删除 |
| --- | --- | --- | --- |
| `build/` | 产物构建、生成、下载、监听、打包、签名及其共享实现 | 是 | 否 |
| `scripts/` | Cargo 环境、格式化、测试、诊断和维护等仓库操作 | 是 | 否 |
| `.build/` | Cargo、Desktop、测试和 Bazel 本地产物 | 否 | 是，运行 `pnpm clean` |
| `app-ts/src/ash/platform/app-server/common/generated/` | Rust 协议快照的前端消费副本 | 否 | 可通过 `pnpm --dir app-ts protocol:sync` 重建 |
| `app-ts/src/ash/base/common/productIcons.ts` | 产品 SVG 生成的图标工厂 | 是 | 否，使用 `pnpm icons:generate` 更新 |
| `app-ts/docs/`、`app-ts/licenses/` | Desktop 的文档和打包输入 | 是 | 否 |
| `node_modules/` | pnpm workspace 的依赖链接和虚拟依赖树；内容寻址 store 使用用户级默认缓存 | 否 | 可通过 `pnpm install` 重新安装 |
| `.ash/` | 当前目录的 Ash 配置或运行状态 | 按目录用途决定 | 不应由构建清理 |

## 构建入口

### Windows 开发环境

以下工具用于源码开发和仓库维护，安装后的 Ash 产品不依赖 Just、Python 或 uv。

- 开发者根据下表自行安装并确认工具版本；`cargo-insta` 等测试维护工具按任务需要另行准备。项目依赖安装入口保留 Node、pnpm 版本校验，编译器和 SDK 缺项由构建工具报告。
- Windows 本机拥有 MSVC、Windows SDK 和桌面运行环境。安装后使用对应目标架构的 Visual Studio Developer PowerShell 构建。LLVM 的 `bin` 目录需在构建终端 PATH 中；使用自定义 LLVM 路径时，在该终端设置 `LIBCLANG_PATH` 指向含 `libclang.dll` 的目录。无需全局设置 `CC`、`CXX`。
- Visual Studio Installer 的“语言包”需安装 **English**，已有中文安装可直接补装。Rust 会向 MSVC 请求英文诊断；缺少英文资源时，中文“正在创建库”进度会被误报为 `linker_messages` warning，见 [Rust #159133](https://github.com/rust-lang/rust/issues/159133)。
- 普通构建和启动入口只准备项目依赖与产物，不调用系统工具安装器。分别用 `just ash`、`just ash-desktop`、`just app` 启动产品。
- Bazel 由 Bazelisk 管理；它读取仓库根的 [`.bazelversion`](../.bazelversion)，不需要手动选择 Bazel 版本。Windows 运行测试前需让 `BAZEL_SH` 指向 Git Bash，例如 `C:\Program Files\Git\bin\bash.exe`。
- 当前未提供 Dev Container。Windows 桌面构建、调试和平台验证在 Windows 上完成。

| 工具 | 版本要求与来源 | 安装来源或组件 |
| --- | --- | --- |
| Node.js | [`.nvmrc`](../.nvmrc) 声明的版本 | Node.js 官方发行包或 fnm |
| pnpm | 根 [`package.json`](../package.json) 的 `packageManager` | npm；操作见根 README |
| Rust | [`rust-toolchain.toml`](../rust-toolchain.toml) 的工具链与组件 | rustup |
| PowerShell 7 | Windows 的 Just shell，需支持 `-CommandWithArgs` 以保留参数边界 | winget `Microsoft.PowerShell`；`just install` 可安装缺失的工具 |
| Python | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `requires-python`；建议 3.12 | 由 uv 管理；Just 中的 Python 脚本通过 `uv run` 执行，无需单独配置 `python` 的 PATH |
| Visual Studio Build Tools | 2022 / MSVC v143，匹配目标架构 | Visual Studio Installer 的“使用 C++ 的桌面开发” |
| Windows SDK | 提供目标架构头文件和库；未固定补丁版本 | Visual Studio Installer 的 Windows SDK 组件 |
| Git | 未固定版本，命令需在 PATH 中可用 | git-scm.com 或 winget `Git.Git` |
| ripgrep | 开发工具未固定版本；产品使用独立锁定产物 | winget `BurntSushi.ripgrep.MSVC` |
| just | 未固定版本，命令需在 PATH 中可用 | winget `Casey.Just` |
| uv | Python 工具环境由 `scripts/uv.lock` 锁定 | winget `astral-sh.uv` |
| CMake | 未固定版本，命令需在 PATH 中可用 | cmake.org 或 winget `Kitware.CMake` |
| LLVM/Clang | 未固定版本；需要 Clang 和 libclang | LLVM 官方发行包或 winget `LLVM.LLVM` |
| Bazelisk | [`.bazelversion`](../.bazelversion) 固定 Bazel 版本 | winget `Bazel.Bazelisk`；CI 使用 `setup-bazel` |

### 初始化

在仓库根目录执行：

1. 按根 [README](../README.md#quick-start) 配置 Node 和 pnpm，确认 `node --version`、`pnpm --version` 与仓库要求一致。
2. 执行 `pnpm install` 安装 Node workspace 依赖。
3. 执行 `just install` 获取 Rust 依赖并通过 uv 准备 Python 工具环境。Windows 上此入口使用系统自带的 `powershell.exe`，不要求预先安装 `pwsh`；缺少 PowerShell 7 时会调用 winget 安装。安装后重启终端和编辑器，让后续 Just 命令读取更新后的 PATH。

### 项目命令

根 `Justfile` 是三个产品和根 Rust workspace 的统一入口。根 `package.json` 提供 pnpm workspace 与 Electron、Browser、Stanza 等 Node 构建入口；`pnpm test` 还会调用 Rust 协议验证。完整 Rust workspace 构建由 `Justfile` 编排。

- Just 在 Windows 上调用 PowerShell 7 的 `-CommandWithArgs`，保留参数边界；其他平台调用 `sh`。
- `just ash-desktop` 内部执行 `pnpm --dir app-ts dev`；VS Code 的 `Ash Desktop (Electron)` 默认 F5 配置使用同一入口，前端走热更新，后端输入变化才重新构建和换代。`Ash Desktop UI (reuse App Server)` 只构建前端并复用兼容的服务。
- Rust 构建、打包和源码启动脚本由 Just 通过 `uv run --frozen --project scripts python` 执行，统一使用锁定的 Python 环境。

前端 Node 工具与 Desktop 单测使用 Node 24 LTS，具体版本由仓库根 `.nvmrc` 和 `package.json` 的 `devEngines.runtime` 共同固定。按 [README 初始化步骤](../README.md#quick-start) 安装根 `package.json` 声明的 pnpm 后，`pnpm install` 会下载并使用固定的 Node 版本，后续 pnpm 脚本也使用该版本。直接运行 Node 命令时仍需自行切换到 `.nvmrc` 指定版本。安装检查要求 pnpm 版本与声明完全一致；其他 Node 主版本不受支持。

#### 产品启动与 Rust 构建

| 命令 | 结果 |
| --- | --- |
| `just ash-desktop` | 启动 Electron Desktop 开发环境 |
| `just app` | 构建 App Server 并启动 Rust Desktop |
| `pnpm dev:web:full` | 启动带 App Server 的完整 Web 开发环境 |
| `just build` | 构建三条产品线的宿主及其开发所需服务程序 |
| `just build-code` | 构建 `ash code` CLI/TUI 宿主及其开发所需服务程序 |
| `just build-desktop` | 构建 Electron Main、Preload 和包含全部 Workbench 模式的 Renderer |
| `just build-app` | 构建 `app` Rust 桌面宿主及其开发所需服务程序 |
| `just build-rust` | 通过统一 Cargo 执行器构建根 Rust workspace |
| `just ash` | 用一次 Cargo 调用构建 Code TUI、本地 daemon 和当前平台沙箱程序，然后直接从源码开发运行目录启动 |
| `just ash-package` | 组装并发布 Desktop、Web 与 Code TUI 共用的完整不可变开发包 |
| `just ash-package-run` | 组装完整开发包，并让 Code TUI 连接该包中的 daemon 与产品服务 |
| `just check <package>` | 检查指定 Rust 包 |
| `just test <package>` | 测试指定 Rust 包 |
| `just test-tui` | 构建服务程序并运行 CLI/TUI PTY 场景 |
| `just runtime-package <args>` | 组装共享运行时发布包 |
| `just code-package <args>` | 在运行时包上加入 `ash` 命令并组装 Code 发布包 |
| `just app-package <args>` | 在运行时包上加入 Rust 桌面端并组装 App 发布包 |

#### 仓库维护

| 命令 | 结果 |
| --- | --- |
| `just lint` | 使用锁定的 Ruff 检查 `build/` 与 `scripts/` 的 Python 代码 |
| `just fmt` / `just fmt-check` | 格式化或检查 Just、Rust 和第一方 Python 源码 |
| `just test-python` / `just test-python build` | 使用锁定的 Python 工具环境运行全部单元测试，或只运行指定 owner 的测试 |
| `just dependencies` | 检查 Rust 依赖声明、间接依赖边界、已审查的多版本集合和无用依赖 |
| `just bench-build <package> [--profile dev]` | 记录一个 Cargo package 的构建耗时、RSS 和产物大小 |

#### Node 构建与测试

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 构建 Electron Main、Preload 和包含全部 Workbench 模式的 Renderer |
| `pnpm build:desktop` | 构建 Electron Main、Preload 和包含全部 Workbench 模式的 Renderer |
| `pnpm test:build` | 运行构建工具自身的单元测试 |
| `pnpm test` | 先验证 Rust 协议，再生成前端协议并运行构建工具检查和 Desktop 单元测试 |
| `pnpm test:integration` | 运行全部浏览器集成测试 |
| `pnpm test:web-integration` | 直接运行带 App Server 的完整 Web 集成测试 |
| `pnpm test:desktop:smoke` | 直接运行 Electron Desktop smoke tests |
| `pnpm typecheck:build` | 严格检查整个 `build/` 中的 TypeScript 构建代码 |
| `pnpm --dir app-ts typecheck:test-unit` | 检查 Desktop 单测入口及其辅助代码 |
| `pnpm clean` | 删除 `.build/` 和 `build/`、`scripts/` 内的 Python 缓存；缓存扫描跳过依赖目录，不跟随链接 |

Desktop 的 `code` 与 `academic` 通过同一个 `build:desktop` 入口构建，`ASH_WORKBENCH_MODE` 选择启动时的默认模式；两者共用一个 Renderer 产物。

#### Bazel 边界测试

Bazelisk 按 `.bazelversion` 选择 Bazel。Windows 先在当前 PowerShell 中配置 Git Bash 路径：

```powershell
$env:BAZEL_SH = "C:\Program Files\Git\bin\bash.exe"
bazelisk test //app-rs:app_ci --test_output=errors --test_env=PATH
```

其他平台直接运行同一条 `bazelisk test` 命令。测试包组装会启动仓库固定版本的 Node，因此 `--test_env=PATH` 将已配置的 Node 路径传给 Bazel 测试进程。该目标检查 App 边界和打包契约；产品行为测试使用上面的对应入口。

### 准备步骤与验证范围

- `test:main` 聚合构建工具和前端单测；协议生成、图标校验和输出目录准备由 `test:unit` 的前置步骤执行一次。单独运行 `test:unit` 或 `test:editor:unit` 同样会准备输入。
- Electron 键盘模块使用 electron-rebuild 的架构和 ABI 记录判断是否需要重新编译；需要显式重编译时运行 `pnpm --dir app-ts rebuild:native --force`。
- `test:smoke:ui` 构建 Electron 和 Renderer 并测试关闭 App Server 的界面；`test:smoke:desktop` 额外组装后端包并测试真实 App Server。Browser 的 `test:smoke:browser` 与 `test:smoke:browser:full` 分别覆盖这两个范围；完整 Web 测试只检查 Renderer、编译浏览器资源并组装一次包含 Node 的后端包，不构建 Electron Main/Preload。
- 使用上述带明确范围的 smoke 命令；不再提供 `test:e2e`、`test:smoke` 和 `test:desktop:e2e` 等重复别名。

### 日常 CI

| 流程 | 覆盖 | 触发 |
| --- | --- | --- |
| `frontend.yml` | 构建工具类型检查与测试、Stanza 构建、前端单测、生产 Browser 与 Electron UI Playwright | 相关路径的 main 提交、PR、手动 |
| `tooling.yml` | 三个平台的 Python lint、格式、构建、包布局和签名契约测试 | 相关路径的 main 提交、PR、手动 |
| `bazel-boundary.yml` | Bazel 下的 App 边界、发布契约、打包和签名测试 | 相关路径的 main 提交、PR、发布、手动 |
| `platform-checks.yml` | 平台实机验证和发布包签名、上传 | 发布、手动；签名和上传只在发布时执行 |

Browser 和 Electron UI 检查不启动 App Server；真实后端集成继续使用对应的本地命令和平台验证。Playwright 失败时上传报告和 trace。

## 输出布局

```text
.build/
├── cargo/                       # Cargo target-dir
├── code/dev/<digest>/           # 源码开发所需的少量可执行文件；不含资源副本和包清单
├── app-ts/
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
├── runtime/dev/store-v1/<target>/<javascript-runtime>/<build-profile>/
│   ├── manifests/<sequence>.json # immutable package selection history
│   └── packages/<version>/<build-id>/ # immutable complete Ash packages and process leases
└── bazel-*                      # Bazel convenience links
```

`.cargo/config.toml` 把默认 Cargo `target-dir` 固定为 `.build/cargo`；显式 `CARGO_TARGET_DIR` 仍可覆盖它。`.bazelrc` 只把工作区便捷链接放入 `.build/`，Bazel 自己的输出用户根仍由 Bazel 管理。

根 Cargo profile 在 `dev` 与 `test` 中对完整依赖图使用轻量优化，并对 `app`、`ash-app-server` 与 `ash-app-server-client` 的超大最终链接单元使用 size optimization；debug assertions、各 profile 既有的调试信息与增量编译仍然保留。该配置把 macOS 产物的 `__eh_frame` 控制在 compact-unwind 的 16 MiB 编码上限内，不能用关闭 `linker_messages` 代替。

Code 源码构建只选择实际运行的 Cargo 包和程序：`ash-cli`、`ash-app-server`、`ash-code-mode-host`，Linux 另加 `ash-bwrap`。这样不会把整个 workspace 的额外依赖特性合并进 Code 构建。Windows x86_64 MSVC 上，Code 开发构建使用 Rust 工具链自带的 `rust-lld` 链接器；显式设置 `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` 时使用调用方指定的链接器。其他产品构建入口不受此设置影响。

## Rust 依赖检查与构建测量

### 依赖检查

依赖规则由 [Rust 规范](../.github/instructions/rust.instructions.md#dependencies-and-build-costs)维护。`scripts/dependencies.py` 是本地与 CI 共用的检查入口；使用 Cargo 返回的工作区成员，读取全部平台的普通、构建和测试依赖声明，并按普通/构建依赖检查内部依赖路径。它不把测试依赖当作产品依赖边界，也不尝试推断外部库内部的业务层次。

安装固定工具版本后运行检查：

```sh
cargo install cargo-shear --version 1.13.4 --locked
just dependencies
just test-python scripts
```

`.cargo/dependencies.toml` 记录整个锁文件中的多版本包、精确版本及当前引入方。版本集合发生变化或记录失效时检查失败；新版本必须结合 `cargo tree --workspace --target all -i <package>` 审阅。它不禁止所有传递依赖的多版本并存，也不把锁文件数量当作当前产品实际编译单元数。

cargo-shear 的依赖错误和依赖警告都会阻断检查，工具处理失败也会失败。工作区内自有 crate 的根目录别名本身不产生编译任务，允许没有依赖方；第三方根依赖仍检查是否被使用。孤立源码文件诊断会打印，但不属于依赖检查的失败条件。依赖误报必须在所属包的 `package.metadata.cargo-shear` 中逐项说明，不能用整个工作区的忽略列表屏蔽真实依赖问题。CI 不运行 `--fix`。

### 构建测量

构建基线使用 macOS 或 Linux 的 `/usr/bin/time`，至少重复三轮。每轮分配自己的空 Cargo 输出目录，依次测量构建、无改动重跑和触碰选定源码时间戳后的重编译；保留日志、Cargo timings、JSON 测量及产物文件大小，然后删除本轮独占的编译输出。共享的 `.build/cargo` 不会被清理。触碰后恢复原时间戳，不覆盖同时发生的编辑。

```sh
cargo fetch --locked
just bench-build ash-keybinding --profile dev --jobs 4
just bench-build ash-cli --profile dev-small --jobs 4
just bench-build ash-cli --profile release --jobs 4
```

报告保存在 `.build/build-health/`。RSS 是 `time` 报告的最大驻留集，不是全部并行编译进程内存之和；产物大小是 Cargo 报告的文件大小，不是签名、剥离符号和压缩后的发布包大小。空 Cargo 输出不代表清空操作系统、下载或外部编译器缓存。依赖下载应在测量前完成，构建使用 `--offline`。

同机、同工具链、同 profile/target、并发数、输入文件和环境参数的报告可以显式比较：

```sh
just bench-build ash-keybinding --jobs 4 --compare .build/build-health/<run>/report.json --max-regression 15
```

超过调用方指定的耗时阈值会失败；`--absolute-regression 2` 可额外允许两秒以内的绝对波动，只有相对和绝对阈值同时超过才失败。负载不同或结果波动时必须复测。

### CI 检查

`Rust checks and build performance` 在 push/PR 检查依赖；`Build tooling` 在 Linux、macOS 和 Windows 运行构建脚本回归测试。仅在 main push 对编译热点 `ash-app-server-protocol` 执行性能门禁，避免 PR 等待重复的全冷编译。每次 main push 的性能作业独立运行，不被后续推送取消，以免遗漏被取消的提交。在同一个 Ubuntu 作业中分别检出推送前后的源码，两份源码使用当前版本的 Rust 工具链、四个并发任务，各测三轮。任一场景的耗时中位数同时增加超过 25% 和两秒时检查失败，两份日志和报告都会上传。首次推送没有基线时不执行性能比较，其余检查照常运行。这是协议包的编译门禁，不代表其他产品的整包耗时预算。

该工作流的追踪测试和协议测试作业使用 sccache 复用不同 CI 运行间的 Rust 编译结果，并关闭 Rust 增量编译。这两个作业先运行覆盖所有目标的 `rust-warnings`，再运行测试，不重复执行已被 warning 检查覆盖的普通 `check`。性能门禁仍使用独立空目标目录且不启用 sccache，以便比较源码改动前后的编译耗时。本机日常构建不自动启用 sccache。

`Rust warnings` 在 Linux、macOS、Windows 并行检查工作区；Linux TUI 测试单独并行运行。PR 改动路径按 Cargo 包及其依赖关系判断是否影响 TUI、CLI 或测试所需的服务程序；根 Cargo 配置、构建入口和无法归属的相关源码改动仍运行 TUI 测试。main push 和手动触发始终运行完整 TUI 覆盖，避免连续推送取消前一次运行后遗漏测试。GitHub Ubuntu runner 无法完成 Bubblewrap 的隔离网络 loopback 设置，因此三个依赖真实沙盒执行的 PTY 场景在单独并行的 macOS 作业中运行，其余 PTY 场景仍在 Linux 运行。测试使用锁定的 ripgrep 产物，并在耗时的 Rust 编译前验证它能启动。Linux 与 macOS TUI 作业的服务程序和 CLI 测试目标统一使用已有的 `ci-test` profile，避免同一作业在 `dev` 与 `test` profile 间重复编译后端依赖；普通 `just test-tui` 仍使用原有默认 profile。

测量脚本的 `--root <workspace>` 允许当前版本的工具测量旧源码，即使旧源码中还没有测量工具。CI 将两个 checkout 放在并列目录，避免当前版本的 `.cargo/config.toml` 影响基线。手动触发 CI 时默认测量 `ash-cli`，也可选择 `ash-app-server` 或 `app`，分别记录产品构建基线。

### 历史测量与适用范围

以下为特定机器和场景的测量记录，不是当前所有产品的构建预算。

2026-09-13 在 macOS aarch64、Rust 1.98.0、四个 Cargo 任务、`CARGO_INCREMENTAL=0`、第三方源码已下载的条件下，用独立空目标目录测量 TUI 测试目标、三个服务程序和 CLI PTY 测试目标的顺序冷编译。原有 `test`/`dev` 组合分别用时 624、449、27 秒，统一使用 `ci-test` 分别用时 409、136、10 秒；总时间约 18 分 20 秒降至 9 分 15 秒，产物目录约 10 GB 降至 9.1 GB。两组无改动重跑均约 0.6 秒；仅触碰 TUI 源码后的重编译从 29.4 秒降至 11.6 秒。`ci-test` 在本机链接时会产生 macOS compact-unwind warning，macOS 沙盒 PTY 作业因此可能输出该链接器提示。GitHub Linux runner 的三段 Cargo 编译日志从原配置合计 29 分 35 秒降至 18 分 10 秒。

协议注册表的 Schema 对象构造、TypeScript 默认配置初始化和依赖名称收集由非泛型函数处理。注册表保存具体类型的方法指针，避免把相同包装逻辑在大量类型和下游消费者中重复实例化。JSON Schema、TypeScript 和 schema hash 仍由协议测试验证同步。

2026-09-13 的本机对照使用固定源码、Rust 1.98.0、aarch64-apple-darwin 和六个 Cargo 任务。第三方依赖已缓存，回切协议注册表实现后构建 `ash` 发布程序，三组无其他 Rust 编译重叠的有效配对结果为 122.70→83.61 秒、108.17→75.63 秒、120.07→83.46 秒，中位数 120.07→83.46 秒，减少 30.5%。六次的重编译包集合一致；早期受干扰、误判 Fresh 或重编译范围不同的运行均未计入。这个结果只说明该重编译场景，不代表所有构建都提速 30.5%。

同次实验没有采用全局 Profile 候选：`4 CGU + ThinLTO` 的单次冷构建约快 9%，但仅修改 CLI 入口后的 Release 重编译中位数从 6.50 秒增加到 159.24 秒；build-override O1 加六个宏相关包 O3 则使开发冷构建从约 313 秒增加到 341 秒，touch 重编译中位数只减少约 0.36 秒。默认参数保留，实际改进来自消除重复生成和实例化。

2026-09-24 在 macOS aarch64、Rust 1.98.0、12 个 Cargo 任务、第三方源码已缓存的条件下，移除产品宿主到 App Server 实现的普通依赖后，分别对单个程序使用三个独立空目标目录测量。`ash-cli` 的 `dev-small` 冷编译中位数为 131.82 秒，无改动重跑 1.60 秒，仅触碰入口文件 2.26 秒；程序为 25,885,952 字节，Cargo timings 记录 552 个编译单元。`app` 的 `dev` 对应数据为 191.84、1.87、1.75 秒；程序为 87,874,120 字节，Cargo timings 记录 758 个编译单元。报告分别保存在 `.build/build-health/ash-cli-dev-small-vlkzv1fs/report.json` 和 `.build/build-health/app-dev-xvx7lkqe/report.json`。这些是各宿主程序的测量；`just build-code` 和 `just build-app` 仍会另外构建 `ash-app-server` 与 `ash-code-mode-host`，两条实际产品构建命令也已通过。

在复用本机共享 Cargo 输出的实际产品命令中，分别修改一次 TUI 的帧间隔常量和 Rust App 的窗口宽度常量，再恢复原值；每条路径重复三次。`just build-code` 重编译 `ash-tui` 与 `ash-cli` 的三次用时为 7.45、4.84、4.67 秒，中位数 4.84 秒；`just build-app` 重编译 `ash-workbench` 与 `app` 的三次用时为 22.80、5.25、4.85 秒，中位数 5.25 秒。无改动重跑分别为 2.12 和 2.30 秒。运行日志保存在 `.build/build-health/edit-loop-20260924/report.json`，临时源码修改已恢复。首轮较慢，不能把后两轮的耗时当作稳定下界。

变更前 `ash-cli` 的一次三轮冷编译中位数约 403.53 秒、程序约 158 MB、编译单元 1134 个，但测量期间 HEAD 和源码时间戳发生变化，不能作为严格配对的提速百分比；无改动与 touch 数据同样作废。变更后的有效报告证明普通 TUI/App 宿主图已不再包含 Typst、LiveKit/WebRTC 和 App Server 实现；测量时工作区尚有后来退出工作区的 Git 分支草稿，数字只适用于报告记录的源码快照。完整产品冷构建尚无同条件前后对照，不能把单包结果当作完整产品提速。

2026-09-24 在 macOS aarch64、Rust 1.98.0、`dev` profile、六个 Cargo 任务和离线依赖缓存下，对 `ash-app-server-protocol` 各使用三个独立空目标目录测量。源码位于同一工作区，目标目录位于本机内置磁盘。协议包原先只为 `PreparedFeedback` 类型依赖整个反馈服务，使 HTTP/TLS 构建进入关键路径；把该类型移入独立的反馈契约包后，协议包不再编译 `ash-client`、`ash-http-client`、`reqwest` 和 `aws-lc-sys`。冷构建中位数从 89.55 秒降至 69.27 秒（减少 22.6%），其中原先单次 `aws-lc-sys` 构建步骤耗时 46.5 秒。无改动重跑中位数为 0.91→0.75 秒；在协议注册表文件末尾临时加入注释触发重编译的中位数为 3.87→4.05 秒，这项注释编辑仅验证增量失效范围，不代表实际功能编辑。`time` 报告的最大 RSS 为 1.33→1.36 GB，协议 `.rlib` 均约 52 MiB；一个测量目标目录从 1.81 降至 1.55 GiB。完整产品构建耗时未由这组包级测量推断。

同日在 macOS aarch64、Rust 1.98.0、`dev` profile、四个 Cargo 任务、`CARGO_INCREMENTAL=0` 和相同源码下，分别用三个独立空目标目录对照普通构建与已预热的本机 sccache 0.16.0。协议包空目标目录构建中位数为 66.03→47.88 秒（减少 27.5%），无改动重跑为 0.72→0.80 秒，触碰 `lib.rs` 时间戳后的重编译为 19.97→1.86 秒；后者复用了内容未变的编译结果，不代表修改代码后的重编译速度。两组包产物合计均为 85,773,398 字节。`time` 的最大 RSS 不覆盖独立运行的 sccache 服务，不能据此判断总内存变化。GitHub Actions 缓存和整个 CI 作业的耗时尚未由这组本机包级测量验证。

同日对 `Rust checks and build performance` 的协议默认配置步骤做了三组交错顺序的完整命令对照。测量使用提交 `e6c4c14b6` 的独立检出、macOS aarch64、Rust 1.98.0、四个 Cargo 任务、`CARGO_INCREMENTAL=0`、离线依赖、每轮独立空目标目录，并关闭 sccache。原顺序 `check → test → rust-warnings` 分别用时 226.33、220.13、177.04 秒；去掉被 `rust-warnings --all-targets` 覆盖的 `check` 并先运行 warning 检查后，分别用时 188.91、145.92、139.26 秒。总耗时中位数为 220.13→145.92 秒，但各轮负载有波动；按交错配对，节省时间分别为 37.42、74.21、37.79 秒。原 `check` 自身耗时中位数为 38.59 秒；测试各轮均有 57 项通过。目标目录大小中位数为 1,321,928→1,055,728 KiB，测试步骤的最大 RSS 中位数为 2.25→2.25 GB；单个测试产物大小未单独测量。追踪作业和协议 `export` 配置的重复 `check` 同样被各自的 `rust-warnings --all-targets` 覆盖，未做单独耗时对照。这组本机无 sccache 的数据不代表 GitHub runner 启用 sccache 后的实际作业耗时。

2026-09-25 在 Windows x86_64 MSVC、Rust 1.98.0、`dev-small` profile、16 个 Cargo 任务、依赖源码已缓存的条件下，对 Code 的三个程序使用独立空目标目录各测三轮。`--workspace --bin ...` 与显式 `--package/--bin` 的完整冷编译中位数为 601.48→557.29 秒（减少 7.3%）；单次配对有反向波动，不能把每轮差值都归因于包选择。Cargo 时间线显示 `windows` 包的特性数从 80 降到 65，编译耗时中位数从 135.0 降到 86.2 秒。无改动重跑中位数为 2.95→3.56 秒；仅触碰 TUI 源码触发重编的中位数为 12.79→12.00 秒，这项触碰只用于确认增量失效范围。

在显式选包基础上，Windows Code 构建改用 Rust 工具链自带的 `rust-lld`。三次独立冷编译为 503.16、507.59、521.97 秒；相对于上一组的冷编差异包含机器负载波动，不能全归因于链接器。对同一处 TUI 文案做三轮实际源码编辑，原链接器与 `rust-lld` 的重编中位数为 11.31→7.84 秒（减少 30.6%），其中 `ash.exe` 链接单元约为 7.21→3.66 秒；无改动重跑中位数为 1.23→1.21 秒。三个程序的产物约为 165.12/151.12/52.37 MiB → 164.50/150.52/51.39 MiB。Windows 手工测量未采集进程树最大 RSS；其他平台未测链接器改动，因为该设置仅用于 Windows x86_64 的 Code 源码构建。

## 构建源码与仓库脚本边界

`build/` 按产品宿主、共享后端和交付物划分。前端 Node 构建逻辑使用 TypeScript；共享后端构建、下载与组包使用 Python。开发与正式发布共用后端包布局和校验实现；发布顺序、凭据注入和上传由 `.github/workflows/` 编排。`just build-code`、`just build-desktop` 和 `just build-app` 分别构建产品宿主；`just build` 聚合这三个入口。完整共享包由 `just ash-package` 单独组装，根 Cargo workspace 的完整构建保留在显式的 `just build-rust`。

| 路径 | 单一职责 |
| --- | --- |
| `build/lib/` | 后端构建共用的归档、签名、Cargo、目标识别和 V8 输入 |
| `build/app_ts/` | Electron Main、Preload、Renderer 和 Web 的 TypeScript 构建与开发启动；监听后端文件变化、调用后端构建入口并读取共享包位置 |
| `build/protocol/` | 将 Rust 生成的协议契约同步给 TypeScript 消费方 |
| `build/app_ts/launch/electron.ts`、`build/app_ts/launch/web.ts` | Electron 启动与重启、本地 Web 静态服务启动 |
| `app-ts/src/ash/platform/app-server/node/` | WebSocket 连接、共享 JSONL 进程传输；由启动方提供工作区、配置目录和可执行文件路径 |
| `build/pnpm/` | pnpm 版本约束、安装入口和单锁文件 workspace 校验 |
| `build/ash_rs/` | Python 实现的共享后端构建：Cargo 程序与协议生成、开发态 App Server 代次、锁定资源、开发包和发布包组装、布局校验及签名记录 |
| `build/app_rs/` | Rust Desktop 组包、签名与远端运行时 bundle 交付 |
| `build/code/` | Code 构建、运行、组包、归档与安装脚本 |
| `build/darwin/` | macOS 签名命令和公证 |
| `build/win32/` | Windows 签名命令 |
| `build/linux/` | Linux 分离签名命令 |
| `build/download/` | Python 后端构建共用的校验下载与解压 |
| `build/resources/` | 共享资源生成 |
| `build/clean.ts` | 根清理入口 |
| `build/package.json`、`build/tsconfig.json` | 构建工具的 TypeScript 测试和类型检查 |

`.build/app-ts/` 是产物目录，按 `main`、`preload`、`renderer`、`node` 等运行目标存放输出。`.build/cargo/` 仍是统一 Cargo 输出目录；相同 profile 的公共依赖会复用。Code 的 `dev-small` 与 App 的默认开发 profile 分别拥有首次编译产物。
`build/app_ts/build.ts` 提供 `all`、`host`、`renderer` 和 `prepare` 入口；`host.ts` 用一次 TypeScript 项目构建编译并监听 Electron Main 与 Preload，增量构建信息放在 `.build/app-ts/`；`watch-app-server.ts` 负责后端监听。启动脚本调用构建能力，构建模块不反向调用启动脚本。

`app-ts` 的开发入口调用 `build/ash_rs/prepare.py` 准备共享包，使用 `build/app_ts/runtimeStore.ts` 读取已发布包的位置。`build/app_ts/appServer.ts` 监听 Rust 修改；`build/protocol/generate.ts` 调用 `build/ash_rs/protocol.py` 生成 Rust 协议文件后同步前端契约，再调用 `build/ash_rs/develop.py` 构建后端程序并发布可热重启的 App Server 代次。Cargo 执行、后端程序复制、资源下载、共享包布局和签名规则只由 Python 持有；TypeScript 负责前端编译、监听和开发进程生命周期。`build/app_rs/`、`build/code/` 和 `build/app_rs/remote/` 以验证过的共享包为输入，仅添加各自交付物；共享包的文件清单和校验由 `build/ash_rs/` 负责。

Web 连接实现编译到 `node` 输出后，由 `build/app_ts/launch/web.ts` 或 Vite 插件加载。两者提供开发包路径和运行配置；连接实现不读取仓库构建目录。
`ws` 属于 `app-ts` 的运行依赖，静态服务器使用的 `sirv` 属于根脚本的开发依赖，共用根锁文件。

### 共享包组装

音频通话通过 Cargo 管理的 LiveKit Rust SDK 接入。音频通话包包含 `ash-voice-host`、`ash-collaboration-server` 和独立 LiveKit Server 程序；Go 工具链不随产品分发。设备助手以 `ash-voice-host/host` feature 构建；Linux 构建机需要 ALSA 开发文件。

LiveKit Server 的版本、来源与 SHA-256 位于 `third_party/livekit/runtime-lock.json`。开发和发布共用 `build/ash_rs/livekit.py`：Linux／Windows 下载并校验上游程序；macOS 下载并校验源码，仅在忽略的构建缓存中解压、编译并清理，不将 Go 源码纳入仓库。macOS 构建机需要 PATH 中的 Go 1.26 工具链和系统 C/C++ 工具链。LiveKit 的 LICENSE、NOTICE 与 SFU 版权声明随包保留。更新方式见 [LiveKit Server](../third_party/livekit/README.md)。

开发入口 `build/ash_rs/prepare.py` 与发布入口 `build/ash_rs/build.py` 共用 `build/ash_rs/layout.py` 组装包，布局与许可证清单由 `layout.json` 声明。组装器要求调用方显式传入受版本控制的协议元数据，不读取前端本地生成文件。开发和发布不再通过 Node 调用另一套组装器。

后端下载与解压由 `build/download/artifacts.py` 提供。Node、ripgrep、V8 和 LiveKit 输入通过摘要校验后进入缓存；下载使用独立临时文件，失败只清理本次临时文件。开发入口复用已校验的缓存产物。

打包入口按交付物定位：`build/ash_rs/build.py` 产出不含 CLI 的共享运行时，`build/code/package.py` 将 `ash` 命令加入经过验证的运行时包，`build/code/archive.py` 将 Code 包归档；`build/app_rs/build.py` 和 `build/app_rs/remote/bundle.py` 分别负责 Rust 桌面端与远端运行时。共享包签名使用 `build/ash_rs/sign.py`，App 签名使用 `build/app_rs/signing.py`，macOS 公证使用 `build/darwin/notarize.py`。

各 Python 入口可用 `python3 -B <脚本路径>` 直接运行，Windows 使用 `python -B <脚本路径>`；模块导入从 `build` 下的所属目录开始。测试放在对应职责目录，`just test-python build` 统一发现并运行。各目录的 `BUILD.bazel` 声明自身工具和直接依赖。

共享发布包先收集未提供预编译文件的第一方程序，再用一次 Cargo 调用构建并读取其报告的可执行文件路径。Code 与 Rust Desktop 都以验证过的共享包为输入，加入各自的程序并重算整包清单；`app-package` 必须传入 `--runtime-package`。签名凭据由环境变量提供，系统签名覆盖共享运行时内的全部可执行程序。

### 仓库脚本与开发运行

`scripts/` 根目录保存跨产品仓库工具：`cargo.py` 为整个 Cargo workspace 准备锁定的构建输入，`format.py` 统一已有格式化器，`test-python.py` 支持 `scripts`、`code`、`build` 定向测试；不指定范围时运行 `scripts` 和 `build`，其中 `build` 已包含 Code 测试。`build/app_ts/launch/` 保存 Electron 和 Web 的运行入口与入口测试；它调用 `build/app_ts/` 的构建和运行准备能力，不持有前端编译规则或共享后端组包规则。

Desktop 的 Node、Browser 和 Playwright 测试入口与 loader 归 `app-ts/test/`，根 `package.json` 直接调用 `app-ts` 的公开测试命令。`build/code/` 保存 Code TUI 的源码运行、完整开发包运行和公开安装脚本。`app` 当前没有独立运行入口，因此不创建空占位文件。

`build/code/build.py` 用一次 Cargo 调用构建 Code TUI、本地 App Server 和当前平台沙箱程序，并从 Cargo 的构建报告取得可执行文件路径。`build/code/run.py` 调用其中的暂存能力，把可执行文件放入按内容区分的 `.build/code/dev/` 目录后启动；这个小目录避免 Windows 上仍在运行的程序阻塞下一次构建，不是产品包。独立运行 `build/code/build.py` 只编译。技能、扩展和产品服务直接读取源码。`build/code/run_package.py` 只服务于显式的完整开发包运行。

完整开发包仍由 `build/ash_rs/prepare.py` 拥有。它在一次 Cargo 调用中构建全部第一方程序；可执行文件和包输入没有变化时直接复用已发布的完整包，有变化时才复制并校验受管资源、计算整包摘要，再通过 Package Store 发布不可变代次。日常 `just ash` 不执行这些组装与发布步骤；只有验证包布局、跨产品交付、回滚或远端运行时边界时才使用 `just ash-package` 或 `just ash-package-run`。Cargo 并发由 Cargo 自己决定；开发者仍可按需显式设置 `CARGO_BUILD_JOBS`。

仓库级 `scripts/` 可以调用 `build/` 公开的构建准备能力，`build/` 的生产模块不得导入或执行 `scripts/`；同仓测试和类型检查覆盖两者。产品启动入口与构建能力放在同一产品构建目录，启动入口调用构建模块，构建模块不反向调用启动入口。包组装由 `build/ash_rs/` 拥有；共享目标识别和 V8 输入解析由 `build/lib/` 拥有，日常 Cargo 命令与发布构建器都依赖这一层。测试内容和 fixture 仍归对应产品目录拥有，仓库脚本只负责跨产品命令入口、进程编排和临时测试输出生命周期。

### 根配置与工具语言

根 `Justfile` 只声明稳定命令并委托到 `build/`、`scripts/` 或产品自身的构建入口，不保存构建机制。根 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 必须留在仓库根，因为它们是 pnpm 发现 workspace 和执行 Node 命令的协议文件；安装策略与校验实现由 `build/pnpm/` 拥有。`build`、`scripts` 和 `app-ts` 共用根锁文件与 TypeScript 版本，pnpm 内容寻址 store 使用用户级默认缓存，子项目不得再声明独立 `packageManager`、`pnpm` 策略或 npm 锁文件。

同理，`.bazelrc`、根 `BUILD.bazel`、`.cargo/config.toml` 和 `tsconfig.base.json` 是对应工具从仓库根发现的协议文件，不能为了让 `build/` 看起来更大而移动。文档站框架配置、内容生成、打包和验收全部归独立的 `ash-docs` 仓库。

前端构建与 Node 工具使用可擦除语法范围内的 TypeScript（`.ts`），由当前 Node.js 直接执行；后端构建、资源下载、包组装和发布使用 Python。`build/resources/icons/` 是共享 SVG 的生成入口，分别生成 Rust 和 TypeScript 资源，不持有运行时组包逻辑。`build/tsconfig.json` 检查 Node 构建工具，`build/app_ts/vite/stanza/tsconfig.json` 检查浏览器中的 Stanza 开发入口；`scripts/pyproject.toml` 和 `scripts/uv.lock` 锁定 Python 仓库工具。

`app-ts/` 只保存产品源码、测试内容和产品清单；构建、资源生成、下载与发布逻辑由根 `build/` 拥有，跨产品测试和维护编排由根 `scripts/` 拥有。Renderer、Workbench 和平台服务不得拥有构建工具配置或仓库操作入口。

旧的 `target/`、`app-ts/dist/`、`app-ts/output/`、`app-ts/.tmp/` 和根 `output/` 仍保留忽略规则，只为防止旧工具或旧分支重新提交这些产物；当前命令不得再写入这些路径。
