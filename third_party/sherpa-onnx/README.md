# Sherpa ONNX 构建资源

[`runtime-lock.json`](runtime-lock.json) 锁定 [Sherpa ONNX v1.13.8](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8) 的静态库归档名称、大小和 SHA-256。哈希来自该版本的 GitHub Release 资源元数据；Cargo 依赖版本同步固定为 `=1.13.8`。

仓库 Cargo 入口、Code 构建与共享产品构建通过 [`build/lib/sherpa.py`](../../build/lib/sherpa.py) 准备资源。归档下载、校验和解压后存入 `third_party/.cache/sherpa-onnx/<版本>/`，通过 `SHERPA_ONNX_LIB_DIR` 提供给上游构建脚本。不同 Cargo profile、feature 和输出目录复用同一份文件；复用前检查库文件哈希，损坏时从已校验的归档恢复。

显式设置 `SHERPA_ONNX_LIB_DIR` 时使用调用方提供的库目录。`SHERPA_ONNX_ARCHIVE_DIR` 可以提供锁定归档的本地副本，仍须匹配大小与哈希。直接调用 Cargo 不经过资源准备入口，遵循上游构建脚本的下载行为。预热共享资源后，仓库入口的离线构建无需再下载 Sherpa。

目标到资源的映射沿用当前上游 `sherpa-onnx-sys`；Linux GNU 与 musl 使用相同归档，这不表示 musl 链接已通过验证。升级时同步审阅上游构建脚本的链接输入、所有目标资源和 Cargo.lock，并运行资源测试及目标平台构建。
