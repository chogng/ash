# ash-utils-audio

- 校验 WAV、MP3、M4A、WebM、Ogg 音频容器和 base64 data URL，保留原始编码字节。
- 单附件最多 16 MiB、一个音轨、一小时时长；拒绝格式不符、空音轨、截断容器和无法测量的时长。
- 按容器包时间戳测量时长，为上下文规划提供每秒十个 token 的向上取整估算；不代表提供商计费。
- 不负责附件存储、网络下载、录音、播放或模型接口选择。
- `tests/fixtures/tone.*` 是生成的一秒 440 Hz 单声道测试音：WAV 为 16 kHz PCM，MP3/AAC/Vorbis/Opus 由 FFmpeg 转码。

验证：`just test ash-utils-audio`、`just check ash-utils-audio`、`just rust-warnings ash-utils-audio`。
