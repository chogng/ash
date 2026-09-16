# ash-voice-agent

- 将授权人类参与者的房间音频混音并发送到 GPT-Live。
- 将 GPT-Live 输出音频重采样并作为 AI 音轨发布回房间。
- 隔离输入、输出缓冲；停止播放会丢弃待播放内容。
- 输出转写、用量和任务委托提议；接收宿主提供的任务说明。
- 不根据混音转写认定请求人，不直接执行工具或命令。
- 每个 worker 只属于一个媒体代次，断线时结束；成员变更由宿主停止并重新装配。
- 停止时先退出房间，再等待 GPT-Live 的最终结算事件。
- 当前尚未接入 App Server 的任务授权、Core 执行和产品 UI。

```sh
just test ash-voice-agent
ASH_TEST_LIVEKIT_SERVER=/absolute/path/livekit-server just test ash-voice-agent --test bridge -- --ignored
```

桥接测试使用真实 LiveKit 服务和本地 GPT-Live 协议模拟服务；真实模型账户、计费、网络和多人对话质量需要单独验收。
