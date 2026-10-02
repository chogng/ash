# 构建与开发

本文说明仓库环境准备、产品构建、通用验证和清理。Electron、Browser、Stanza 的启动模式、热更新和前端测试集中在 [app-ts README](../app-ts/README.md)；产品关系见 [产品线](product-lines.md)。

## 构建入口

以下命令均在仓库根目录执行。工具版本以仓库配置为准：

| 工具 | 版本来源 |
| --- | --- |
| Rust | [`rust-toolchain.toml`](../rust-toolchain.toml) |
| Node.js | [`.nvmrc`](../.nvmrc)；pnpm 使用 [`package.json`](../package.json) 中的 `devEngines.runtime` 自动获取固定版本 |
| pnpm | 根 [`package.json`](../package.json) 的 `packageManager`，安装方法见 [README](../README.md#quick-start) |
| Python | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `requires-python`，建议 3.12 |
| Just | 安装后确保 `just` 在 PATH 中 |
| Bazel（按需） | Bazelisk 读取 [`.bazelversion`](../.bazelversion) |

### macOS 与 Linux 开发环境

安装 Rust、Just 和 Python 3.11 及以上版本。Unix 构建入口使用 `python3`；运行前确认 `python3 -c 'import tomllib'` 成功。macOS 自带 Python 可能不满足要求，可使用 `uv run --python 3.12 just ash-desktop`；Apple Silicon 上的 Homebrew Python 3.12 也可将 `/opt/homebrew/opt/python@3.12/libexec/bin` 放在 PATH 前部。

准备完整后端包时，macOS 还需要 Go 1.26 和系统 C/C++ 工具链来构建 LiveKit Server，见 [LiveKit Server](../third_party/livekit/README.md)。Linux 的完整后端构建需要 ALSA 开发库；沙箱构建需要 C 编译器和 libcap，见 [共享包构建](../build/ash_rs/README.md)。

### Windows 开发环境

安装下列工具后，使用对应目标架构的 **Visual Studio Developer PowerShell** 构建。已安装的 Ash 产品不依赖这些开发工具。

| 工具 | 安装要求 |
| --- | --- |
| Visual Studio Build Tools | 2022 / MSVC v143，选择“使用 C++ 的桌面开发”和 Windows SDK |
| Visual Studio English 语言包 | 在 Installer 中补装，避免中文链接器进度被 Rust 误报为 warning |
| PowerShell 7 | 支持 `-CommandWithArgs`；`just install` 可通过 winget 安装缺失的工具 |
| Python | `python` 命令指向满足仓库要求的版本 |
| Git、ripgrep、CMake | 安装并加入 PATH |
| LLVM/Clang | LLVM 的 `bin` 加入 PATH；自定义安装路径时，设置 `LIBCLANG_PATH` 指向含 `libclang.dll` 的目录 |
| Bazelisk（按需） | 运行 Bazel 测试前，将 `BAZEL_SH` 设为 Git Bash 路径 |

无需全局设置 `CC`、`CXX`。Windows 桌面构建和平台验证在 Windows 上完成；Dev Container 用于 Linux 开发。

### 初始化

1. 按 [README](../README.md#quick-start) 安装仓库指定的 pnpm。
2. 执行 `pnpm install`，安装 Node workspace 依赖。
3. 执行 `just install`，获取 Cargo 依赖并创建含固定版本 Ruff 的 `scripts/.venv`。Windows 缺少 PowerShell 7 时，此步骤会安装它；随后重启终端和编辑器以更新 PATH。

直接执行 `node` 时仍需使用 `.nvmrc` 指定版本；pnpm 脚本使用仓库固定的 Node。Python 构建入口在 Windows 使用 `python`，其他平台使用 `python3`。

### 项目命令

#### 启动

| 产品 | 命令 | F5 配置 |
| --- | --- | --- |
| 完整 Electron 桌面端 | `just ash-desktop` | `Ash (Electron)` |
| Rust 桌面端 | `just app` | `Ash App (Rust)` |
| 终端界面 | `just ash` | `Ash Code (TUI)` |

仅前端、只监听前端、完整 Web 和独立编辑器的区别及对应命令见 [前端启动方式](../app-ts/README.md#启动项目)。

#### 构建与维护

| 命令 | 结果 |
| --- | --- |
| `just build` | 构建三条产品线及其开发所需服务程序 |
| `just build-code` / `just build-desktop` / `just build-app` | 构建指定产品 |
| `just build-rust` | 构建根 Rust workspace |
| `just check <package>` | 检查指定 Rust 包 |
| `just lint` | 检查 Python 代码 |
| `just fmt` / `just fmt-check` | 格式化或检查 Just、Rust 和第一方 Python 源码 |
| `pnpm typecheck:build` | 检查 TypeScript 构建工具 |
| `pnpm clean` | 清理本地产物和 Python 缓存 |

验证完整开发包时使用 `just ash-package`，需要让 Code TUI 运行该包时使用 `just ash-package-run`。日常 `just ash` 只准备源码运行所需程序。

发布包入口为 `just runtime-package`、`just code-package` 和 `just app-package`，参数和组装顺序见 [共享包构建](../build/ash_rs/README.md)、[Code 发布](../build/code/README.md)及 [App 发布](../app-rs/docs/app-release-graph.md)。

### 测试

| 命令 | 覆盖范围 |
| --- | --- |
| `just test <package>` | 指定 Rust 包 |
| `just test-processes <package> --test <target>` | 独立运行指定进程集成测试，支持多个 `--test` 和测试名过滤 |
| `just test-tui-unit <filter>` | TUI 库单测，默认使用 `ci-test` |
| `just test-tui <filter>` | 真实 CLI/TUI PTY 场景，服务程序与测试统一使用 `ci-test` |
| `just test-python` / `just test-python build` | 全部仓库 Python 测试，或仅构建工具测试 |
| `pnpm test` | Rust 协议验证、构建工具检查和前端单测 |
| `pnpm test:build` | TypeScript 构建工具单测 |

Electron、Browser、编辑器的构建和测试命令，以及测试是否启动 App Server，见 [前端验证命令](../app-ts/README.md#常用命令)。

Windows Cargo 的测试 Job 禁止子进程脱离，而共享 App Server 必须独立于启动者存活。验证这种进程生命周期时，使用 `just test-processes ash-app-server --test managed_lifecycle`：Cargo 负责编译，仓库脚本按 Cargo 报告的路径独立运行测试程序，保留后台的脱离标志。该入口只接受显式选择的集成测试，不包含库单测或文档测试；普通测试继续使用 `just test`。

修改 TUI 后先运行受影响的单测，需要验证真实进程、终端信号或恢复时再运行 PTY 场景：

```sh
just test-tui-unit session_manager
just test-tui actual_tui_process_interrupts_an_inflight_http_stream
```

涉及进程内 App Server 的会话测试需显式启用功能：`just test-tui-unit conversation_flow_tests --features in-process-tests`。两个入口都可用 `just --set tui_profile <profile> ...` 覆盖配置；PTY 入口的服务程序和测试会一起切换。首次构建服务程序仍需时间。日常启动验证用 `just build-code`，使用 `dev-small`。

`ci-test` 继承 `test` 的优化配置：共享 workspace 包使用优化级别 1，TUI 保留包级别的 0，App Server 及其客户端保留 `s`。将整个 workspace 降到 0 会使 macOS 服务程序的 `__eh_frame` 超过 compact-unwind 的 16 MiB 偏移限制；因此不在 `ci-test` 中覆盖全局优化级别。调试信息仍为 `limited`，异常展开设置不变。

同一轮验证按单测、必要的 PTY 场景、warning 检查顺序运行；不要同时启动这些 Cargo 任务。`test-tui-unit` 和 `test-tui` 复用 `.build/cargo` 中同配置的产物，并发运行仍会等待 Cargo 构建锁。

#### UI 场景录屏

场景录屏需要带 `drawtext` 滤镜的 FFmpeg：macOS 使用 `ffmpeg-full` 并将其 `bin` 加入 PATH，Windows 可安装 `Gyan.FFmpeg`，Linux 可安装 `ffmpeg`。运行方法和证据目录见 [前端 UI 场景录屏](../app-ts/README.md#ui-场景录屏)。

#### Bazel 边界与 TUI 场景测试

Windows 先配置 Git Bash，然后运行 App 边界和打包契约测试；其他平台只需第二条命令：

```powershell
$env:BAZEL_SH = "C:\Program Files\Git\bin\bash.exe"
bazelisk test //app-rs:app_ci --test_output=errors --test_env=PATH
```

`--test_env=PATH` 将固定版本 Node 的路径传给测试进程。`//ash-cli:tui-real-scenarios` 运行同一组 CLI/TUI PTY 场景；先将锁定的 `rg`、`tgrep` 路径设为 `ASH_RG_PATH`、`ASH_TGREP_PATH`。Linux CI 无法运行的真实沙箱场景由 macOS 作业覆盖。

### Dev Container：Linux Desktop、Web 与后端

安装 Docker 和 VS Code Dev Containers 扩展，执行 **Dev Containers: Reopen in Container**。配置见 [`.devcontainer/`](../.devcontainer/)，首次创建需联网安装工具、项目依赖、Chromium 和后端资源。

在容器终端执行 `just ash-desktop` 启动 Electron，在宿主机打开转发的 6080 端口，使用 VNC 密码 `vscode` 查看桌面。容器启用 `privileged` 并配置 Electron 沙箱权限；依赖和产物使用容器卷，与宿主机隔离。

仅前端 Web 模式执行 `pnpm --dir app-ts dev:web --host 0.0.0.0`，打开转发的 5173 端口。完整 Web 模式和 App Server 只监听容器回环地址，须在容器内运行 Playwright，不能通过端口转发在宿主机浏览器访问。Browser 测试执行 `pnpm test:desktop:smoke:browser` 或 `pnpm test:web-integration`；Electron Playwright 使用容器桌面。

## 输出布局

| 路径 | 内容 |
| --- | --- |
| `.build/cargo/` | 默认 Cargo 输出，可由 `CARGO_TARGET_DIR` 覆盖 |
| `.build/code/dev/<digest>/` | Code 源码运行所需程序 |
| `.build/app-ts/` | Electron、Renderer、生成的测试程序和 Playwright 报告 |
| `.build/runtime/dev/` | 完整后端开发包和选用记录 |
| `.build/build-health/` | 构建测量日志与报告 |
| `.build/ash-playwright-mcp/` | 临时 UI 场景与验证证据 |
| `.build/bazel-*` | Bazel 工作区便捷链接；Bazel 输出缓存另行管理 |

Sherpa ONNX 静态库使用按版本共享的校验缓存，位于 `third_party/.cache/sherpa-onnx/`。仓库 Cargo 入口与产品构建会准备并复用该资源，详见 [资源锁定与离线构建](../third_party/sherpa-onnx/README.md)。

`pnpm clean` 删除 `.build/` 及 `build/`、`scripts/` 内的 Python 缓存，不清理 `node_modules`、用户级 pnpm store 或 `.ash/` 配置。源码目录 `build/`、`scripts/` 不属于构建产物。

生成的前端协议副本位于 `app-ts/src/ash/platform/app-server/common/generated/`，可由 `pnpm --dir app-ts protocol:sync` 重建。受版本控制的图标工厂使用 `pnpm icons:generate` 更新。

## Rust 依赖检查与构建测量

### 依赖检查

按 [Rust 依赖规范](../.github/instructions/rust-coding-guidelines.instructions.md#dependencies-and-build-costs) 安装固定版本的检查工具，然后执行：

```sh
cargo install cargo-shear --version 1.13.4 --locked
just dependencies
```

检查覆盖依赖声明、产品依赖方向、无用依赖和 [已审查的多版本集合](../.cargo/dependencies.toml)。集合变化时通过 `cargo tree --workspace --target all -i <package>` 审阅；误报需在所属包的 `package.metadata.cargo-shear` 中逐项说明。

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

### CI 检查

| 工作流 | 覆盖 |
| --- | --- |
| [frontend.yml](../.github/workflows/frontend.yml) | TypeScript 构建工具、编辑器、前端单测和 Browser/Electron UI Playwright |
| [tooling.yml](../.github/workflows/tooling.yml) | Python 检查及构建、包布局、签名契约测试 |
| [bazel-boundary.yml](../.github/workflows/bazel-boundary.yml) | App 边界、发布契约和 CLI/TUI PTY 场景 |
| [platform-checks.yml](../.github/workflows/platform-checks.yml) | 平台验证和发布包签名、上传 |
| [rust-warnings.yml](../.github/workflows/rust-warnings.yml) | Rust warning 检查和 TUI 测试 |
| [rust-build-health.yml](../.github/workflows/rust-build-health.yml) | 依赖检查、Rust 测试和构建性能比较 |

每次 main push 的性能检查在同一 runner 和工具链下对协议包前后版本各测三轮；耗时中位数同时增加超过 25% 和两秒时失败。查看上传的报告，负载波动时复测。具体触发条件和平台分工以工作流为准。

### 历史测量与适用范围

以下是特定源码、机器和场景的记录，不是当前构建预算。完整实验过程可通过本文件的 Git 历史查阅，原始报告位于各次记录指定的 `.build/build-health/` 目录。

| 日期与条件 | 改动与结果 | 适用范围 |
| --- | --- | --- |
| 2026-09-13，macOS aarch64、Rust 1.98.0、4 个任务 | TUI 测试与服务程序统一为 `ci-test` 后，顺序冷编译约 18 分 20 秒 → 9 分 15 秒，输出约 10 GB → 9.1 GB | 不代表其他 profile；当时 macOS 链接仍有 compact-unwind 提示 |
| 2026-09-13，同平台、6 个任务 | 协议注册表共享非泛型实现，三组发布重编译中位数 120.07 → 83.46 秒 | 六次重编译包集合一致；全局 `4 CGU + ThinLTO` 候选使 CLI 编辑重编译 6.50 → 159.24 秒，未采用 |
| 2026-09-24，同平台、`dev`、6 个任务 | 协议类型移出反馈服务，三轮空输出目录构建中位数 89.55 → 69.27 秒，RSS 1.33 → 1.36 GB | 协议包结果，未证明完整产品提速 |
| 2026-09-24，同平台、`dev`、4 个任务 | 已预热 sccache 的协议包空输出构建 66.03 → 47.88 秒 | touch 复用了未变化的内容，不代表实际编辑；RSS 未覆盖缓存服务 |
| 2026-09-24，同平台、无 sccache | 协议默认配置去除重复 check，三轮完整命令中位数 220.13 → 145.92 秒 | 同机交错对照，有负载波动；不代表 GitHub runner |
| 2026-09-25，Windows x86_64、Rust 1.98.0、`dev-small` | Code 使用 `rust-lld` 后，三轮实际文案编辑重编译中位数 11.31 → 7.84 秒 | Windows Code 编辑场景；未采集进程树 RSS，冷编译不能单独归因于链接器 |
| 2026-09-26，macOS arm64 | Vite 显式预优化依赖后，首次窗口菜单和编辑区可见耗时 4507 → 2873 毫秒，重载 1 → 0 次 | 两次依赖缓存失效的单次 Playwright 对照，不代表日常启动或 Rust 冷编译 |
| 2026-09-28，macOS arm64、Rust 1.98.0、12 个任务 | TUI 测试包优化级别降为 0，实际编辑重编译中位数 13.31 → 6.72 秒，测试程序 235.2 → 253.9 MiB | 共享增量输出；缺少同条件冷编译对照 |
| 2026-09-28，同平台、`dev-small` | Code TUI 优化级别降为 0，三轮实际编辑重编译中位数 5.79 → 3.49 秒，回切为 5.84 秒 | `just build-code` 的 TUI 编辑场景；冷编译及运行性能未配对测量，发布配置未变 |
| 2026-09-30，macOS arm64、Rust 1.98.0、现有 `test` 缓存 | `just --set tui_profile test test-tui-unit session_manager` 在提交稳定后的单次重跑中，Cargo 阶段 0.74 秒，13 项测试执行 0.13 秒 | 先前运行观察到宏动态库的系统签名校验等待，期间 `git pull` 也触发了重编译；此记录未测默认 `ci-test` 的冷构建，不是配置修改前后的速度对照 |
| 2026-10-01，macOS arm64、Rust 1.98.0、`ash-tui` / `dev-small`、12 个任务 | 三轮空输出目录构建中位数 125.97 秒，无改动 1.73 秒，源码时间戳变化 2.82 秒；冷构建 RSS 1.34 GiB，TUI `.rlib` 54.8 MiB | TUI 自身冷编译中位数 10.37 秒；AWS-LC 构建中位数 84.06 秒，经 HTTP、GitHub、State 依赖延长尾部。构建脚本还下载 Sherpa 库，Cargo 离线模式未阻止该下载；不是优化前后对照 |
| 2026-10-01，同平台、现有 `dev-small` 缓存 | 源码不变，仅通过 `ASH_BUILD_COMMIT` 改变构建提交号，`just build-code` 单次耗时 2.30 → 16.27 秒，13 个编译单元重编译；恢复后 15.81 秒 | `build-info` 的提交身份经过协议和诊断依赖传播至 TUI、CLI 与 App Server；未改 Git checkout。单次触发实验，不是提速结果 |
| 2026-10-01，同平台、`ash-tui` / `dev-small`、12 个任务，三轮对照 | TLS 显式使用 ring，云端转写改为宿主选择的 feature，Sherpa 静态库按锁定版本共享后：冷构建 125.97 → 80.54 秒，无改动 1.73 → 1.41 秒，时间戳重编译 2.82 → 2.53 秒；冷构建 RSS 1.34 → 1.33 GiB，TUI `.rlib` 54.8 MiB | 最终代码冷构建约快 36%，三轮为 83.57 / 78.30 / 80.54 秒；前一候选的三轮中位数为 89.57 秒，差值不单独归因于 SDK 适配修正。仅 TLS 调整为 117.39 秒。TUI 默认依赖图移除 AWS-LC、model-provider 与 tokenizers；完整 App Server 仍启用云端转写，并因其他上游依赖保留 AWS-LC。共享 Sherpa 资源已预热，原构建脚本会在 Cargo 离线模式中下载资源，结果包含消除该下载的收益；不代表首次资源准备、其他平台或完整产品冷构建 |
| 2026-10-01，同平台、现有 `dev-small` 缓存，三轮实际 `just build-code` 对照 | 构建身份与稳定数据契约分开后，仅改变 `ASH_BUILD_COMMIT` 的构建中位数 13.73 → 6.13 秒；重编译包从 13 个缩至身份库、CLI、App Server，协议与 TUI 保持缓存 | 无改动 1.51 → 0.83 秒，TUI 时间戳重编译 4.17 → 3.32 秒；时间戳变化不是实际功能编辑。单项身份调整的提交号重编译为 9.64 秒；这些完整入口数据不用于推断完整产品冷构建 |
| 2026-10-02，macOS arm64、Rust 1.98.0、`ci-test` | 移除全局优化级别 0 后，App Server / Remote 的 `__eh_frame` 分别为 10.8 / 10.5 MiB，低于 16 MiB；两个服务的实际链接均通过 `-D warnings` | 验证使用提交 `240064771` 的独立检出，保留 TUI 的包级别 0 与异常展开设置。三轮构建基线因期间出现新提交而被测量工具拒绝，不作为构建速度对照；日志及段大小位于 `.build/build-health/unwind-20261002/` |

优化前的报告为 `.build/build-health/ash-tui-dev-small-gc6em9qr/report.json`，完整入口、提交号实验和测试日志汇总在 `.build/build-health/tui-investigation-20261001/report.json`。该次调查的默认 `ci-test` 13 项会话测试通过，首次 Cargo 编译 33.20 秒，无改动重跑 0.70 秒；当时未复现持续卡死，系统对宏动态库的检查耗时未单独测量。

2026-10-01 优化对照报告：最终 TUI 为 `.build/build-health/ash-tui-dev-small-big7auep/report.json`，前候选为 `ash-tui-dev-small-o1xchm_t/report.json`，TLS 单项为 `ash-tui-dev-small-r4dns3wj/report.json`；完整 Code 的基线、身份单项与最终候选位于 `.build/build-health/tui-fix-20261001/{baseline,identity,final}-product.json`。

同日验证时也复现了系统等待：`rustc` 的采样栈停在加载过程宏动态库的 `dlopen → mapSegments → fcntl`，编译器 CPU 为 0，`syspolicyd` 正在执行安全评估。该轮小范围 `just check` 共耗时 4 分 42 秒，并最终继续完成；栈与系统日志保存在上述 `tui-fix-20261001` 目录。此现象与依赖编译的 CPU 工作不同，已实现的依赖与缓存调整不能保证消除 macOS 首次加载检查；本次未更改系统安全设置。

本次验证：完整 `just build-code`、默认 TUI 的 1,197 项测试、本地与 cloud 语音测试、诊断/反馈及听写 RPC、协议测试、更新与 Remote 宿主测试、受影响包的 `just rust-warnings`、Python 构建测试与 `just dependencies`。真实模型/麦克风测试按已有条件忽略；Windows/Linux 构建未在本机执行。后端与 Remote 的 `ci-test` 程序链接有 `__eh_frame` 超过 16 MiB 的 compact-unwind 提示；测试通过，但不将其记录为无 warning 的构建。正常 Code 的 `dev-small` 构建和包级 warning 检查未出现该提示，未改变全局 profile 或 unwind 设置。


2026-10-01 补齐 `utils/cargo-bin` 和 `utils/cli` 时，对 `ash-cli` / `dev-small` 做了三轮构建对照，使用同一 macOS arm64 主机、Rust 1.98.0 和 12 个任务。最初空输出构建中位数为 85.70 秒；补齐后为 98.00 秒，回切原 CLI 源码后为 98.17 秒。无改动分别为 1.45 / 1.62 / 1.58 秒，源码时间戳重编译为 2.60 / 2.78 / 2.81 秒。后两组的冷构建 RSS 为 1.68 / 1.54 GiB，CLI 二进制约 83.4 MiB。回切保留了新增 workspace 成员；这些结果未证明工具库能够提速，也不能把最初与后两组的差异直接归因于工具库。

真实 `just build-code` 的三轮对照中，无改动为 0.78 → 0.78 秒，CLI 错误前缀的实际代码编辑为 2.36 → 2.40 秒，CLI 二进制约 84.5 MiB，编辑构建 RSS 约 0.87 GiB。参数图拆成独立 crate 的实验，在 TUI Debug 文案实际编辑后为 3.63 → 3.57 秒，回切为 3.69 秒；没有明显收益，已撤回。Cargo timings 中 `ash-app-server-protocol` 单个编译单元约 41–48 秒，新增 CLI 工具库约 0.24 秒；该调查未修改协议实现或全局优化配置，冷编译瓶颈仍在。

报告分别为 `.build/build-health/ash-cli-dev-small-{iktqajj3,9wk3uvac,jw5yk5r9}/report.json`；完整入口与拆分实验位于 `.build/build-health/cli-utils-20261001/{baseline-product,kept-product,tui-product}.json`。Cargo/Bazel 工具库测试、CLI 43 项测试、一个真实终端资源场景、正常 Code 构建、包级 warning 检查及依赖检查通过。完整 Bazel CLI 目标的首次分析被已有 `collaboration-mode-templates` / `ash-mcp` 依赖标签错误阻断；后续修复结果见下文。Windows/Linux 运行行为未在本机验证。

2026-10-01 随后对协议编译做了三项实验：`ash-exec` 的 JSON Schema 派生改为显式 `schema` feature，两个协议包在 `dev-small` 下使用 `opt-level=0`，以及优化 `syn`、`quote`、`proc-macro2`、`serde_derive` 的候选配置。最终保留前两项；schema feature 的嵌套类型与标识符约束由测试覆盖。

下表每项为三轮中位数，测量基于 `0090c73f55` 及本次改动，使用同一 macOS arm64 主机、Rust 1.98.0、12 个任务。CLI 冷构建使用独立输出目录；Code 编辑场景复用产品输出，逐轮修改协议 `AppServerListenInfoError` 的实际错误文本，并确认协议及下游重新编译，随后恢复原文。

| 方案 | CLI 冷构建 / 秒 | CLI 无改动 / 秒 | CLI 时间戳重编译 / 秒 | Code 协议编辑 / 秒 | CLI 冷构建 RSS / GiB | Code 的 ash / MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 基线 | 90.79 | 1.87 | 2.69 | 14.10 | 1.69 | 84.6 |
| schema 显式开启 | 91.65 | 1.64 | 2.83 | 13.27 | 1.35 | 85.5 |
| 再将协议包优化级别降为 0 | 100.05 | 1.64 | 2.90 | 9.07 | 1.24 | 93.7 |
| 再优化宏依赖的候选 | 87.32 | 1.58 | 2.82 | 8.62 | 1.24 | 92.9 |
| 撤回宏配置后的复测，最终保留 | 74.26 | 1.47 | 2.74 | 8.74 | 1.24 | 93.7 |

最终方案的实际协议编辑约快 38%，Code 无改动仍约 0.8 秒，编辑构建 RSS 为 1.59 GiB。代价是开发 CLI 二进制约增大 11%。协议编译单元本身的三轮中位数从底层 31.92 秒、上层 45.96 秒降到 9.42 秒、21.76 秒；回切复测为 9.26 秒、18.48 秒。

同一份代码、相同已记录输入与环境的两组冷构建结果从 100.05 秒变为 74.26 秒，波动较大，因此不能给出稳定冷构建提速比例，也不能将宏候选的差值单独归因于宏优化。宏配置回切后编辑时间为 8.74 秒，与候选的 8.62 秒接近，未保留该配置。这些结果不代表完整 Code 冷构建、所有协议类型编辑、发布构建或其他平台。

CLI 报告位于 `.build/build-health/ash-cli-dev-small-{n4o_stkm,og0s6jgl,in95a67w,fha0_w73,voewa4mc}/report.json`；实际产品报告位于 `.build/build-health/protocol-20261001/{baseline,schema-off,opt0,macro3,kept}-product.json`。

协议测试（上层 72 项、底层 45 项）、执行测试（默认配置 10 项、schema 配置 11 项）、CLI 命令测试 9 项、包级检查、两种配置的 warning 检查、依赖检查及当前工作区的 `just build-code` 通过。执行测试的旧 Turn fixture 已补齐 `mode`。Bazel 已同步显式 schema feature 和可选依赖；首次目标分析被已有的 `collaboration-mode-templates` 目标名称错误阻断，随后完成以下修复。其他平台未在本机测量。

同日修正 Bazel 的 `collaboration-mode-templates`、`ash-mcp` 目标名与 App Server 导入名，补齐协议目标的可选 schema 依赖、Web 模板资源及云端语音 feature。共享构建宏现在让单测继承库的 feature，执行 schema 测试与云端语音测试不再被跳过。协议 fixture 测试使用 `cargo-bin` 定位 Cargo/Bazel 资源；metadata 与解码器生成保持固定 JSON 字段顺序，不受 `serde_json/preserve_order` 影响。

`bazel build //ash-rs/exec:exec //ash-cli:ash` 和生成二进制的 `ash --help` 通过。五个 Bazel 单测目标共通过 114 项：模式模板 2 项、MCP 12 项、执行/schema 11 项、语音 17 项、协议 72 项；语音的三项真实模型/麦克风测试按既有条件忽略。Cargo 在显式启用 `export,serde_json/preserve_order` 时的协议 72 项测试也通过；受影响包的检查、warning 检查与依赖检查通过，`just generate-protocol` 没有改变生成文件。日志位于 `.build/build-health/protocol-20261001/bazel-*.log` 与 `protocol-preserve-order3.log`；这次修复没有新增性能测量。

早期 WebRTC 构建记录属于已切换的依赖图，不能用于当前耗时判断。2026-09-24 产品宿主拆除 App Server 实现依赖的单包测量，也没有同条件完整产品冷构建的前后对照。

## 构建源码与仓库脚本边界

| 路径 | 职责 |
| --- | --- |
| `build/app_ts/` | Electron、Web 的构建、开发启动和后端变化监听 |
| `build/ash_rs/` | 共享后端构建、资源下载、组包与签名 |
| `build/code/`、`build/app_rs/` | 各产品的构建和交付 |
| `build/lib/`、`build/download/` | 共用的 Cargo、归档、签名和下载实现 |
| `build/protocol/`、`build/resources/` | 协议同步与共享资源生成 |
| `build/pnpm/`、`build/clean.ts` | Node 安装校验与清理 |
| `scripts/` | 仓库级 Cargo 环境、格式化、测试、依赖检查和测量 |

根 `justfile` 和 `package.json` 声明命令并调用上述实现。`scripts/` 可以调用 `build/`；构建实现不反向调用仓库脚本。前端构建工具使用 TypeScript，后端构建和组包使用 Python。测试内容归对应产品，运行产物归 `.build/`。

工具需要从仓库根发现的 Cargo、pnpm、Bazel 和 TypeScript 配置留在根目录；Node workspace 共用根锁文件。共享包布局和发布流程见 [构建器说明](../build/ash_rs/README.md)，桌面开发生命周期见 [app-ts README](../app-ts/README.md)，文档站由独立的 `ash-docs` 仓库负责。
