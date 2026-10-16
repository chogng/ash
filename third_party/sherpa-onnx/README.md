# Sherpa ONNX 构建资源

[`runtime-lock.json`](runtime-lock.json) 来自公开的
[ash-sherpa-onnx v1.13.8-ash.1](https://github.com/chogng/ash-sherpa-onnx/releases/tag/v1.13.8-ash.1)。
资源仓库按 SHA-256 和大小校验并发布上游 v1.13.8 的原始静态库归档；模型权重继续由 Ash 的模型服务独立管理。

仓库 Cargo 入口、Code 构建与共享产品构建通过
[`build/lib/sherpa.py`](../../build/lib/sherpa.py) 从资源仓库准备静态库。
归档和提取结果缓存于 `third_party/.cache/sherpa-onnx/<运行库版本>/`，不同
Cargo profile、feature 和输出目录复用缓存；复用前检查库文件哈希，损坏时从已校验归档恢复。
并发准备同一目标时使用文件锁。

Bazel 从同一锁文件准备静态库，通过 `cc_import` 传递链接依赖，关闭 sys crate 的构建脚本。

Rust 安全 API 直接使用 crates.io 的 `sherpa-onnx =1.13.8`。仅 `sherpa-onnx-sys`
固定到资源仓库中的薄绑定包：FFI 声明来自校验过的上游发布 crate，构建脚本只负责链接。
它不含 C++ 源码树、下载器或 HTTP/解压构建依赖，缺少静态库时直接失败。
上游 sys crate 支持无下载依赖的外部库模式后，可以删除根 Cargo patch 和对应来源审批。

直接调用 Cargo 前需设置 `SHERPA_ONNX_LIB_DIR`；仓库构建入口会自动准备。
显式设置此变量时使用调用方提供的库目录。`SHERPA_ONNX_ARCHIVE_DIR` 可提供锁定归档的本地副本，
仍校验大小与哈希；预热资源后可离线构建。

支持 Windows MSVC、macOS、Linux GNU 的 x64/ARM64 共六个目标。Windows 使用静态 CRT。
上游 Linux 归档依赖 glibc，不能用于 musl；在资源仓库提供真正的 musl 构建前，自动准备会明确报错。

资源仓库每周检查上游稳定版本，更新时同步审阅 FFI ABI、链接输入、平台要求和依赖许可证，
通过全部目标的消费者构建后发布新版本。Ash 再同步升级 Git 修订与本锁文件，并编译实际语音消费者。
