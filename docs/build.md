# 构建与开发

本文说明环境准备、产品构建、验证和缓存清理。Electron、Browser、Stanza 的启动模式、热更新和前端测试见 [前端开发](frontend.md)；产品关系见 [产品线](product-lines.md)。

## 构建入口

以下命令均在仓库根目录执行。工具版本以仓库配置为准：

| 工具          | 版本来源                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Rust          | [`rust-toolchain.toml`](../rust-toolchain.toml)                                                               |
| Node.js       | [`.nvmrc`](../.nvmrc)；pnpm 使用 [`package.json`](../package.json) 中的 `devEngines.runtime` 自动获取固定版本 |
| pnpm          | 根 [`package.json`](../package.json) 的 `packageManager`，安装方法见[初始化](#初始化)                         |
| Python        | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `requires-python`，建议 3.12                         |
| Just          | 安装后确保 `just` 在 PATH 中                                                                                  |
| Bazel（按需） | Bazelisk 读取 [`.bazelversion`](../.bazelversion)                                                             |

### macOS 与 Linux 开发环境

安装 Rust、Just 和 Python 3.11 及以上版本。首次初始化使用 PATH 中的 `python3`；确认 `python3 -c 'import tomllib'` 成功。macOS 自带 Python 可能不满足要求，可用 `uv run --python 3.12 just install` 初始化；Apple Silicon 上的 Homebrew Python 3.12 也可将 `/opt/homebrew/opt/python@3.12/libexec/bin` 放在 PATH 前部。初始化后，Just 和前端构建入口优先复用 `scripts/.venv`，日常启动无需再包装 `uv run`。

准备完整后端包时，macOS 还需要 Go 1.26 和系统 C/C++ 工具链来构建 LiveKit Server，见 [LiveKit Server](../third_party/livekit/README.md)。Linux 的完整后端构建需要 ALSA 开发库；沙箱构建需要 C 编译器和 libcap，见 [共享包构建](../build/runtime/README.md)。

### Windows 开发环境

安装下列工具后，使用对应目标架构的 **Visual Studio Developer PowerShell** 构建。已安装的 Ash 产品不依赖这些开发工具。

| 工具                         | 安装要求                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Visual Studio Build Tools    | 2022 / MSVC v143，选择“使用 C++ 的桌面开发”和 Windows SDK                                    |
| Visual Studio English 语言包 | 在 Installer 中补装，避免中文链接器进度被 Rust 误报为 warning                                |
| PowerShell 7                 | 支持 `-CommandWithArgs`；`just install` 可通过 winget 安装缺失的工具                         |
| Python                       | `python` 命令指向满足仓库要求的版本                                                          |
| Git、ripgrep、CMake          | 安装并加入 PATH                                                                              |
| LLVM/Clang                   | LLVM 的 `bin` 加入 PATH；自定义安装路径时，设置 `LIBCLANG_PATH` 指向含 `libclang.dll` 的目录 |
| Bazelisk（按需）             | 运行 Bazel 测试前，将 `BAZEL_SH` 设为 Git Bash 路径                                          |

无需全局设置 `CC`、`CXX`。Windows 桌面构建和平台验证在 Windows 上完成；Dev Container 用于 Linux 开发。

### 初始化

1. 使用 [pnpm 独立安装方式](https://pnpm.io/installation/)，安装根 [`package.json`](../package.json) 的 `packageManager` 指定版本。仓库安装检查要求版本一致。
2. 执行 `pnpm install`，安装 Node workspace 依赖。
3. 执行 `just install`，获取 Cargo 依赖并创建含固定版本 Ruff 和 codespell 的 `scripts/.venv`。Windows 缺少 PowerShell 7 时，此步骤会安装它；随后重启终端和编辑器以更新 PATH。

直接执行 `node` 时使用 `.nvmrc` 指定版本；pnpm 脚本使用仓库固定的 Node。Just 和 Node 启动的 Python 构建工具优先使用初始化创建的 `scripts/.venv`。Node 入口可用 `PYTHON` 显式指定解释器，Just 可用 `just --set python <解释器路径> <命令>` 覆盖；尚未初始化时，Just 使用 Windows 的 `python` 或其他平台的 `python3`。

pnpm 根据 `devEngines.runtime` 下载并使用固定的 Node 版本，通常不需要单独安装 Node。`pnpm install` 可在 PowerShell 与 Bash 中执行。运行 Electron 或 Browser Workbench 前需要前端依赖；只开发 CLI/TUI 时按所需 Rust 工具和后端资源准备环境。

### 项目命令

#### 启动

| 产品                 | 命令            | F5 配置          |
| -------------------- | --------------- | ---------------- |
| 完整 Electron 桌面端 | `just ash`      | `Ash (Electron)` |
| 终端界面             | `just ash-code` | `Ash Code (TUI)` |

仅前端、只监听前端、完整 Web 和独立编辑器的区别及对应命令见 [前端启动方式](frontend.md#启动项目)。

#### 构建与维护

| 命令                                            | 结果                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `just build`                                    | 构建两个产品及其开发所需服务程序                                           |
| `just build-code` / `just build-ash`            | 构建指定产品                                                               |
| `just build-rust`                               | 构建根 Rust workspace                                                      |
| `just check <package>`                          | 检查指定 Rust 包                                                           |
| `just lint`                                     | 检查 Python 代码                                                           |
| `just spellcheck`                               | 检查仓库源码和文档中的常见英文拼写错误                                     |
| `just fmt` / `just fmt-check`                   | 调用各语言工具，格式化或检查 Just、Rust、Python、TS/JS、配置与文档         |
| `just rust-format` / `just rust-format-check`   | 单独格式化或检查 Rust，不需要前端依赖                                      |
| `pnpm format:ts` / `pnpm format:ts:fix`         | 检查或格式化第一方 TS/JS；可追加文件或目录                                 |
| `pnpm format:config` / `pnpm format:config:fix` | 用 Prettier 检查或格式化 JSON、YAML、Markdown、CSS、HTML                   |
| `pnpm format` / `pnpm format:fix`               | 检查或格式化上述前端源码、配置与文档                                       |
| `pnpm typecheck:build`                          | 检查 TypeScript 构建工具                                                   |
| `pnpm stylelint`                                | 只读检查生产 CSS 的变量和选择器，报告文件、行和列；可追加文件、目录或 glob |
| `pnpm hygiene`                                  | 检查 CSS 变量和选择器，再用前端单测验证变量清单与注册表一致                |
| `pnpm stylelint:update`                         | 用真实颜色、尺寸注册表更新变量清单，保留组件变量；审阅生成差异后再检查     |
| `pnpm clean`                                    | 清理本地产物和 Python 缓存                                                 |

格式化工具按语言选择：TS/JS 使用 [`tsfmt.json`](../tsfmt.json)，Rust 使用 [`rustfmt.toml`](../rustfmt.toml)，Python 使用固定版本 Ruff，配置与文档使用 [Prettier](../.prettierrc.toml)。前端与 Rust 格式化入口只处理第一方源码；检查命令不修改文件。修改后优先检查受影响的文件，完整格式检查见 [Formatting CI](../.github/workflows/format.yml)。

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

#### 固定开发步骤

以下入口由 [`scripts/workflow.py`](../scripts/workflow.py) 组织现有命令：

| 命令                           | 完成的步骤                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `just context <file>`          | 列出所属 Cargo 包、适用规范与引用的 skill                                                          |
| `just verify <package>`        | 使用同一 `ci-test` profile 执行包级 `check`、`test`、`rust-warnings`；失败或没有通过任何用例时停止 |
| `just snapshot <path.snap>...` | 定位所属 TUI 测试并按组运行；展示待审阅差异，有待审阅基线时返回非零退出码                          |
| `just snapshot --pending`      | 汇总 TUI 的 `.snap.new`，按测试分组复跑并展示差异                                                  |

`verify` 支持 `--filter <test-name>`、`--features <features>` 和 `--profile <profile>`；过滤条件只传给测试，feature 与 profile 传给三个步骤。`verify` 和 `snapshot` 支持 `--plan`，只解析并展示命令，不编译或运行。路径可以使用仓库根目录下的相对路径或绝对路径。

```sh
just context crates/tui/snapshots/fullscreen/composer/composer_focused.snap
just snapshot crates/tui/snapshots/fullscreen/composer/composer_focused.snap
just snapshot --pending --plan
just verify ash-utils-home-dir
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

#### Bazel 边界与 TUI 场景测试

运行迁移后的 CLI/TUI 场景：

```sh
bazel test //cli:tui-real-scenarios --test_output=errors --test_env=PATH
```

`--test_env=PATH` 将固定版本 Node 的路径传给测试进程。`//cli:tui-real-scenarios` 运行同一组 CLI/TUI PTY 场景；先将锁定的 `rg`、`tgrep` 路径设为 `ASH_RG_PATH`、`ASH_TGREP_PATH`。Linux CI 无法运行的真实沙箱场景由 macOS 作业覆盖。

### Dev Container：Linux Desktop、Web 与后端

安装 Docker 和 VS Code Dev Containers 扩展，执行 **Dev Containers: Reopen in Container**。配置见 [`.devcontainer/`](../.devcontainer)，首次创建需联网安装工具、项目依赖、Chromium 和后端资源。

在容器终端执行 `just ash` 启动 Electron，在宿主机打开转发的 6080 端口，使用 VNC 密码 `vscode` 查看桌面。容器启用 `privileged` 并配置 Electron 沙箱权限；依赖和产物使用容器卷，与宿主机隔离。

仅前端 Web 模式执行 `pnpm dev:web --host 0.0.0.0`，打开转发的 5173 端口。完整 Web 模式和 App Server 只监听容器回环地址，须在容器内运行 Playwright，不能通过端口转发在宿主机浏览器访问。Browser 测试执行 `pnpm test:desktop:smoke:browser` 或 `pnpm test:web-integration`；Electron Playwright 使用容器桌面。

## 输出布局

| 路径                                        | 内容                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `.build/cargo/`                             | 默认 Cargo 输出，可由 `CARGO_TARGET_DIR` 覆盖                             |
| `.build/code/dev/generations/<digest>/bin/` | Code 源码运行所需程序；保留当前版本与仍在运行的版本，程序对象以硬链接复用 |
| `.build/desktop/`                           | Electron、Renderer、生成的测试程序和 Playwright 报告                      |
| `.build/desktop/web/ash/`                   | 独立 Web 构建，包含浏览器 Workbench 与 Sessions 页面                      |
| `.build/runtime/dev/`                       | 完整后端开发包和选用记录                                                  |
| `.build/build-health/`                      | 构建测量日志与报告                                                        |
| `.build/ash-playwright-mcp/`                | 临时 UI 场景与验证证据                                                    |
| `.build/bazel-*`                            | Bazel 工作区便捷链接；Bazel 输出缓存另行管理                              |

Sherpa ONNX 静态库使用按版本共享的校验缓存，位于 `third_party/.cache/sherpa-onnx/`。仓库 Cargo 入口与产品构建会准备并复用该资源，详见 [资源锁定与离线构建](../third_party/sherpa-onnx/README.md)。

### 清理与缓存

`pnpm clean` 删除 `.build/`、旧 `target/`、`dist/`、旧 `test/integration/browser/dist/`，以及根目录和 `build/`、`scripts/` 内的 Python、pytest、Ruff 缓存；同时删除本地 `node_modules/` 内的 `.vite/`、`.vite-temp/` 缓存。清理前停止构建和开发进程；下次启动会重新构建。

清理保留源码、依赖包、用户级 pnpm store、`third_party/.cache/`、生成的协议源码和 `.ash/` 配置，不遍历符号链接指向的目录。Bazel 外部输出缓存单独用 `bazel clean --expunge` 清理。

日常 Cargo 和产品构建保留编译缓存，只记录使用时间并持有租约。目录盘点与回收通过 `just prune-build-cache` 单独执行，避免热构建等待扫描或清理后重新编译。

| 清理参数             | 默认值 | 回收内容                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| `--max-gib`          | 32 GiB | 闲置增量缓存；保留依赖库和程序                                                    |
| `--artifact-max-gib` | 64 GiB | 闲置 profile 的全部产物，包含增量缓存；按最近使用时间整组清理，下次使用需要重编译 |

预算仅在显式清理时应用。回收保留锁文件，跳过正在构建、运行或完成不足一分钟的 profile，工作集可能暂时超限。自定义 `CARGO_TARGET_DIR` 不自动参与预算；仓库内的其他 Cargo 输出目录可用 `--target-dir` 指定。

开发运行版本由发布器按租约回收，保留当前版本与仍在运行的版本。验证脚本应在结束时删除自行创建的临时编译、索引目录，只保留报告和复现材料；`just bench-build` 会自动清理自己的编译目录。开发包的发布与回收规则见 [共享包构建](../build/runtime/README.md)和 [Code 构建](../build/code/README.md)。

`just rust-warnings` 检查新生成与已缓存的编译警告，保持 `RUSTFLAGS` 与普通构建一致，避免生成另一套产物。

生成的前端协议副本位于 `src/ash/platform/app-server/common/generated/`，可由 `pnpm protocol:sync` 重建。受版本控制的图标工厂使用 `pnpm icons:generate` 更新。

## Rust 依赖检查与构建测量

### 构建配置

配置以 [`Cargo.toml`](../Cargo.toml) 与 [`.cargo/config.toml`](../.cargo/config.toml) 为准：

| Profile     | 用途                                                  | 调试信息       |
| ----------- | ----------------------------------------------------- | -------------- |
| `dev`       | 普通开发构建，保留增量编译                            | `limited`      |
| `dev-small` | Code 等产品开发程序；按包调整优化级别和 codegen units | 关闭并剥离符号 |
| `ci-test`   | 包级完整验证、TUI 单测与 PTY 场景，共用编译产物       | `limited`      |

`ci-test` 继承 `test` 的优化配置：共享包为 1，TUI 为 0，App Server 及其客户端为 `s`。不要全局降到 0，否则 macOS 服务程序的 `__eh_frame` 可能超过 compact-unwind 的 16 MiB 偏移限制。

协议消费者使用队列、通话、协作和任务交付的轻量契约，服务实现使用同一份类型；schema/export 按需启用。优化依赖范围与实际编辑循环后，再决定是否调整编译参数。本地保留增量编译；使用 sccache 的 CI 作业关闭增量编译，不能直接照搬到本地。

### 依赖检查

按 [Rust 依赖规范](../.agents/skills/rust-development/SKILL.md#dependencies) 检查依赖。工具使用下列固定版本：

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

| 工作流                                                              | 覆盖                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [frontend.yml](../.github/workflows/frontend.yml)                   | TypeScript 构建工具、编辑器、前端单测和 Browser/Electron UI Playwright |
| [tooling.yml](../.github/workflows/tooling.yml)                     | Python 检查及构建、包布局、签名契约测试                                |
| [bazel-boundary.yml](../.github/workflows/bazel-boundary.yml)       | App 边界、发布契约和 CLI/TUI PTY 场景                                  |
| [platform-checks.yml](../.github/workflows/platform-checks.yml)     | 平台验证和发布包签名、上传                                             |
| [rust-warnings.yml](../.github/workflows/rust-warnings.yml)         | Rust warning 检查和 TUI 测试                                           |
| [rust-build-health.yml](../.github/workflows/rust-build-health.yml) | 依赖检查、Rust 测试和构建性能比较                                      |

相关文件变更推送到 main 后，性能检查在同一 runner 和工具链下对协议包前后版本各测三轮；耗时中位数同时增加超过 25% 和两秒时失败。具体触发条件和平台分工以工作流为准。

### 历史测量与适用范围

以下仅保留能说明当前构建选择的测量。条件均为 macOS arm64、Rust 1.98.0、`dev-small`、12 个任务、三轮中位数；不能作为其他机器或当前版本的耗时预算。

| 场景                     | 已验证结果                                                                                             | 范围与代价                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 2026-10-05，协议依赖拆分 | 队列、通话、协作、任务交付类型移入契约 crate 后，协议包空输出构建 43.50 → 32.26 秒，编译单元 255 → 174 | 热构建没有明显变化；完整产品仍需要执行、图片和 SQLite，未证明完整产品冷构建提速 |
| 2026-10-01，实际协议编辑 | schema 按需启用、协议包优化级别降为 0 后，`just build-code` 重编译 14.10 → 8.74 秒                     | 开发 CLI 程序约增大 11%；冷构建波动较大，未给出稳定提速比例                     |

工具库补齐没有证明产品构建提速；参数库拆分、过程宏优化与构建依赖 profile 对齐候选均未证明收益，未保留。原始测量保存在 `.build/build-health/`；已提交的详细记录可从本文 Git 历史查阅。

## 构建源码与仓库脚本边界

根 `justfile` 和 `package.json` 声明命令并调用上述实现。`scripts/` 可以调用 `build/`；构建实现不反向调用仓库脚本。前端构建工具使用 TypeScript，后端构建和组包使用 Python。测试内容归对应产品，运行产物归 `.build/`。

工具需要从仓库根发现的 Cargo、pnpm、Bazel 和 TypeScript 配置留在根目录；Node workspace 共用根锁文件。共享包布局和发布流程见 [构建器说明](../build/runtime/README.md)，桌面开发生命周期见 [前端开发](frontend.md)，文档站由独立的 `ash-docs` 仓库负责。
