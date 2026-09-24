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

包装脚本会读取 Cargo 参数中的 `--target`；没有指定时使用当前主机目标。它把锁定文件写入 `rusty_v8` 自己识别的本地镜像布局。缓存存在后，普通 `cargo test`、`cargo check` 和 `cargo build` 会通过 `.cargo/config.toml` 直接读取同一份文件，不需要包装脚本或手工环境变量。`just app`、`just app-check`、`just app-test`、共享开发包的 `prepareDevPackage.ts` 和发布构建负责在缓存缺失时下载并校验文件。

## 更新约束

升级 `v8` crate 时必须同步更新根 `Cargo.toml`、`Cargo.lock`、`runtime-lock.json`、`MODULE.bazel` 中的 Bazel 下载声明以及目标选择规则。每个 release checksum 文件必须精确覆盖 archive 和 binding 两项；不接受未校验下载，也不把预编译二进制提交到仓库。

验证入口：

```sh
python3 -B -m unittest build.lib.test_v8
node --test build/runtime/prepareDevPackage.test.ts
python3 -B scripts/cargo.py test -p ash-v8-poc --features sandbox
bazel test //ash-rs/v8-poc:v8-poc-unit-tests
```
