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
| uv            | [`scripts/pyproject.toml`](../scripts/pyproject.toml) 的 `tool.uv.required-version`                           |
| Just          | 安装后确保 `just` 在 PATH 中                                                                                  |
| Bazel（按需） | Bazelisk 读取 [`.bazelversion`](../.bazelversion)                                                             |

### macOS 与 Linux 开发环境

安装 Rust、Just、仓库要求的 uv 和 Python 3.11 及以上版本。首次初始化使用 PATH 中的 `python3`；确认 `python3 -c 'import tomllib'` 成功。macOS 自带 Python 可能不满足要求，可用 `uv run --python 3.12 just install` 初始化；Apple Silicon 上的 Homebrew Python 3.12 也可将 `/opt/homebrew/opt/python@3.12/libexec/bin` 放在 PATH 前部。初始化后，Just 和前端构建入口优先复用 `scripts/.venv`，日常启动无需再包装 `uv run`。

准备完整后端包时，macOS 还需要 Go 1.26 和系统 C/C++ 工具链来构建 LiveKit Server，见 [LiveKit Server](../third_party/livekit/README.md)。Linux 的完整后端构建需要 ALSA 开发库；沙箱构建需要 C 编译器和 libcap，见 [共享包构建](../build/README.md)。

### Windows 开发环境

安装下列工具后，使用对应目标架构的 **Visual Studio Developer PowerShell** 构建。已安装的 Ash 产品不依赖这些开发工具。

| 工具                         | 安装要求                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Visual Studio Build Tools    | 2022 / MSVC v143，选择“使用 C++ 的桌面开发”和 Windows SDK                                    |
| Visual Studio English 语言包 | 在 Installer 中补装，避免中文链接器进度被 Rust 误报为 warning                                |
| PowerShell 7                 | 支持 `-CommandWithArgs`；`just install` 可通过 winget 安装缺失的工具                         |
| Python                       | `python` 命令指向满足仓库要求的版本                                                          |
| uv                           | 安装 `scripts/pyproject.toml` 要求的版本并加入 PATH                                          |
| Git、ripgrep、CMake          | 安装并加入 PATH                                                                              |
| LLVM/Clang                   | LLVM 的 `bin` 加入 PATH；自定义安装路径时，设置 `LIBCLANG_PATH` 指向含 `libclang.dll` 的目录 |
| Bazelisk（按需）             | 运行 Bazel 测试前，将 `BAZEL_SH` 设为 Git Bash 路径                                          |

无需全局设置 `CC`、`CXX`。Windows 桌面构建和平台验证在 Windows 上完成；Dev Container 用于 Linux 开发。

### 初始化

1. 使用 [pnpm 独立安装方式](https://pnpm.io/installation/)，安装根 [`package.json`](../package.json) 的 `packageManager` 指定版本。仓库安装检查要求版本一致。
2. 执行 `pnpm install`，安装 Node workspace 依赖。
3. 执行 `just install`，获取 Cargo 依赖并通过 uv 同步 `scripts/uv.lock` 中固定的 Ruff 和 codespell 到 `scripts/.venv`。Windows 缺少 PowerShell 7 时，此步骤会安装它；随后重启终端和编辑器以更新 PATH。

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

#### 提交前本地验证与 CI

交付前在当前平台完成受影响范围的必要验证；已有诊断和通过结果覆盖当前输入时直接复用，无需为提交或推送重复构建。Rust 包复用下方的 `just verify`，前端按改动选择已有类型检查、构建和 Playwright 入口。扩大到全量、跨平台或预计长时间验证前按 [测试规范](../.github/instructions/testing.instructions.md#learnings) 取得用户确认；人工审阅改动和结果是另一个环节，不代替测试范围确认或行为验证。

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

`verify` 支持 `--filter <test-name>`、`--features <features>` 和 `--profile <profile>`；过滤条件只传给测试，feature 与 profile 传给三个步骤。`verify` 和 `snapshot` 支持 `--plan`，只解析并展示命令，不编译或运行。路径可以使用仓库根目录下的相对路径或绝对路径。

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

#### Bazel TUI 场景测试

运行迁移后的 CLI/TUI 场景：

```sh
bazel test //cli:tui-real-scenarios --test_output=errors --test_env=PATH
```

`--test_env=PATH` 将固定版本 Node 的路径传给测试进程。`//cli:tui-real-scenarios` 运行同一组 CLI/TUI PTY 场景；先将锁定的 `rg`、`tgrep` 路径设为 `ASH_RG_PATH`、`ASH_TGREP_PATH`。Linux CI 无法运行的真实沙箱场景由 macOS 作业覆盖。

### Dev Container：Linux Desktop、Web 与后端

安装 Docker 和 VS Code Dev Containers 扩展，执行 **Dev Containers: Reopen in Container**。配置见 [`.devcontainer/`](../.devcontainer)，首次创建需联网安装工具、项目依赖、Chromium 和后端资源。

当前容器镜像未预装 uv。若首次初始化提示缺少 uv，在容器中安装 `scripts/pyproject.toml` 要求的版本并加入 PATH，再执行 `sh .devcontainer/post-create.sh` 完成初始化。

在容器终端执行 `just ash` 启动 Electron，在宿主机打开转发的 6080 端口，使用 VNC 密码 `vscode` 查看桌面。容器启用 `privileged` 并配置 Electron 沙箱权限；依赖和产物使用容器卷，与宿主机隔离。

仅前端 Web 模式执行 `pnpm dev:web --host 0.0.0.0`，打开转发的 5173 端口。完整 Web 模式和 App Server 只监听容器回环地址，须在容器内运行 Playwright，不能通过端口转发在宿主机浏览器访问。Browser 测试执行 `pnpm test:desktop:smoke:browser` 或 `pnpm test:web-integration`；Electron Playwright 使用容器桌面。

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

### 清理与缓存

`pnpm clean` 删除 `.build/`、旧 `target/`、`dist/`、旧 `test/integration/browser/dist/`，以及根目录和 `build/`、`scripts/` 内的 Python、pytest、Ruff 缓存；同时删除本地 `node_modules/` 内的 `.vite/`、`.vite-temp/` 缓存。清理前停止构建和开发进程；下次启动会重新构建。

清理保留源码、依赖包、用户级 pnpm store、`third_party/.cache/`、`.ash/` 配置，不遍历符号链接指向的目录。Bazel 外部输出缓存单独用 `bazel clean --expunge` 清理。

日常 Cargo 和产品构建保留编译缓存，只记录使用时间并持有租约。目录盘点与回收通过 `just prune-build-cache` 单独执行，避免热构建等待扫描或清理后重新编译。

| 清理参数             | 默认值 | 回收内容                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| `--max-gib`          | 32 GiB | 闲置增量缓存；保留依赖库和程序                                                    |
| `--artifact-max-gib` | 64 GiB | 闲置 profile 的全部产物，包含增量缓存；按最近使用时间整组清理，下次使用需要重编译 |

预算仅在显式清理时应用。回收保留锁文件，跳过正在构建、运行或完成不足一分钟的 profile，工作集可能暂时超限。自定义 `CARGO_TARGET_DIR` 不自动参与预算；仓库内的其他 Cargo 输出目录可用 `--target-dir` 指定。

开发运行版本由发布器按租约回收，保留当前版本与仍在运行的版本。验证脚本应在结束时删除自行创建的临时编译、索引目录，只保留报告和复现材料；`just bench-build` 会自动清理自己的编译目录。开发包的发布与回收规则见 [共享包构建](../build/README.md)和 [Code 构建](../build/code/README.md)。

`just rust-warnings` 检查新生成与已缓存的编译警告，保持 `RUSTFLAGS` 与普通构建一致，避免生成另一套产物。

类型检查、Electron 主进程/preload 编译和开发 watch 使用 TypeScript 7.0.2。工作区将编译器固定在 `@ash/typescript-compiler` npm 别名下，`pnpm exec tsc` 和现有构建/测试脚本均调用 TS7。`typescript` 别名保留 `@typescript/typescript6@6.0.2` 兼容包提供的 TS6 JavaScript API，供本地化提取、热更新分析、格式化和架构测试使用；它提供独立的 `tsc6` 命令。升级时同步根目录和 `build/` 的编译器/API 依赖、`test/scenario/` 的编译器依赖及锁文件，并验证 host watch 的失败与恢复、preload 导入限制和 Web/Electron 启动。

前端与构建工具直接消费 `.build/protocol/typescript/` 的共享生成协议，产物不提交到 Git。正常前端、Rust Just 和打包入口自动准备协议：优先复用本地缓存或源码匹配的后端包，缺少匹配产物时需要 Rust 工具链重新生成。修改后端协议后可运行 `just generate-protocol`，再运行 `pnpm typecheck:protocol`；直接 Cargo 构建前必须先准备。协议生成器与开发后端统一使用 `dev-small` profile，复用相同配置的依赖产物；生成器的 `export` feature 仍保留独立编译变体。受版本控制的图标工厂使用 `pnpm icons:generate` 更新。

只构建前端的设备可以使用另一台设备或发布流程生成的完整后端包。解压后设置 `ASH_PROTOCOL_PACKAGE` 为包根目录，再运行现有 pnpm 构建或安装命令；也可直接运行 `python -B build/protocol/generate.py --package-root <包根目录>`。生成器会比较相对路径下的源码内容、Cargo 清单和锁文件、生成器及编译标志，并校验包内每个协议文件的摘要和协议身份。匹配时恢复 `.build/protocol/`，无需 Cargo；源码、输入清单或包内容变化时重新生成，不会把旧包的接口视为当前源码。当前开发包存储中的最新选中包会被自动检查，无需设置环境变量。

开发和发布后端包均携带 `ash-resources/protocol/` 中的 TS 类型、运行时解码器、JSON Schema 和 metadata，以及 `ash-resources/protocol-sources.json` 源码指纹。所有文件进入现有包摘要和 build identity。该复用只免去协议生成所需的 Rust；编译或修改后端仍需要 Rust，运行时继续严格校验协议 major 和 schema hash。

## 发布调试符号与离线崩溃解析

第一阶段已接入 Cargo 发布组包、符号归档和离线工具。release 仅增加 `line-tables-only`、`split-debuginfo = off`、`strip = false`；macOS 发布入口覆盖为 `packed`。优化、LTO、codegen units、开发和测试 profile 保持不变。本机已验证 macOS arm64 的真实 release 程序、内联源码行和受控 abort core；Linux/Windows 与正式签名、上传流程须由发布 CI 验证。统一 panic 采集、Electron 和 JavaScript 符号属于后续阶段。

### 第一阶段使用

本地发布前设置编译身份和符号目录；`ASH_BUILD_ID` 必须为这次编译的新身份，不能在编译结束后才注入。Python 使用仓库虚拟环境的 3.11+ 解释器；Linux/Windows 需 LLVM 的 objcopy、strip、dwarfdump、pdbutil、symbolizer，dump 导入另外需要支持 Python 的 LLDB。工具可通过 `ASH_LLVM_BIN` 指定目录，macOS 可直接使用 Xcode 的 dwarfdump 和 atos。

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

具有模块 ID 的 JSON 也可输入：`schemaVersion: 1`，`modules` 每项含 `format`（`macho`/`elf`/`pe`）、`arch`（`aarch64`/`x86_64`）、`id` 和加载 `base`；`frames` 每项含 `module` 索引、`pc` 和可选 `thread`。ELF 还需按 PT_LOAD 得到的 `loadBias`，或帧中的 `fileAddress`。UUID/build-id 使用无连字符的小写十六进制，PDB ID 为小写 GUID 加十进制 Age，例如 `<guid>-1`。`addressKind: returnAddress` 明确标记原始返回 PC，解析器按架构回退到调用指令；OS 已处理的地址不重复回退。

符号清单绑定最终模块与产品包的 SHA-256、包 `buildId`、Git 提交、编译身份、配置和锁文件摘要、工具版本、CI 来源、源码路径映射与 release OUT_DIR 的生成 Rust 源码。正式 Cargo 入口记录真实产物消息中的 features、有效 profile 和构建命令；手动传入的 prebuilt 程序明确标记未捕获编译调用。Desktop update host 也通过 Cargo 产物消息选择输入，避免猜测输出目录。发布先上传并下载核对符号归档，再上传产品包；Actions artifact 只作任务间运输。保存全部正式及撤回版本的 companion assets 和匹配产品包；本地 `.build/` 清理不替代持久归档。当前覆盖 Cargo 构建；Bazel、第三方源码符号和自动崩溃上传尚未接入。

### Codex 的已有流程与 Ash 的差异

对照 Codex 提交 `c3d3b142d10f4316b46e35aad7e5317e7e506cb7`：

- [release profile](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/codex-rs/Cargo.toml) 保留 `line-tables-only` 调试信息和未剥离符号；发布 CI 为 macOS 覆盖 `split-debuginfo = packed`，其他平台使用 `off`。
- [符号归档脚本](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/.github/scripts/archive-release-symbols-and-strip-binaries.sh) 保存 macOS dSYM、Linux `.debug` 和 Windows PDB。Unix 分离符号后剥离程序，Linux 还写入 `.gnu_debuglink`。
- [发布工作流](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/.github/workflows/rust-release.yml) 上传独立符号归档，并将符号产物纳入最终发布资产；Cargo 和 Bazel 产物用不同名称区分。
- [包级验证](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/scripts/codex_package/smoke_tests/test_codex_package.py) 在 Linux 检查函数及源码行、macOS 检查函数解析、Windows 检查 PDB 与程序匹配。这些检查没有证明所有真实崩溃都能自动采集、展开和解析。

Ash 的 release 使用 Cargo 默认调试信息设置，现有组包与签名会计算和更新文件摘要，目前没有对应的第一方符号归档入口。采用 Codex 的按平台分离方式，但统一在包的 staging 副本上剥离，保留 Cargo/Bazel 原始输出；增加逐模块身份、最终包绑定和真实崩溃验证。LTO、codegen units 与优化级别保持现状，不与符号接入一起调整。

### 生成与组包顺序

release 的候选配置如下；这是计划中的配置，不表示当前已生效：

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
| macOS arm64/x64          | `<binary>.dSYM`  | Mach-O UUID 与架构              | Cargo 的 packed dSYM；检查程序和 dSYM UUID 一致，使用 `atos`/LLDB 解析                  |
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
cargo install cargo-deny --version 0.20.2 --locked
just dependency-security
```

检查覆盖依赖声明、产品依赖方向、无用依赖和 [已审查的多版本集合](../.cargo/dependencies.toml)。集合变化时通过 `cargo tree --workspace --target all -i <package>` 审阅；误报需在所属包的 `package.metadata.cargo-shear` 中逐项说明。

`dependency-security` 根据 [Ash 安全策略](../.cargo/deny.toml) 检查整个 workspace、全部 features 和所有目标平台的漏洞、停止维护及撤回版本、第三方许可证和来源。许可证集合与 Git 来源取自 Ash 实际依赖图；Git 依赖必须固定 revision。Ash 自身未发布的专有包不参与第三方 SPDX 许可证检查。重复版本和依赖方向仍由 `dependencies` 负责；安全例外需要逐项审查，不能用整体关闭检查来通过 CI。

2026-10-10 安全修复将 rustls 的最低版本提高到 0.23.45，并将撤回的 chacha20 0.10.1 更新到 0.10.2。Typst 的间接依赖 citationberg 0.7.0 尚未发布 XML 修复，因此根 Cargo manifest 固定其 [上游修复提交](https://github.com/typst/citationberg/commit/06a591e2f237d25e1dfdedac3f3d1494c496c52d)，统一使用 quick-xml 0.41.0，修复 [重复属性检查的计算量问题](https://rustsec.org/advisories/RUSTSEC-2026-0194.html) 和 [命名空间分配无上限问题](https://rustsec.org/advisories/RUSTSEC-2026-0195.html)。该提交只升级 quick-xml，保持 citationberg 的版本与 API；发布兼容修复版本后移除 patch 及其 Git 来源许可。rustls 新版本要求升级 aws-lc-rs、aws-lc-sys 和 rustls-webpki，属于 TLS 修复的必要依赖变化。

依赖整改优先采用兼容发布版或固定 revision 的上游修复，不为消除停止维护告警而复制整个依赖源码树。BM25、Syntect、Ratatui、tokenizers、V8、Typst 及其文献和 SVG/PDF 依赖继续使用发布版；Cargo 与 Bazel 由根 manifest 和 lockfile 选择相同来源。已撤掉 `third_party/rust` 的十二个副本及专用校验、源码准备器和 CI 路径规则。

停止维护报告按具体 advisory ID 审查，原因和移除条件只维护在 [安全策略](../.cargo/deny.toml)；它们不豁免其他漏洞、撤回版本、许可证或来源检查。Typst 字体迁移等待兼容上游发布，避免维护字体引擎分叉；字体集合、复杂文字、数学排版、SVG/PDF、语法高亮及 XML 边界保留消费者验证。

BM25 的同分候选由上游 HashSet 顺序决定。Ash 在自己的搜索入口按原始分数和工具名称排序，再截断候选并转换 reciprocal rank，保证重建索引、单条结果和排除项不会受到哈希遍历顺序影响；无需修改或复制 BM25 源码。

2026-10-11 在 Windows 恢复发布版后，CLI 的 40 项、Code Mode runtime 的 19 项及 tokenizer 的 12 项库测试首轮通过；搜索同分排序修复后，`just test ash-tools -p ash-typst -p ash-v8-poc --features ash-v8-poc/sandbox --profile ci-test --lib` 通过 tools 的 39 项、Typst 的 11 项和 V8 sandbox 的 7 项测试。`just test-tui-unit render::highlight::tests` 的 4 项与 `just test-tui-unit app::marketplace_tests` 的 24 项通过，合计 156 项消费者测试。已移除随序列化补丁及字体回补一起撤掉的专用测试和资源，保留真实高亮、排版、搜索及 XML 边界覆盖。

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

以下仅保留能说明当前构建选择的测量。条件均为 macOS arm64、Rust 1.98.0、`dev-small`、12 个任务、三轮中位数；不能作为其他机器或当前版本的耗时预算。

| 场景                     | 已验证结果                                                                                             | 范围与代价                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 2026-10-05，协议依赖拆分 | 队列、通话、协作、任务交付类型移入契约 crate 后，协议包空输出构建 43.50 → 32.26 秒，编译单元 255 → 174 | 热构建没有明显变化；完整产品仍需要执行、图片和 SQLite，未证明完整产品冷构建提速 |
| 2026-10-01，实际协议编辑 | schema 按需启用、协议包优化级别降为 0 后，`just build-code` 重编译 14.10 → 8.74 秒                     | 开发 CLI 程序约增大 11%；冷构建波动较大，未给出稳定提速比例                     |

2026-10-07，在同一 macOS arm64、Rust 1.98.0、12 个任务和已缓存依赖条件下，协议生成器从 `dev` 改用 `dev-small`：三轮触碰协议库源码时间戳后，生成阶段的中位数从 12.96 降到 7.35 秒；无改动重跑为 0.93 与 0.99 秒。生成器程序从 17.9 增至 23.1 MB，不进入产品包。此结果覆盖协议生成阶段，不代表完整桌面构建或实际协议字段编辑提速，也没有证明冷构建收益。

同日，在相同条件下，Electron 后端监听器根据 Cargo 的协议生成器依赖图跳过普通业务源码保存时的协议生成。三轮触碰 `crates/app-server/src/server/operations.rs` 后，从文件变更到后端构建成功的中位数从 6.02 降到 4.95 秒，约减少 18%。两组均使用已缓存的 `dev-small` 产物，包含 250 毫秒防抖及首次依赖图查询，App Server 与 Remote Server 均实际重编译。测量期间暂停另一个源码监听器，完成后恢复；有并发构建或锁等待的早期数据已排除。此结果覆盖后端监听器的时间戳触碰重编译，不代表真实功能编辑、冷构建或完整桌面启动提速。

工具库补齐没有证明产品构建提速；参数库拆分、过程宏优化与此前构建依赖 profile 对齐候选均未证明收益，未保留。原始测量保存在 `.build/build-health/`；已提交的详细记录可从本文 Git 历史查阅。

## 构建源码与仓库脚本边界

根 `justfile` 和 `package.json` 声明命令并调用上述实现。`scripts/` 可以调用 `build/`；构建实现不反向调用仓库脚本。前端构建工具使用 TypeScript，后端构建和组包使用 Python。测试内容归对应产品，运行产物归 `.build/`。

工具需要从仓库根发现的 Cargo、pnpm、Bazel 和 TypeScript 配置留在根目录；Node workspace 共用根锁文件。共享包布局和发布流程见 [构建器说明](../build/README.md)，桌面开发生命周期见 [前端开发](frontend.md)，文档站由独立的 `ash-docs` 仓库负责。
