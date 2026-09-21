# LiveKit WebRTC 补丁

- 仅保存 Ash 当前使用的 `webrtc-sys` 源码；`livekit` 和 `livekit-signaling` 直接使用官方 crate。
- 上游版本、commit 和 crate 归档校验值记录在 `upstream.json`。
- `patches.diff` 修复异常文本按 UTF-8 字节边界切片引发的崩溃。
- 根 Cargo manifest 仅通过 `[patch.crates-io]` 覆盖 `webrtc-sys`。
- 上游发布该修复后删除本目录覆盖，恢复完全使用官方 crate。

## 验证

```sh
python3 ash-rs/vendor/livekit-rust-sdks/verify.py
just test webrtc-sys --manifest-path ash-rs/vendor/livekit-rust-sdks/Cargo.toml --lib rtc_error
just test ash-livekit-client --lib
just dependencies
```
