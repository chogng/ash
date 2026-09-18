# ash-livekit-client

- 隔离官方 LiveKit Rust SDK 与 libwebrtc 依赖。
- 发布、接收 48 kHz 单声道 PCM，保留参与者和轨道身份。
- 输出有界媒体事件与音频队列，丢弃超过 200 ms 的积压音频。
- 按轨道分别缓冲和混音；保留音源身份，支持轨道音量与移除后清理。
- 清空播放缓存保留现有轨道音量；轨道真正移除或房间更换时释放对应设置。
- 封装 24/48 kHz 的 10 ms 重采样。
- 关闭或丢弃房间时终止收流任务；控制事件过载结束连接。
- 设备采集、播放及 AEC/NS/AGC 由 `voice-host` 负责。
- 通过 `ash-screen-capture` 支持屏幕共享视频轨道发布，并在退出房间或关闭共享时清理流与注销轨道。

macOS 最终二进制需要 `-ObjC` 链接选项，已在工作区 Cargo 配置设置；产品其他构建入口仍需分别验证。

真实服务测试需要显式提供已核验的 LiveKit Server。当前验证版本为 1.13.7：

```sh
ASH_TEST_LIVEKIT_SERVER=/absolute/path/livekit-server just test ash-livekit-client --test room -- --ignored
```

测试启动临时回环服务，验证实际 Opus 音频双向传输；不打开麦克风，不代表真实设备或公网连通性验收。

- 房间网络使用 Ash 的 HTTP／WebSocket 传输；`connect_with_network` 接受统一的证书、代理和超时配置，重连及区域发现继续使用同一配置。
- `stats` 返回发布端与订阅端的连接统计；SDK 本地补丁由 `../vendor/livekit-rust-sdks/` 维护。
