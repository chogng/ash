# 构建与开发

本文说明环境准备、产品构建、验证和缓存清理。Electron、Browser、Stanza 的启动模式、热更新和前端测试见 [前端开发](frontend.md)；产品关系见 [产品线](product-lines.md)。

## 构建入口

以下命令均在仓库根目录执行。工具版本以仓库配置为准：

| 工具          | 版本来源                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Rust          | [`rust-toolchain.toml`](../rust-toolchain.toml)                                                               |
| Git           | [共享 Git 最低版本要求](../crates/git/README.md#git-版本要求)                                                 |
| Node.js       | [`.nvmrc`](../.nvmrc)；pnpm 使用 [`package.json`](../package.json) 中的 `devEngines.runtime` 自动获取固定版本 |
| pnpm          | 根 [`package.json`](../package.json) 的 `packageManager`，安装方法见[初始化](#初始化)                         |
| Python        | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `requires-python`，建议 3.12                         |
| uv            | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `tool.uv.required-version`                           |
| Just          | [`.just-version`](../.just-version)，安装对应版本并确保 `just` 在 PATH 中                                     |
| Bazel（按需） | Bazelisk 读取 [`.bazelversion`](../.bazelversion)                                                             |

### macOS 与 Linux 开发环境

macOS 架构支持范围见 [Getting started](../README.md#getting-started)。

安装 Rust、Just、仓库要求的 uv 和 Python 3.11 及以上版本。首次初始化使用 PATH 中的 `python3`；确认 `python3 -c 'import tomllib'` 成功。macOS 自带 Python 可能不满足要求，可用 `uv run --python 3.12 just install` 初始化；Apple Silicon 上的 Homebrew Python 3.12 也可将 `/opt/homebrew/opt/python@3.12/libexec/bin` 放在 PATH 前部。初始化后，Just 和前端构建入口优先复用 `scripts/.venv`，日常启动无需再包装 `uv run`。

准备完整后端包时，macOS 还需要 Go 1.26 和系统 C/C++ 工具链来构建 LiveKit Server，见 [LiveKit Server](../third_party/livekit/README.md)。Linux 的完整后端构建需要 ALSA 开发库；沙箱构建需要 C 编译器和 libcap，见 [共享包构建](../build/README.md)。

### Windows 开发环境

安装下列工具后，使用对应目标架构的 **Visual Studio Developer PowerShell** 构建。已安装的 Ash 产品不依赖这些开发工具。

| 工具                         | 安装要求                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual Studio Build Tools    | 2022 / MSVC v143，选择“使用 C++ 的桌面开发”和 Windows SDK                                                                                                                               |
| Visual Studio English 语言包 | 在 Installer 中补装，避免中文链接器进度被 Rust 误报为 warning                                                                                                                           |
| PowerShell 7                 | 支持 `-CommandWithArgs`；`just install` 可通过 winget 安装缺失的工具                                                                                                                    |
| Python                       | `python` 命令指向满足仓库要求的版本                                                                                                                                                     |
| uv                           | 安装 `scripts/pyproject.toml` 要求的版本并加入 PATH                                                                                                                                     |
| Git、ripgrep、CMake          | 安装并加入 PATH                                                                                                                                                                         |
| LLVM/Clang                   | Visual Studio Installer 中安装 C++ Clang tools，或安装完整 LLVM；符号测试需要 `llvm-pdbutil.exe`、`llvm-symbolizer.exe`。自定义安装路径时，`LIBCLANG_PATH` 指向含 `libclang.dll` 的目录 |
| Bazelisk（按需）             | 运行 Bazel 测试前，将 `BAZEL_SH` 设为 Git Bash 路径                                                                                                                                     |

无需全局设置 `CC`、`CXX`。Windows 桌面构建和平台验证在 Windows 上完成；Dev Container 用于 Linux 开发。

Windows x64 的 Cargo 链接默认使用 Rust 工具链自带的 `rust-lld`；MSVC 和 Windows SDK 仍用于 C/C++ 依赖与系统库。配置位于 `.cargo/config.toml` 的 `target.x86_64-pc-windows-msvc`，与其他平台共用源码和开发入口。首次切换链接器会使 Cargo 重建受影响的缓存；后续编辑复用增量产物。Windows ARM64、macOS 和 Linux 保留各自原有配置。按目标选择链接器的规则见 [Cargo 配置文档](https://doc.rust-lang.org/stable/cargo/reference/config.html#targettriplelinker)。

### 初始化

1. 使用 [pnpm 独立安装方式](https://pnpm.io/installation/)，安装根 [`package.json`](../package.json) 的 `packageManager` 指定版本。仓库安装检查要求版本一致。
2. 执行 `pnpm install`，安装 Node workspace 依赖。
3. 执行 `just install`，先检查 Rust 和当前平台的符号工具，再获取 Cargo 依赖并通过 uv 同步 `scripts/uv.lock` 中固定的 Ruff 和 codespell 到 `scripts/.venv`。Windows 缺少 PowerShell 7 时，此步骤会安装它；随后重启终端和编辑器以更新 PATH。

可单独运行 `just check-build-tools` 检查工具路径和可执行性；全量 `just test-python build` 和默认 Python 测试入口会在任何测试开始前执行同一预检，一次列出全部缺失或不可用的工具。Windows 自动发现 PATH、标准 LLVM 安装目录及 `vswhere` 返回的 Visual Studio LLVM 目录，按宿主架构选择工具，无需为了交叉编译改用目标架构工具。自定义 LLVM 可设置 `ASH_LLVM_BIN` 指向其 `bin`。Linux 符号测试需要 `llvm-nm`、`llvm-objcopy`、`llvm-strip`、`llvm-dwarfdump`、`llvm-symbolizer`（Debian/Ubuntu 可安装 `llvm`）；macOS 使用 Xcode 命令行工具，并检查 LLDB 的 Python 支持。

直接执行 `node` 时使用 `.nvmrc` 指定版本；pnpm 脚本使用仓库固定的 Node。Just 和 Node 启动的 Python 构建工具优先使用初始化创建的 `scripts/.venv`。Node 入口可用 `PYTHON` 显式指定解释器，Just 可用 `just --set python <解释器路径> <命令>` 覆盖；尚未初始化时，Just 使用 Windows 的 `python` 或其他平台的 `python3`。

Python 工具依赖只在 [`scripts/pyproject.toml`](../scripts/pyproject.toml) 声明，解析结果及下载哈希由提交的 [`scripts/uv.lock`](../scripts/uv.lock) 保存。修改依赖后执行 `uv lock --project scripts`，再运行 `just install-python`。安装入口和 CI 都使用 `uv sync --locked`；声明与锁文件不一致时失败，不自动改写锁文件。同步复用选定的 Python，不下载其他解释器，也不从源码构建依赖。

pnpm 根据 `devEngines.runtime` 下载并使用固定的 Node 版本，通常不需要单独安装 Node。`pnpm install` 可在 PowerShell 与 Bash 中执行。运行 Electron 或 Browser Workbench 前需要前端依赖；只开发 CLI/TUI 时按所需 Rust 工具和后端资源准备环境。

### 项目命令

#### 启动

| 产品                 | 命令            | F5 配置          |
| -------------------- | --------------- | ---------------- |
| 完整 Electron 桌面端 | `just ash`      | `Ash`            |
| 终端界面             | `just ash-code` | `Ash Code (TUI)` |

仅前端、只监听前端、完整 Web 和独立编辑器的区别及对应命令见 [前端启动方式](frontend.md#启动项目)。

#### Rust 模块与叶函数热更新实验

`ash-build` 是 Ash 自有的开发构建器，当前覆盖无状态的 `ash-app-server-diff` 适配器及其中一个登记的标量叶函数 `zero_based_line_index`。完整模块使用当前固定的 Cargo/rustc 检查和增量构建；符合限制的函数体修改会提取成无第三方依赖的临时 crate，由同一 Cargo/rustc 单独检查和编译。不需要安装或运行 rust-analyzer。构建器尚未接入通用函数语义分析、MIR 失效跟踪或 Cranelift JIT，不能当作 ra-jit 的等价替代；独立分析能力见下方桥接入口。

在启动 Electron 开发实例的同一终端设置独立目录，例如 Windows PowerShell：

```powershell
$env:ASH_RUST_LIVE_DIRECTORY = "$PWD\.build\desktop\dev\rust-live"
just live-build
pnpm dev
```

正常开发构建会启用 App Server 的 `rust-live` feature。此路径还要求 `debug_assertions`，默认 release 配置不编入装载路径。未设置环境变量时保留普通构建流程；退出实验时移除该变量并重新执行正常开发准备。

Electron Rust watcher 仅把 `crates/app-server-diff/src/` 内的 `.rs` 修改交给模块构建器；共享 diff 算法、其他 crate、协议和 Cargo 清单修改仍执行普通后端构建。已有完整构建失败时，后续模块保存也必须先重试该完整构建。Web watcher 保留原来的构建与选择流程。

初始化和 `just live-build` 建立完整模块基线。watcher 的适配器保存会请求常驻 `ash-build` 的函数路径，并通过独立的未修改 RA 桥接更新内存源码、检查类型／布局和 MIR：仅当其余源码、清单、工具链、模块代次以及函数签名和行／列占位保持一致时，单独编译该函数。当前支持参数、整数／布尔字面量、基本运算、条件表达式及列出的 `usize` 饱和／环绕算术方法；局部绑定、宏、外部名字、扩展方法、泛型和其他函数均回到完整模块编译。布局变化也保守回退，以免改变后续 `line!()`／`column!()` 的值。一次性 Python `--functions-only` 参数也通过相同桥接，但每次重载 RA；watcher 使用 `--serve` 复用分析库。依赖／协议保存关闭旧会话后执行完整构建，退出 watcher 通过 EOF 释放子进程及缓存租约。

函数 DLL 只交换 `usize` 和状态码，按完整模块的独立代次隔离。每次 diff 请求选择一次函数镜像，所有行和 hunk 使用同一代；编译错误保留上一版本，函数 panic 则用模块原生实现重新计算整个请求。编译器相关的语法与 TOML 依赖只在 `ash-dev-build` 的 `compiler` feature 下启用，宿主仅依赖装载器。生成 crate 复制实际 `dev`／`dev-small` 配置及 diff 包覆盖值，复用工作区 Cargo 配置中的目标、链接器、CRT 和缓存；自定义编译器／flags 等环境覆盖会保守回到完整模块。

模块通过版本化 C ABI 传递有界 JSON 字节，宿主同步复制返回内容，双方各自释放自己的 Rust 分配。模块发布在协议 schema hash 隔离的目录中，用内容摘要命名 DLL／动态库，校验可装载性和 ABI 后原子更新 `current.json`；借用检查或其他编译错误不会前移指针。请求持有当前模块的引用，更新时旧请求可以完成，之后的新请求使用新模块。加载异常保留上一可用模块；没有可用模块时使用宿主编译时的适配器并记录原因。

模块与函数对象暂不自动回收，清理实验发布目录前先退出加载它的开发宿主。构建产物继续使用现有 Cargo 缓存租约和预算，保持当前静态 CRT、链接器和 profile 参数。本地 ra-jit 提供了失效边界、不可变产物和运行时替换的设计参考；该实现未复制或依赖其 rust-analyzer 分支，也未改动本地 ra-jit 检出。

#### 未修改 rust-analyzer 的分析桥接

`just analyze-rust <源路径> <UTF-8 字节偏移>` 通过独立进程调用上游 `ra_ap_* = 0.0.358`，不依赖 ra-jit 分支。已在真实 Ash 工作区验证函数、类型、布局、结构化 MIR 摘要、引用、声明宏及内存增量分析；过程宏和生成源码通过独立 Cargo fixture 验证。`ash-build` 已将桥接用于已注册标量函数的编译准入；机器码继续由 rustc 生成。使用、JSON 协议和能力缺口见 [Rust 分析桥接](rust-analysis.md)。

#### 构建与维护

| 命令                                              | 结果                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `just build`                                      | 构建两个产品及其开发所需服务程序                                           |
| `just build-code` / `just build-ash`              | 构建指定产品                                                               |
| `just build-rust`                                 | 构建根 Rust workspace                                                      |
| `just check <package>`                            | 检查指定 Rust 包                                                           |
| `just lint`                                       | 检查 Python 代码                                                           |
| `just spellcheck`                                 | 检查仓库源码和文档中的常见英文拼写错误                                     |
| `just fmt` / `just fmt-check`                     | 调用各语言工具，格式化或检查 Just、Rust、Python、TS/JS、配置与文档         |
| `just fmt <路径...>` / `just fmt-check <路径...>` | 只格式化或检查指定的仓库文件或目录                                         |
| `just fmt-check --changed <base-ref>`             | 检查相对基准分支共同祖先的提交、暂存、未暂存及未跟踪文件改动               |
| `just rust-format` / `just rust-format-check`     | 单独格式化或检查 Rust，不需要前端依赖                                      |
| `pnpm format:ts` / `pnpm format:ts:fix`           | 检查或格式化第一方 TS/JS；可追加文件或目录                                 |
| `pnpm format:config` / `pnpm format:config:fix`   | 用 Prettier 检查或格式化 JSON、YAML、Markdown、CSS、HTML                   |
| `pnpm format` / `pnpm format:fix`                 | 检查或格式化上述前端源码、配置与文档                                       |
| `pnpm typecheck:build`                            | 检查 TypeScript 构建工具                                                   |
| `pnpm stylelint`                                  | 只读检查生产 CSS 的变量和选择器，报告文件、行和列；可追加文件、目录或 glob |
| `pnpm hygiene`                                    | 检查 CSS 变量和选择器，再用前端单测验证变量清单与注册表一致                |
| `pnpm stylelint:update`                           | 用真实颜色、尺寸注册表更新变量清单，保留组件变量；审阅生成差异后再检查     |
| `pnpm clean`                                      | 清理本地产物和 Python 缓存                                                 |

格式化工具按语言选择：TS/JS 使用 [`tsfmt.json`](../tsfmt.json)，Rust 使用 [`rustfmt.toml`](../rustfmt.toml)，Python 使用固定版本 Ruff，配置与文档使用 [Prettier](../.prettierrc.toml)。前端与 Rust 格式化入口只处理第一方源码；检查命令不修改文件。修改后优先检查受影响的文件，完整格式检查见 [Formatting CI](../.github/workflows/format.yml)。

增量入口复用上述格式化器和排除规则；Rust 按文件读取，不递归格式化其他模块。提交前显式运行检查并修复所需文件，CI 保留全仓格式检查。Just 版本不符时检查会明确失败，本地和 CI 都读取 `.just-version`。修改格式规则后执行全仓检查。

`just spellcheck` 使用固定版本 codespell，扫描范围和允许词分别由 [`.codespellrc`](../.codespellrc)、[`.codespellignore`](../.codespellignore) 维护。`pnpm stylelint` 检查生产 CSS 的变量与选择器；更新变量清单使用 `pnpm stylelint:update` 并审阅差异。

验证完整开发包时使用 `just ash-package`，需要让 Code TUI 运行该包时使用 `just ash-package-run`。日常 `just ash-code` 只准备源码运行所需程序。

### 测试

| 命令                                            | 覆盖范围                                                 |
| ----------------------------------------------- | -------------------------------------------------------- |
| `just test <package>`                           | 指定 Rust 包                                             |
| `just test-processes <package> --test <target>` | 独立运行指定进程集成测试，支持多个 `--test` 和测试名过滤 |
| `just test-tui-unit <filter>`                   | TUI 库单测，默认使用 `ci-test`                           |
| `just test-tui <filter>`                        | 真实 CLI/TUI PTY 场景，服务程序与测试统一使用 `ci-test`  |
| `just test-python` / `just test-python build`   | 全部仓库 Python 测试，或仅构建工具测试                   |
| `pnpm test`                                     | Rust 协议验证、构建工具检查和前端单测                    |
| `pnpm test:build`                               | TypeScript 构建工具单测                                  |

Electron、Browser、编辑器的构建和测试命令，以及测试是否启动 App Server，见 [前端验证命令](frontend.md#常用命令)。

#### 提交前本地验证与 CI

交付前在当前平台完成受影响范围的必要验证；已有诊断和通过结果覆盖当前输入时直接复用，无需为提交或推送重复构建。Rust 按所属包及受影响消费者使用下方的 `just verify`，可用 `--lib`、`--test <target>` 和 `--filter <test-name>` 缩小测试范围；前端按改动选择已有类型检查、构建以及按文件或场景过滤的测试入口。完整 workspace 回归与跨平台 CI 矩阵由远端工作流执行；本地全量复现仅在明确要求时运行。预计长时间验证前按 [测试规范](../.github/instructions/testing.instructions.md#learnings) 确认范围。

推送后，[已配置的 CI](#ci-检查) 继续验证提交的代码及对应平台、工作流环境。Windows 本地结果不代表 Linux 或 macOS 通过；本地执行构建、测试命令也不代表 GitHub 上的调度、权限、签名或上传流程已通过。工作流是否触发及覆盖哪些目标，以其事件和路径条件为准。

交付说明列出实际执行的命令、平台和结果。剩余验证应注明具体工作流或作业、平台或目标及本地无法覆盖的原因；缺少依赖或既有失败造成的阻塞也要明确说明。完整要求见 [测试规范](../.github/instructions/testing.instructions.md#本地结果与-ci-覆盖)。

#### 固定开发步骤

以下入口由 [`scripts/workflow.py`](../scripts/workflow.py) 组织现有命令：

| 命令                           | 完成的步骤                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `just context <file>`          | 列出所属 Cargo 包、适用规范与引用的 skill                                                          |
| `just verify <package>`        | 使用同一 `ci-test` profile 执行包级 `check`、`test`、`rust-warnings`；失败或没有通过任何用例时停止 |
| `just snapshot <path.snap>...` | 定位所属 TUI 测试并按组运行；展示待审阅差异，有待审阅基线时返回非零退出码                          |
| `just snapshot --pending`      | 汇总 TUI 的 `.snap.new`，按测试分组复跑并展示差异                                                  |

`verify` 支持 `--lib` 或可重复的 `--test <target>`、`--filter <test-name>`、`--features <features>` 和 `--profile <profile>`；目标选择与过滤条件只传给测试，feature 与 profile 传给三个步骤。`verify` 和 `snapshot` 支持 `--plan`，只解析并展示命令，不编译或运行。路径可以使用仓库根目录下的相对路径或绝对路径。

只有 trait 契约或测试设施、由消费方覆盖行为的包，可以在自己的 Cargo 清单中声明
`[package.metadata.ash.verify]` 的 `test-packages` 列表。例如 `ash-core-api` 声明 `["ash-core"]`，
`ash-http-test-support` 声明三个共用 HTTPS 设施的消费方：check 和 warning 检查仍检查所属包，
测试按声明顺序运行消费方的真实行为用例。列表必须非空、名称不能重复，全部消费方必须属于
当前 workspace；测试过滤、feature 和 profile 同样应用到每个消费方，任何一套测试失败或
零通过用例都会停止验证。不声明该字段时测试所属包。

```sh
just context crates/tui/snapshots/fullscreen/composer/composer_focused.snap
just snapshot crates/tui/snapshots/fullscreen/composer/composer_focused.snap
just snapshot --pending --plan
just verify ash-utils-home-dir --lib
```

`snapshot` 覆盖 `crates/tui/snapshots/` 下由带字面量名称的断言生成的外部快照，接受 `.snap` 和 `.snap.new`，同一测试只运行一次。动态名称、共享 helper 中的断言和真实 PTY 快照使用所属测试入口。需要进程内 App Server 时传入 `--features in-process-tests`。运行生成 `.snap.new`，不直接覆盖基线。

按 [test-tui](../.agents/skills/test-tui/SKILL.md) 逐份审阅后，显式列出要接受的具体文件：

```sh
just snapshot crates/tui/snapshots/fullscreen/composer/composer_focused.snap --accept
```

`--accept` 必须显式列出已审阅文件，不能与 `--pending` 同用；接受后按组复跑测试。其他待审阅文件保留；目录中还有 `.snap.new` 时返回非零退出码并列出路径。

Windows Cargo 的测试 Job 禁止子进程脱离。验证共享 App Server 独立于启动者存活时，使用 `just test-processes ash-app-server --test managed_lifecycle`，先由 Cargo 编译，再独立运行测试程序。此入口只接受显式选择的集成测试；普通测试使用 `just test`。

修改 TUI 后先运行受影响的单测，需要验证真实进程、终端信号或恢复时再运行 PTY 场景：

```sh
just test-tui-unit session_manager
just test-tui actual_tui_process_interrupts_an_inflight_http_stream
```

涉及进程内 App Server 的会话测试需显式启用功能：`just test-tui-unit conversation_flow_tests --features in-process-tests`。两个入口都可用 `just --set tui_profile <profile> ...` 覆盖配置；PTY 入口的服务程序和测试会一起切换。首次构建服务程序仍需时间。日常启动验证用 `just build-code`，使用 `dev-small`。

同一轮验证按单测、必要的 PTY 场景、warning 检查顺序运行；不要同时启动这些 Cargo 任务。`test-tui-unit` 和 `test-tui` 复用 `.build/cargo` 中同配置的产物，并发运行仍会等待 Cargo 构建锁。

#### UI 场景录屏

场景录屏需要带 `drawtext` 滤镜的 FFmpeg：macOS 使用 `ffmpeg-full` 并将其 `bin` 加入 PATH，Windows 可安装 `Gyan.FFmpeg`，Linux 可安装 `ffmpeg`。运行方法和证据目录见 [前端 UI 场景录屏](frontend.md#ui-场景录屏)。

#### Bazel TUI 场景测试

运行迁移后的 CLI/TUI 场景：

```sh
bazel test //cli:tui-real-scenarios --test_output=errors --test_env=PATH
```

`--test_env=PATH` 将固定版本 Node 的路径传给测试进程。`//cli:tui-real-scenarios` 运行同一组 CLI/TUI PTY 场景；先将锁定的 `rg`、`tgrep` 路径设为 `ASH_RG_PATH`、`ASH_TGREP_PATH`。Linux CI 无法运行的真实沙箱场景由 macOS 作业覆盖。

Linux 构建需安装 `pkg-config` 和 `libwayland-dev`。Bazel 只导入宿主的 Wayland client 共享库，不把 pkg-config 返回的整个系统库目录加入链接路径，避免宿主 libc 覆盖固定工具链的 libc；运行时仍由操作系统提供 Wayland。

### Dev Container：Linux Desktop、Web 与后端

安装 Docker 和 VS Code Dev Containers 扩展，执行 **Dev Containers: Reopen in Container**。配置见 [`.devcontainer/`](../.devcontainer)，首次创建需联网安装工具、项目依赖、Chromium 和后端资源。

镜像基于 Debian 13（trixie），保留仓库固定的 Node、Rust 和 Just，并从官方镜像安装与 `scripts/pyproject.toml` 一致的 uv；LLVM 包含构建预检所需的符号工具，Zenity 及 AT-SPI 提供 Web 服务端工作区审批的原生对话框和 GTK 无障碍运行环境。系统 Git 须满足[共享最低版本要求](../crates/git/README.md#git-版本要求)。切换基础系统后重新执行 `sh .devcontainer/post-create.sh`，让旧 Python 环境卷按新系统解释器重新同步。

在容器终端执行 `just ash` 启动 Electron，在宿主机打开转发的 6080 端口，使用 VNC 密码 `vscode` 查看桌面。容器启用 `privileged` 并配置 Electron 沙箱权限；依赖和产物使用容器卷，与宿主机隔离。`/dev/shm` 配置为 1 GiB：Chromium 并发加载本地 Renderer 模块和样式时会占用共享内存，Docker 默认的 64 MiB 会导致 `net::ERR_FAILED`。修改该配置后须重建容器。手动创建测试容器时保留 `--shm-size=1g` 和 namespace 能力（本机 Linux Docker 已验证 `--cap-add SYS_ADMIN`），再运行 `.devcontainer/configure-electron-sandbox.sh` 配置沙箱权限；不要用 `--no-sandbox` 绕过启动失败。

容器启用 Docker init 回收退出的 Electron 后代进程。镜像显式保留 `XAUTHORITY=/home/node/.Xauthority`，使隔离测试的临时 `HOME` 仍能连接受认证的 VNC X11 桌面；手动创建容器时同时保留 `--init` 和该环境变量。TigerVNC 使用 `~/.config/tigervnc`，入口等待受认证的 X11 就绪后再启动 noVNC，桌面启动失败会退出容器。构建输出卷与源码 bind mount 可以属于不同文件系统，需原子发布到源码目录的生成文件必须在目标目录旁创建临时文件，再 `rename`；不能从 `.build` 卷直接重命名跨卷文件。

镜像将 `SHELL=/bin/bash` 声明为 `node` 用户的实际登录 shell。手动通过 `docker exec` 启动产品或测试时须保留该环境，旧容器可显式传入 `-e SHELL=/bin/bash`；没有 `SHELL` 时终端后端会回退到 `/bin/sh`，不会获得 Bash 的路径转义与 shell integration 能力。

仅前端 Web 模式执行 `pnpm dev:web --host 0.0.0.0`，打开转发的 5173 端口。完整 Web 模式和 App Server 只监听容器回环地址，须在容器内运行 Playwright，不能通过端口转发在宿主机浏览器访问。Browser 测试执行 `pnpm run test:smoke:browser` 或 `pnpm test:browser:integration`；Electron Playwright 使用容器桌面。

## 输出布局

构建源码按职责组织：根目录 `remote/` 声明远端交付要求，`build/app_server.py` 和
`build/remote.py` 是产品组装入口，`build/lib/` 持有共享依赖解析与包校验，
`build/prepare.py` 准备共享开发包，`build/desktop/develop.py` 选择 Desktop 增量版本，
`build/lib/development_store.py` 为 Desktop 和 Code 提供版本存储、租约与回收。
源码布局与下面的输出布局分别维护；迁移构建源码不会改变现有开发包位置或租约。

| 路径                                                                              | 内容                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.build/cargo/`                                                                   | 默认 Cargo 输出，可由 `CARGO_TARGET_DIR` 覆盖                             |
| `.build/code/dev/generations/<digest>/bin/`                                       | Code 源码运行所需程序；保留当前版本与仍在运行的版本，程序对象以硬链接复用 |
| `.build/desktop/`                                                                 | Electron、Renderer、生成的测试程序和 Playwright 报告                      |
| `.build/desktop/web/ash/`                                                         | 独立 Web 构建，包含浏览器 Workbench 与 Sessions 页面                      |
| `.build/runtime/dev/`                                                             | 完整后端开发包和选用记录                                                  |
| `.build/build-health/`                                                            | 构建测量日志与报告                                                        |
| `.build/ash-playwright-mcp/`                                                      | 临时 UI 场景与验证证据                                                    |
| `.build/protocol/`、`.build/protocol-inputs.json`、`.build/protocol-sources.json` | 共享协议生成物和输入缓存，正常构建自动重建                                |
| `.build/bazel-*`                                                                  | Bazel 工作区便捷链接；Bazel 输出缓存另行管理                              |

Sherpa ONNX 静态库使用按版本共享的校验缓存，位于 `third_party/.cache/sherpa-onnx/`。仓库 Cargo 入口与产品构建会准备并复用该资源，详见 [资源锁定与离线构建](../third_party/sherpa-onnx/README.md)。

### Electron 开发运行包

`pnpm prepare:electron` 准备并缓存开发运行包，macOS 包含 Ash 名称和图标。主可执行文件保留 `Electron` 名称：Electron 根据该文件名判断 `app.isPackaged`，改名会让源码目录启动误用发布包路径。Desktop build/dev 与 CI 在准备阶段调用；TS 启动器和测试只读取产物路径，缺失或过期时提示重新准备，不在启动时复制或签名。

### Electron 平台模块

`pnpm install` 不编译 `native-keymap` 和 `native-is-elevated`。Desktop 的 build/dev 准备入口执行 `pnpm prepare:desktop-addons`：使用当前 Electron 加载实际 `.node` 文件并检查导出；现有产物可用时不启动 rebuild，也不遍历依赖树。Windows 额外准备权限检测模块，其他平台只准备键盘布局模块。仅 Web 构建和类型检查无需这些二进制。

缺失或加载失败时，先从 `.build/desktop-addons/` 恢复与模块源码、平台、架构和 Electron 精确版本匹配的产物，校验 SHA-256 并重新验证加载；没有可用缓存才调用编译器，编译后仍须通过 Electron 加载检查。CI 复用精确 lockfile 和准备脚本对应的缓存。`pnpm prepare:desktop-addons --force` 可显式重新编译；缓存不替代各平台的行为测试。

macOS 和 Windows 发布组包使用同一个准备入口，不再无条件重新编译。交付时保留模块加载器、许可证和唯一的 Release 二进制，排除源码、构建中间文件和重复的 `bin/` 副本；非 Windows 包排除整个权限检测模块。

### 清理与缓存

`pnpm clean` 删除 `.build/`、旧 `target/`、`dist/`、旧 `test/integration/browser/dist/`，以及根目录和 `build/`、`scripts/` 内的 Python、pytest、Ruff 缓存；同时删除本地 `node_modules/` 内的 `.vite/`、`.vite-temp/` 缓存。清理前停止构建和开发进程；下次启动会重新构建。

清理保留源码、依赖包、用户级 pnpm store、`third_party/.cache/`、`.ash/` 配置，不遍历符号链接指向的目录。Bazel 外部输出缓存单独用 `bazel clean --expunge` 清理。

仓库 Cargo 和产品构建入口每小时最多盘点并回收一次闲置缓存，其他热构建只记录使用时间并持有租约。`just prune-build-cache` 可立即检查预算并覆盖本次清理上限。扫描可能增加该次构建的启动时间；超过预算的闲置 profile 回收后需要重新编译。

| 清理参数             | 默认值 | 回收内容                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| `--max-gib`          | 32 GiB | 闲置增量缓存；保留依赖库和程序                                                    |
| `--artifact-max-gib` | 64 GiB | 闲置 profile 的全部产物，包含增量缓存；按最近使用时间整组清理，下次使用需要重编译 |

预算在定期检查及显式清理时应用，两项预算重叠，全部产物的 64 GiB 已包含增量缓存。回收保留锁文件，跳过持有运行租约或 Cargo 锁的 profile；全产物回收还保留完成不足一分钟的 profile，受保护工作集可能暂时超限。编译和测试通过仓库入口运行，租约覆盖整个命令执行期间；直接运行 Cargo 产物的进程不受运行租约保护。自定义 `CARGO_TARGET_DIR` 不自动参与预算；仓库内的其他 Cargo 输出目录可用 `--target-dir` 指定。

开发运行版本由发布器按租约回收，保留当前版本与仍在运行的版本。验证脚本应在结束时删除自行创建的临时编译、索引目录，只保留报告和复现材料；`just bench-build` 会自动清理自己的编译目录。开发包的发布与回收规则见 [共享包构建](../build/README.md)和 [Code 构建](../build/code/README.md)。

`scripts/cargo.py` 的普通 check、test、clippy 命令默认使用共享 `ci-test` profile，包括 `just check`、`just test` 和 `just rust-warnings`；显式 `--profile`、`--release` 或 `-r` 优先。`ci-test` 只是编译配置名，不执行 CI 流水线。产品开发程序和协议生成器继续复用 `dev-small`，发布使用 release；普通 build/run 保留 Cargo 默认配置及现有工具的产物路径，保留各自的体积与调试约束。`just rust-warnings` 检查新生成与已缓存的编译警告，保持 `RUSTFLAGS` 与普通构建一致，避免生成另一套产物。

单次纯类型检查使用锁定的 Bun 1.4.3：Renderer、Common、Protocol、Extensions、Memories、Stanza、构建工具和单元测试运行器工具均通过 `bun check -p <config> --all` 检查。Browser integration、Smoke automation 和 Scenario 的配置也都是 `noEmit`，其准备阶段使用 Bun 检查类型。现有 pnpm 入口继续准备协议、本地化等生成输入；多个检查顺序执行，避免大型 Bun 进程同时争抢 CPU。共享机器可对直接检查添加 `--threads 4`。Bun 不生成 JavaScript 或 `.tsbuildinfo`；对照测量与工具职责见 [构建工具说明](../build/README.md)。

Electron 主进程/preload、单元测试与扩展测试的 JavaScript 编译，以及开发 host watch 和 `typecheck:web:watch`，继续使用 TypeScript 7.0.2；Bun 1.4.3 尚不支持独立的 `bun check --watch`。工作区将编译器固定在 `@ash/typescript-compiler` npm 别名下，`pnpm exec tsc` 调用 TS7。Vite/Rolldown 和 Scenario 的 esbuild 继续打包，Node.js、Mocha 和 Playwright 继续执行测试，pnpm 管理依赖与锁文件。`typescript` 别名保留 `@typescript/typescript6@6.0.2` 兼容包提供的 TS6 JavaScript API，供本地化提取、热更新分析、格式化和架构测试使用；它提供独立的 `tsc6` 命令。升级时同步根目录和 `build/` 的编译器/API 依赖、`test/scenario/` 的编译器依赖及锁文件，并验证 host watch 的失败与恢复、preload 导入限制和 Web/Electron 启动。

前端与构建工具直接消费 `.build/protocol/typescript/` 的共享生成协议，产物不提交到 Git。正常前端、Rust Just 和打包入口自动准备协议：优先复用本地缓存或源码匹配的后端包，缺少匹配产物时需要 Rust 工具链重新生成。修改后端协议后可运行 `just generate-protocol`，再运行 `pnpm typecheck:protocol`；直接 Cargo 构建前必须先准备。协议生成器与开发后端统一使用 `dev-small` profile，复用相同配置的依赖产物；生成器的 `export` feature 仍保留独立编译变体。受版本控制的图标工厂使用 `pnpm icons:generate` 更新。

只构建前端的设备可以使用另一台设备或发布流程生成的完整后端包。解压后设置 `ASH_PROTOCOL_PACKAGE` 为包根目录，再运行现有 pnpm 构建或安装命令；也可直接运行 `python -B build/protocol/generate.py --package-root <包根目录>`。生成器会比较相对路径下的源码内容、Cargo 清单和锁文件、生成器及编译标志，并校验包内每个协议文件的摘要和协议身份。匹配时恢复 `.build/protocol/`，无需 Cargo；源码、输入清单或包内容变化时重新生成，不会把旧包的接口视为当前源码。当前开发包存储中的最新选中包会被自动检查，无需设置环境变量。

开发和发布后端包均携带 `ash-resources/protocol/` 中的 TS 类型、运行时解码器、JSON Schema 和 metadata，以及 `ash-resources/protocol-sources.json` 源码指纹。所有文件进入现有包摘要和 build identity。该复用只免去协议生成所需的 Rust；编译或修改后端仍需要 Rust，运行时继续严格校验协议 major 和 schema hash。

## 发布调试符号与离线崩溃解析

第一阶段已接入 Cargo 发布组包、符号归档和离线工具。符号接入时，release 仅增加 `line-tables-only`、`split-debuginfo = off`、`strip = false`；macOS 发布入口覆盖为 `packed`，当时未调整优化、LTO、codegen units、开发和测试 profile。后续 Windows x64 组包优化见下文历史测量。本机已验证 macOS arm64 的真实 release 程序、内联源码行、离线 Mach-O core 加载及栈展开；Linux/Windows 与正式签名、上传流程须由发布 CI 验证。统一 panic 采集、Electron 和 JavaScript 符号属于后续阶段。

### 宿主工具验收

2026-10-18，在 macOS 27.0.1（26A434）、arm64 实机执行 `just check-build-tools` 和 `just test-python build scripts` 通过：构建测试 249 项、脚本测试 196 项，各跳过 1 项。跳过项分别要求 Windows 长路径边界和显式构建的 Agent eval 产品程序；12 项发布符号回归均执行通过。宿主使用 Xcode Command Line Tools 26.2、Apple LLVM 17.0.0、LLDB 1703.0.236.21（Python scripting 可用）、Rust 1.98.0 和 Python 3.12.14。未安装 `llvm-symbolizer`，因此真实源码行与内联帧解析走 `/usr/bin/atos`，没有用 mock 代替平台符号工具。

本次覆盖真实优化 Rust 测试程序的 dSYM 收集与 staging 剥离、UUID／摘要核对、Cargo dSYM 符号链接归档、ASLR 地址转换及错误构建拒绝，并通过真实 LLDB 加载确定的离线 Mach-O core、展开第一方栈帧并保留未解析的外部帧。初次完整入口因两个测试把 `/var` 别名当作物理路径而失败，修正预期为解析后的路径后重跑通过；构建参数和环境隔离断言保留。工具、源码指纹、红绿日志与结果见 `.build/macos-symbol-acceptance-20261018/validation.json`。这些是宿主工具与测试程序验收，不代表本次执行了正式产品签名、系统崩溃采集或发布上传。

此前已有 Windows 真实工具预检及 23 项相关测试记录（跳过 2 项）。2026-10-18，WSL2 `AshBuild`（Ubuntu 24.04、x86_64、Rust 1.98.0、LLVM 18）执行 `just --set python python3 check-build-tools` 和 `just --set python python3 test-python build scripts`，构建 248 项（跳过 3 项）、脚本 196 项（跳过 4 项）通过，包含真实 ELF/DWARF 符号处理；这两组是既有平台证据，本次未重跑。

### 第一阶段使用

本地发布前设置编译身份和符号目录；`ASH_BUILD_ID` 必须为这次编译的新身份，不能在编译结束后才注入。Python 使用仓库虚拟环境的 3.11+ 解释器；先运行 `just check-build-tools` 验证宿主符号工具，各平台安装要求与 `ASH_LLVM_BIN` 用法见[初始化](#初始化)。dump 导入另外需要支持 Python 的 LLDB。

```sh
export ASH_BUILD_COMMIT="$(git rev-parse HEAD)"
export ASH_BUILD_ID="local-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen)"
export ASH_SYMBOLS_DIR="$PWD/.build/releases/symbols/local"
python -B build/app_server.py --target aarch64-apple-darwin --package-dir .build/releases/runtime
```

`build/app_server.py`、`build/remote.py`、`build/code/package.py` 支持 `--symbols-dir`，也读取 `ASH_SYMBOLS_DIR`；Desktop 组包读取该环境变量并收集 update host。普通开发组包不开启符号流程。CI 在 release 编译前设置身份和目录，签名完成后执行归档；无精确匹配符号的第一方模块会使归档失败。

```sh
# 在产品签名和 archive.py 完成之后绑定最终文件；输出归档和外部 .sha256。
python -B build/release/symbols.py archive \
  --package ash-app-server=.build/releases/runtime \
  --archive ash-app-server=.build/releases/ash-app-server.tar.gz \
  --output .build/releases/assets

# sha256 来自对应 Release companion checksum；.ips 或经典 .crash 报告无需最终程序。
python -B build/release/symbolicate.py \
  --symbols <ash-symbols-构建身份.tar.gz> --sha256 <归档SHA256> \
  --input <报告.ips> --output .build/crash-analysis.json
```

core/minidump 还需 `--images <最终解压产品根目录>` 和 `--executable <该包的主程序>`。输入按魔数识别，原始报告和 dump 不会改写；输出 JSON 和同名 `.txt`，退出码 0 表示帧全部解析，2 表示仍有未解析帧，其他非零表示输入或工具失败。外部模块缺少供应方符号时保留原始 PC 和原因。ELF core 必须包含模块身份所在的文件映射页；缺页时不会借用用户提供程序的 build-id。LLDB 的 Mach-O stack core 可从 `all image infos` 元数据获取 UUID。

LLDB 初始化先关闭符号预加载和符号文件脚本，再创建不自动加载宿主依赖的目标，只添加校验后的产品映像；独立目标的用法见 [LLDB 离线符号解析](https://lldb.llvm.org/use/symbolication.html#using-python-api-to-symbolicate)。Mach-O 回归测试使用真实优化、剥离后的程序及其 dSYM，构造确定的寄存器和栈快照，经真实 LLDB 加载和展开后检查源码行及未解析的外部返回帧；此测试覆盖 core 导入，不依赖运行中进程的捕获。

具有模块 ID 的 JSON 也可输入：`schemaVersion: 1`，`modules` 每项含 `format`（`macho`/`elf`/`pe`）、`arch`（`aarch64`/`x86_64`）、`id` 和加载 `base`；`frames` 每项含 `module` 索引、`pc` 和可选 `thread`。ELF 还需按 PT_LOAD 得到的 `loadBias`，或帧中的 `fileAddress`。UUID/build-id 使用无连字符的小写十六进制，PDB ID 为小写 GUID 加十进制 Age，例如 `<guid>-1`。`addressKind: returnAddress` 明确标记原始返回 PC，解析器按架构回退到调用指令；OS 已处理的地址不重复回退。

符号清单绑定最终模块与产品包的 SHA-256、包 `buildId`、Git 提交、编译身份、配置和锁文件摘要、工具版本、CI 来源、源码路径映射与 release OUT_DIR 的生成 Rust 源码。正式 Cargo 入口记录真实产物消息中的 features、有效 profile 和构建命令；手动传入的 prebuilt 程序明确标记未捕获编译调用。Desktop update host 也通过 Cargo 产物消息选择输入，避免猜测输出目录。发布先上传并下载核对符号归档，再上传产品包；Actions artifact 只作任务间运输。保存全部正式及撤回版本的 companion assets 和匹配产品包；本地 `.build/` 清理不替代持久归档。当前覆盖 Cargo 构建；Bazel、第三方源码符号和自动崩溃上传尚未接入。

### Codex 的已有流程与 Ash 的差异

对照 Codex 提交 `c3d3b142d10f4316b46e35aad7e5317e7e506cb7`：

- [release profile](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/codex-rs/Cargo.toml) 保留 `line-tables-only` 调试信息和未剥离符号；发布 CI 为 macOS 覆盖 `split-debuginfo = packed`，其他平台使用 `off`。
- [符号归档脚本](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/.github/scripts/archive-release-symbols-and-strip-binaries.sh) 保存 macOS dSYM、Linux `.debug` 和 Windows PDB。Unix 分离符号后剥离程序，Linux 还写入 `.gnu_debuglink`。
- [发布工作流](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/.github/workflows/rust-release.yml) 上传独立符号归档，并将符号产物纳入最终发布资产；Cargo 和 Bazel 产物用不同名称区分。
- [包级验证](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/scripts/codex_package/smoke_tests/test_codex_package.py) 在 Linux 检查函数及源码行、macOS 检查函数解析、Windows 检查 PDB 与程序匹配。这些检查没有证明所有真实崩溃都能自动采集、展开和解析。

符号接入前，Ash 的 release 使用 Cargo 默认调试信息设置，当时组包与签名会计算和更新文件摘要，但没有第一方符号归档入口。接入时采用 Codex 的按平台分离方式，统一在包的 staging 副本上剥离，保留 Cargo/Bazel 原始输出；增加逐模块身份、最终包绑定和真实崩溃验证。该阶段没有调整 LTO、codegen units 与优化级别。

### 生成与组包顺序

根 release 的符号配置已生效：

```toml
[profile.release]
debug = "line-tables-only"
split-debuginfo = "off"
strip = false
```

发布入口在 macOS 构建时设置 `CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=packed`，让 Cargo 在对象文件仍可用时生成可独立归档的 dSYM。Bazel 入口必须生成等价调试产物，不会自动读取 Cargo profile。已有预编译程序必须携带匹配符号，不能对已经剥离的程序事后重建符号。[Cargo 的调试信息与分离规则](https://doc.rust-lang.org/cargo/reference/profiles.html#debug) 保留源码行而不提供完整局部变量，因此发布崩溃解析不承诺变量查看能力。

唯一顺序为：

1. 校验 release 来源、工具链与目标，注入编译身份，构建未剥离程序与符号。
2. 将程序复制到 staging，从同一次构建提取符号，检查模块 ID 和调试行信息。
3. 仅修改 staging 中尚未签名的第一方程序：Unix 剥离调试信息，Linux 补 debuglink；保留动态导出和展开所需的元数据。Windows 保留 PE 调试目录，PDB 不进产品包。
4. 组装产品并生成未签名包的文件摘要；执行现有系统签名，再通过现有签名记录流程刷新摘要和包 `buildId`。Desktop 封装、重签名和 notarization 完成后，再检查其中实际发出的程序。
5. 对最终包扫描模块 ID 和文件 SHA-256，将最终包身份绑定到符号清单。使用这些最终程序执行符号验证和原有包级验收。
6. 冻结并归档符号清单和符号文件，验证归档哈希；产品包、更新描述与匹配符号都完成持久保存后，才允许最终发布。

不能在签名或最终包摘要计算后剥离程序。修改一个已签名输入时应重新走 staging、签名和验收流程；引用供应方的已签名外部程序时保留其字节，不把它交给第一方剥离步骤。

| 平台                     | 符号产物         | 匹配身份                        | 提取与检查                                                                              |
| ------------------------ | ---------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| macOS arm64              | `<binary>.dSYM`  | Mach-O UUID 与架构              | Cargo 的 packed dSYM；检查程序和 dSYM UUID 一致，使用 `atos`/LLDB 解析                  |
| Linux GNU/musl arm64/x64 | `<binary>.debug` | ELF GNU build-id 与架构         | `llvm-objcopy --only-keep-debug`，剥离 staging 后写 debuglink；检查 ID 和 debuglink CRC |
| Windows MSVC arm64/x64   | PDB              | PE CodeView 与 PDB 的 GUID、Age | 从 PE 引用定位 PDB，校验签名；不能只按文件名猜测或选择最新 PDB                          |

Linux release 必须有非空 GNU build-id；若所选链接器没有生成，在 Linux 发布入口增加对应链接参数并验证，不能对所有平台设置同一链接参数。Windows PDB 必须独立可用，不允许依赖构建机 `.obj` 的 FASTLINK 产物。匹配规则分别参考 [GDB 独立符号文件](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Separate-Debug-Files.html) 和 [LLVM 的 PDB/PE 匹配说明](https://llvm.org/docs/PDB/PdbStream.html#matching-a-pdb-to-its-executable)。

覆盖清单从真实产品组装输入和最终包枚举，不只扫描 CLI。包括 CLI、App Server、daemon、remote、exec server、V8 两个宿主、voice host、collaboration server、Windows sandbox 程序、update host 和其他实际发出的第一方 Rust 程序或动态库。共用同一模块的 Code、App Server、Desktop 包复用符号，但各自记录最终文件摘要和包身份。Remote 后续独立分发也必须提供同样的符号绑定。

静态链接的 Rust 依赖随第一方程序一起解析；预编译 V8/C++、Go LiveKit、Electron、Node、插件及系统库的源码符号需要各自供应方产物，不能通过开启 Rust debug 补回。清单逐项标记覆盖范围和不可用原因，未知外部帧保留原始地址。

### 身份、归档与保存

现有 [`ash-build-identity`](../crates/build-identity/src/lib.rs) 提供编译身份，发布前通过 `ASH_BUILD_COMMIT` 和 `ASH_BUILD_ID` 注入 Git SHA 与构建身份。构建身份由发布任务在编译前确定，记录 CI run、attempt、job、target 和输入配置；同一版本重建不覆盖先前身份。现有 commit 派生的默认 ID 不足以区分同一源码的不同构建。

编译身份、模块 ID 和 [`build/lib/package.py`](../build/lib/package.py) 按最终文件计算的包 `buildId` 分开记录。后者只能在组包或签名后得到，不回填进已编译程序，避免循环依赖。解析匹配以模块 ID 为准，版本与 Git SHA 仅用于检索候选和定位源码。

每次发布构建保存 `ash-symbols-<version>-<target>-<builder>-<build-key>.tar.gz`，在 `.build/releases/symbols/` 下准备；`build-key` 是编译身份 SHA-256 的前 24 个十六进制字符，归档路径独立于产品包。归档包含 `manifest.json`、平台符号、路径映射和必要的生成源码。最终发布程序保留在既有发布包中，可按清单摘要取回用于展开 dump；只保存 `.debug`/PDB 不代替最终程序保存。

`manifest.json` 使用 `schemaVersion`，包含：

- 构建来源：版本、Git SHA、编译身份、target、Cargo/Bazel、Rust/链接器/符号工具版本、实际 profile/flags/features、依赖锁文件摘要和 CI 来源。
- 模块记录：产品内相对路径、第一方/外部来源、架构、平台模块 ID、PE 引用的 PDB basename、符号相对路径及 SHA-256、覆盖状态。
- 包绑定：产品、最终包 `buildId`、发布包路径与 SHA-256，以及每个模块在各最终包中的文件 SHA-256。重复模块共用符号记录，签名导致字节变化时分别保留绑定。
- 源码来源：Git SHA、调试路径到仓库相对路径的映射、构建时生成源码的归档路径及哈希。解析输出指向该提交，不能指向当前工作区的同名文件。

首版沿用 GitHub Release companion assets 保存符号；GitHub Actions artifact 只作任务间传递。保留所有正式发布版本和撤回版本的符号及匹配程序，直到明确终止这些版本的诊断支持，不用“最近一次成功 CI”替代历史产物。资产位置与可见性继承仓库发布策略；若要保持符号私有，则整个归档和查询索引改为受控存储，不同时维护两份独立清单。

归档创建使用临时路径，全部验证成功后原子完成。归档本身的 SHA-256 写在外部发布索引或 checksum 文件中，不放进它自身的 manifest；绑定现有发布来源验证或签名流程。上传后重新核对哈希和可取回性，失败则阻止对应产品发布。产物缓存可以清理，已发布版本的持久符号不能随 Cargo 缓存回收。

### 崩溃输入与离线解析

第一版不要求部署新的崩溃上传服务。解析输入为原始 OS 报告/dump，或具有模块 ID、模块加载信息和原始帧地址的 panic/栈记录。单独一个绝对地址、函数名或版本号不足以精确解析，解析器应报告缺少信息，不能猜测匹配模块。

| 输入             | 采集与解析方式                                                                                               | 边界                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Rust panic       | 产品宿主统一安装有界 panic hook，保留原有 hook；记录编译身份、线程、模块身份和原始帧，诊断导出时包含这些记录 | 现有代码尚无完整第一方实现；`RUST_BACKTRACE=1` 仅为临时排查入口，文本 backtrace 不保证完整模块信息 |
| macOS 程序崩溃   | 导入系统 `.ips`/crash report 的线程和 Binary Images，用匹配 dSYM 在 macOS 上运行 `atos`/LLDB                 | 按 UUID 匹配，使用加载地址处理 ASLR；无系统报告时不能声称已捕获                                    |
| Linux 程序崩溃   | 导入已有 core/`coredumpctl` 导出结果与映射信息，GDB/LLDB 使用最终程序和独立符号展开，再交给地址解析器        | core 是否生成由系统配置决定；产品不默认修改系统 core 策略                                          |
| Windows 程序崩溃 | 导入 WER/ProcDump 的 `.dmp`，有 Python 支持的 LLDB 使用匹配 EXE/DLL 展开，LLVM 用 PDB 解析                   | WER LocalDumps 默认关闭，按需配置单个程序并说明管理员要求，不默认写全局注册表                      |

WER 的行为与权限参考 [Microsoft 的本地 dump 文档](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)。OS 级信号、访问违规、abort 与被系统终止不能用 Rust panic hook 兜底，也不在信号处理器里调用分配内存、锁或外部工具。panic 记录与 OS dump 使用同一离线模块匹配契约。

解析顺序为：校验归档与清单摘要 → 读取报告内模块身份 → 找到相同架构和 ID 的符号 → 按报告格式处理地址 → 展开及解析帧 → 关联准确提交的源码。ELF 由 LLDB 按 PT_LOAD 展开并导出文件地址，Mach-O 使用 image load address/slide，PE 使用 RVA；不能把三种格式统一成简单减去映射起点。保留原始 PC、调用返回地址类型、模块信息和转换后的地址，按工具约定处理返回地址，不统一盲目减一。

地址解析优先调用 [`llvm-symbolizer`](https://llvm.org/docs/CommandGuide/llvm-symbolizer.html)，保留 Rust demangle 与内联帧；macOS 未安装 LLVM 时使用 `atos -inlineFrames -fullPath`。平台 dump 通过隔离的 LLDB Python 适配器展开，禁用用户初始化脚本和符号文件脚本。输出包含输入哈希、所用归档及模块 ID、函数、源码路径/行号、内联帧和未解析原因，支持 JSON 与可读文本。模块不匹配或归档缺失时保留原帧并返回未完成状态，不选择相同版本的另一个模块。对 OOM kill、SIGKILL 或没有足够栈数据的退出，只报告已有进程退出事实。

诊断共享字段归 `crates/diagnostics`，编译身份仍归 `crates/build-identity`；各产品宿主负责注册 hook，daemon 负责现有子进程退出观察与 stderr 生命周期，不把产品宿主职责迁入 CLI。默认记录有界、无内容的崩溃元数据；dump 可能包含会话内容或凭据，只在用户主动导出时加入，不默认远程上传。解析在产品进程外进行，限制报告/归档大小、路径、解包成员、工具超时和工具输出；取消时终止并回收工具子进程及临时目录，失败保留输入和已完成报告。

### 落点、验收与分步实施

构建所有权保持在 `build/`。[`build/release/symbols.py`](../build/release/symbols.py) 统一生成、staging 剥离、模块校验和最终包绑定；[`build/release/symbolicate.py`](../build/release/symbolicate.py) 负责离线导入与平台工具调用。两者分别服务发布和故障排查，避免在每个 CI shell 中复制平台规则。共享组包逻辑在 [`build/lib/package.py`](../build/lib/package.py) 写摘要前调用前者；CLI 包、Desktop update host 和后端包均传入实际构建输入，而非让脚本猜测 Cargo 输出位置。

[Unix 发布入口](../.github/workflows/platform-checks.yml)、[Windows 发布入口](../.github/workflows/release-windows.yml) 和 [Desktop macOS](../build/desktop/package-darwin.ts)/[Windows](../build/desktop/package-win32.ts) 组包入口接入同一契约，最终发布 job 检查对应符号索引。`platform-checks.yml` 已改为检查 `ash-app-server`，删除历史 `zui` 入口并沿用实际 Python 组包测试；工作流配置检查通过不代表正式发布已运行。GNU/musl、CPU 和构建器逐项声明实际发布覆盖，不因支持列表中存在一个 target 就宣称已经验证。

验收必须使用实际发出的 stripped/signed 程序及 companion symbols，不能只断言符号文件存在：

1. 每个第一方模块校验 ID、哈希、架构和调试行信息；三平台各用独立 release 测试程序验证已知非内联函数及内联函数的源码行，Windows 不能停留在 PDB 路径检查。
2. 在有 dump 支持的隔离 CI 场景中触发受控 panic 和进程崩溃，验证从报告/dump 到函数、行号和提交的完整流程。测试程序不进入产品，正式包另外执行启动/RPC/原有 smoke 验收。
3. 验证 ASLR、同版本不同构建、重命名 PDB、错误 UUID/build-id/GUID、损坏归档、缺失符号和缺失源码；错误匹配必须被拒绝。
4. 验证剥离后启动正常、动态导出及栈展开可用、签名通过、最终包文件摘要与更新描述一致、符号和 source map 未混入默认产品包。给已签名输入做负向测试，确认不会未经重签就改写。
5. 按既有构建测量流程比较 release 调试信息接入前后的构建时间、峰值内存、最终程序和符号归档大小；测量结论只覆盖实际执行的目标，不顺便调整优化参数。

第一阶段完成 Rust 发布符号、持久归档、精确匹配、手动导入 OS 报告和离线解析；第二阶段统一第一方 panic 记录与诊断导出，使没有 OS dump 的 panic 也能进入同一解析链；第三阶段补 Electron Crashpad、与实际 Electron 版本匹配的供应方符号、Node addon 符号及 JavaScript source map。Electron 的 [crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter) 可配置只在本地保存报告，不能据此认为独立 Rust 子进程也被覆盖。前端 source map 由前端构建负责，在持久索引中按生成文件哈希绑定后才从用户包排除；第二、三阶段完成前明确报告相应采集和解析缺口。

## Rust 依赖检查与构建测量

### 构建配置

配置以 [`Cargo.toml`](../Cargo.toml) 与 [`.cargo/config.toml`](../.cargo/config.toml) 为准：

| Profile     | 用途                                                                | 调试信息           |
| ----------- | ------------------------------------------------------------------- | ------------------ |
| `dev`       | 普通开发构建，保留增量编译                                          | `limited`          |
| `dev-small` | Code 等产品开发程序；关闭本地 LTO，按包调整优化级别和 codegen units | 关闭并剥离符号     |
| `ci-test`   | 包级完整验证、TUI 单测与 PTY 场景，共用编译产物                     | `limited`          |
| `release`   | 发布产品；Windows x64 后端组包额外使用 CGU=1                        | `line-tables-only` |

`ci-test` 继承 `test` 的优化配置：共享包为 1，TUI 为 0，App Server 及其客户端为 `s`。不要全局降到 0，否则 macOS 服务程序的 `__eh_frame` 可能超过 compact-unwind 的 16 MiB 偏移限制。

Windows x64 后端 release 组包在[共享可执行文件构建入口](../build/lib/package_binaries.py)显式传入 `--config profile.release.codegen-units=1`，覆盖也进入既有符号编译记录。优化级别保持 3，LTO 沿用默认值；根 Cargo release、开发/测试 profile 和直接构建的 CLI/TUI 配置保持原有职责。该覆盖只应用于 `release` 与 `x86_64-pc-windows-msvc` 的组合，测量依据见下文。

协议消费者使用队列、通话、协作和任务交付的轻量契约，服务实现使用同一份类型；schema/export 按需启用。优化依赖范围与实际编辑循环后，再决定是否调整编译参数。本地保留增量编译；使用 sccache 的 CI 作业关闭增量编译，不能直接照搬到本地。

### 依赖检查

按 [Rust 依赖规范](../.agents/skills/rust-development/SKILL.md#dependencies) 检查依赖。工具使用下列固定版本：

```sh
cargo install cargo-shear --version 1.13.4 --locked
just dependencies
cargo install cargo-deny --version 0.20.2 --locked
just dependency-security
```

检查覆盖依赖声明、产品依赖方向、无用依赖和 [已审查的多版本集合](../.cargo/dependencies.toml)。集合变化时通过 `cargo tree --workspace --target all -i <package>` 审阅；误报需在所属包的 `package.metadata.cargo-shear` 中逐项说明。

`dependency-security` 根据 [Ash 安全策略](../.cargo/deny.toml) 检查整个 workspace、全部 features 和所有目标平台的漏洞、停止维护及撤回版本、第三方许可证和来源。许可证集合与 Git 来源取自 Ash 实际依赖图；Git 依赖必须固定 revision。Ash 自身未发布的专有包不参与第三方 SPDX 许可证检查。重复版本和依赖方向仍由 `dependencies` 负责；安全例外需要逐项审查，不能用整体关闭检查来通过 CI。

2026-10-10 安全修复将 rustls 的最低版本提高到 0.23.45，并将撤回的 chacha20 0.10.1 更新到 0.10.2。rustls 新版本要求升级 aws-lc-rs、aws-lc-sys 和 rustls-webpki，属于 TLS 修复的必要依赖变化。

依赖整改优先采用兼容发布版或固定 revision 的上游修复，不为消除停止维护告警而复制整个依赖源码树。BM25、Syntect、Ratatui、tokenizers、V8 继续使用发布版；Cargo 与 Bazel 由根 manifest 和 lockfile 选择相同来源。已撤掉 `third_party/rust` 的十二个副本及专用校验、源码准备器和 CI 路径规则。

停止维护报告按具体 advisory ID 审查，原因和移除条件只维护在 [安全策略](../.cargo/deny.toml)；它们不豁免其他漏洞、撤回版本、许可证或来源检查。消费者测试继续覆盖实际使用的语法高亮与搜索边界。

BM25 的同分候选由上游 HashSet 顺序决定。Ash 在自己的搜索入口按原始分数和工具名称排序，再截断候选并转换 reciprocal rank，保证重建索引、单条结果和排除项不会受到哈希遍历顺序影响；无需修改或复制 BM25 源码。

2026-10-14 移除内置 Typst 编译器及其协议、字体、许可证和 citationberg patch。Academic 改为可停用的声明式扩展，继续复用 Stanza 编辑模型；PDF 阅读器保留。下述 2026-10-11 验证记录描述当时的依赖图，不表示现版本仍提供 Typst。

2026-10-11 在 Windows 恢复发布版后，CLI 的 40 项、Code Mode runtime 的 19 项及 tokenizer 的 12 项库测试首轮通过；搜索同分排序修复后，`just test ash-tools -p ash-typst -p ash-v8-poc --features ash-v8-poc/sandbox --profile ci-test --lib` 通过 tools 的 39 项、Typst 的 11 项和 V8 sandbox 的 7 项测试。`just test-tui-unit render::highlight::tests` 的 4 项与 `just test-tui-unit app::extensions_tests` 的 24 项通过，合计 156 项消费者测试。已移除随序列化补丁及字体回补一起撤掉的专用测试和资源，保留真实高亮、排版、搜索及 XML 边界覆盖。

`just check ash-tools -p ash-model-tokenizer -p ash-typst -p ash-tui -p ash-v8-poc -p ash-code-mode-runtime --profile ci-test` 的正常编译检查通过；相同六个包加 `ash-cli` 的 `just rust-warnings ... --profile ci-test` 全部目标检查通过。`just dependencies`、使用锁定 cargo-deny 0.20.2 的 `just dependency-security` 通过；`just test-python scripts` 运行 162 项，7 项按平台条件跳过，其余通过。Bazel 的 `build @crates//:bm25 @crates//:syntect` 实际编译通过并更新 lockfile；改动文件的 Rust、Python、JSON/Markdown 格式及 `git diff --check` 通过。未运行完整 workspace 回归或 Web/Electron UI，本轮未修改 UI 行为；Linux/macOS 的消费者编译由 `rust-warnings.yml` 的对应 warnings 作业覆盖，本机无法执行这些系统上的运行验证。

2026-10-10 的此前验证覆盖 Windows product-update 的 signing 构建与下载测试、daemon、http-client、Symphony；相应正常构建与 warning 检查通过。Symphony 的一个既有测试需要在独立测试子进程中设置 HOME。恢复发布版后的消费者验证需以本次实际运行结果为准，不能复用已撤掉源码补丁的验证结论。

CLI commands 的七项 Windows 10060 超时已定位并修复：控制连接能及时返回，业务连接却在初始化内置 SSH 扩展时递归修改整个 Cargo 输出目录的 ACL，阻塞 `initialize` 响应。启动方现在显式区分安装包和内置模块；内置模块不需要磁盘包读取授权，保留相同的 AppContainer、限制令牌和 Job 隔离。账号夹具同时固定 `ZCODE_DATA_BASE_DIR`，避免宿主凭据覆盖临时 home。重建 App Server 后，`just test-processes ash-cli --profile ci-test --test commands` 的全部 10 项通过，0 项跳过，未放宽断言或延长超时。版本切换用例使用该入口在 Cargo 的 Windows Job 外运行，以验证 daemon 的独立生命周期。

扩展宿主的 38 项进程测试、3 项 Windows 隔离测试及共用监管器的 19 项单测通过；新增回归用例在修复前失败，修复后验证内置模块不遍历无关目录。隔离探针同时验证内置模块不获得工作目录的临时读取权限、句柄存活时 ACL 不变，以及进程结束后的权限和 AppContainer 回收。App Server 和 JS 宿主正常构建通过；Windows sandbox、Editor Extension Host、JS Extension Host 和 CLI 的普通编译及全部目标 warning 检查通过，统一使用 `ci-test`。

stdio 的两项 Windows 错误 32 也已修复。进程探针确认旧实现只杀掉并回收 CLI 转发进程，真正的 App Server 仍持有 `connectors.sqlite3`、`state.sqlite3` 及其 WAL/SHM 文件；取消 stdout 读取不能证明后代进程已退出。会话现在先 join 写入线程，关闭 stdin 触发服务端 EOF 清理，再等待转发命令退出和读取线程结束。显式 shutdown、stdio Drop 和初始化拒绝共用该清理路径，进程等待失败会返回错误；未添加延时、重试或测试豁免。`just test-processes ash-cli --profile ci-test --test stdio` 的原有两项及新增 Drop 用例全部通过（3/3，0 项跳过），保留立即删除 profile 的断言。`just test ash-app-server-client --profile ci-test --lib` 全部 45 项通过，包括四项子进程 EOF 清理回归；`just test ash-remote-connections --profile ci-test --lib` 在 Windows 可执行的 26 项通过。CLI 正常构建、`just check ash-app-server-client -p ash-cli --profile ci-test` 和 `just rust-warnings ash-app-server-client -p ash-cli --profile ci-test` 的全部目标检查通过。Linux/macOS 的完整 stdio 与 SSH 生命周期目标接入 [rust-warnings.yml](../.github/workflows/rust-warnings.yml) 的 `stdio-lifecycle` 作业（`ubuntu-24.04`、`macos-15`），由 blocking CI 汇总结果；缺少 OpenSSH 或 `lsof` 会失败。作业复用 Ash 的校验和锁定 ripgrep 准备器，同一 `ci-test` profile、`--locked` 和 warning 门禁构建实际 CLI、App Server、Remote Server、JS 宿主，并分别编译和运行测试。

Linux WSL 的独立源码快照验证已通过：`scripts/cargo.py --deny-warnings --process-tests test -p ash-cli --test stdio --profile ci-test --locked` 全部 8 项通过；`scripts/cargo.py --deny-warnings test -p ash-app-server-client -p ash-remote-connections --lib --profile ci-test --locked` 分别 45/45 和 35/35 项通过，均无跳过。关闭前确认服务端持有 SQLite 文件并记录后代 PID，关闭后要求 CLI、实际服务端、SSH 传输及所记录的后代退出，`lsof` 没有目录文件占用，再立即删除夹具目录。真实 OpenSSH 回环覆盖 shutdown 和 Drop，独立后台跨连接保留后通过正式 stop 关闭；已移除两个 500ms 等待及终端 attach 重试。Linux 的四个正常可执行产物构建以及 CLI、客户端、远程连接库的全部目标 warning 检查通过；结束后的进程清点没有 Ash 运行时或夹具 sshd 遗留。Windows 客户端 45 项回归及同一组包的全部目标 warning 检查通过；并行夹具的时间戳目录冲突由唯一序号修复。macOS 本机不可用，新增 `stdio-lifecycle (macos-15)` 作业尚未触发，不能报告 macOS 运行通过。

TLS 最低版本、撤回的 chacha20 更新、citationberg 的 quick-xml 修复和 Liquid 上游固定提交继续保留；它们不依赖本地 Rust 源码副本。停止维护告警的逐项例外不能代替消费者正常构建、行为测试和 warning 检查。Linux/macOS 运行及 Android loader 编译仍需在所属平台验证；V8 源码生产仍由 [rusty-v8-release.yml](../.github/workflows/rusty-v8-release.yml) 和 [V8 构建说明](../third_party/v8/README.md) 负责，本轮不声称完整 C++ 源码构建通过。

### 构建测量

测量工具需要 macOS 或 Linux 的 `/usr/bin/time`，默认重复三轮，分别记录空输出目录构建、无改动重跑和仅触碰源码时间戳后的重编译：

```sh
cargo fetch --locked
just bench-build ash-cli --profile dev-small --jobs 4
```

报告保存在 `.build/build-health/`。每轮使用独立 Cargo 输出目录，完成后仅清理该目录；共享 `.build/cargo` 保留。依赖需预先下载，构建使用离线模式。

比较报告时保持机器、工具链、profile、target、并发数和缓存条件一致：

```sh
just bench-build ash-cli --profile dev-small --jobs 4 --compare .build/build-health/<run>/report.json --max-regression 15
```

`--absolute-regression 2` 可额外允许两秒以内的波动。RSS 是 `time` 报告的最大驻留集；产物大小是 Cargo 输出文件大小。空输出目录不会清空系统或外部编译器缓存，touch 场景也不能证明实际代码编辑的重编译速度。

测量真实源码编辑时，恢复原内容后保留新的文件修改时间，再构建最终产物。把修改时间退回编辑前可能让另一个 profile 误用实验源码的缓存；仅触碰时间戳且内容未变的场景不受此限制。

### CI 检查

[blocking-ci.yml](../.github/workflows/blocking-ci.yml) 是常规检查的 PR、main 推送和 merge queue 入口。路径规则集中在 [ci-workflows.json](../.github/ci-workflows.json)，选择器读取完整 Git diff，不受 GitHub 路径过滤的文件数量限制；没有基线的新分支和手动运行检查全部常规工作流。子工作流保留独立手动入口，Bazel 的 release 入口和依赖安全的每周检查也保留。平台与发布工作流继续使用自己的入口。

汇总检查名为 `CI required`。被选中的检查必须成功，只有选择器明确排除的检查才允许跳过；失败、取消、缺少结果或选择器失败都会阻断。GitHub 仓库 ruleset/分支保护需要将 `CI required` 设为必需检查；修改工作流文件不会自动修改仓库设置。

Git blob 默认上限为 1 MiB，包括二进制文件。检查候选提交中新增或修改的对象；重命名按目标路径重新判断。已审查的大文件在 [blob-size-policy.json](../.github/blob-size-policy.json) 中使用精确路径、有限预算和原因，不能使用目录豁免。本地检查当前提交的完整树：

```sh
python -B scripts/check_blob_size.py --head HEAD
```

检查指定范围时加入 `--base <commit>`；检查器读取 Git 对象，未提交的工作区内容不计入。

| 工作流                                                              | 覆盖                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [blocking-ci.yml](../.github/workflows/blocking-ci.yml)             | 按变更选择检查，并汇总为 `CI required`                                   |
| [blob-size-policy.yml](../.github/workflows/blob-size-policy.yml)   | Git 对象大小和已审查的精确路径预算                                       |
| [cargo-deny.yml](../.github/workflows/cargo-deny.yml)               | Rust 依赖安全、许可证、来源；每周更新 advisory 检查                      |
| [format.yml](../.github/workflows/format.yml)                       | TypeScript、Rust、配置、文档格式                                         |
| [codespell.yml](../.github/workflows/codespell.yml)                 | 拼写检查                                                                 |
| [frontend.yml](../.github/workflows/frontend.yml)                   | TypeScript 构建工具、编辑器、前端单测和 Browser/Electron UI Playwright   |
| [tooling.yml](../.github/workflows/tooling.yml)                     | Python 检查及构建、包布局、签名契约测试                                  |
| [media.yml](../.github/workflows/media.yml)                         | 媒体相关 Rust 检查和平台集成测试                                         |
| [bazel.yml](../.github/workflows/bazel.yml)                         | Bazel 构建下的 Linux CLI/TUI PTY 场景                                    |
| [platform-checks.yml](../.github/workflows/platform-checks.yml)     | 跨平台验证、Linux/macOS 发布构建，以及统一发布验证和上传                 |
| [release-windows.yml](../.github/workflows/release-windows.yml)     | 由主流程调用，构建并签名 Windows Code/App Server 包及 x64 Desktop 安装器 |
| [rust-warnings.yml](../.github/workflows/rust-warnings.yml)         | Rust warning 检查和 TUI 测试                                             |
| [rust-build-health.yml](../.github/workflows/rust-build-health.yml) | 依赖检查、Rust 测试和构建性能比较                                        |

相关文件变更推送到 main 后，性能检查在同一 runner 和工具链下对协议包前后版本各测三轮；耗时中位数同时增加超过 25% 和两秒时失败。具体触发条件和平台分工以工作流为准。

### 历史测量与适用范围

#### macOS arm64 开发构建（2026-10-01～16）

以下仅保留能说明当前构建选择的测量。条件均为 macOS arm64、Rust 1.98.0、`dev-small`、12 个任务、三轮中位数；不能作为其他机器或当前版本的耗时预算。

| 场景                     | 已验证结果                                                                                             | 范围与代价                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 2026-10-05，协议依赖拆分 | 队列、通话、协作、任务交付类型移入契约 crate 后，协议包空输出构建 43.50 → 32.26 秒，编译单元 255 → 174 | 热构建没有明显变化；完整产品仍需要执行、图片和 SQLite，未证明完整产品冷构建提速 |
| 2026-10-01，实际协议编辑 | schema 按需启用、协议包优化级别降为 0 后，`just build-code` 重编译 14.10 → 8.74 秒                     | 开发 CLI 程序约增大 11%；冷构建波动较大，未给出稳定提速比例                     |

2026-10-07，在同一 macOS arm64、Rust 1.98.0、12 个任务和已缓存依赖条件下，协议生成器从 `dev` 改用 `dev-small`：三轮触碰协议库源码时间戳后，生成阶段的中位数从 12.96 降到 7.35 秒；无改动重跑为 0.93 与 0.99 秒。生成器程序从 17.9 增至 23.1 MB，不进入产品包。此结果覆盖协议生成阶段，不代表完整桌面构建或实际协议字段编辑提速，也没有证明冷构建收益。

同日，在相同条件下，Electron 后端监听器根据 Cargo 的协议生成器依赖图跳过普通业务源码保存时的协议生成。三轮触碰 `crates/app-server/src/server/operations.rs` 后，从文件变更到后端构建成功的中位数从 6.02 降到 4.95 秒，约减少 18%。两组均使用已缓存的 `dev-small` 产物，包含 250 毫秒防抖及首次依赖图查询，App Server 与 Remote Server 均实际重编译。测量期间暂停另一个源码监听器，完成后恢复；有并发构建或锁等待的早期数据已排除。此结果覆盖后端监听器的时间戳触碰重编译，不代表真实功能编辑、冷构建或完整桌面启动提速。

2026-10-16，修复 Desktop 监听器已准备协议、但底层二进制构建仍重复准备的问题。监听器调用 `build/desktop/develop.py --protocol-prepared`，直接构建默认仍检查协议；协议依赖变更、生成失败重试和构建期间的新保存仍由监听器处理。相同 macOS arm64、Rust 1.98.0、`dev-small` 热缓存下，交替运行默认与已准备路径各三次：无改动阶段中位数为 1.77 → 1.63 秒，触碰上述业务源码后的中位数为 8.48 → 8.32 秒，两条路径均确认 App Server 与 Remote Server 实际重编译。触碰构建最大 RSS 中位数均约 1850 MiB，产物 generation 相同。结果波动大于这次耗时差，尚不能证明稳定的增量编译提速；此测量只覆盖监听器调用的后端构建阶段，不包含防抖、首次依赖发现，也未测量真实功能编辑、冷构建或其他平台。原始命令、逐轮日志和测量脚本在 `.build/perf-desktop-20261016/build-paired.json` 及同目录下。

同日，`dev-small` 显式设置 `lto = "off"`，关闭默认 `false` 仍执行的 crate 内 ThinLTO；其余优化级别、CGU、增量编译和发布 profile 保持原设置。在同一工具链、12 个任务和热缓存下，分别三次修改 `operations.rs` 的 `instructions-init-v1` 版本值，监听器调用的完整后端构建与 generation 发布阶段中位数为 16.07 → 8.17 秒，约减少 49%；最大 RSS 中位数为 1821 → 1635 MiB。Cargo timings 中 App Server 的代码生成从约 8.6 降至 0.5 秒，App Server 和 Remote Server 均实际重编译。无改动中位数为 1.69 → 1.72 秒。计时不含监听器防抖、首次依赖发现、前端构建或应用重启，未证明所有业务编辑或其他平台的同等收益。单独限制提示词函数内联、降低 App Server 优化级别和移动指令选择逻辑的候选均未显示足够收益，未保留。

同一提交和依赖锁定下，另用 `just bench-build ash-app-server --profile dev-small --jobs 12 --source crates/app-server/src/server/operations.rs` 在隔离输出目录各跑三轮。默认功能集的首次构建中位数为 202.36 → 170.25 秒，约减少 16%；无改动为 2.35 → 2.34 秒，时间戳触碰为 6.83 → 6.66 秒。候选触碰的三次耗时为 6.54、12.08、6.66 秒，保留全部样本，不将这组波动解释为稳定提速。首次构建最大 RSS 中位数为 3943 → 4150 MiB，增加约 5%；触碰构建为 1851 → 1648 MiB。原始报告分别在 `.build/build-health/ash-app-server-dev-small-el3s_mak/report.json` 和 `.build/build-health/ash-app-server-dev-small-ga8z7go5/report.json`。这里的首次构建只清空独立输出目录，保留系统缓存，不代表整个 Desktop 首次构建。

此开发配置有体积代价：Desktop 构建的 App Server 为 221.29 → 246.11 MiB，Remote Server 为 166.03 → 176.10 MiB。在相同 Desktop 产物、隔离用户目录和 8 个各 4000 行的 TypeScript 文件下，实测两个后端 generation，均通过 30 次构建目录写入及 24 次编辑器打开/关闭断言：后端空闲 RSS 为 166.3 → 169.6 MiB，关闭编辑器后为 169.6 → 171.9 MiB；打开文件中位数为 137.3 → 138.6 毫秒，编辑阶段后端累计 CPU 为 1.76 → 1.98 秒。这是一次受控场景对比，不代表正式包占用或所有运行时负载都无回归。构建原始命令、Cargo timings、逐轮数据及运行场景保存在 `.build/perf-incremental-20261016/`，汇总为 `build-summary.json` 和 `runtime-summary.json`。

工具库补齐没有证明产品构建提速；参数库拆分、过程宏优化与此前构建依赖 profile 对齐候选均未证明收益，未保留。原始测量保存在 `.build/build-health/`；已提交的详细记录可从本文 Git 历史查阅。

#### 2026-10-17：Windows x64 release 体积 A/B

在 Windows 11 x64、i5-12600KF、64 GiB 内存、Rust 1.98.0 / LLVM 22.1.8 上，以 8 个 Cargo jobs 比较四组独立配置。构建目标是 `x86_64-pc-windows-msvc` 的 19 个后端可执行文件，包含 `ash-voice-host/host`；使用锁定依赖、离线构建和独立 Cargo 输出目录，保留共享缓存。所有有效 A/B 使用同一份生产源码：`7dee9da39e6d` 加 Git 处理器的 `self.context.git_runtime_service()` 编译修复。

候选参考 Zed 的官方 [体积优化提交](https://github.com/zed-industries/zed/commit/976ab33fb4b262155f518713019e0a8e7b788c9e)；其 [Linux 链接优化提交](https://github.com/zed-industries/zed/commit/d6b7f24b7b864a32893766445927bce5cff83552) 的平台参数不属于这轮 Windows 实验。四组分别为原 release、仅 `codegen-units = 1`、仅 `lto = "thin"`、选择性 `opt-level = "z"`，没有测量参数叠加组合。

选择性 `z` 将工作区设为 `z`、非工作区依赖设为 3，并将 `ash-diff`、`ash-file-search`、`ash-syntax`、`ash-language`、`ash-model-tokenizer`、`ash-code-mode-runtime`、`ash-v8-runtime`、`ash-realtime-voice`、`ash-voice-agent`、`ash-voice-host`、`ash-livekit-client`、`ash-screen-capture`、`ash-utils-image` 保留为 3。

下表的 MB 为十进制；不含 PDB 等 companion symbols。后端包采用 Desktop 使用的 `host-provided-node` 形式。桌面安装器使用正常 Inno Setup 6.7.3 流程生成，均为未签名的本地测量制品。四组复用完全相同的 Electron 44.4.5、前端及 addon 文件，逐文件摘要确认差异只来自后端程序和对应包元数据；压缩包的百分比不能直接用于另带独立 Node 的分发包。

| 配置       | 19 个后端 exe 总计 MB |    后端 tar.gz MB | 完整桌面安装器 MB |
| ---------- | --------------------: | ----------------: | ----------------: |
| 原 release |                513.31 |            198.78 |            241.49 |
| CGU=1      |      477.49（−6.98%） |  189.61（−4.61%） |  238.42（−1.27%） |
| ThinLTO    |      504.69（−1.68%） |  195.47（−1.66%） |  241.29（−0.08%） |
| 选择性 z   |     457.74（−10.83%） | 178.09（−10.41%） |  229.75（−4.86%） |

CGU=1 的完整桌面目录从 1,075.31 MB 降至 1,039.29 MB，减少 36.02 MB（3.35%）；完整安装器只减少 3.07 MB。可执行文件、安装目录和压缩下载制品的降幅不能互相代替。

运行比较使用真实组包中的 App Server stdio RPC，独立用户目录，交错轮换四组顺序共 9 轮。每轮预热后分别执行 64 次稀疏 diff、64 次密集 diff、16 次完整语法解析、64 次增量语法解析、32 次文件搜索，并校验各组结果指纹一致。负载为 5,000 行稀疏 diff、1,200 行密集 diff、500 个 TypeScript 函数和 4,096 个工作区文件。

下表基线为各轮请求中位数的中位数；变化为同轮配对比值的中位数，正数表示耗时增加。因此变化百分比不等于两个总体中位数直接相除。

| RPC 场景     | 基线 ms | CGU=1 变化 | ThinLTO 变化 | 选择性 z 变化 |
| ------------ | ------: | ---------: | -----------: | ------------: |
| 稀疏 diff    |  31.330 |     −1.98% |       −2.38% |        +3.61% |
| 密集 diff    |  22.473 |     +2.58% |       +0.41% |        +1.01% |
| 完整语法解析 |  28.728 |     −1.20% |       −4.43% |        +6.87% |
| 增量语法解析 |  20.630 |     +1.63% |       −1.21% |       +13.98% |
| 文件搜索     |   1.394 |     −2.24% |       +0.46% |       +12.54% |

CGU=1 未发现稳定的运行回退，但不能将未显著的差异视为严格等效：例如密集 diff 的配对 bootstrap 95% 区间为 −22.36%～+17.43%。选择性 z 的文件搜索区间为 +5.73%～+17.81%，增量语法解析区间为 −7.50%～+27.05%。启动对比仅使用第 2～9 轮：预热后的基线中位数为 882.90 ms，CGU=1 的配对变化为 +1.46%，区间包含零。首轮因基线已做过校准、其他程序首次运行而条件不同，保留原始记录但不用于归因；这轮没有证明首次安装启动的变化。

补查各轮均值和 P95 后，CGU=1 的配对变化范围分别为 −3.45%～+3.56% 和 −2.17%～+2.66%；五个 P95 区间均包含零。各轮 P95 使用原始请求样本的 nearest-rank 分位数，详细区间与逐轮变化保留在 `analysis.json`，不能把小样本的尾延迟结果视为严格等效证明。

另用现有 `time_context_benchmark` 补测 ContextInput、ContextPlanner、ContextAssembler 和 JSON 序列化，16/128 个工具、普通/时间后缀四个场景，每次预热 100 次、采样 1,000 次，共交错重复 5 轮。CGU=1 的配对 P50 变化为 −6.45%～−0.78%；选择性 z 为 +25.79%～+37.38%。例如 128 个工具的普通场景，五轮 P50 的中位数为基线 270.5 μs、CGU=1 268.4 μs、ThinLTO 254.7 μs、选择性 z 371.2 μs。原 `instruction_benchmark_composition` 在基线就因请求指令不一致触发断言，没有弱化该断言或将失败运行纳入性能数据。

应用内存只测 App Server 自身峰值 RSS，中位数为基线 326.23 MiB、CGU=1 323.70 MiB、ThinLTO 326.39 MiB、选择性 z 327.13 MiB；不能据此宣称整个应用或进程树的内存收益。CPU 原始值只包含服务进程，并受 Windows 计时粒度限制，零值不表示整个操作没有 CPU 开销。本轮没有测量远程模型、语音、GPU、CLI/TUI 或其他平台的运行性能。

基线与 CGU=1 各确认三次空输出目录、无改动重跑和时间戳触碰构建。基线使用 trial 2/3/4，CGU=1 使用 trial 1/2/3；六组源码指纹一致，各配置的 19 个 exe 逐个大小完全一致。日志审计确认所有无改动样本的 Rust 编译产物均为 `fresh`，所有触碰样本均实际重编译 App Server 库。下表为三次中位数，提交内存为 Windows Job Object 的整个构建进程树峰值，**不是 RSS**。

| 构建场景   | 基线秒 | CGU=1 秒 | 壁钟变化 | 基线 / CGU=1 提交峰值 GiB |
| ---------- | -----: | -------: | -------: | ------------------------: |
| 空输出目录 |  763.5 |  1,008.5 |  +32.08% |              7.22 / 11.54 |
| 无改动重跑 |    4.4 |      9.3 | +111.32% |               0.21 / 0.21 |
| 触碰重编译 |  150.9 |    505.2 | +234.76% |              7.13 / 10.69 |

无改动重跑测的是完整构建入口，三次范围分别为基线 4.3～10.1 秒、CGU=1 4.3～13.3 秒；两组都没有重编译 Rust 单元，不能将这部分差异归因为 LLVM 代码生成。首轮 Cargo timings 显示，CGU=1 的触碰成本主要在 App Server 库编译阶段（约 140→486 秒），ThinLTO 主要在最终 bin 构建阶段；ThinLTO 的单次触碰构建为 559.5 秒，选择性 z 为 96.7 秒。后两组只有一次构建样本，没有据此宣称稳定的构建加速。

最终采用 Windows x64 后端 release 组包的 CGU=1，以发布构建成本换取 6.98% 的后端 exe 体积收益，保留优化级别 3 和 LTO 默认值。选择性 z 的当前范围有可重复的负载回退，暂不采用；ThinLTO 的主要两个 exe 略增、完整安装器只减少约 0.20 MB，也不采用。本轮结论不代表完整发布 CI 的时间或其他目标的表现。

落地验证通过：`just verify ash-app-server --lib --filter git_runtime::tests` 完成 check、48 项 Git 回归和全目标 warning 检查；`just test-python build scripts` 运行 217+192 项测试，13 项按条件跳过；Python lint、改动文件格式与 `git diff --check` 通过。Git 测试补齐现有处理器调用，并在临时仓库固定 `core.autocrlf=false`，隔离开发者换行偏好，保留原有内容断言。这些测试夹具修改不进入 release 程序。

正常 `build/release/symbols.py build-update-host` 入口实际构建通过，编译清单记录了 CGU=1 命令覆盖及优化级别 3，实际 PE/PDB 配对收集通过。额外复用现有优化程序的源码行、内联帧和错误构建拒绝断言，在平台支持的符号参数上仅添加 CGU=1，也通过。原始日志、安装器和二进制快照保留，独立 Cargo 目标与 4,096 文件临时工作区已清理；共享 `.build/cargo` 保留。复测应新建报告目录并使用记录的源码，避免覆盖本轮归档。

原始日志、Cargo timings、逐轮 JSON、PE section 大小、结果指纹和测量脚本保存在 `.build/build-health/release-ab-20261017/`。关键文件为 `analysis.json`、`build-summary.json`、`runtime-raw.json`、`core-runtime-raw.json`、`package-sizes.json`、`desktop-sizes.json` 和各配置的 `trial-*/report.json`。最初编译失败后恢复的基线 trial 1 标记为 `recovery`，不能充当空输出目录构建样本；失败和校准日志也保留在该目录。

#### 2026-10-18：Windows x64 Rust 保存到 Desktop 可用

在 Windows 11 x64、i5-12600KF、64 GiB 内存、Rust 1.98.0 / LLVM 22.1.8 上，比较默认 MSVC `link.exe` 与 Rust 自带的 `rust-lld`。两组均使用 `dev-small`、默认 16 个 Cargo jobs、相同 features、静态 CRT、8 MiB 栈预留与正常进程优先级。源码固定为 `25aa6b15e62a4bf394d8bcf236b6bdc74c7df315` 加本轮相同的工作区重连修复；Rust/Cargo/构建输入及该前端修复的摘要为 `27892018c6a484730167d2713b312f716f4e1b01b9fa91dcb358d47e84b61190`，测量脚本摘要为 `db3656918173a4dda952e6eb039831daa449718bd46d48c3d086defed63b8d89`。

每组先预热全部 21 个开发后端程序，再在真实 Electron 窗口中连续保存三次 `crates/app-server/src/server/request_processors/diff.rs`：将输入大小上限依次增加 1、2、3 字节。计时从写入源码前开始，经过实际 Rust watcher、250 毫秒防抖、四组 Cargo 构建、运行代次发布与后端重连，直到界面能搜索到刚更新的独立工作区文件中的准确文本。每次要求运行代次和 Renderer 初始化次数增加；结束后恢复原始源码并重新构建。Cargo timings 确认每次只重编译 App Server 库及二进制，其余程序复用。基线保留共享 `.build/cargo`；候选使用独立输出目录预热，未清除共享缓存。

| 指标（三次中位数）                   |    MSVC |     LLD |           变化 |
| ------------------------------------ | ------: | ------: | -------------: |
| 保存 Rust → 界面完成新内容搜索       | 45.25 s | 42.13 s |      缩短 6.9% |
| 保存 Rust → 新运行代次发布           | 30.34 s | 26.77 s |     缩短 11.8% |
| 实际链接进程存活时间                 |  6.90 s |  3.07 s |     缩短 55.5% |
| 无源码改动的后端构建、检查与发布入口 | 10.84 s | 10.71 s | 未证明稳定收益 |

完整可用时间的原始三轮为 MSVC `45.62 / 45.25 / 44.43 s`，LLD `61.89 / 41.74 / 42.13 s`。LLD 第一轮在 Cargo 编译开始前出现额外等待，原因未定位，仍计入结果；因此不能承诺每轮都更快。正常两轮的收益主要来自链接，App Server 库编译仍约 7.5 秒，后端发布后的重连和工作区就绪仍约 14–16 秒。Cargo 的二进制编译单元含 Rust 编译和链接，未直接当作纯链接时间；表中链接时间来自 Win32 进程创建与退出时间，且仅跟踪实际 watcher 的子进程。

真实验证同时发现：热重启后的新连接未重新绑定工作区目录，协议就绪后搜索仍返回 `SearchUnavailable`。现有 Renderer 工作区 owner 现在在本地重连后重新执行原初始化流程，复用已保存授权；已有双窗口重启 smoke 增加了新内容搜索断言。上述两组均包含同一修复，45.25 → 42.13 秒只比较链接器，不能当作修复前失败流程的可用时间。

21 个 exe 总体积为 `356,505,088 → 355,358,208` 字节，App Server 为 `168,174,080 → 168,060,928` 字节。逐个对照 PE 架构、程序属性、子系统、DLL 安全标志与栈预留/提交大小，结果一致；LLD 的两个优化 PE/PDB 夹具测试验证源码行、内联帧和错误构建拒绝。无改动样本全部为 Cargo fresh，Windows Job Object 整个构建进程树的峰值提交内存中位数为 `201.38 / 200.05 MiB`，不是 RSS，也不能据此宣称编辑构建或应用内存改善。

上述链接器比较仅为 Windows x64 选择 LLD，保留开发 profile 与其他平台参数。没有冷构建加速、Mac/Linux/ARM64 性能或完整发布 CI 的结论。Unix `just bench-build` 依赖 `/usr/bin/time`，本轮使用独立 Windows 观测脚本；早期源码版本变动、缓存修复、失败验证和预热均保留日志并排除在上述六个有效样本之外。原始逐轮 JSON、Cargo timings、链接进程记录、PE 对照、测试日志和脚本在 `.build/perf-win-edit-20261018/`，主要入口为 `summary.json`、`baseline-edit-ready.json`、`lld-edit-ready.json`、`baseline-linkers.json`、`lld-linkers.json`、`timing-summary.json` 与 `scope.md`。

#### Windows x64 开发准备与后端恢复（2026-10-18，第二轮）

继续使用同一台 Windows 11 x64、i5-12600KF、64 GiB、Rust 1.98.0、`dev-small`、默认 16 个编译任务和正常优先级；两组均使用仓库配置的 LLD 和普通 `.build/cargo`。HEAD 为 `25aa6b15e62a4bf394d8bcf236b6bdc74c7df315`。预热后，通过同一个真实 Rust watcher 修改 App Server 的 diff 输入上限，构建全部 21 个程序，等待已有窗口完成新后端初始化，并从外部修改的工作区文件中搜索到精确的新内容。计时从写入 Rust 源码之前开始，包含冻结文件、加载预热、发布和恢复；没有把加载成本移到计时之外。每组内部的源码和 HEAD 都有稳定性校验，没有其他 Rust 构建争用。

| 指标                                    |    仅 LLD 的基线 |     本轮最终结果 |             变化 |
| --------------------------------------- | ---------------: | ---------------: | ---------------: |
| 保存 Rust → 完成新内容搜索，五次中位数  |          42.15 s |          29.10 s |       缩短 31.0% |
| 保存 Rust → 新代次发布，五次中位数      |          25.15 s |          23.06 s |        缩短 8.3% |
| 新代次发布 → 完成新内容搜索，五次中位数 |          17.09 s |           5.99 s |       缩短 64.9% |
| 实际链接进程，五次中位数                |           2.83 s |           2.88 s | 没有链接加速结论 |
| 无源码改动的完整后端入口，三次中位数    |           9.97 s |           7.48 s |       缩短 25.0% |
| 其中 Cargo 依赖图查询，三次中位数       | 3.66 s，四次查询 | 1.13 s，一次查询 |       缩短 69.1% |

完整可用时间的基线五次为 `42.65 / 42.15 / 40.30 / 40.68 / 43.50 s`；候选五次为 `29.10 / 29.80 / 29.91 / 28.89 / 29.05 s`。基线原第五次在发布目录重命名时遇到 `WinError 5`，该失败保留，另补测一次相同的小幅源码修改；五次成功样本来自六次尝试。最终候选五次全部成功，且每次只重编译了预期的 App Server 单元。各阶段分别取中位数，因此不能直接把表中阶段中位数相加。最初 MSVC 的 45.25 秒是上一组历史测量；本轮直接对照的是新采集的 42.15 秒 LLD 基线。

剩余耗时的证据和实际改动：

- 构建入口原来为四个功能组分别查询依赖、准备外部库。现在只为外部输入解析一次并集，实际 Cargo 编译仍分四组，保持设备、语音推理功能与 App Server 的依赖隔离。外部库准备本身仍约 1.17 秒，主要节省来自重复依赖查询，不能把它表述为编译器优化。
- 真窗口计时发现，旧后端停止约 2 秒，新后端启动约 13 秒；其中 `Command::spawn` 单独占约 9–11 秒，协议探活不到 1 秒。对 exe 副本追加不改变代码的 PE 尾部标记后，三次首次加载为 `11.03 / 8.71 / 8.92 s`，同一文件紧接着再次加载为约 `4–5 ms`。同文件的硬链接也能立即加载。该实验定位到 Windows 新映像的首次加载；没有据此断言具体安全组件，也没有关闭或更改系统防护。
- Windows 开发入口在核心功能组完成后，把新 App Server 冻结到现有不可变对象仓库，用私有硬链接保护它免于回收，并在后台执行不打开后端或用户配置的 `--version`。媒体程序构建和资源发布与这次加载重叠；正式代次直接链接同一个对象，避免预热后再复制出另一个文件。加载期间持有操作系统文件租约；构建被终止后，后续发布能回收遗留的临时链接和无引用对象。Cargo 的可变输出没有被硬链接，声明式资源仍是单链接副本。初步直接预热 Cargo 输出的方案出现过 `29–53 s` 长尾，已拒绝，原始结果保留在 `round2-final-*`；上表仅使用最终同文件方案的完整五次结果 `round2-frozen-*`。
- Windows 本地 socket 改用就绪通知，消除读写固定睡眠与监听轮询的额外延迟；超时和维护时限仍由原 owner 保持。Main 只允许最新的连接获取请求附加端口，过期请求不能在长重启后再替换新连接。发布目录仅对 Windows 短暂共享或访问错误做有限重试，失败时保留旧指针。

这些改动留在同一套代码中：公共构建流程与连接生命周期共享；Windows 的 socket 适配、映像预加载和 x64 链接器配置按平台选择，不维护 Windows/macOS/Linux 分支。没有冷构建、macOS/Linux 或 ARM64 的性能结论，也没有新的编辑构建 RSS 结论。当前核心 Cargo 组构建仍约 13 秒，其中链接进程约 2.9 秒，是后续时间下限的一部分。

补充租约回收验证期间，工作区 HEAD 更新至 `131825f93b0fd9bf3e37ef9b075808a5a474b1cf`。跨越这次更新、触发大量依赖重建而超时的 `round2-pinned-*` 没有有效样本，予以排除。在当前代码完成全部 21 个后端程序与前端构建、恢复缓存后，同一脚本重新完成五次编辑：`28.03 / 27.60 / 27.90 / 30.34 / 30.18 s`，中位数 `28.03 s`。这五次单独作为当前版本验证，不与上表同一 HEAD 的前后对照混合，也不据此计算新的加速比例。

回归验证包括 Windows `ash-uds` 的 5 项、transport 的 21 项、daemon 的 48 项测试及对应检查和 warnings；修改的 Python 构建模块 19 项测试、scripts 的 196 项测试（7 项跳过）；当前版本 Main 2,684 文件、Renderer 4,203 文件、automation 2,871 文件的类型检查，以及格式和 diff 检查。没有完整 build Python 测试套件通过的结论。Rust 定向验证在对照阶段完成，当前 HEAD 另完成正常全部后端构建。

双窗口开发运行时 smoke 在对照阶段连续三次通过；当前 HEAD 首次验证又发现 Agents 启动时语言服务间接解析宿主服务，早于 context keys 注册而失败，已把语言服务的创建移到该窗口 context keys 注册之后。修复后连续三次全部通过（`44.7 / 43.1 / 46.1 s` 为整个测试时间），日志 `final-head-smoke-fixed.log`。启动超时保持 30 秒、整个测试上限保持 120 秒；验证两窗口连接代次准确增长一次、订阅不重复、草稿保留、重启后精确搜索新文件内容和旧运行时代次回收，没有通过增加超时规避失败。

原始样本、同一测量脚本的 SHA-256、各组源码指纹、失败日志与阶段统计见 `.build/perf-win-edit-20261018/round2-summary.json`、`round2-baseline-edit-ready.json`、`round2-baseline-extra-edit-ready.json`、`round2-frozen-edit-ready.json`、`final-head-edit-ready.json` 和 `round2-*-phases.json`。`round2-final-pe.json` 和 `final-head-pe.json` 对照了全部 21 个程序的 PE 架构、安全标志、子系统和 8 MiB 栈预留，均保持一致。不把预热、失败尝试或临时诊断计入成功样本。

#### Windows x64 剩余编辑等待与外部实践核对（2026-10-18，第三轮）

目标是继续缩短 Rust 保存到已有窗口能搜索新内容的完整时间，尝试达到 15 秒。机器、Rust 1.98.0、LLD、`dev-small`、16 jobs、普通优先级、正常共享缓存和全部 21 个后端程序与第二轮一致；本轮 HEAD 固定为 `131825f93b0fd9bf3e37ef9b075808a5a474b1cf`。不把第二轮旧 HEAD 的 29.10 秒直接作为新候选的对照。

交替对照仍使用真实 Electron、实际 watcher、实际 Rust 常量编辑和重连后的新文件精确搜索。每个样本采用此前未编译过的常量值，记录不同 exe 的 SHA-256；固定其余源码、HEAD 和测量脚本，检查没有 Cargo 锁等待、每次只有一个 App Server 链接。`edit-ready-round3.mjs` 的 SHA-256 为 `6ea3055d4a736cfe8e170974ae47bf4bf8d2d7d3e7a07cf1067777ec9b906f2d`。预热与恢复源码后的重建不算成功样本。没有通过删共享缓存、提高优先级、关闭安全防护或放宽 smoke 超时制造收益。

先核对公开项目的实际源码，而非把其设置视作通用最优值。以下链接为本次检索时的上游分支状态，后续可能变化：

| 参考                                                                                                                                                                          | 查到的具体做法                                                                                                                                           | 对本轮的约束与判断                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex Cargo profiles](https://github.com/openai/codex/blob/main/codex-rs/Cargo.toml) 与[组包说明](https://github.com/openai/codex/blob/main/scripts/codex_package/README.md) | `dev-small` 使用零级优化、关闭调试信息并剥离符号；组包可接受已经构建的入口和辅助程序，避免再次构建。                                                     | Ash 已使用单独开发 profile 和复用产物；App Server 零级优化仍须测量完整循环，其较大 exe 可能抵消编译收益。                                                                                                                       |
| [Zed Cargo profiles](https://github.com/zed-industries/zed/blob/main/Cargo.toml)                                                                                              | 开发模式启用增量编译、16 CGU、有限调试信息；显式对齐 build-override，并选择性优化过程宏。                                                                | Ash 的增量编译已启用，开发模式关闭调试信息，且已有 16 CGU 与 App Server 256 CGU 的选择性设置。当前编辑仅重编译 App Server 库和 bin，不存在每次重编译数百构建依赖的证据；此前构建依赖 profile 对齐也未证明收益。                 |
| [Warp Cargo profiles](https://github.com/warpdotdev/warp/blob/master/Cargo.toml) 与[开发入口](https://github.com/warpdotdev/warp/blob/master/script/run)                      | 开发模式减少调试信息并选择性优化热点依赖；若干本地服务开关从 Cargo features 移至环境变量；Windows/Linux 直接 `cargo run`，macOS 分派至 App bundle 脚本。 | 核查运行配置是否不必要地改变编译图。Ash 的四个功能组是隔离语音/设备宿主依赖，不应为减少命令数合并；本轮日志只出现一次 App Server 重编译和链接。共用源码与入口，平台差异放在 target 配置和平台实现中，无须维护三个操作系统分支。 |
| [Warp 的 WASM 体积优化](https://www.warp.dev/blog/reducing-wasm-binary-size)                                                                                                  | 调整编译选项并异步加载资源，针对浏览器首次下载和加载成本。                                                                                               | 这是 WASM 发布场景，不证明 Windows Rust 编辑循环提速；不能据此给开发 profile 加 LTO。                                                                                                                                           |
| [Claude Code 官方仓库](https://github.com/anthropics/claude-code)                                                                                                             | 提供安装、插件和问题报告入口。                                                                                                                           | 本次没有取得可核验的内部 Rust 开发构建流程，不能把产品响应速度当作大型 Rust 项目的编译证据。X 定向检索未取得可用的相关原始帖子，未用二手转述补结论。                                                                            |

[sccache 官方限制](https://github.com/mozilla/sccache#rust)说明增量编译 crate 与需要链接的可执行目标不能缓存，因此没有为这个热编辑场景关闭增量编译来强行启用缓存。[Cranelift 官方支持说明](https://github.com/rust-lang/rustc_codegen_cranelift#not-yet-supported)显示 Windows x64 已支持，但 Windows panic 展开仍不支持；没有将 Ash 的默认工具链改成 nightly 或改变 panic 行为。[Microsoft Dev Drive](https://learn.microsoft.com/windows/dev-drive/)支持把 Rust 缓存与构建输出放到专用开发卷；其 Defender performance mode 要求实时保护开启且仅适用于 Dev Drive。这是后续主机存储实验的候选，本轮未创建卷、迁移 checkout 或修改安全配置，也没有测得其收益。

诊断记录显示，App Server 库一次耗时约 10.74 秒，其中前端约 6.37 秒、代码生成约 4.37 秒；bin 单元约 5.23 秒，包含编译和链接，不能全部算作链接。冻结不可变 exe 约 0.3 秒。新字节 exe 的首次 `--version` 加载在同一个慢诊断中达 15.21 秒，与后三个 Cargo 功能组和资源复制重叠。资源共 2,197 个文件、23.7 MB，一次慢样本复制耗时 10.84 秒，发布锁内回收旧代次耗时 4.41 秒；后续安静样本复制约 1.9 秒、回收约 0.45 秒。这些是诊断样本，不是可以相加得到的稳定时间下限，也不据此把 Windows 首次映像加载延迟归因于特定安全组件。

| 候选                                                                | 原始完整时间（秒）                                     | 结果                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Windows App Server 零级优化                                         | 34.93 / 34.24 / 33.95                                  | exe 从约 168.3 MB 增至 196.7 MB，未保留。                             |
| 一级优化，同时提前准备资源、移出锁内回收，交替三对                  | 基线 31.26 / 31.36 / 31.40；候选 32.66 / 32.89 / 31.76 | 中位数 31.36 → 32.66 秒，回退，未保留。                               |
| 保持原优化级别，提前准备资源、4 worker 复制、移出锁内回收，交替三对 | 基线 32.80 / 30.63 / 29.92；候选 30.60 / 30.37 / 30.47 | 中位数 30.63 → 30.47 秒，仅约 0.16 秒，未证明足够稳定的收益，未保留。 |
| RPC JSON 编解码类型擦除，交替三对                                   | 基线 31.51 / 32.94 / 32.60；候选 33.95 / 34.53 / 34.42 | 中位数 32.60 → 34.42 秒，慢约 5.6%，未保留。                          |

原始 COFF 符号分析发现 App Server 库含 61,169 个函数 section，其中 23,709 个符号名包含 Serde；按函数 section 计的机器码分别约 21.66 MB、6.67 MB。这只能定位泛型生成代码的调查方向，不等于这些时间和字节全部属于 JSON 编解码。[Cargo 对泛型实例化位置的说明](https://doc.rust-lang.org/cargo/reference/profiles.html#overrides-and-generics)也说明，只优化提供泛型的依赖不一定改变消费 crate 的生成成本。因此另测了通过 [erased-serde](https://github.com/dtolnay/erased-serde)共享 RPC JSON 编解码的候选。只擦除编码的探索样本为 44.42 / 29.81 / 32.00 秒；同时擦除编解码的探索样本为 28.88 / 27.67 / 27.58 秒，但这个优势在上表交替三对中没有复现。已恢复全部五个原文件，撤回新依赖、lockfile 和 RPC 修改，没有为不足的收益承担新的动态分派成本。

资源并行候选的发布前中位数为 24.30 → 23.12 秒，但发布后完成搜索为 6.33 → 7.25 秒，完整时间只改善约 0.16 秒；无改动入口为 8.40 → 8.71 秒。不能把发布前的局部节省单独当作开发体验收益。Serde 对照的发布前中位数为 26.52 → 28.51 秒，发布后为 6.17 → 5.91 秒，实际链接为 2.55 → 2.94 秒。本轮各阶段均来自对应的完整样本，不把不同样本的中位数相加作为一个真实样本。

本轮没有保留新的运行时或 Cargo 优化，15 秒目标未达到；恢复此前第二轮实现。后续若要继续明显缩短等待，需要实测缩小业务编辑所失效的编译单元，或改变主机文件/映像加载路径的成本，不能仅凭其他项目的参数承诺减半。不要为这个目标另建 Windows/macOS/Linux 源码分支；共享的构建图与业务边界调整可共用，链接器和必要系统适配按目标选择。

恢复后正常全部 21 个后端程序构建通过，相关 Python 测试 19 项通过；双窗口重启 smoke 再次通过（用例 53.6 秒，整个运行 54.2 秒），启动超时仍为 30 秒、用例上限仍为 120 秒。21 个 exe 的 PE 架构、程序属性、安全标志、子系统及 8 MiB 栈预留与先前基线一致，App Server 为 168,309,760 字节。最后确认没有本轮 watcher、测量 Node/Python 或 Cargo/rustc 进程；没有清除共享编译缓存。证据为 `round3-final-normal.log`、`round3-final-python.log`、`round3-final-smoke.log`、`round3-final-pe.json` 和 `round3-rollback.json`。发现一个候选遗留的资源暂存目录（bin 为空），自动审批拒绝删除，已保留，不能报告全部暂存目录清理完成。

同文件重复启动的映像缓存探针显示，已知内容新副本首次运行约 2.46 秒，同文件重复运行约 0.034 秒；在同一文件末尾改动无害 PE 尾部字节后首次运行仍达 7.84 / 11.76 秒。相同新字节的另一副本约 2.48 秒。因此未采用覆盖同一 exe 文件以复用加载缓存的方案。原始五次探索基线为 33.89 / 65.65 / 58.31 / 53.90 / 65.05 秒，存在未解释的长尾，且最后一轮与本次发起的 Windows 性能计数器查询重叠；另一次探索候选最后一轮与小型 rustc 参数探针重叠。这些日志完整保留，均未拿来宣称配对加速。

全部本轮脚本、失败/探索日志、Cargo timings、COFF 分析、映像探针和逐轮摘要位于 `.build/perf-win-edit-20261018/round3-*`。汇总为 `round3-summary.json`；三组交替候选的主体数据分别为 `round3-pair-*-edit-ready.json`、`round3-final-pair-*-edit-ready.json` 和 `round3-erased-pair-*-edit-ready.json`。仅测 Windows x64 热编辑场景；没有新冷构建、全应用 RSS 或其他平台的性能结论。

#### Windows x64 单独一级优化复测（2026-10-18，第四轮）

在 HEAD `0ef650faaf2e7965821cd6278399991185e94a75`，继续使用同一台 Windows x64、Rust 1.98.0、LLD、`dev-small`、默认 16 jobs、普通优先级和共享 `.build/cargo`。第三轮的一级优化与资源流程一起测量；本轮只在 `[profile.dev-small.package.ash-app-server]` 增加 `opt-level = 1`，不叠加其他构建或运行时改动。原设置继承该包的 `opt-level = "s"`。

先完成当前源码的正常后端与前端准备，再按原参数三次、候选三次、恢复原参数三次的顺序测量。沿用第三轮同一个 `edit-ready-round3.mjs`，SHA-256 仍为 `6ea3055d4a736cfe8e170974ae47bf4bf8d2d7d3e7a07cf1067777ec9b906f2d`；通过真实 Rust watcher 分别把 diff 输入上限增加 821–823、901–903、831–833 字节，每次使用未编译过的值。计时包含源码保存、四组 Cargo、发布、已有窗口重连和准确的新内容搜索。每次均只有一个 App Server 重编译和一次链接，没有 Cargo 锁等待；前后基线的构建输入指纹完全相同。预热和恢复源码后的构建不计入样本。

| 配置             | 完整可用时间，三次原始秒数 | 完整中位数 | 发布前中位数 | 发布后中位数 | 核心 Cargo 组中位数 | 链接中位数 |
| ---------------- | -------------------------- | ---------: | -----------: | -----------: | ------------------: | ---------: |
| 原参数，候选之前 | 32.06 / 31.79 / 29.28      |    31.79 s |      23.96 s |       7.84 s |             13.45 s |     3.03 s |
| 只改一级优化     | 67.34 / 29.53 / 29.16      |    29.53 s |      23.84 s |       6.18 s |             13.66 s |     3.11 s |
| 恢复原参数       | 36.98 / 29.71 / 32.05      |    32.05 s |      24.44 s |       5.88 s |             14.00 s |     3.11 s |

核心 Cargo 组包含 App Server 编译、链接及同组的其他程序检查，不能当作纯 Rust 前端或纯代码生成时间。各阶段分别取中位数，不能相加当作一个完整样本。候选的完整中位数较低，但范围重叠，原参数也能达到 29 秒左右；发布前和核心 Cargo 组没有相应的明显改善，候选另有一次未解释的 67.34 秒长尾。该长尾保留在全部统计中，没有剔除。这个三组探索对照不足以证明稳定的完整循环收益，也不用于宣称确定的回退百分比。候选 exe 为 171,922,432 字节，原参数为 168,318,976 字节，增加约 2.14%。本轮撤回一级优化，保留第二轮实现；15 秒目标仍未达到。

两次准备失败单独保留：首次启动与前端重建重叠，HTML 尚未生成；随后一次因先使用 `--protocol-prepared`、再生成当前前端协议，后端仍返回旧 schema hash。均无有效编辑样本。改用正常 `build/desktop/develop.py` 准备后，当前协议一致，九次正式编辑全部完成。不能把这些准备失败、预热或恢复构建纳入性能结果。

本机卷清点均为 NTFS，没有 Dev Drive；未创建卷、迁移检出或修改安全设置。源码检查仍显示主库同时包含请求适配与宿主装配；把一个小适配器移入上游 crate 仍可能触发主库重编译，不能仅凭拆分文件或增加 crate 宣称缩小完整失效路径。领域边界调整及 Dev Drive 仍无本轮性能结论；没有新的冷构建、RSS、其他平台或发布性能结论。

源码常量和 `Cargo.toml` 均已逐字恢复，恢复时保留新的文件修改时间。最终正常全部 21 个后端程序构建通过；`pnpm run build` 完成 Main 2,685 文件和 Renderer 4,205 文件类型检查及正常前端构建。`pnpm run smoketest-no-compile test/smoke/areas/windows/development-runtime.spec.ts --grep 'Rust publication reconnects Workbench and Agents once' --max-failures=1` 通过，1 项用例 57.2 秒，整个运行 57.9 秒；保持原有启动和测试超时，验证双窗口重连、订阅、草稿、新内容搜索和旧代次回收。全部生产候选已撤回，没有新增测试实现；本轮验证使用已有重启场景覆盖恢复后的正常行为。

原始九次结果、相同测量脚本、源码与构建输入指纹、逐次链接进程和 watcher 日志在 `.build/perf-win-edit-20261018/round4-*`；汇总为 `round4-summary.json`，最终构建和 smoke 为 `round4-final-normal.log`、`round4-final-smoke.log`。确认无本轮 watcher、测量或 Rust 构建进程。旧资源暂存目录及五个测量临时目录的删除被自动审批策略阻止，均保留，准确路径见 `round4-cleanup.json`；不能报告清理完成。共享编译缓存未清除。

#### Windows x64 按 diff 领域缩小编译失效范围（2026-10-18，第五轮）

本轮固定 HEAD `0ef650faaf2e7965821cd6278399991185e94a75`，继续使用同一台 Windows x64、Rust 1.98.0、LLD、`dev-small`、默认 16 jobs、普通优先级及共享 `.build/cargo`。没有调整现有 profile 参数；新包继承拆分前 App Server 的相同包级覆盖，保持优化、调试信息、增量编译、panic 和代码生成单元设置。第三方依赖版本及校验和没有变化。

选取现有无状态 diff 请求适配边界：算法仍归 `ash-diff`，JSON 参数解码、512 KiB 单侧输入预算、UTF-16 范围适配和协议错误映射移至 `ash-app-server-diff`。仅把实现移到上游包仍使原 App Server 主库重编译，完整循环没有改善。因此让原目录 `crates/app-server` 编译为 `ash-app-server-runtime`，保留服务、连接、目录准入、队列和状态的所有权；新增 `crates/app-server-host` 作为薄装配入口，以无状态函数指针传入具体 diff 实现。产品包、可执行文件名称及 `open_app_server*`／`run` 入口签名保持原样；直接构造底层 `AppServer::new` 的调用者须显式提供处理函数。产品入口及其原有进程测试移动到 host 包。运行时仅在测试依赖中引用具体适配器，正常依赖图不再包含它。

测量继续使用真实 Rust watcher、四组 Cargo、全部 21 个后端程序、实际代次发布、已有 Electron 窗口重连和新文件内容的精确搜索。计时从写入 Rust 源码前开始，不以编译结束或进程启动代替可用。沿用第三轮脚本，仅增加 `ASH_PERF_SOURCE` 以选择移动后的适配器；`edit-ready-round5.mjs` 的 SHA-256 为 `e827cedf8b6060ee94ee51387c59ebd8ccb4faef6ac5cfec75ea071ae3f4fbc7`。依次测量三组，每组使用此前未编译过的输入上限值（分别增加 1001–1003、1101–1103、1201–1203 字节）；每次确认新的 exe SHA-256、一次链接、无 Cargo 锁等待、组内源码输入指纹不变。源码在退出时恢复，并保留新的修改时间；准备与恢复构建不计入样本。

| 编译依赖方向                       | 完整可用时间，三次原始秒数 | 完整中位数 | 发布前中位数 | 发布后中位数 | 核心 Cargo 组中位数 | 链接中位数 |
| ---------------------------------- | -------------------------- | ---------: | -----------: | -----------: | ------------------: | ---------: |
| 原 App Server 主库                 | 46.14 / 29.97 / 29.76      |    29.97 s |      24.03 s |       5.95 s |             13.92 s |     3.08 s |
| 主库依赖独立 diff 适配器           | 30.84 / 30.21 / 32.16      |    30.84 s |      24.41 s |       6.43 s |             14.22 s |     3.11 s |
| 薄入口并列装配运行时与 diff 适配器 | 25.63 / 24.92 / 25.27      |    25.27 s |      17.14 s |       8.34 s |              6.86 s |     3.03 s |
| 最终源码与构建引用同步后复测       | 25.40 / 31.21 / 24.96      |    25.40 s |      16.99 s |       8.14 s |              6.80 s |     3.00 s |

依赖倒转组和最终复测的 watcher 日志都只编译 `ash-app-server-diff` 和薄 `ash-app-server`，没有编译 `ash-app-server-runtime`。倒转后的完整中位数较本轮基线缩短约 15.7%；最终源码复测中位数为 25.40 秒，较本轮基线缩短约 15.2%，核心 Cargo 组为 6.80 秒。链接仍约 3 秒，未明显改善。发布后的等待增大，不能用核心编译节省量代替完整体验收益，也不能相加各阶段中位数。基线的 46.14 秒长尾保留；这是顺序预热样本组的测量，不是冷构建或严格交替配对实验。该结果仅覆盖 diff 适配器的真实业务编辑，不能推广为所有 App Server 业务修改都会达到 25 秒。

最终复测使用同一个测量脚本及新的输入上限值（增加 1301–1303 字节），源码输入指纹为 `c45b48470b37302c67926b38965e6b28237e968fc68179f8a721d1f0cae48fc3`。测量前所有 Rust 校验进程已退出，先完成正常后端准备，未改前端或测量期间的其他构建输入。第二次的 31.21 秒完整长尾也保留：发布前 16.88 秒，发布后 14.33 秒，不能把这一差值归因于 Rust 编译。三次均没有缓存回收或 Cargo 锁等待，均有不同 exe SHA-256 和一次链接。退出后输入上限恢复为 512 KiB，再次正常构建全部 21 个后端程序并发布通过，证据为 `round5-final-normal.log`。

15 秒目标仍未达到；它是沿用 TODO 的体验目标，不是测量推导的性能下限。本轮保留经过实际失效日志与完整循环支持的领域边界调整，并按用户要求停止继续试验。其余仍处于共享运行时的业务编辑尚无相同收益结论；若后续重新开启，需根据链接、发布、新映像加载和重连的实测成本选择方向。本轮没有创建卷、迁移检出、改变安全设置或增加测试超时，没有新的冷构建、全应用 RSS、其他操作系统或发布性能结论。

原始样本、逐次源码指纹、链接进程、Cargo timings、watcher 日志和阶段统计保留在 `.build/perf-win-edit-20261018/round5-*`，汇总为 `round5-summary.json`。组内输入指纹分别为 `4855d908c14dfb330f251b536add946c9f76ff9d375b16d1a958d8e0e93c7d57`、`2cddf87f1f1ab5da9bdc21dad62f9ef281df5d826c136ce92be4900e9f6ccfc0`、`b891db48a57681999fb24a676c6a7959136e7e78602fa89efc5c476a18ea5302`。后续同步了默认构建入口、Bazel／CI／测试工具引用和依赖约束，清理无调用者的测试依赖并补充回归；不把这些校验工作计作额外性能收益。

验证使用仓库现有包装命令：`just verify ash-app-server-diff --lib` 的 3 项适配器测试、`just verify ash-app-server-runtime --lib --filter diff_operations` 的 2 项分派回归、协议包 3 项依赖图回归，以及产品入口 stdio／WebSocket／schema 的 6 项测试全部通过。`just test-processes ash-app-server --test managed_lifecycle --test managed_initialize` 的 11 项真实托管进程测试通过。运行时、适配器、产品、App Server Client 和 Remote Server 的相关 check／警告检查通过；没有用无测试匹配的命令代替执行证据。

依赖检查覆盖 220 个 workspace 成员、87 项已审核多版本包，`just dependencies` 通过。包更名后的依赖约束继续禁止 daemon 反向依赖共享运行时，以及 Core 契约或 Code Mode 客户端越过原有实现边界。测试包装器继续为运行时单元测试准备 Markdown Math 和 LLDB 辅助程序。`just test-python scripts` 最终 197 项通过（跳过 7 项）；首次脚本套件因缺新包 Bazel 注册失败、首次调用方编译因 Remote 两处测试缺 `read_access` 失败，均已修复并重跑相应验证。Bazel BUILD 注册与 CLI 二进制标签已同步，注册测试通过；本机没有 Bazel／Bazelisk，未执行 Bazel query 或构建，不宣称该路径已通过。

目录运行时回归执行 12 项，11 项通过；`ide_windows_are_discovered_across_real_profile_directory_runtimes` 失败。该测试与未修改的 IDE 处理逻辑混用了 Windows 普通路径和标准库 `canonicalize` 的 verbatim 路径：初次根预期断言失败，诊断性修正预期后仍被现有 `validate_context` 拒绝为 `InvalidParams`。两处试探性测试修改均撤回，没有为构建优化扩展修改 IDE 授权逻辑；该轮失败不计作通过，日志 `round5-runtime-registry*.log` 保留，后续独立修复见下段。一次错误的 `just test --filter` 调用被 Cargo 参数解析拒绝，随后使用位置过滤器执行了上述 12 项测试，也未把参数失败计作测试通过。

2026-10-18 在源码基线 `ff00a9e3063613ddde2dc6226aaaa9a86addd983` 上独立修复 IDE 路径一致性：上下文校验与策略过滤沿用目录 owner 的 `dunce::canonicalize`，原始文件名仅用 `dunce::simplified` 统一可安全转换的 Windows 前缀，仍同时检查原始相对路径与解析后目标的读取策略。测试根预期改为 `Dir::canonical_path`，跨目录回归同时断言选区、打开标签与脏文件。Windows 11 build 22631／x64 上先复现原始断言失败，再运行 `just verify ash-app-server-runtime --lib --filter ::ide`：14 项 IDE 回归、生产 check 与全目标零 warning 检查通过，覆盖普通／verbatim 路径、目录外拒绝和 denied buffers；Unix 专属符号链接回归保留但本机未运行。正常库构建 `python -B scripts/cargo.py build -p ash-app-server-runtime --lib --profile ci-test` 也通过。日志为 `.build/ide-context-baseline.log`、`.build/ide-context-verify.log` 与 `.build/ide-context-build.log`；这项正确性修复不计入开发循环的性能收益。

验证期间，仓库现有缓存预算自动回收了 14.56 GiB 空闲缓存（`round5-runtime-registry-fixed.log`）；没有手动清理共享缓存。正常全部后端构建随后重新确认了开发产物，这段测试验证和准备耗时不计入编辑样本。另在复核日志时确认，基线首个 46.14 秒样本包含正常预算自动回收 1.69 GiB 的耗时，已完整保留，没有扣除；其余两次基线约 29.97／29.76 秒。该维护事件使首个样本的负载不完全匹配，不能把顺序样本的百分比解释为严格受控或冷构建收益。

正常全部 21 个后端程序的 PE 架构、程序属性、安全标志、子系统和 8 MiB 栈预留与既有 LLD 基线一致（`round5-final-pe.json`）；App Server 为 168,348,672 字节。最后确认输入上限已恢复，无本轮 watcher、测量或 Cargo／rustc 进程。诊断与测量临时目录保留，没有绕过此前的自动删除审批拒绝。

#### App Server 启动模型迁移保留历史按需加载（2026-10-19）

源码复核发现，`open_app_server_with_codebase_providers` 的旧模型 provider 迁移调用 `ThreadController::list_threads()`，在每次打开目录运行时时读取全部 Thread 的完整快照；没有实际迁移时仍执行全量读取与快照克隆。这会抵消 `LocalStateRepository` 对普通历史的按需加载。

Core 现在随原有事件 batch 原子写入 `ThreadCatalogRecord.resumable_model_providers`，记录 Agent 角色、基础指令、Advisor 和未结束 Turn 的模型选择所引用的 provider。迁移先筛选轻量目录，只加载命中旧标识的 Thread，并继续通过原有 `ModelProvidersMigrated` 事件提交变更。已完成调用及其历史模型事实保持原样。

该字段是可重建的派生索引，旧目录缺失字段时从权威历史补齐；不增加全局“迁移已完成”标记，因此后来导入或新增的旧模型选择仍能被识别。目录记录格式保持兼容，补索引不改写旧事件。正常入口继续检查目录索引，不把检查移到只执行一次的构造函数中。

Windows x64 上先用 Core 回归复现原实现加载无关历史的失败，再完成 3 项 Core 迁移回归、`just verify ash-state --lib --filter model` 的 6 项回归、`just verify ash-thread-store --lib` 的 3 项回归，以及 `just verify ash-app-server-runtime --lib --filter model_provider_migration` 的初始化回归。最后一项通过实际 App Server 组合入口跨两个目录打开同一 profile，确认 24 条空闲历史保持未加载；再新增旧 provider 选择，确认只加载并迁移对应的 1 条 Thread。Core／State／Thread Store／App Server 的生产 check 与全目标 warnings 均通过；`scripts/.venv/Scripts/python.exe -B scripts/cargo.py build -p ash-app-server --bin ash-app-server --profile ci-test` 正常产品构建通过。验证摘要及源码指纹为 `.build/app-server-migration-validation.json`，后端验证与最终构建日志为 `.build/app-server-migration-*.log`。

以上是修复时的正确性验证；后续完整开发循环复测如下。

#### Windows x64 启动模型迁移修复的完整循环复测（2026-10-19）

在 `3df4938dac9ed7e40e73bf7019394595dfcf19e8` 加上上述未提交修复，暂停同检出的开发与同步任务后测量。前后仅切换 `thread_controller.rs`、`thread_reducer.rs`、`thread-store/src/store.rs` 的迁移实现，其余 Rust／构建输入保持一致。使用同一台 i5-12600KF／16 逻辑处理器、Windows 11 build 22631、Rust 1.98.0、LLD、`dev-small`、默认 16 jobs、普通优先级和共享 `.build/cargo`，没有清理共享缓存或修改系统安全设置。

每个版本先正常预热全部后端，再分别在空 profile 和历史 profile 连续尝试 5 次。历史种子由真实 Core／SQLite 写入：100 条 Thread、2,000 个已完成 Turn、10,100 个事件、16,384,000 字节回答文本，数据库 47,869,952 字节；目录派生索引已经存在，测量不包含旧目录首次补索引。各组从同一种子独立复制，初次启动与首次搜索不计入热编辑时间。

通过真实 `build/desktop/watch-app-server.ts --skip-initial` 保存 diff 输入上限的新常量值，计时从写源码开始，包含四组 Cargo、代次发布、已有 Electron 窗口重连及准确的新文件内容搜索。只看到 `ash.appServer.initialized` 不算可用：搜索必须返回且高亮本次唯一 token。搜索仍沿用原有 30 秒断言，失败保留，未增加产品或测试超时。

| 场景           | 修复前原始完整秒数                    | 修复后原始完整秒数                    | 成功样本中位数  | 成功次数，前 → 后 |
| -------------- | ------------------------------------- | ------------------------------------- | --------------- | ----------------- |
| 空资料库       | 20.71 / 19.84 / 20.26 / 20.06 / 19.66 | 20.64 / 20.22 / 19.57 / 19.80 / 19.65 | 20.06 → 19.80 s | 5/5 → 5/5         |
| 100 条历史会话 | 23.39 / 21.34 / 22.27 / 失败 / 失败   | 20.69 / 21.15 / 21.83 / 21.16 / 20.63 | 22.27 → 21.15 s | 3/5 → 5/5         |

空库中位数仅缩短 0.26 秒（1.3%），范围重叠，未证明明显收益。历史场景的成功样本中位数缩短 1.12 秒（5.0%）；这只能说明本轮有小幅改善，不能用 3 个成功基线样本和 5 个成功候选样本推导稳定的总体延迟或失败率改善。两个基线失败分别在保存后 49.76／49.60 秒结束：后端约 19.8 秒已初始化，随后搜索在原有 30 秒断言内持续返回 `SearchUnavailable`，没有将失败时间当作可用时间。

| 阶段中位数           | 空库，前 → 后   | 历史，前 → 后   |
| -------------------- | --------------- | --------------- |
| 保存至发布           | 14.05 → 13.81 s | 13.81 → 13.73 s |
| 发布至完成新内容搜索 | 6.05 → 5.97 s   | 8.46 → 7.43 s   |
| 核心 Cargo 组        | 5.59 → 5.48 s   | 5.55 → 5.49 s   |
| 实际链接             | 2.45 → 2.45 s   | 2.50 → 2.42 s   |

阶段各自取中位数，不能相加当作一个实际样本。20 次均只重编译 `ash-app-server-diff` 与薄 `ash-app-server`，每次一个链接、不同 exe SHA-256，无 Cargo 锁等待、缓存预算回收或额外源码变动。核心编译基本未变；本次修复的观测收益主要出现在历史场景的发布后恢复阶段。修复后距离 15 秒仍差空库 4.80 秒、历史 6.15 秒，即还需缩短当前完整时间约 24.2%／29.1%。这不是测量推导的性能下限，也不是所有 Rust 业务编辑的结果。

历史组仍有独立的请求准入问题：修复前日志出现 21 次请求上限错误及 2 次工作区恢复失败；修复后虽 5 次搜索均通过，仍有 18 次请求上限错误。`AppServerProtocolClient.requestRaw` 在 pending 达到 128 时立即拒绝，`rendererApi` 的工作区恢复会记录这类失败。本次未修改客户端准入或恢复逻辑，不能宣称该问题已解决；后续应复测历史恢复时的请求调度与工作区恢复可靠性。

为防其他前端构建改变对照，测量使用 `.build/pm21` 的编译前端副本，2,810 个文件前后 SHA-256 一致；真实 Rust 源码、watcher、Cargo 缓存与发布目录仍在本检出。两版都临时固定 `ASH_BUILD_COMMIT` 为同一源码提交，避免 `.git/packed-refs` 更新时间单独触发 build-identity 重编译，未更改编译参数。正常结束后撤去该变量，恢复三个修复文件及 512 KiB 输入上限并保留新修改时间，正常全部 21 个后端程序构建与发布通过。当前前端完整构建也通过。

证据位于 `.build/perf-win-edit-20261019-migration/`：`q2-summary.json`、`q2-diagnostics-summary.json`、`q2-progress.json`、`q2-*-edit-ready.json`、watcher 日志、链接进程与 Cargo timings。汇总核对了同一 HEAD、测量脚本、组内源码指纹、归一化输入指纹、种子及前端副本。`edit-ready-q2.mjs` SHA-256 为 `12e16bdb6f53e3bf7401dd3b1a35cc55962728250c525e692543cc30a9206cab`；归一化输入为 `128e784cca53c4c39394d93885c58d4492e3902dfeb23d9839a43e525b9c22fe`。先测基线再测候选，样本量有限，未进行交替随机实验或冷构建／RSS／其他平台测量。

此前的 `candidate-*`、`v2-*`、`retry*`、`frozen-*`、`quiet-*` 尝试均保留。它们分别受到 Git refs 更新、Cargo 锁、前端重建或外部 rebase 的影响，其中 `quiet-*` 在候选空库第 4 次被输入守卫中止；没有将这些组混入本次匹配对照，也没有把不同源码上此前约 25 秒的结果当作本次修复基线。

#### 2026-10-21：Windows x64 Rust 模块热更新原型

在当前检出 `937af130ec21b2c9a213250ce165eee722c078f2` 加本轮修改、同一台 i5-12600KF Windows x64 上验证 `ash-build`。使用固定 Rust 1.98.0、LLD、现有静态 CRT 和 `dev-small` 参数；正式宿主与开发模块均由官方 Cargo/rustc 构建。没有接入 ra-jit 的分析或代码生成核心，没有函数级编译结论。

预热后分别修改 diff 输入上限的常量，每次使用新值。对照通过正常 `scripts/cargo.py` 重建启用 `rust-live` feature 的 App Server，但进程不设置模块目录，再启动 stdio RPC 并确认新上限生效；候选调用模块构建入口，在同一个运行中的 stdio App Server 上确认相同种类的行为变化，同时验证 Unicode UTF-16 范围保持一致。两边各做一次校准后记录三次有效样本，所有长尾保留：

| 路径                      | 保存至新规则生效，三次秒数 |  中位数 | 构建入口耗时中位数 |
| ------------------------- | -------------------------- | ------: | -----------------: |
| 宿主重建与 stdio 进程重启 | 79.07 / 14.99 / 18.19      | 18.19 s |             6.93 s |
| 模块增量构建与原进程装载  | 3.98 / 4.10 / 3.99         |  3.99 s |             3.99 s |

上述构建入口耗时包含包装器、Cargo 和链接，不是纯 rustc 时间。79.07 秒样本中构建入口占 67.70 秒，其长尾原因未定位。候选先测、对照后测，各自的原生依赖图均已预热，未进行随机交替配对，不能用这一组小样本承诺稳定加速比例。对照日志每次仅重编译 diff 适配器和薄 App Server，候选仅重编译适配器与动态模块；完整宿主首次准备和模块首次准备不计入热编辑样本。没有清理共享 Cargo 缓存或改变系统安全设置。

另通过真实 `watchAppServer` 路径分别保存一次输入上限修改和一次 `zero_based_line_index` 函数体修改，从落盘到原 stdio 进程返回新规则／新行号分别为 5.02 秒和 6.08 秒，PID 各自保持不变，宿主未重建或重启。它们是单次功能验收，不能充当稳定延迟上限；也不是 Electron 窗口的完整交互测量。第一轮 watcher 验收失败后定位到 Windows Python 启动器继承正在读取的 stdin 管道而阻塞；后台构建关闭 stdin 后上述两个场景通过，首次失败日志保留。

模块路径实际触发了 rustc 的 E0382 借用检查错误，确认发布指针不变且上一最新规则仍可调用。原生 DLL 回归覆盖并发旧调用跨越替换、ABI 不匹配、校验和损坏、非法／过大／缺失清单和 panic 边界；领域适配器回归核对 JSON ABI 的返回结果与错误。试验常量、函数体和错误源码均已恢复，正常模块及宿主恢复构建通过。此次没有冷构建、RSS、发布构建、其他系统或完整 Electron 窗口的性能结论。

原始计时、构建日志、stdio 日志、PID 和源文件摘要在 `.build/build-health/rust-live-20261021/`，主记录为 `results.json`、`watcher-result.json` 与 `function-watcher-result.json`。复现实验脚本为 `.build/ash-build-eval.py`、`.build/ash-build-watch-eval.mjs` 和 `.build/ash-build-function-watch-eval.mjs`；运行前应使用新的输出目录，避免覆盖本轮证据。

Windows 本机验证通过：`just verify ash-dev-build --lib` 与 `just verify ash-app-server-diff-live --lib` 共执行 4 项 Rust 回归，并完成各自 check／warnings；正常 `scripts/cargo.py build --locked -p ash-app-server --bin ash-app-server --profile dev-small --features rust-live --target x86_64-pc-windows-msvc` 构建通过，`just rust-warnings ash-app-server --profile dev-small --features rust-live --target x86_64-pc-windows-msvc` 全目标检查通过。`node --test build/desktop/appServer.test.ts` 的 26 项回归、`python -B -m unittest build.desktop.test_live build.lib.test_package_binaries build.desktop.test_develop` 的 23 项回归通过；`just test-python scripts` 运行 202 项、跳过 7 项，通过。构建工具 TypeScript 143 文件检查、`just dependencies`（230 个 workspace 成员、85 项已审核多版本）、改动文件格式和 `git diff --check` 均通过；未执行 Bazel 构建。最终源码摘要、二进制摘要和实际重编译单元另存 `validation.json`。

#### 2026-10-21：Windows x64 标量叶函数编译原型

在上述模块原型之后，增加 `zero_based_line_index(usize) -> usize` 的受限函数路径。此处对照为当前实现的完整模块构建，两边均使用同一个运行中的 stdio App Server；不与上一节的重建／重启宿主结果拼接比较。代码基于 `937af130ec21b2c9a213250ce165eee722c078f2` 加本次工作区修改；Windows x64、i5-12600KF、rustc 1.98.0、LLD、静态 CRT 和 `dev-small` 配置保持一致。函数 crate 复制 diff 包的 `opt-level = "s"` 和 `codegen-units = 256`，没有通过关闭检查或降低优化来制造差异。

两条路径预热后，交替三组“函数、模块”保存。每次修改同一函数的 `saturating_sub` 参数为新值，通过九行 diff 的实际行号验证效果，而非仅检查发布日志。顺序固定，未随机化；测量期间无其他 Rust 构建，未清理共享缓存，正常缓存预算维护发生在预热之前。记录从源码写入到实际 RPC 返回新结果的时间，包含 Python 入口、工具准备、Cargo 和装载：

| 当前路径               | 三次秒数           | 中位数 |
| ---------------------- | ------------------ | -----: |
| 提取并单独编译叶函数   | 2.93 / 2.87 / 2.79 | 2.87 s |
| 增量构建完整 diff 模块 | 3.99 / 3.97 / 4.11 | 3.99 s |

函数路径的 Cargo 日志只重编译 `ash-live-function`，完整模块的 `current.json` 字节保持不变；模块路径实际重编译 diff 适配器及其 cdylib。两边始终使用 PID 32500。单独通过实际 `watchAppServer` 保存一次函数体修改，落盘到新结果为 3.71 秒，PID 32052 保持不变；该单次数据包含 watcher 防抖，不能当作稳定上限。没有测量完整 Electron 窗口、RSS、冷构建、其他系统或通用 Rust 函数的性能。

真实边界验证同时覆盖：函数内类型错误 E0308 不改变函数或模块指针，上一函数仍可调用；函数运行时除零 panic 被 DLL 捕获，整份 diff 回到当前完整模块的原生投影；加入局部绑定后选取完整模块构建。所有受控源码均恢复，并重新发布原始模块。原始样本、逐次构建日志、服务日志、脚本及摘要在 `.build/build-health/rust-functions-final-20261021/`，主记录为 `results.json`、`function-watcher-result.json` 与 `validation.json`；早期测量另保留于 `.build/build-health/rust-functions-20261021/`。

本轮 Windows 验证：`just verify ash-dev-build --lib --features compiler`、`just verify ash-app-server-diff --lib`、`just verify ash-app-server-diff-live --lib` 合计 10 项 Rust 回归，并完成各包 check／warnings；正常 App Server 构建及其 `dev-small`／`rust-live` 全目标 warnings 检查通过。watcher 26 项、Python 构建 24 项、脚本 202 项（7 项跳过）通过；构建工具 TypeScript 143 文件、依赖检查、Ruff、改动文件格式与 `git diff --check` 通过。Bazel 仅同步了源资源及编译器 feature 声明，未运行其构建。当前函数选择器仍不是语义数据库；一般 Rust 的宏展开、单态化、依赖／布局失效和常驻 JIT 留在根 `TODO.md`。

#### 2026-10-21：未修改 RA 接入常驻函数构建与热更新

`ash-build` 已通过独立 JSON 进程接入未修改的 `ra_ap_* = 0.0.358`。常驻 watcher 会话按当前修订查询函数、类型、原生标量布局、调用解析和 MIR，再由 Cargo/rustc 编译已注册的 `zero_based_line_index(usize) -> usize`。运行中的 diff 请求按既有 C ABI 选择新函数 DLL。工具链、优化、LLD、静态 CRT 和正确性检查均保留；未增加 Cranelift 后端或修改上游 RA。协议、准入、失效及退出规则见 [Rust 分析桥接](rust-analysis.md#ash-build-构建会话)。

在同一台 Windows x64 i5-12600KF、Rust 1.98.0、`dev-small` 上，对同一函数的减量参数逐次换新值，通过真实 60 行 stdio diff 的所有行号验证行为。五轮轮换函数／模块顺序，后面三轮加入正常宿主重建与重启；所有路径均先预热，正常重启复用同一个已初始化的 `ASH_HOME`。计时从落盘前到新 RPC 结果返回，未计入独立准备，未触碰共享缓存。函数和模块路径始终使用同一 PID 33664，函数路径始终复用编译器 PID 9868；函数分析修订从 2 连续增加到 6，报告源文件摘要逐次与磁盘一致。

| 路径                          | Cargo 编译／链接中位数 | 落盘至新 RPC 结果的全部样本        | 全流程中位数 |
| ----------------------------- | ---------------------: | ---------------------------------- | -----------: |
| 正常宿主重建与 stdio 重启     |                 5.28 s | 18.33 / 15.92 / 18.08 s            |      18.08 s |
| 完整 diff 模块热更新          |                 1.53 s | 4.18 / 4.14 / 4.42 / 4.33 / 4.17 s |       4.18 s |
| RA 准入后单独编译函数并热更新 |                 0.27 s | 1.20 / 1.00 / 1.09 / 1.05 / 1.20 s |       1.09 s |

Cargo 列取对应日志的 `Finished` 时间：普通路径实际重编译 diff 和薄宿主，模块路径重编译 diff 和 cdylib，函数路径只重编译生成的 `ash-live-function`。它们的输入范围不同，不是更换 rustc 后端的对照。普通构建入口（含包装器）中位数为 7.03 秒；函数分析请求中位数为 7.10 毫秒，完整函数路径仍需约 1.09 秒。各阶段分别取中位数，不能直接相加。全流程相对模块约为 3.8 倍、相对重建／重启约为 16.6 倍；后一个差异包含免重启的收益，不全部来自编译。接入前独立三对基线为函数 2.90 秒、模块 4.51 秒，先后测量，仅用于解释常驻工具减少启动成本，不作为随机受控因果实验。

另从真实 `watchAppServer` 验证连续四次保存：首次 22.54 秒，之后 2.02 / 1.35 / 1.42 秒，预热后中位数 1.42 秒。包含 250 毫秒防抖和 RPC 轮询，四次均未重建／重启宿主，只启动一次分析会话；PID 32608。这个场景使用 stdio 宿主及实际文件 watcher，没有启动 Electron 窗口。

主配对测量后又关闭了 Cargo 子进程继承的 stdin，避免它与常驻服务竞争构建协议管道。最终代码重新通过上述 Rust 验证，并执行三次独立的真实函数更新：1.61 / 1.23 / 1.39 秒，中位数 1.39 秒，同一后端进程返回新结果；记录为 `.build/build-health/rust-bridge-finalcheck-20261021/`。此复核没有同时重测模块和宿主，不能把差异归因为 stdin 改动或混入主配对样本。当前观察应理解为预热后的函数路径约 1.1～1.4 秒，不能承诺每次固定 1.09 秒。

新建分析会话并不便宜：匹配组的工具／工作区准备为 6.08 秒，首次函数请求 16.02 秒（其中分析 13.95 秒），合计约 22.10 秒。预热后的 RA `WorkingSet64` 瞬时约 1.98 GiB、私有提交约 2.02 GiB；这是单独 RA 进程的观测，不是进程树或峰值 RSS。此版本适合作为可选编译实验，不能据此认定它能减少整个应用的内存。首次完整宿主准备、下载和冷构建未纳入性能结论。`just bench-build` 在本机明确拒绝运行，因为 `/usr/bin/time` RSS 入口只支持 macOS／Linux；保留拒绝日志，没有伪造包级 clean／unchanged／touch 或 RSS 样本。

实际故障验收确认：类型错误保留模块和函数的两个指针；除零 panic 回到当前完整模块的原生投影；局部绑定回退模块构建；主动终止 RA 后本次走 Cargo 模块，下一次重新加载桥接并恢复函数路径；EOF 退出编译会话及 RA 子进程。受控源码均恢复为原 SHA-256 `8e3f03bf1f7a6d5686b535087f913a0202c660264a1757ebc15219acb08379c4`，原始模块和正常宿主恢复构建通过。

原始匹配样本、Cargo／分析／服务日志、逐次报告和脚本在 `.build/build-health/rust-bridge-matched-20261021/`；此前使用每次独立用户目录的对照保留在 `.build/build-health/rust-bridge-integrated-20261021/`，其 `watcher-results.json` 保存上述连续保存场景。接入前基线为 `.build/build-health/rust-bridge-before-20261021/`。不同组没有混合计算中位数，首次加载及全部长尾保留。正常回归为 `just verify ash-dev-build --lib --features compiler` 的 6 项测试及 check／全目标 warnings、30 项 Node 构建／watcher 回归、29 项 Python 构建相关回归、202 项脚本测试（7 项跳过）、145 文件 TypeScript 检查及改动文件格式检查。未执行其他操作系统、Bazel、发布或完整 Electron 交互性能验证。

本地 ra-jit 参考固定在干净检出 `49bdeab6b9c6b23bf2f4b9734da3f046b6fe6092`，没有修改它。其编译器将自有 `hir-ty-codegen` 挂入 vendored RA 的 MIR 模块，包含完整 codegen、实例／依赖失效和可执行文件补丁；我们的桥接暂只消费分析结果并保留 rustc。上游 [公开基准](https://github.com/indexable-inc/ra-jit/blob/49bdeab6b9c6b23bf2f4b9734da3f046b6fe6092/docs/benchmarks.md) 中，单函数修改为 48～325 毫秒，但使用 EPYC／Linux、Rust 1.99 和其他项目，不能把其倍数直接套给 Ash。[真实 den 应用记录](https://github.com/indexable-inc/ra-jit/blob/49bdeab6b9c6b23bf2f4b9734da3f046b6fe6092/docs/live.md#in-den) 则将保存到补丁的 1.0～1.5 秒与补丁应用的 0.4～0.6 毫秒分开，说明“应用补丁耗时”不能当作完整编辑循环。

该版本的 [Windows 平台说明](https://github.com/indexable-inc/ra-jit/blob/49bdeab6b9c6b23bf2f4b9734da3f046b6fe6092/docs/platforms.md#windows-x86-64-msvc) 已有 COFF 和 PE 文件补丁，`cargo ra-jit` 在 Windows 仍交回 Cargo，运行中热修改使用 macOS Mach API。本机也只有 Rust 1.98／stable，没有为了对照改动 Ash 工具链或安装 1.99，因此未声称完成 Windows 上与 ra-jit 同项目的对跑。若继续追求几十毫秒，需要验证独立的 MIR→Cranelift、实例／符号桥接、依赖／布局失效以及 Windows 代码发布边界；当前约 7 毫秒的分析查询说明分析不是预热后的主要耗时，但不能推导完整 JIT 的速度上限。

#### 2026-10-21：公开 RA 语义、自有 MIR 与 Cranelift 百毫秒热更新

在同一 Windows x64 i5-12600KF、Rust 1.98.0 和检出上，接通未修改 `ra_ap_* = 0.0.358` 的公开语义 API → 自有标量控制流 MIR → Cranelift 0.135.1 → 可执行映射。RA 的 MIR `Operand.kind` 为私有字段，没有把 debug 文本当 IR；完整上游 MIR 导出仍有接口缺口。局部绑定、分支、循环、整数转换、短路逻辑和同文件直接调用已进入普通标量函数路径，具体范围见 [标量 MIR 边界](rust-analysis.md#标量-mir-与本机代码边界)。宿主不链接 RA 或 Cranelift。

每次先对精确源函数图执行 `rustc --emit=metadata`，再做独立代码生成；发布前重查磁盘快照。Cranelift 使用无优化快速生成，Rustc 对照仍继承 `dev-small` 中 diff 包的 `opt-level = "s"`、256 CGU 和既有链接设置。两者是开发工作流比较，包含消除 Cargo／系统链接的收益，不能当作同优化等级的编译器后端对跑，也没有运行时等速结论。没有跳过 rustc 检查、清理共享缓存、关闭系统安全设置或替换工具链。

预热后六轮交替 Rustc／Cranelift 的先后顺序，逐次修改同一行号函数的减量参数；每次通过真实 60 行 stdio diff 的全部行号确认生效。始终使用 App Server PID 8604、编译器 PID 34224，模块指针不变，函数镜像在 Rustc DLL 与 Cranelift 代码间互换；每次核对分析修订、磁盘源摘要和镜像 SHA-256。随后在函数体中加入局部变量、`while` 和一个同文件 helper 调用，完整建立一次基线，再测五次函数更新。采样期间没有并行 Rust 构建。

| 路径                                | 落盘到新 RPC 的全部样本（毫秒）        |  中位数 |
| ----------------------------------- | -------------------------------------- | ------: |
| Rustc 提取叶函数、Cargo 链接        | 1069 / 1107 / 1926 / 997 / 1038 / 1013 | 1054 ms |
| Cranelift 标量叶函数                | 112 / 136 / 171 / 153 / 139 / 132      |  137 ms |
| Cranelift 局部变量、循环、helper 图 | 164 / 140 / 132 / 138 / 148            |  140 ms |

此匹配组的叶函数完整循环约快 7.7 倍；Rustc 的 1926 毫秒长尾保留。Cranelift 叶函数的分析、rustc 校验、代码生成、发布中位数分别约 12.55／78.72／3.13／14.84 毫秒；普通标量函数分别约 14.14／69.68／2.63／14.68 毫秒。各阶段分别取中位数，不直接相加。普通标量函数组没有匹配的单函数 Rustc 提取基线，不能沿用叶函数倍数。此前正常宿主重建／重启的 18.08 秒属于另一组历史数据，本轮没有重测，不能拼成新的端到端加速倍数。

真实 `watchAppServer` 路径保持现有 250 毫秒防抖。首轮暴露目录查询顺带执行完整协议准备、引出协议源文件通知并排队重建的问题，后续保存因此退回 4～5 秒；失败记录完整保留在 `.build/build-health/rust-cranelift-watcher-20261021/` 和 `rust-cranelift-watch-diagnostic-20261021/`。将 `--source-directories` 改为只查询 Cargo 图，协议准备仍由原有准备／契约保存入口负责。修复后在新目录重测相同的普通函数场景：首次 32.24 秒，后续 434／405／376／427／409 毫秒，中位数 **409 毫秒**。六次均为函数发布，只启动一个分析会话，没有模块发布、宿主重建或重启，PID 34732 不变。这是实际文件 watcher + stdio 宿主，未启动 Electron 窗口。

毫秒级结果只适用于预热后的受支持标量图。直接配对组新建工具／工作区会话为 6.33 秒，首次函数分析／构建请求为 26.32 秒，合计约 32.65 秒；完整模块发布后的下一次分析请求也为 28.38 秒。首次加载、冷构建和内存问题没有被 Cranelift 消除。本轮没有重新采集 RSS／冷构建；Windows `bench-build` 不支持 `/usr/bin/time` RSS 的既有边界继续适用。

独立小工作区将含多次循环、continue／break、局部遮蔽、短路逻辑、窄整数与有符号转换、嵌套调用及求值顺序的普通函数图交给真实 RA 进程，通过 CLI 生成／执行 Cranelift 代码，五组输入逐项与正常 rustc 可执行文件输出一致。最初探针误用 LF 字符串偏移选择 CRLF 落盘文件中的函数，按实际字节偏移修正后通过；没有把这一探针错误归因于 ABI。原始脚本、rustc 对照和 IR 位于 `.build/build-health/rust-cranelift-source-20261021/`。

故障验收通过：不可变局部重赋值被 rustc E0384 拒绝，模块／函数指针均不变；本机除零返回失败状态，整份 diff 回到完整模块投影；修改 helper 本体使上下文失效并重建模块；不支持的数组／索引走 Cargo。镜像回归还覆盖旧映射保持可调用、错误目标／入口、校验和和损坏清单拒绝。所有临时函数体和 helper 已恢复为原 SHA-256 `8e3f03bf1f7a6d5686b535087f913a0202c660264a1757ebc15219acb08379c4`，原始模块恢复构建通过。

直接配对证据为 `.build/build-health/rust-cranelift-matched-20261021/results.json`、逐次响应、worker／服务日志及 `probe.py`；最终 watcher 证据为 `.build/build-health/rust-cranelift-watcher-final-20261021/watcher-results.json`、日志和 `watcher-probe.mjs`。本机通过 `just verify ash-rust-build-ir --profile ci-test --lib`、`just verify ash-rust-analysis --profile ci-test`、`just verify ash-dev-build --profile ci-test --features compiler --lib` 和 `just verify ash-app-server-diff-live --profile ci-test --lib`，合计 21 项 Rust 测试及对应 check／warnings；无 compiler feature 的 runtime warnings 也通过。协议工具 17 项、Node 构建／watcher 30 项、仓库脚本 202 项（7 跳过）通过；依赖检查为 232 成员／89 项已审核多版本。未运行 Bazel、其他系统或完整 Electron 交互性能验证。

本地 ra-jit 仍是未修改的 `49bdeab6b9c6b23bf2f4b9734da3f046b6fe6092`。我们的 137～140 毫秒受控标量编辑已经处于其公开单函数 48～325 毫秒的量级，但项目、硬件、平台、优化与能力覆盖不同，不能据此宣称追平或超过。ra-jit 覆盖泛型实例、跨 crate 依赖和可执行文件补丁；Ash 当前只热替换一个明确注册的 C ABI 入口，helper 本体仍保守重建，无非标量对象、drop、一般单态化和跨文件失效。下一阶段瓶颈先是 rustc 校验与首次语义加载，能力缺口仍需逐项补齐。

#### 2026-10-21：同 crate 跨文件依赖失效与真实业务函数

继续使用未修改的 RA 0.0.358、Rust 1.98.0、Cranelift 0.135.1 和同一 Windows x64 主机。标量 IR 升至 2，记录函数／常量／模块声明的准确源码、library 根与检查模式；支持同 crate 跨文件调用、别名、模块同名函数、字面量标量常量及 unsigned `div_ceil`。分析前批量覆盖源码，图摘要按源文件失效；共享依赖更新可原子替换多个入口，完全无关的源文件变化可直接复用代码。具体协议与限制见 [分析桥接](rust-analysis.md#多入口依赖失效与执行验证)。

模块语义需要保留原 Cargo owner 的检查上下文：新图执行 `cargo check --locked --offline --package <owner> --lib --profile dev-small`，没有用扁平化函数文本冒充原 crate。编译器核对分析的 library 目标、全部依赖文本、构建配置及发布前的磁盘快照。条件编译暂保守退回 Cargo，`#[cfg(test)]` 测试模块除外；尚未绑定完整 artifact feature／cfg 配置。源文件或配置集合变化会重载 RA。机器码与 MIR 均按摘要不可变保存，多个入口共用一个发布指针；原 owner 检查失败时整组旧入口继续可调用。

真实业务验证选用 `ash-utils-string` 的既有 `approx_bytes_for_tokens` 与 `approx_tokens_from_byte_count`，修改两者共享的 `APPROX_BYTES_PER_TOKEN`，使用含 0、最大 usize 和临界值的 12 个输入，共 24 个结果，逐项比较正常 Cargo 消费者、JIT 和独立整数运算预期。两个函数来自同一实际源文件；跨文件调用另由下方 App Server 和多模块 fixture 验证。JIT 在 `ash-build --serve-functions` 标量宿主执行这些真实函数，没有自动替换 App Server 所有 token 预算调用。

对照的 Cargo 消费者直接依赖实际 `ash-utils-string`，复制根 lockfile 并核对外部依赖版本，使用相同工具链、target 和 `dev-small` 参数。每个 backend 在每轮计时前都先回到原常量 4 并预热，再分别执行相同的 5／6／7 修改；三轮交替先后顺序，测量时没有其他 Rust 构建。每次验证两个图均失效、MIR／机器码摘要及快照与落盘源码一致。

| 路径                       | 保存到 24 个新结果的全部样本 |  中位数 |
| -------------------------- | ---------------------------- | ------: |
| Cargo 编译并启动正常消费者 | 1848 / 1681 / 1733 ms        | 1733 ms |
| 常驻 Cranelift 标量宿主    | 854 / 894 / 843 ms           |  854 ms |

这组完整循环约快 2.03 倍，但 **Cargo 纯构建中位数 844 ms，JIT build 请求中位数 847 ms，编译时间基本持平**。完整循环的收益主要来自避免正常消费者进程启动，不是 Cranelift 后端本身快了两倍。JIT 的分析、Cargo check、代码生成与镜像阶段中位数分别为 9.18／828.74／4.46 ms；保留的 Cargo 检查支配本轮成本。首次图构建 7.65 秒，其中分析 6.78 秒，不属于热更新样本。修复 profile 优先级、配置守卫及 Windows 路径后的该组三轮为最终确认；此前独立六轮为 Cargo 1668 ms／JIT 854 ms，没有合并两组样本或择优删除长尾。

App Server 验证将既有 `zero_based_line_index` 本体暂移到另一个源文件的 `pub(super)` helper，保持原业务行为，随后只编辑该 helper。预热后五次保存到真实 60 行 stdio diff RPC 的全部新行号为 1096／1096／1072／1088／1085 ms，中位数 **1088 ms**；原 App Server PID 4988、编译器 PID 19788 不变，完整模块指针不变，图含两个函数且 helper 引用都在注册图内。分析、owner check、代码生成、发布阶段中位数为 7.59／1041.27／1.45／10.11 ms。随后同宿主五次完整模块更新为 2740／3146／2787／2523／2730 ms，中位数 **2740 ms**。两组按阶段顺序测量，没有交替配对，不据此给出精确加速倍数；本轮也没有重新测 Electron watcher 的 250 ms 防抖。

此场景工具准备 6.64 秒，首次分析／更新请求 15.39 秒，其中分析 14.26 秒。首次 owner check 的未预热失败探测曾耗 36.21 秒，单独保留在 `rust-cross-file-appserver-final-20261021`，不放入预热样本。最初的 Windows 快照反斜杠／语义图正斜杠不一致导致错误退回模块，修复后增加真实快照路径回归。另一探针因默认 GBK 读取包含 UTF-8 的 baseline 失败，显式指定编码后重新完整验收；失败目录未删除。

故障与失效验证通过：跨文件 helper 的 E0384 保留模块和函数指针，旧 RPC 结果不变；恢复合法 helper 后可继续更新；添加注册图外的第二个真实原生调用者后，helper 修改转为完整模块发布。多模块双入口 fixture 验证共享 helper／跨文件常量同时使两个入口失效，无关模块修改复用两份代码（5.54 ms），配置变化重建全部入口，条件导入被拒绝而旧入口保留，EOF 结束全部子进程。fixture 的小图 warm 更新约 138～140 ms，只说明桥接链路可达到该量级，不能代替真实业务包的 Cargo check 成本。

全部业务实验源码已恢复：diff SHA-256 为 `8e3f03bf1f7a6d5686b535087f913a0202c660264a1757ebc15219acb08379c4`，token 源码为 `c8e813907f1a71e720ca2e97668a13af0e2c7b0a6cd2275c5caa65090e5e6144`；临时跨文件 helper 已移除，原始模块和正常业务消费者恢复构建通过。最终业务证据在 `.build/build-health/rust-cross-file-business-final3-20261021/`，此前六轮在 `rust-cross-file-business-complete-20261021/`；App Server 完整证据在 `rust-cross-file-appserver-complete-20261021/`，多模块失效证据在 `rust-cross-file-session-complete-20261021/`，各目录包含脚本、结果、日志及相关 MIR／清单。

验证通过 `just verify ash-rust-build-ir --profile ci-test --lib`（4 项）、`just verify ash-rust-analysis --profile ci-test`（6 项）、`just verify ash-dev-build --profile ci-test --features compiler --lib`（16 项）、`just verify ash-utils-string --profile ci-test --lib`（12 项），包含相应 check／warnings；不启用 compiler 的 `ash-dev-build` runtime warnings 也通过。`just dependencies` 为 232 成员／89 项已审核多版本，`just test-python scripts` 为 202 项、7 跳过。Rust 与文档定向格式及 `git diff --check` 通过。未重新测 RSS、其他系统、Bazel 或完整 Electron UI。

当前交付扩大到同 crate 的闭合标量图和注册入口依赖更新。跨 crate、非标量对象、drop、单态化、完整 cfg 配置及一般业务函数自动插桩仍未实现。继续优化应先解决原 owner 检查和首次语义加载成本，不能为取得几十毫秒而直接省略 rustc 正确性检查。

#### 2026-10-21：复用 Cargo 检查上下文的百毫秒业务热更新

沿用同一 Windows x64、Rust 1.98.0、未修改 RA 0.0.358、Cranelift 和 `dev-small`，优化原 owner 检查的调度成本。诊断中交替修改真实 `ash-utils-string` 共享常量，Cargo 检查为 912／856／802 ms；从 Cargo 捕获的原始完整 crate rustc 命令为 84／100／88 ms。两者都检查原模块树和外部依赖，后者仅把 metadata／incremental 输出改到私有目录。此诊断不包含代码生成或业务执行，也没有将其冒充完整热更新时间。

实现通过 Cargo 的 `RUSTC_WRAPPER` 记录成功 library 检查的真实参数及环境差异。后续依旧启动 rustc 检查完整原 crate，保留 extern／cfg／lint／profile，只复用 Cargo 已确定的上下文，避免每次重新解析、调度整个工作区。没有跳过类型／借用检查，没有用提取函数检查替代业务 crate，也没有修改 RA、工具链或正常开发 profile。复用只在当前会话有效，输出／incremental 不写回 Cargo 缓存。

复用范围先限定为无 owner build script、仅依赖 registry 的包。配置、环境、工具链安装和依赖产物均有失效守卫，registry 包完整文件集合及 build-script 产物也按内容核对；检查前后验证，同一请求的前置票据只复用一次，最多四线程并行摘要。符号链接、路径／Git 依赖、owner build script、外部跟踪输入或预算超限继续走 Cargo；Cargo 重编依赖时拒绝用旧 RA 上下文发布。边界和预算见 [完整 crate 检查](rust-analysis.md#完整-crate-检查与-cargo-上下文复用)。本轮没有通过降低正确性要求换取速度。

真实业务仍为 `approx_bytes_for_tokens` 与 `approx_tokens_from_byte_count`。最后复核使用同一常驻编译器 PID 37064、同一 RA 会话、target、依赖和 profile，三轮交替两种检查策略；每一策略先回到原常量 4 并预热，再修改相同的 5／6／7，计时直到 12 个边界输入的全部 24 个新结果返回。两组均包含依赖守卫、完整 crate 检查、图失效、代码生成、原子发布与调用，不包含工具准备、RA 首次加载或消费者进程启动。另用锁文件版本一致的正常 Cargo 业务消费者逐项核对 24 个结果，全部一致。

| 同链路检查策略                     | 保存到全部新结果的样本 |  中位数 |
| ---------------------------------- | ---------------------- | ------: |
| 强制 Cargo owner 检查              | 1140 / 1044 / 1094 ms  | 1094 ms |
| 复用 Cargo 上下文，完整 rustc 检查 | 337 / 332 / 318 ms     |  332 ms |

该匹配组完整循环约快 3.3 倍，已达到数百毫秒；不是小于 100 ms。复用路径前置分析／依赖核对、完整检查及后置守卫、代码生成／镜像阶段中位数分别为 121.26／189.92／5.96 ms，各阶段中位数不直接相加。899.83 → 189.92 ms 的检查阶段变化包含消除 Cargo 调度的收益，没有将其解释成 rustc 类型检查器本身快了五倍。强制 Cargo 对照也包含新增守卫，因此不能将该组 1094 ms 直接当作上一节约 847 ms 的旧构建请求。此前独立六轮相同并行守卫实现为 1111 → 327 ms；补齐安装身份守卫前的三轮为 1021 → 254 ms，并完成两种故障验证。各组完整保留，不合并或择优删除长尾；更早的串行／重复核对实现为 1299 → 542 ms，显示守卫自身也需优化。

最后复核的首次 build 为 6.99 秒（其中分析 6.18 秒）；首次真正捕获检查命令的 owner 编辑为 917 ms。Cargo 已 fresh 时不会伪造一份命令，会继续用 Cargo，直到实际 owner 检查发生。另三轮的故障场景中，修改 manifest 后重新加载／检查为 7.54 秒，明确返回 `check_backend: cargo` 并使两个入口重编。这些冷成本均不计入预热样本。

故障验证包括：目标函数不可变局部重赋值报 E0384；未进入标量图的 `location.rs` 中加入错误返回类型报 E0308，两者均保留整个发布指针和两个旧入口；配置变化转回 Cargo；单元回归在前置票据形成后改变依赖内容，确认后置守卫拒绝结果；还验证等长文件内容变化、新增文件、缺失配置新建、工具链安装变化和输出隔离。新检查没有因源码图命中缓存而略过完整 crate 检查。

业务测量仍在标量执行宿主中，没有自动替换 App Server 的 token 预算调用。App Server 包含路径依赖，因此本轮不宣称其跨文件更新达到该速度；单独复核运行中 diff 更新、错误保留和图外调用者模块回退，不能拿该复核的一次采样作为新性能基准。首次复核因依赖实际重编而保守退回模块，保存了这次结果；预热后完整复核通过，始终为同一 App Server／编译器 PID。实际修改过的业务源文件和 manifest 均恢复原字节；正常 owner 检查恢复通过。

验证通过 `just verify ash-dev-build --profile ci-test --features compiler --lib`（19 项）、`just verify ash-utils-string --profile ci-test --lib`（12 项）及其 check／warnings；无 compiler feature 的 runtime warnings 也通过。正常 `dev-small` 编译器构建通过；`just dependencies` 为 232 成员／89 项已审核多版本，`just test-python scripts` 为 202 项、7 跳过。Rust／文档定向格式和 `git diff --check` 通过。

证据位于 `.build/build-health/rust-owner-check-diagnostic-20261021/`、`rust-owner-check-business-20261021/`（串行守卫六轮）、`rust-owner-check-business-parallel-20261021/`（并行六轮）、`rust-owner-check-business-final-20261021/`（三轮及故障验证）、`rust-owner-check-business-confirm-20261021/`（最终三轮及正常 Cargo oracle）和 `rust-owner-check-appserver-final-20261021/`，包含脚本、每次响应、完整检查日志、MIR 和镜像清单。Windows 既有基准入口依赖 `/usr/bin/time`，本轮使用真实编辑循环分阶段计时，没有重测 RSS、冷构建或清理共享缓存，也未验证其他平台或完整 Electron UI。

#### 2026-10-21：路径依赖检查复用与 App Server 真实热更新

将上述完整 crate 检查上下文复用扩展到 App Server 的真实路径／Git 依赖图，仍使用 Windows x64、Rust 1.98.0、未修改的 RA 0.0.358、Cranelift 和原 `dev-small`。首次成功 Cargo 检查建立上下文；后续每次启动原完整 library 的 rustc 检查，保留原 extern／cfg／lint／profile，检查前后都读取依赖内容。路径／Git 包跟踪完整文件集合，registry 读取 rustc dep-info 的实际源码闭包；依赖产物、manifest／锁文件、build-script 声明的外部输入及生成目录、native search 目录都参与守卫。实际链路跟踪约 3999 个路径（含缺失配置），每次读取约 357.1 MiB，预算为 16384 个依赖路径／512 MiB。边界见 [完整 crate 检查](rust-analysis.md#完整-crate-检查与-cargo-上下文复用)。

诊断发现排序后按连续片分给线程，会把大产物集中在一个线程；改为最多四线程交错处理元数据和内容，并为每个线程复用 256 KiB 缓冲区，减少 Windows 上反复提交大块内存的成本。没有缓存摘要或改成仅核对 mtime，依赖仍在检查前后完整读取。另修复两处实际链路问题：消费排队批次时取消已被消费保存对应的剩余 timer；Windows 的访问时间通知按文件身份、长度、mtime／ctime 去重，rename／删除／读取失败继续交给构建。实机确认等长写入后恢复 mtime，状态变更时间仍变化；回归覆盖这种编辑，不把只读 RA 扫描误判成整后端源码修改。完整模块的镜像加载验证及函数基线复核均在原子发布前完成，避免 RPC 先看到新模块、随后才报告基线失败。

实际场景把 diff 的 `zero_based_line_index` 委托给独占的跨文件 helper，交替修改其减数，运行真正的 `watchAppServer → LiveBuilder → live.py --serve → ash-build → ash-rust-analysis → Cranelift → 运行中 App Server`。每次保存后轮询真实 `diff/compute`，直到全部 60 行结果符合新减数。保留原 250 ms debounce；计时从文件写入到全部 RPC 新结果，包含检查、代码生成及运行中替换，排除工具准备和首次加载。返回新结果后再等待该次发布完成，避免下一次编辑干扰前一次测量。

| 相同函数编辑、保存至全部 RPC 新结果 | 五次样本                            |  中位数 |
| ----------------------------------- | ----------------------------------- | ------: |
| 原 Cargo owner 检查                 | 1394 / 1394 / 1381 / 1370 / 1361 ms | 1381 ms |
| 路径依赖守卫＋原完整 rustc 检查     | 754 / 789 / 749 / 770 / 750 ms      |  754 ms |

这两组是同机、相同工具链／目标／profile／编辑内容的前后独立会话，约快 1.83 倍，耗时下降约 45.4%，已达到数百毫秒，尚未小于 100 ms。后组 App Server PID 38296、编译器 PID 42600、RA PID 36940 在预热样本中均不变，没有模块或整后端重建。候选每次仍执行约 714 MiB 的两遍依赖内容读取；典型单遍枚举约 10–13 ms，读取／摘要约 136–158 ms，完整检查连同两遍守卫约 454–497 ms，生成机器码约 1.3–1.5 ms。阶段范围用于定位，不直接相加中位数。另一组直接请求编译器并调用常驻真实 App Server 的实测为 501 / 472 / 472 / 481 / 531 ms，中位数 481 ms，包含全部 60 行 RPC 结果，排除 watcher 的 250 ms 等待；这是独立会话，不是从总数减去 debounce 得到的数值。

该组首次保存至 RPC 为 23.71 秒，包含准备及首次语义加载，不计入 warm 样本。真正依赖或协议构建输入改变时，必须重新交给 Cargo、发布完整模块并退休旧分析上下文；下一次语义加载仍有秒级成本。百毫秒结果只覆盖已预热的注册入口及同 crate 独占标量图，路径依赖自身修改不因此获得跨 crate 的 JIT 代码生成；owner build script、一般泛型／非标量／drop 和准确 artifact cfg 绑定仍在已有缺口内。

故障场景在真实常驻 App Server 中验证：helper 不可变局部重赋值报 E0384；路径依赖 `ash-diff` 中加入错误返回类型报 E0308；两者均保留模块／函数发布指针及旧 RPC 结果。恢复后可继续更新；合法路径依赖变化和协议包声明的 `../../.build/protocol/metadata.json` 变化转为完整模块发布，后续重新加载分析后恢复函数更新。实验源码和协议元数据按原字节恢复，临时 helper 删除，正常模块恢复构建通过。

Rust `just verify ash-dev-build --features compiler` 为 22 项并通过 check／全目标 warnings；不启用 compiler feature 的 runtime warnings 也通过。App Server watcher、LiveBuilder 和源码归属定向测试 39 项通过，build TypeScript 为 145 文件无错误；脚本测试 202 项、7 跳过。排队 timer 回归已确认去掉修复时失败。全量 `pnpm --dir build run test:prepared` 首次为 233 项、200 通过、6 失败、27 跳过，另观察到导出 SDK 的 Academy 类型错误、Windows Host watcher 多余失败通知、Electron 生命周期退出等待及符号链接 EPERM。已补 live builder fixture 和后端 Python 清单；当时的定向结果不表示全量通过；macOS 整套回归补验见下文，Windows 补验见后续 [Windows 构建工具全量复核](#2026-10-21windows-构建工具全量复核)。

2026-10-20 在当前 macOS 检出复核上述失败所属的四个文件：`node --test build/builtin/editorClients.test.ts build/desktop/host.test.ts build/desktop/launch/electron.test.ts build/testRunners.test.ts`，22 项全部通过，无失败或跳过，用时 15.94 秒。包括仓库外 Academy SDK 类型检查、Host watch、两种 profile 的 Electron 启停和符号链接 fixture；Electron 使用受控 Node 进程替身，没有启动真实 Electron 窗口。该次未修改实现，也未重跑全量或 Windows；不能单独据此关闭验证缺口。日志为 `/tmp/ash-rust-todo-review-20261020.log`。

2026-10-21，在当前 macOS arm64 检出 `a66ebb32a` 加本轮修改上完成本机整套补验。`pnpm --dir build run test:prepared` 首跑为 236 项、214 通过、6 失败、16 跳过；最终为 220 通过、0 失败、16 跳过，用时 16.04 秒。修复包括：独立 TS 作者测试从 PATH 定位 npm，兼容 pnpm 自带的无 npm Node；恢复测试夹具补齐当前 view catalog；Academic 场景收集遵守 disconnected browser 与 connected editor 的实际目标；CSS 竞态 fixture 用轮询消除原生事件合并对断言的影响。

Host 的真实监听缺口也在本机复现：递归目录事件漏收文件内容写入，延迟到达的初始条目又可能造成空编译。现按原有源码／协议／本地化根预先注册文件监听，以自适应目录时间戳轮询发现增删；同一待编译批次只发布一次未就绪。现有 Host／Electron 回归覆盖生成输入、正常与失败保存、编译中排队、配置修改、缓存排除与进程回收，并补新增文件、修改、删除和失败编译实际读取无效源码的断言。`pnpm build` 正常 Desktop 构建通过；build 146 文件、Renderer 4446 文件、automation 2994 文件类型检查通过。这里只确认行为，不宣称监听性能收益。

最终日志及本轮 patch／构建摘要保存在 `.build/local-acceptance-20261021/validation.json`。16 项跳过涉及独立 Academy 原生开发宿主、Windows 特有行为、浏览器调试器 F5、Windows 进程及显式启用的产品取消场景，均不算通过；该次 macOS 结果不覆盖 Windows 与远端完整 CI；Windows 已在后续本机复核中补验。Electron launcher 的构建工具测试使用受控 Node 替身；另一次真实 Desktop 冷启动及进程重启通过，范围见 [语法会话](editor-architecture.md#语法会话与主题样式)。

最终 watcher 证据位于 `.build/build-health/rust-path-check-watcher-verified-20261021/`，基线在 `rust-path-check-watcher-baseline-20261021/`；包含全部样本、测量二进制摘要、PID、日志和脚本。早期 `candidate`、`final`、`buffered`、`confirm` 轮次保留了不均衡摘要开销、混入冷依赖重编、基线发布顺序及 Windows 访问通知误触发等失败，均未纳入上述 warm 对比；其中误触发的普通后端构建还遇到运行中扩展可执行文件的 Windows 占用，未停止用户的运行进程或删除该产物。`trace` 的中间实现为 1291 ms，未计作最终结果。直接调用与失效证据位于 `rust-path-check-appserver-20261021/` 和 `rust-path-check-appserver-final-20261021/`。没有清空共享缓存、修改 RA／工具链或降低正确性检查，也未验证其他平台、RSS、Bazel 或完整 Electron UI。

### 2026-10-21：Windows 构建工具全量复核

在当前 Windows 11 x64、build 22631 的普通权限进程中，以 `b2cbfdac794596616d6ed024085978b442dd5539` 加本轮修改验收，Node 为仓库固定的 `v24.21.0`。首先对原待办的四个文件复跑，22 项中 15 通过、5 失败、2 跳过，确认 SDK 导出、Host watcher、两种 Electron profile 和文件符号链接 fixture 均仍有失败。全量检查又暴露了 npm 定位、启动恢复 fixture 和 Academic 场景收集的旧接线问题。

SDK 导出现在按相对路径识别并复制声明文件，避免 Windows 路径分隔符造成 `marked.d.ts` 等依赖遗漏；仓库外 Academy 类型检查验证了完整导出链。独立 TS 作者安装测试从 pnpm 提供的原 Node 路径定位 npm，避免把 `node_modules/.bin` 中的 Node 硬链接当作完整安装目录。所有安装仍只使用离线本地归档。

Host watcher 合并同一待处理批次的失效通知，Windows 按文件身份、大小、mtime／ctime 排除重复读取通知。保留 mtime 的内容修改与上次编译完成的输入快照比较，必要时才绕过 TS7 的 mtime 增量门禁；回归同时验证普通修改不重编无变化的 preload，以及等长修改恢复 mtime 后仍产生新输出。Electron fixture 在 Windows 验证原进程退出，不等待不会执行的 POSIX 信号处理器，并由既有 `ProcessRun` 收尾；Windows 进程回收测试持有原生进程句柄，避免把复用后的 PID 算作残留。链接拒绝用例在 Windows 使用普通权限可创建的 junction，保留 Unix 文件符号链接覆盖。启动恢复 fixture 补齐当前查询接口，CI 收集断言改为当前宿主实际支持的场景，没有靠跳过失败测试消项。

最终 `pnpm --dir test/scenario compile`、构建工具 146 文件类型检查和 10 个修改文件的格式检查通过；`pnpm --dir build run test:prepared` 为 **236 项、209 通过、0 失败、27 跳过**，跳过项受平台或显式启用条件限制，不计作通过。`pnpm run build:host` 正常构建通过，随后执行：

```powershell
pnpm run smoketest-no-compile test/smoke/areas/windows/home.spec.ts --grep 'Desktop development startup opens Agents with prepared runtime resources' --output .build/build-tools-acceptance-20261021/desktop-startup
```

该真实 Electron／App Server 启动及打开 Agents 窗口场景为 **1 passed (22.6s)**。Host 使用本轮构建的 `.build/desktop/main/src/main.js`，Renderer 复用未修改的已准备产物，后端使用 `host-provided-node/dev-small` 开发包 `3a85f92b9d35183f2203e04428aebc69faaa185d9974fbbc686f1882cd033886`。测试命令已退出，检查时没有本轮 Host／Electron fixture 残留进程。本项已从根 TODO 移除；结论仅覆盖本机 Windows，不代表其他平台或远端 CI 全绿。

随后检出更新至 `f274d7a8f`，合并上游文件监听和目录成员轮询改动，Windows 保留原生内容事件以检测恢复 mtime 的保存；npm 定位同时保留原 Node 路径和 PATH 回退。合并后的全量构建测试再次为 **236 项、209 passed、27 skipped、0 failed**，build 146 文件类型检查及三处合并代码格式检查通过。Host 回归新增文件增删步骤后，Windows 单跑约 17 秒、全量并发约 35 秒，测试截止时间调整为 60 秒，全部行为断言保留。正常 Desktop 重建及 automation 3003 文件检查通过；复核日志在 `.build/process-recovery-windows-20261021/build-merge-final.log`、`build-merge-typecheck.log` 和 `preparation-merged.log`。

证据位于 `.build/build-tools-acceptance-20261021/`：`source.diff`、`runtime.json`、`focused-initial.log`、`full.log`、`full-fixed.log`、最终 `full-final.log`、`host-build.log` 及 `desktop-startup-final.log`。修正前失败、诊断探针和首次启动命令零匹配的选择记录均保留，未计入最终通过结果。

## 构建源码与仓库脚本边界

根 `justfile` 和 `package.json` 声明命令并调用上述实现。`scripts/` 可以调用 `build/`；构建实现不反向调用仓库脚本。前端构建工具使用 TypeScript，后端构建和组包使用 Python。测试内容归对应产品，运行产物归 `.build/`。

工具需要从仓库根发现的 Cargo、pnpm、Bazel 和 TypeScript 配置留在根目录；Node workspace 共用根锁文件。共享包布局和发布流程见 [构建器说明](../build/README.md)，桌面开发生命周期见 [前端开发](frontend.md)，文档站由独立的 `ash-docs` 仓库负责。
