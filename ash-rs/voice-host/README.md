# ash-voice-host

- 管理本机音频设备，按需开始采集、播放或双向音频；停止时释放设备。
- 客户端与设备进程使用有界管道交换控制消息及 20 ms 单声道 PCM16，支持 16、24、48 kHz。
- `Speech` 模式调用 Sonora 做降噪和回声消除；回声参考来自实际提交给扬声器的样本。
- 使用 CPAL 打开设备，Rubato 转换设备采样率；工作线程处理 DSP，设备回调只做有界队列读写。
- 控制命令优先处理；代次标识使旧音频失效，超时或取消请求会终止不可安全复用的进程。
- 网络连接、鉴权、转写、模型事件及会话界面由调用方负责。24 kHz 可用于 Ash 实时 API，48 kHz 可用于 `realtime-webrtc`。

## 使用和构建

- 默认 Cargo feature 只包含 `AudioHost` 客户端和 PCM 协议，不引入设备或 DSP 依赖。
- `--features host` 构建设备进程。调用方通过明确的绝对文件路径启动 `AudioHost::spawn`，不依赖 PATH 或外置媒体插件。
- 控制顺序为启动进程、`start`、采集/播放、`stop`、`close`；可以在同一进程中重新开始音频会话。
- 客户端独占进程所有权，Drop 会终止 helper；父管道关闭时 helper 退出。
- 播放输入必须正好是配置采样率下 20 ms 的音频。队列容量限制为约 200 ms，过载明确报错。
- 麦克风静音和播放中断分别推进采集、播放代次，各自清理旧缓冲，不停止另一方向的音频。

```sh
just check ash-voice-host --features host
just test ash-voice-host --features host
just rust-warnings ash-voice-host --features host
```

## 设计参考与验证范围

- 参考 VS Code 的采集、语音服务、播放分工，自行实现 Rust PCM 会话及生命周期；没有复制其实现。
- 原移植的运行库加载、WebRTC、音轨、播放管线及设备处理模块已整体退场；设备与 DSP 归 `devices.rs` / `audio.rs`，进程会话归 `server.rs`，网络归 `realtime-webrtc`。
- 单元测试验证实际重采样、Sonora 处理、静音与中断代次、资源释放和协议边界；进程测试使用真实 helper，且不打开麦克风。
- 自动化结果不代表真实设备、操作系统权限、蓝牙切换或服务端通话已完成验证。
- 当前完成 macOS 测试与构建、Windows 设备端测试目标交叉编译、Linux 客户端测试目标交叉编译。Linux 设备端检查需要 ALSA 目标 SDK，本机尚未配置。
