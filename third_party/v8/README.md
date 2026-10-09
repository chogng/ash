# Code Mode V8 构建输入

本目录拥有 Code Mode 使用的 `rusty_v8` 预编译输入锁定规则，不拥有 JavaScript 执行语义、工具审批或运行时生命周期。运行时实现由 `ash-code-mode-runtime` crate 负责。

产品通过独立的 `ash-code-mode-host` 执行 V8。App Server 只依赖 Host 客户端与共享会话接口，不链接 V8，避免与 WebRTC 所带的 Abseil 静态符号冲突。

## 构建和打包行为

`runtime-lock.json` 为每个 Ash 发布目标锁定一份启用 V8 沙箱的静态库压缩包和对应 Rust binding，并记录 SHA-256。当前文件来自 OpenAI Codex 的 `rusty-v8-v150.4.0` release，因为 `rusty_v8` 上游没有发布这一版本的沙箱组合产物。

| 场景 | 下载位置 | 最终产品里有什么 |
| --- | --- | --- |
| Desktop 本地调试 | `third_party/.cache/v8/v<version>/` | V8 静态链接进本地可执行文件；缓存文件不进 Git |
| 直接运行 Cargo | `.cargo/config.toml` 将同一目录配置为 `rusty_v8` 本地镜像 | V8 静态链接进构建结果；已有缓存不会访问上游 |
| Python 发布构建 | `third_party/.cache/v8/v<version>/`，可用参数覆盖缓存根目录 | V8 静态链接进发布可执行文件；不会额外复制 archive 或 binding 到安装包 |
| Bazel | Bazel repository cache | V8 静态链接进 Bazel 产物 |

下载器先校验已有缓存；缓存缺失或摘要不匹配时重新下载，并在原子替换前再次校验。`RUSTY_V8_ARCHIVE` 和 `RUSTY_V8_SRC_BINDING_PATH` 只允许同时覆盖；`V8_FROM_SOURCE=1` 明确选择源码构建并跳过预编译产物解析。

## 本地 Cargo 入口

首次准备缺失的 V8 文件或需要校验缓存时使用：

```sh
python3 -B scripts/cargo.py test -p ash-code-mode-runtime
```

包装脚本会读取 Cargo 参数中的 `--target`；没有指定时使用当前主机目标。它把锁定文件写入 `rusty_v8` 自己识别的本地镜像布局。缓存存在后，普通 `cargo test`、`cargo check` 和 `cargo build` 会通过 `.cargo/config.toml` 直接读取同一份文件，不需要包装脚本或手工环境变量。`just app`、`just app-check`、`just app-test`、共享开发包的 `prepare.py` 和发布构建负责在缓存缺失时下载并校验文件。

## 更新约束

### 独立产物发布

`.github/workflows/rusty-v8-release.yml` 从与 Cargo 锁定版本对应的
`source-lock.json` 固定的 `denoland/rusty_v8` commit 递归检出源码，校验子模块、
Rust、Chromium C++ 编译器和 Clang 19 绑定工具链版本后构建
`ptrcomp_sandbox_release`，覆盖锁定文件中的全部 8 个目标。
Ash 的 Bazel 目前只消费预编译输入，因此此流程直接使用上游 Cargo/GN
构建入口，不依赖 Codex 的 Bazel 源码构建图。

手动运行 workflow 只构建和验证；推送 `rusty-v8-v<crate-version>` tag
才会在当前仓库创建独立的 prerelease，不覆盖已有 release。
发布前验证 Cargo manifest、Cargo lock 和产物 lock 的版本一致，
每个目标的 checksum 必须精确覆盖 archive 和 binding 两项。
macOS、GNU Linux 和 Windows x64 使用 `ash-v8-poc` 链接并执行产物；
执行探针时串行运行测试，避免多个首批 isolate 并发初始化进程级沙箱地址池。
Windows ARM64 和 musl ARM64 验证交叉链接；musl x64 链接并执行探针。
GNU ARM64 使用上游 x64 构建工具交叉编译，并在单独的 ARM64 runner
对同一份新产物执行 Cargo 与 Bazel 测试；发布汇总依赖该运行验证通过。
Clang 23 生成的匿名枚举常量名称不符合此版本 Rust crate 的约定，因此
绑定使用单独固定版本的 Clang 19，并显式设置其内置头文件目录。
绑定工具链由 Ubuntu/Homebrew/Chocolatey 安装，准备步骤校验精确版本。
GNU 使用固定 SHA-256 的 Chromium Debian sysroot（glibc 2.27），避免
宿主机头文件引入 Bazel glibc 2.28 不具备的 `__isoc23_*` 等符号。
ARM64 交叉构建为目标与 x64 构建工具分别选择匹配 CPU 的固定 GNU sysroot。
GNU binding 生成也显式使用同一份目标 SDK，避免交叉解析时误用宿主头文件。
musl 的 Cargo 链接器使用固定版本和 SHA-256 的 Zig。x64 使用 `zig cc`，
关闭 Rust 自带 CRT，由 Zig 统一提供启动对象，避免重复定义 `_start`。
ARM64 使用同一 Zig 包内的 GNU `ld.lld` 和 Rust 自带 musl CRT，显式保留
Cortex-A53 843419 修复参数；`zig cc` 会拒绝 Rust 1.98 默认传入的该参数。
ARM64 Cargo 所需的 `__clear_cache` 单独从该固定 Zig 包的 compiler-rt 源码
构建，不重复提供其他 builtins 或 CRT。构建 sysroot 来自
Ubuntu/Alpine 软件包，系统 SDK 与 runner 镜像仍由 CI 环境提供。
musl 关闭依赖 glibc 头文件的全局 allocator shim；V8 sandbox 保持启用。
全部目标显式关闭用于模拟浏览器分配行为的 standalone PartitionAlloc，
使用嵌入式 V8 的平台分配器；其 ARM IFUNC 代码依赖 musl/旧 GNU SDK
没有的 `sys/ifunc.h`。这与 V8 sandbox、指针压缩开关互相独立，发布检查
同时验证这些 GN 参数，防止混入不同配置的产物。
全部 macOS/Linux 目标还通过仓库现有 Bazel 消费图验证同一份新产物，
ARM64 musl 只链接，其余目标执行测试。Windows 的 Bazel C++ 工具链目前使用
GNU ABI，不能验证 MSVC archive，因此这两个目标使用 Cargo 验证。
Linux 的 Bazel 消费规则会在派生 archive 中弱化两份 libc++ 共用的异常 ABI
入口，避免重复符号；下载文件和发布摘要保持原样。
ARM64 Linux 的 Bazel 派生库还合入目标 compiler-rt builtins，补齐 Rust
builtins 未提供的 `__clear_cache`；Cargo 使用 GNU GCC 或固定的 Zig runtime
提供同一入口。
musl 验证平台同时声明 LLVM 与 Rust 的 libc 约束，防止选择 GNU 输入。
x64 静态探针使用明确的 Linux 测试执行工具链；musl ARM64 仅构建测试程序，
不要求 x64 runner 具备 ARM64 测试执行平台。

各目标先保存源码 archive/binding 和构建记录，消费测试失败时仍可检查该配对。
候选锁生成和发布依赖全部目标的消费测试以及 GNU ARM64 的实际执行通过。
每次成功的验证会生成包含新摘要和当前仓库来源的候选 `runtime-lock.json`，
与 archive、binding、每目标 checksum 和记录源码、编译器及 GN 参数的
`build.json` 一同保存为 workflow artifact；tag 运行还会发布这些文件。
workflow 不改写消费端锁定文件。首次转用 Ash 自有 release 时，
先确认发布产物及 checksum，再将候选 lock 的来源和摘要同步到本目录与
`MODULE.bazel`，运行下面的验证入口。

发布工具的本地验证入口：

```sh
python3 -B build/v8/release.py metadata
python3 -B -m unittest build.v8.test_release build.v8.test_smoke build.lib.test_v8
```

### 消费端版本升级

升级 `v8` crate 时必须同步更新根 `Cargo.toml`、`Cargo.lock`、`runtime-lock.json`、`source-lock.json`、`MODULE.bazel` 中的 Bazel 下载声明以及目标选择规则。源码 pin 必须来自对应版本的上游 commit，并同步其 Rust 与 Chromium 编译器版本。每个 release checksum 文件必须精确覆盖 archive 和 binding 两项；不接受未校验下载，也不把预编译二进制提交到仓库。

验证入口：

```sh
python3 -B -m unittest build.lib.test_v8
just test-python build
python3 -B scripts/cargo.py test -p ash-v8-poc --features sandbox -- --test-threads=1
bazel test //crates/v8-poc:v8-poc-unit-tests --test_arg=--test-threads=1
```
