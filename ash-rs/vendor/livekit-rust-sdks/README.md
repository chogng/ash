# LiveKit Rust SDK 补丁

- 保存 Ash 当前使用的三个 Rust 包源码：`livekit`、`livekit-signaling`、`webrtc-sys`；不包含 Go 服务端。
- 上游版本、commit、crate 归档校验值记录在 `upstream.json`；其余 SDK 依赖继续由 Cargo 管理；`patches.diff` 记录与发布源码的完整 Rust 改动。
- 为每个房间传入 HTTP／WebSocket 客户端，覆盖首次连接、重连、连接诊断和区域发现；不同网络配置不共享区域缓存。
- 导出 `SessionStats`，让 Ash 的媒体接入层能够提供连接统计。
- 修复 WebRTC 异常文本按 UTF-8 字节边界切片引发的崩溃；保留官方已有的非法枚举值保护。
- 清理路径依赖暴露的未使用私有代码和重复分支；保留上游旧协议字段与公开兼容接口。
- 自动增益由 `voice-host` 的 Sonora 实现，不重复引入 Zed 的音频处理补丁或旧构建补丁。
- 上游现有目录和 `mod.rs` 保持其组织方式，便于对照；Ash 新增测试使用独立文件。
- 根 Cargo manifest 通过 `[patch.crates-io]` 使用这些源码；此目录的独立 workspace 用于运行上游及补丁回归测试。

## 验证

```sh
python3 ash-rs/vendor/livekit-rust-sdks/verify.py
just test livekit-signaling --manifest-path ash-rs/vendor/livekit-rust-sdks/Cargo.toml --lib
just test webrtc-sys --manifest-path ash-rs/vendor/livekit-rust-sdks/Cargo.toml --lib rtc_error
just test ash-livekit-client --lib
just test ash-voice-host --features host --lib
just dependencies
```

更新版本时重新核对 Zed 补丁与官方实现，只保留仍然需要的改动；同步来源、锁文件、许可证、真实房间测试和 warning 检查。
