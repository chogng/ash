# Code Mode V8 消费输入

Ash 通过 `runtime-lock.json` 固定独立依赖仓库的 archive/binding 配对，当前 crate 为 `152.2.0`、内嵌 V8 为 `15.2.124.1`。发布产物来自 [ash-rusty-v8](https://github.com/chogng/ash-rusty-v8/releases/tag/rusty-v8-v152.2.0)，迁移保留原配对摘要与发布证据。

## 职责

- `ash-rusty-v8` 拥有源码锁、C++ 补丁、Chromium libc++、Bazel/GN 生产工具链、独立 ABI 探针和八平台发布。生产入口见[独立仓库说明](https://github.com/chogng/ash-rusty-v8#readme)。
- Ash 拥有 Cargo/Bazel 消费版本、产物校验、Code Mode 运行语义和产品集成测试。主仓库不保留 V8 源码生产入口，也不触发依赖仓库构建。
- `crates/v8-runtime` 拥有进程级初始化、运行时防护及沙盒内存分配器；权限、模块加载、执行与取消由各宿主负责。

## 下载和构建

Cargo 包装入口按所选依赖图准备 `third_party/.cache/v8/ash-release/v<version>/` 中的配对；普通 Cargo 通过 `.cargo/config.toml` 使用同一镜像。下载前后校验 SHA-256，损坏缓存重新获取，完成后原子替换。静态库链接进独立宿主，archive 和 binding 不进入最终产品包。

Bazel 直接消费锁定配对，Linux 消费规则仅在派生 archive 中弱化共享异常 ABI 符号；ARM64 派生库合入对应 compiler-rt builtins。下载文件与发布摘要保持原样。Windows V8 宿主使用 MSVC 配对，进程 IPC 隔离外围 GNU ABI；没有 Windows GNU V8 库回退。

```sh
python3 -B -m build.lib.v8 --check
just verify ash-v8-runtime
just verify ash-v8-poc --features sandbox
bazel test //crates/v8-poc:v8-poc-unit-tests --compilation_mode=opt --test_arg=--test-threads=1
```

`--check` 只验证消费版本、沙盒 profile、Cargo lock 与 Bazel 配对摘要，不编译引擎。Bazel 生产脚本、源码图和 C++ 补丁由独立仓库维护。

显式 `RUSTY_V8_ARCHIVE`、binding 或 mirror 覆盖继续遵循上游规则，调用方负责提供同版本、目标和功能配置的配对。显式 `V8_FROM_SOURCE=1` 由上游 Cargo crate 处理，不属于 Ash 日常 CI；Ash 运行时防护仍覆盖这些输入。

## 运行时约束

所有 JavaScript 宿主必须链接启用沙盒的引擎。发布配对包含 Array.sort 混合元素修复，但上游 Cargo 源码和显式覆盖输入可能不含回补，因此共享初始化仍禁用 Maglev、Turbolev 和 TurboFan 数组内建函数内联。只有全部受支持输入均包含修复后，才移除这些防护。

Code Mode 在独立 `ash-code-mode-host` 中运行。`ash-external-js-ext` 为可选宿主，不默认入包；App Server 不直接链接 V8，避免与 WebRTC 的静态依赖冲突。二进制打包继续使用既有独立宿主入口和校验清单。

## 采用新版本

依赖仓库先完成源码生产、全部目标的原生探针和发布汇总，产出候选 `runtime-lock.json`。Ash 随后同步根 `Cargo.toml`、`Cargo.lock`、`runtime-lock.json`、`MODULE.bazel` 中的 crate header、archive 和 binding 声明，并验证受影响消费者。发布产物不可原地覆盖；版本升级与产品采用分别验收。
