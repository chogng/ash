# ash-livekit-client

- 使用官方 LiveKit 信令协议与 `webrtc-rs`，自行管理房间、轨道和媒体收发。
- 发布、接收 48 kHz 单声道 PCM，保留参与者和轨道身份。
- 输出有界控制事件、音频和共享视频队列，丢弃超过 200 ms 的积压帧。
- 按轨道分别缓冲和混音；保留音源身份，支持轨道音量与移除后清理。
- 清空播放缓存保留现有轨道音量；轨道真正移除或房间更换时释放对应设置。
- 封装 24/48 kHz 的 10 ms 重采样。
- 关闭或丢弃房间时终止收流任务；控制事件过载结束连接。
- 设备采集、播放及 AEC/NS/AGC 由 `voice-host` 负责。
- 通过 `ash-screen-capture` 发布共享视频，并接收带参与者、轨道和旋转信息的 RGBA 帧。
- 停止共享先停止采集，再注销轨道；窗口关闭或采集错误通过媒体事件返回。
- 共享帧最长边不超过 8192 像素，总像素不超过 16,777,216；队列满时丢弃新帧。

真实服务测试需要显式提供已核验的 LiveKit Server。当前验证版本为 1.13.7：

```sh
ASH_TEST_LIVEKIT_SERVER=/absolute/path/livekit-server just test ash-livekit-client --features host --test room -- --ignored
```

测试启动临时回环服务，验证实际 Opus 音频双向传输，以及共享视频的解码、停止和重新发布。视频源为确定性测试画面；不打开麦克风，不代表真实设备或公网连通性验收。

### 频道通话联调

`tests/channels.rs` 启动真实协作服务和 LiveKit，用两个独立媒体进程通过频道权限入房。
验证双向可辨识音频、静音与恢复、编辑者降为只读后的收听与发布限制，以及撤权后旧连接退出、缓存票据无法收听或向新房间注入音频。服务进程和临时配置随测试退出清理。

```sh
scripts/.venv/bin/python -B build/lib/livekit.py aarch64-apple-darwin
scripts/.venv/bin/python -B scripts/cargo.py build --profile ci-test \
  -p ash-collab-server -p ash-livekit-client --features ash-livekit-client/host
ASH_TEST_LIVEKIT_SERVER="$PWD/third_party/.cache/livekit/1.13.7/aarch64-apple-darwin/livekit-server" \
ASH_TEST_COLLABORATION_SERVER="$PWD/.build/cargo/ci-test/ash-collab-server" \
ASH_LIVEKIT_CLIENT_PATH="$PWD/.build/cargo/ci-test/ash-livekit-client" \
just test ash-livekit-client --features host --test channels -- --ignored --nocapture
```

以上为 macOS ARM64 示例；其他平台使用对应目标与可执行文件后缀。
显式增加 `ASH_TEST_VOICE_HOST=/absolute/path/ash-voice-host` 可打开真实默认输入和输出：
戴耳机说话，测试检查麦克风帧在另一客户端解码，并将对方返回的测试音通过设备播放。
只记录帧数，不保存麦克风录音。没有该变量时完全不打开物理设备。

桌面双配置验收使用 `test/smoke/areas/call/channel-call.spec.ts`：

```sh
ASH_TEST_LIVEKIT_SERVER=/absolute/path/livekit-server \
pnpm test:smoke:desktop test/smoke/areas/call/channel-call.spec.ts
```

它通过频道树加入，验证双方默认静音、开麦状态同步、停止／恢复收听、角色降级后的自动重连和成员移除。
需要真实输入、输出设备。仅在明确验收无麦克风场景时设置 `ASH_TEST_CALL_ALLOW_NO_MICROPHONE=1`；
该模式只接受具体的设备缺失错误，并标注物理采集未验证，不能作为真人开麦通过的证据。

- 进程内所有房间共享 Ash 的 HTTP／WebSocket 传输；首次连接前注册一次，再次入房、连接诊断和区域发现继续使用同一网络策略。
- `stats` 返回 Ash 自己的发布端与订阅端报告计数，不向调用方暴露 SDK 类型。
- `livekit-signaling` 与 `livekit-protocol` 负责服务端信令，`webrtc-rs` 负责 ICE、DTLS、SRTP 与 RTP；PCM 和共享画面的编解码分别使用 `opus-rs` 与 `oxideav-vp8`。
