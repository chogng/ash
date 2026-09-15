# ash-realtime-webrtc

- 管理一条 WebRTC 音频连接，使用 Opus 发送和接收 48 kHz 单声道 PCM16。
- 支持 UDP、TCP 及两者同时启用；SDP 和鉴权交换由调用方负责。
- 可禁用数据通道，也可由调用方指定发起或接收的通道名；消息原样交给调用方。
- 连接就绪由 WebRTC 连接状态决定，不依赖模型服务或数据通道名称。
- 接收端使用有界序列窗口处理乱序与丢包，使用 Opus 丢包补偿，输出固定 20 ms PCM。
- 通过 `VoicePeer::close` 回收连接和任务；Drop 取消任务并安排关闭连接。
- 不依赖音频设备、helper、安装布局或 GStreamer；本机设备能力由 `voice-host` 提供。

## 接口

- `VoicePeer::new(PeerConfig)` 创建连接，`offer` / `answer` / `accept_answer` 交换 SDP。
- `connected` 等待连接建立，`send_audio` 提交 960 个 PCM16 样本，`next_event` 读取音频或数据通道事件。
- `DataChannel::Disabled` 支持纯音频；`Initiate(name)` / `Accept(name)` 控制应用通道。
- `send_text` 发送最多 16 KiB 文本；不解释业务 JSON、不丢弃接收到的应用消息。
- 事件消费者积压超过有界队列时连接失败并关闭，避免无界保留音频和业务事件。

## 验证

```sh
just check ash-realtime-webrtc
just test ash-realtime-webrtc
just rust-warnings ash-realtime-webrtc
```

- 真实本机连接测试覆盖无数据通道的音频收发、自定义通道双向消息和 UDP/TCP。
- 编解码与乱序测试使用真实 Opus；未验证公网 NAT、TURN 或实际模型服务。
- 当前完成 macOS 测试和构建。Windows 交叉检查被 `ring` 所需的 MSVC C 头文件阻塞，不能视为已通过 Windows 构建。
- 原 helper 控制客户端、进程协议和安装探测模块已删除；新客户端归 `voice-host`，本 crate 只保留网络传输职责。
