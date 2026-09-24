# LiveKit Server

- Rust 接入使用 Cargo 管理的 `livekit` 和 `livekit-api` SDK。
- 此目录仅记录独立服务器的固定版本、来源、SHA-256 与版权声明，不保存 Go 源码或程序。
- `build/ash_rs/livekit.py` 为本地开发及发布准备服务器；Linux、Windows 下载上游程序，Linux GNU 与 musl 使用同一静态程序。
- macOS 在 macOS 构建机上下载并校验源码，在缓存中编译；需要 Go 1.26 工具链与系统 C/C++ 工具链。
- 下载及构建产物保存在忽略的 `third_party/.cache/livekit/`；Go 工具链不随产品分发。
- 更新时同步锁文件、上游 LICENSE、NOTICE、pkg/sfu/NOTICE 以及通话部署版本检查，并验证媒体测试和各平台服务器准备流程。
