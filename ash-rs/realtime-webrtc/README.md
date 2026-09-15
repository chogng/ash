# ash-realtime-webrtc

- 管理独立 `ash-voice-host` 进程，复用 Ash 的安装发现、构建标识和进程回收能力。
- 提供 WebRTC offer/answer 协商控制、运行库初始化、设备开启、静音控制和音量峰值读取。
- 用有界队列保留控制顺序；取消启动、关闭任一共享句柄或释放最后一个句柄时终止会话进程。
- 隔离控制接口与音频依赖；音频采集、处理、编码、播放和网络媒体传输均由 helper 执行。
- 不负责提供商鉴权、SDP 服务端交换、模型事件、Thread、工具执行或产品 UI。

## 安装与协议

- 使用 `InstallContext` 发现的物理安装包，仅启动 `ash-resources/voice/bin/ash-voice-host[.exe]`，拒绝 helper 路径中的符号链接跳转。
- `RealtimeWebrtcSession::start` 要求 `BuildInfo` 有编译时 Git commit；helper 必须确认协议版本 `1` 和相同 commit。
- 控制帧是大端 u32 长度加 JSON，最多 128 KiB；SDP 最多 64 KiB，调试输出隐藏其内容。音频不经过控制管道。
- 子进程只继承列明的系统、设备和网络环境变量；屏蔽加载器注入、应用凭据及外部媒体插件搜索路径。
- `is_supported` 只检查平台及 helper/主运行库文件是否存在，不证明运行库完整、设备可用或网络已连接。

## 调用与生命周期

- 在 UI 线程之外调用 `RealtimeWebrtcSession::start`，传入 `AbortRegistration`，取得 offer 和共享句柄。
- 调用方完成服务端 SDP 交换，再在 UI 线程之外调用 `apply_answer_sdp`；成功返回表示 helper 已完成协商、打开设备并应用当前控制状态。
- 设备初始关闭采集和播放；会话默认请求开启两者。协商期间设置的 `MicrophoneState`、`SpeakerState` 在首次开启前生效。
- 静音和扬声器控制按顺序入队，队列满时结束会话；setter 返回表示已入队，不表示设备已经应用。
- `take_microphone_peak`、`take_speaker_peak` 消费累计峰值，`take_error` 消费一次后台错误。
- `close` 取消正在等待的操作并触发进程终止；进程由共享运行时异步回收。低层 `VoiceHost::close` 等待关闭确认和退出。

## 实现与验证范围

- 本 crate 包含控制客户端和会话实现，不包含 `ash-voice-host` 可执行文件或 GStreamer 运行库；仅添加此 crate 不会启用产品语音。
- 集成测试复制测试程序组成独立安装包，模拟 helper，验证真实管道、控制顺序、错误分类、取消和进程回收。
- 测试不打开麦克风、不加载媒体库，也不连接真实语音服务。
- 验证命令：`just check ash-realtime-webrtc`、`just test ash-realtime-webrtc`、`just rust-warnings ash-realtime-webrtc`、`just dependencies`。
- 源码构建无法自动读取 Git 标识时，运行这些 Rust 命令前设置 `ASH_BUILD_COMMIT` 为当前完整 commit；测试包和模拟 helper 使用同一编译标识，不使用开发占位值。
- 来源及修改说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
