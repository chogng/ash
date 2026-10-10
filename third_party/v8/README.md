# Code Mode V8 构建输入

本目录拥有 Code Mode 使用的 `rusty_v8` 输入锁定规则和可选 Bazel 源码构建图，不拥有 JavaScript 执行语义、工具审批或运行时生命周期。运行时实现由 `ash-code-mode-runtime` crate 负责。

产品通过独立的 `ash-code-mode-host` 和 `ash-external-js-ext` 执行 V8。App Server 只依赖 Host 客户端与共享会话接口，不链接 V8，避免与 WebRTC 所带的 Abseil 静态符号冲突。

## 构建和打包行为

`runtime-lock.json` 为每个 Ash 发布目标锁定一份启用 V8 沙箱的静态库压缩包和对应 Rust binding，并记录 SHA-256。当前文件来自 OpenAI Codex 的 `rusty-v8-v152.2.0` release，因为 `rusty_v8` 上游没有发布这一版本的沙箱组合产物。

| 场景             | 下载位置                                                              | 最终产品里有什么                                                      |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Desktop 本地调试 | `third_party/.cache/v8/v<version>/`                                   | V8 静态链接进本地可执行文件；缓存文件不进 Git                         |
| 直接运行 Cargo   | `.cargo/config.toml` 将同一目录配置为 `rusty_v8` 本地镜像             | V8 静态链接进构建结果；已有缓存不会访问上游                           |
| Python 发布构建  | `third_party/.cache/v8/v<version>/`，可用参数覆盖缓存根目录           | V8 静态链接进发布可执行文件；不会额外复制 archive 或 binding 到安装包 |
| Bazel            | 预编译输入使用 Bazel repository cache；Windows 宿主固定使用 MSVC 配对 | V8 静态链接进 Bazel 产物                                              |

下载器先校验已有缓存；缓存缺失或摘要不匹配时重新下载，并在原子替换前再次校验。默认包装入口显式传递已校验的 archive、binding 路径和 `RUSTY_V8_ARCHIVE_SHA256`，让上游再次验证静态库，并避免 Cargo 恢复缓存时误用旧 binding。`V8_FROM_SOURCE=1` 明确选择源码构建并跳过预编译产物解析。

Rust binding crate 使用 crates.io 发布的 v8 152.2.0，不维护本地源码副本；引擎版本、静态库 ABI 和锁定配对保持一致。`V8_FROM_SOURCE=1` 使用发布包自带的源码与上游构建入口。停止维护宏依赖的逐项审查见 [依赖安全策略](../../.cargo/deny.toml)。

显式设置 `RUSTY_V8_ARCHIVE`、`RUSTY_V8_SRC_BINDING_PATH`、`RUSTY_V8_SRC_BINDING_URL`、`RUSTY_V8_MIRROR` 或 `RUSTY_V8_MIRROR_TAG` 时，包装入口直接使用 [rusty_v8 上游的输入选择规则](https://github.com/denoland/rusty_v8/blob/v152.2.0/README.md#the-rusty_v8_archive-environment-variable)，不下载默认配对或改写这些设置。`RUSTY_V8_ARCHIVE` 可以单独指向包含 archive 和 binding 的目录；指定 binding 路径优先于 binding URL，镜像模板、tag 和 fallback 由上游处理。调用方负责提供匹配目标、版本和功能配置的输入，以及需要的 `RUSTY_V8_ARCHIVE_SHA256`。

Windows 的两个 V8 宿主始终作为独立 MSVC 可执行文件构建，复用 Codex 的
checksum-pinned archive/binding。外围 Bazel 产品仍可使用 gnullvm；进程之间
走现有 IPC，不把 MSVC Rust/C++ 库链接到 GNU 可执行文件。没有 Windows GNU
源码回退，也不使用 Linux binding 代替 Windows binding。

`ash_v8_host` 直接使用上游 `rust_binary(platform=...)`，由 Bazel 的
`platform.flags` 声明 MSVC 平台对应的 exec 配置、C++ 工具链和 Rust 链接器。
设置覆盖整个宿主依赖闭包，避免 `rules_rust` 在过程宏分析时选择 GNU V8 输入。
无需内部配置转换、软链接包装或手工转发 runfiles；产物直接使用规范 `.exe` 名称。
Rust 编译器通过上游 `rules_rust.repository_set` 准备；C++ 使用上游
`rules_cc` 发现的 Visual Studio Build Tools 和 Windows SDK，Rust 链接使用
工具链自带的 LLD，以支持 Bazel execroot 的长路径。配置在下一条 Bazel 命令
生效，外围默认工具链保持不变。MSVC 平台需要 Windows 构建宿主，并安装对应
CPU 的 C++ Build Tools 与 SDK；其 C++ 工具链设置在该闭包内优先于调用方的
extra toolchains。

```powershell
bazel build //:v8_host_binaries
bazel cquery //:v8_host_binaries --output=files
bazel info execution_root
```

若 Bazel 无法自动识别 Visual Studio 安装，使用上游的
`--repo_env=BAZEL_VC=<Visual Studio 安装目录>/VC`。ARM64 目标需要 ARM64
工具组件。上述文件集合仅包含两个宿主，查询路径相对于 Bazel 的 execution root；
incoming platform 转换的输出可能位于带配置后缀的目录，不能拼接旧 wrapper 路径。
将查询到的文件分别传给 `build/app_server.py`
的 `--code-mode-host-bin`、`--external-js-ext-bin`。打包器保留这两个独立
可执行文件及其规范名称，不复制 V8 archive/binding。Windows Cargo 开发打包
也显式选择 MSVC 目标，避免继承调用者的 `CARGO_BUILD_TARGET=gnullvm`。

Inspector 文件生成继续复用 V8 的 `py_binary` 和 `rules_python` 的解释器、
依赖与 runfiles，不手工拼接 Python 搜索路径。

Bazel 的输出目录补丁复用 Codex 的 archive 输入判断：设置
`RUSTY_V8_ARCHIVE` 时，仅把静态库目录放进声明的 `OUT_DIR`，保留上游
`build_dir()` 的源码构建布局。无需额外环境开关。当前 `rusty_v8` 上游仍把
静态库放进 Cargo 的父目录，因此这部分适配仍需保留。

## 本地 Cargo 入口

首次准备缺失的 V8 文件或需要校验缓存时使用：

```sh
python3 -B scripts/cargo.py test -p ash-code-mode-runtime
```

包装脚本会读取 Cargo 参数中的 `--target`；没有指定时使用当前主机目标。它把锁定文件写入 `rusty_v8` 自己识别的本地镜像布局。缓存存在后，普通 `cargo test`、`cargo check` 和 `cargo build` 会通过 `.cargo/config.toml` 直接读取同一份文件，不需要包装脚本或手工环境变量。`just app`、`just app-check`、`just app-test`、共享开发包的 `prepare.py` 和发布构建负责在缓存缺失时下载并校验文件。

Cargo 包装、开发构建和发布打包入口各查询一次所选包的依赖图，按同一结果准备协议、V8 和语音输入。打包时只查询需要编译的缺失程序；全部 V8 消费者均已提供可执行文件时，其他缺失程序不会触发 V8 下载。源码选择与上游一致：`V8_FROM_SOURCE` 仅接受 `1`、`true`、`yes`；大写值仍走预编译路径。

只做类型检查时，可显式设置 `RUSTY_V8_SKIP_DOWNLOAD=1`；包装入口只下载并校验 binding，跳过静态库。PowerShell 示例：

```powershell
$env:RUSTY_V8_SKIP_DOWNLOAD = '1'
python -B scripts/cargo.py check -p ash-v8-runtime
Remove-Item Env:RUSTY_V8_SKIP_DOWNLOAD
```

恢复普通构建前必须取消该变量。此模式可能产生上游 build-script warning，不能用来替代需要链接静态库的构建、测试或 `just rust-warnings`。

## 更新约束

### 本地源码构建与修改反馈

日常构建默认使用锁定的 archive/binding。需要修改 V8 C++ 代码、生成工具
或源码构建规则时，显式选择 `--config=v8-source`。Bazel 图包含
V8、ICU、Chromium libc++/libc++abi、Rust C++ binding、torque、mksnapshot
和生成源码；每个编译动作由 Bazel 跟踪并复用本地 action cache。
`rusty_v8_source_pair` 是源码配对入口，`ash-v8-poc` 通过现有 crate override
消费同一图的 archive/binding，消费代码修改不需要重新打包或上传 V8。
发布使用 `rusty_v8_source_release_pair`，包含原始 archive 和固定 crate binding，
不包含 Linux Bazel 消费端的符号弱化或 ARM builtins 合并。
源码和预编译适配规则统一由主仓库 `BUILD.bazel` 拥有；注入 crate 规则的
`ash_v8_targets` 仓库只通过 `targets.BUILD.bazel` 转发两个配对输入。

在 Linux x64 本地先分析依赖和动作，再选择实际需要的构建：

```sh
bazel cquery //third_party/v8:rusty_v8_source_pair --config=v8-source --platforms=@llvm//platforms:linux_amd64_gnu.2.28
bazel aquery 'mnemonic("CppCompile", filter("v8_152_2_0_binding", deps(//third_party/v8:rusty_v8_source_archive)))' --config=v8-source --platforms=@llvm//platforms:linux_amd64_gnu.2.28 --include_artifacts=false
bazel build //third_party/v8:rusty_v8_source_pair --config=v8-source --platforms=@llvm//platforms:linux_amd64_gnu.2.28
bazel test //crates/v8-poc:v8-poc-unit-tests --config=v8-source --platforms=@llvm//platforms:linux_amd64_gnu.2.28 --test_arg=--test-threads=1
```

图查询只分析，不编译完整 V8。首轮源码构建仍需要下载工具链和编译 C++；
后续复用 action cache，不清理已有缓存。Linux（含 WSL）和 macOS 的 disk cache
位于 `~/.cache/ash/bazel-disk-cache`；Windows 位于 `.build/bazel-disk-cache`。
WSL 的缓存放在 Linux 文件系统，避免每个缓存文件都经过 Windows 挂载路径。
源工作区保持原位置。旧 disk cache 保留；需要覆盖位置时可显式传入 `--disk_cache`。
迁移时复制旧目录的 `ac` 和 `cas` 条目，不覆盖新目录已有条目。
`bazel clean` 不自动删除 disk cache；缓存位置变更在下一条 Bazel 命令生效。
需要展开依赖时，对具体目标运行 `cquery 'deps(<label>)'`；动作检查优先
过滤正在修改的目标，避免导出完整 V8 图的所有编译参数和头文件。
跨 CPU 的生成工具使用 exec 配置，库使用目标配置。源码图提供 Linux GNU、
musl 和 macOS 的目标选择；交叉构建时选 `--config=v8-source-arm64` 或
`--config=v8-source-x64` 并指定对应 `--platforms`，让宿主机 mksnapshot
生成目标 CPU 的代码。Windows MSVC 仍使用下述 Cargo/GN 发布入口，
不能把 GNU C++ 工具链与 MSVC archive 混用。本机的验证范围见实际执行结果，
这些规则的存在不表示全部平台已经验证通过。

源码规则和补丁采用 Codex
`rusty-v8-v152.2.0` tag 的固定源码输入，对应 V8 `15.2.124.1`、
crate `152.2.0` 和固定的 Chromium 运行库 revision。`MODULE.bazel` 锁定下载
与 patch；`BUILD.bazel` 中的配对选择保留源码与预编译两条入口。
Python 模板依赖和生成器路径统一使用 Ash 的 Python 3.12 工具链；
构建选择精确版本，不根据宿主机碰巧安装的 `>=3.10` 解释器改变 wheel 配对。
源码 Linux archive 使用与预编译消费相同的异常 ABI 弱化和 ARM builtins
适配；原始源码 archive 仍可通过 `rusty_v8_source_archive` 单独构建。
`source.bzl` 的配置转换只在 archive 依赖内启用 Chromium libc++、指针压缩
和 sandbox；外围 Rust 构建工具继续使用 Ash 默认 C++ 头文件与运行库。
这避免把 V8 的 `-nostdinc++` 策略传播到 Rust process wrapper 等辅助程序。

### 独立产物发布

与上述 Codex tag 的源码生产方式对比如下。入口对齐不等于全部平台已经验证：

| 环节                 | Codex                                        | Ash 当前状态                                                                          |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Linux/macOS 产物生产 | Bazel 源码配对目标                           | 发布复用本地 Bazel 源码图，保存原始 archive                                           |
| Linux/macOS binding  | 使用固定 crate 的 release binding            | 相同；不在发布时运行 bindgen                                                          |
| 本地源码反馈         | Bazel 跟踪各个 C++ 动作                      | 相同依赖闭包；Linux GNU/musl x64 源码、Cargo 与 Bazel 消费探针已通过                  |
| Windows MSVC         | 上游 Cargo/GN                                | 源码生产保留同一路线；Bazel 独立 MSVC 宿主消费预编译 archive，GNU 客户端通过 IPC 调用 |
| C++ 配置范围         | 发布命令统一配置 Chromium libc++             | Ash 只在 V8 archive 依赖闭包启用，避免影响外围 Rust 构建工具                          |
| Python               | workflow 使用 3.12，V8 模板依赖补丁使用 3.11 | workflow、Bazel 解释器与模板依赖统一为精确 3.12                                       |
| 沙箱探针             | 调用所链接库的 `v8__V8__IsSandboxEnabled()`  | 已使用相同检查，验证静态库配置与 Rust feature 一致                                    |

`.github/workflows/rusty-v8-release.yml` 覆盖锁定文件中的全部 8 个沙箱目标。
Linux/macOS 使用 `build/v8/release.py bazel-stage` 构建原始配对目标，先构建，
再以同一平台与 CPU 配置查询输出，避免把上一次配置留下的文件误当新产物。
宿主与目标 CPU 相同时复用 `v8-source` 本地配置；交叉构建显式选择目标 CPU，
让宿主 mksnapshot 生成正确的代码，构建记录保留宿主 CPU 与所用配置。
V8、ICU、Chromium 运行库、LLVM SDK 和 crate binding 由 `MODULE.bazel`
及源码补丁锁定，不再准备 GN 编译器、Clang 19 bindgen 或系统 musl/GNU SDK。
Windows 从 `source-lock.json` 固定的 `denoland/rusty_v8` commit 递归检出，
校验子模块、Rust、源码补丁和 Chromium 编译器 pin 后使用 Cargo/GN 构建，
保持 archive 的 MSVC ABI。当前不自动运行跨平台源码矩阵。

手动运行 workflow 只构建和验证；推送 `rusty-v8-v<crate-version>` tag
才会在当前仓库创建独立的 prerelease，不覆盖已有 release。
源码发布 workflow 不再由 PR 或其他 workflow 自动触发；本地反馈不需要
等待八目标云端矩阵。
发布前验证 Cargo manifest、Cargo lock 和产物 lock 的版本一致，
每个目标的 checksum 必须精确覆盖 archive 和 binding 两项。
macOS、GNU Linux 和 Windows x64 使用 `ash-v8-poc` 链接并执行产物；
执行探针时串行运行测试，避免多个首批 isolate 并发初始化进程级沙箱地址池。
探针通过上游 C binding 检查所链接 V8 的真实 sandbox 配置，不能只检查
Rust feature；archive 与 feature 不匹配必须使测试失败。
Windows ARM64 和 musl ARM64 验证交叉链接；musl x64 链接并执行探针。
GNU ARM64 使用 Bazel exec 配置中的 x64 生成工具交叉编译，并在单独的 ARM64 runner
对同一份新产物执行 Cargo 与 Bazel 测试；发布汇总依赖该运行验证通过。
Windows 使用 `152.2.0` 的上游 Cargo build script 下载固定的 Chromium Clang
与同 revision 的 libclang，并自动为 bindgen 设置编译器和内置头文件目录。
不再通过 Chocolatey 安装另一份 Clang 或手工传递 bindgen 参数。产物打包时
验证 GN 实际选择的编译器路径、Clang/libclang revision 与 libclang.dll；
源码生产应用与 Codex 相同的 Array.sort 回补，Bazel 和 Windows GN 都必须包含它。
GNU 源码生产和 Bazel 消费统一选择 LLVM 的 glibc 2.28 平台；musl 使用同时
声明 LLVM 与 Rust libc 约束的目标平台。宿主生成工具与目标库分别解析工具链。
musl 的 Cargo 链接器使用固定版本和 SHA-256 的 Zig。x64 使用 `zig cc`，
关闭 Rust 自带 CRT，由 Zig 统一提供启动对象，避免重复定义 `_start`。
ARM64 使用同一 Zig 包内的 GNU `ld.lld` 和 Rust 自带 musl CRT，显式保留
Cortex-A53 843419 修复参数；`zig cc` 会拒绝 Rust 1.98 默认传入的该参数。
ARM64 Cargo 所需的 `__clear_cache` 单独从该固定 Zig 包的 compiler-rt 源码
构建，不重复提供其他 builtins 或 CRT。Cargo 的 musl 链接器与 Bazel 的源码 SDK
分别拥有自己的工具链。Windows 的 GN 参数关闭 standalone PartitionAlloc，
保留 sandbox 和指针压缩；发布汇总会验证参数。Bazel 的功能开关由 archive
配置转换拥有，汇总核对源码图摘要、平台、CPU 配置和 Bazel 版本，拒绝混入
GN 生成的 Linux/macOS 产物。
全部 macOS/Linux 目标还通过仓库现有 Bazel 消费图验证同一份新产物，
ARM64 musl 只链接，其余目标执行测试。Windows MSVC 发布产物仍使用 Cargo 验证；
Windows 独立宿主的 Bazel MSVC 消费另行验证，不生产 Windows GNU V8 archive。
Linux 的 Bazel 消费规则会在派生 archive 中弱化两份 libc++ 共用的异常 ABI
入口，避免重复符号；下载文件和发布摘要保持原样。
ARM64 Linux 的 Bazel 派生库还合入目标 compiler-rt builtins，补齐 Rust
builtins 未提供的 `__clear_cache`；Cargo 使用 GNU GCC 或固定的 Zig runtime
提供同一入口。
musl 验证平台同时声明 LLVM 与 Rust 的 libc 约束，防止选择 GNU 输入。
x64 静态探针使用明确的 Linux 测试执行工具链；musl ARM64 仅构建测试程序，
不要求 x64 runner 具备 ARM64 测试执行平台。
musl 链接工具缓存复用已完成的 Zig 解压目录；每次仍校验下载包和整个
工具链文件树的摘要及版本。内容缺失、被修改或 pin 变化时重新解压，
失败时保留上一份工具链。进程锁串行化共享缓存的准备，解压完成后才
发布目录和完成记录。缓存、链接器脚本及 ARM helper 按 pin 摘要分目录；
pin 的变更在下一次准备命令生效，正在运行的消费者继续使用原目录。

各目标先保存源码 archive/binding 和构建记录，消费测试失败时仍可检查该配对。
候选锁生成和发布依赖全部目标的消费测试以及 GNU ARM64 的实际执行通过。
每次成功的验证会生成包含新摘要和当前仓库来源的候选 `runtime-lock.json`，
与 archive、binding、每目标 checksum 和 `build.json` 一同保存为 workflow artifact；
tag 运行还会发布这些文件。构建记录使用 schema 2：Bazel 记录固定输入图摘要、
工具版本、平台与 CPU 配置，Windows GN 记录上游源码、编译器及 GN 参数。
Windows 在构建前通过 `release.py windows-tools` 准备上游跳过的 `tools/win`：
只下载 GN 使用的四个 DebugVisualizers 文件，校验固定 revision 的响应和文件摘要。
Gitiles 压缩包含请求时间，不能锁定整个包的摘要，因此使用内容稳定的 TEXT 响应。
工具链校验允许该子模块保持未初始化，但检查其 Git revision 与文件摘要；
这些输入由 `source-lock.json` 锁定，并写入 Windows 构建记录。
压缩默认与 Codex 一致，使用 gzip 等级 6 并省略文件名和时间戳。
本地可显式添加 `--pigz /path/to/pigz --compression-jobs 12` 使用 pigz 2.8
并行压缩；不根据 PATH 自动切换压缩器。构建记录保存压缩工具、等级及
pigz 版本和并发数；压缩失败不会覆盖上一份完整配对。
workflow 不改写消费端锁定文件。首次转用 Ash 自有 release 时，
先确认发布产物及 checksum，再将候选 lock 的来源和摘要同步到本目录与
`MODULE.bazel`，运行下面的验证入口。

发布工具的本地验证入口：

源码图输入使用仓库规定的 LF 换行。工作区的 CRLF 配置头会使提交后的
源码字节变化，导致所有依赖它的 C++ 动作重新编译；源码生产入口会在
启动 Bazel 前拒绝这类输入，请先恢复 LF 再运行。

```sh
python3 -B build/v8/release.py metadata
python3 -B build/v8/release.py bazel-stage --target x86_64-unknown-linux-gnu --output .build/v8-release/x86_64-unknown-linux-gnu --jobs 12
python3 -B build/v8/smoke.py pair --target x86_64-unknown-linux-gnu --artifacts .build/v8-release/x86_64-unknown-linux-gnu
RUSTY_V8_ARCHIVE="$PWD/.build/v8-release/x86_64-unknown-linux-gnu/librusty_v8_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.a.gz" \
RUSTY_V8_SRC_BINDING_PATH="$PWD/.build/v8-release/x86_64-unknown-linux-gnu/src_binding_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.rs" \
just test ash-v8-poc --locked --target x86_64-unknown-linux-gnu --features sandbox -- --test-threads=1
python3 -B build/v8/smoke.py bazel --target x86_64-unknown-linux-gnu --artifacts .build/v8-release/x86_64-unknown-linux-gnu --output .build/v8-release/bazel-inputs
python3 -B -m unittest build.v8.test_release build.v8.test_smoke build.lib.test_v8
```

### 消费端版本升级

升级 `v8` crate 时必须同步更新根 `Cargo.toml`、`Cargo.lock`、`runtime-lock.json`、`source-lock.json`、`MODULE.bazel` 中的 Bazel 下载声明以及目标选择规则。源码 pin 必须来自对应版本的上游 commit，并同步其 Rust 与 Chromium 编译器版本。Bazel 源码入口还需同步 V8 tag、Chromium libc++/libc++abi/LLVM-libc revision、crate binding 名称及补丁上下文。每个 release checksum 文件必须精确覆盖 archive 和 binding 两项；不接受未校验下载，也不把预编译二进制提交到仓库。

验证入口：

```sh
python3 -B -m unittest build.lib.test_v8
just test-python build
python3 -B scripts/cargo.py test -p ash-v8-poc --features sandbox -- --test-threads=1
bazel test //crates/v8-poc:v8-poc-unit-tests --test_arg=--test-threads=1
```
