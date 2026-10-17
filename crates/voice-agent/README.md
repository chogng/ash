# ash-voice-agent

- 接收 `model-provider` 创建的 `VoiceModelSession`，不选择供应商、模型、音色或密钥。
- 将授权人类参与者的房间音频混音并发送到 GPT-Live。
- 将 GPT-Live 输出音频重采样并作为 AI 音轨发布回房间。
- 隔离输入、输出缓冲；停止播放会丢弃待播放内容，并拒绝同一模型会话的迟到音频。
- 当前模型事件没有响应代次，停止后需要新建模型会话才能恢复播报。
- 只将在线且已授权的人类成员交给模型；最后一人离开时关闭房间与模型连接。
- 输出转写、用量和任务委托提议；接收宿主提供的任务说明。
- 不根据混音转写认定请求人，不直接执行工具或命令。
- 每个 worker 只属于一个媒体代次，断线时结束；成员变更由宿主停止并重新装配。
- 停止时先退出房间，再等待 GPT-Live 的最终结算事件。
- 模型拒绝保留供应商错误代码；运行失败后仍清理房间和模型连接，后续清理失败不会覆盖首个运行错误。
- App Server 的单人 `voice` 路径已装配本 crate：委托通知原 Chat，沿用其 mode、任务队列和审批，再将 Core 进度传回语音模型；转写保存在原 Thread。本 crate 仍不直接执行任务。
- 当前产品路径只允许一名人类与一名 AI，尚无向任意多人通话邀请 AI 的产品入口。真实模型与多人协作验收范围见[协作媒体方案](../docs/design/collaboration-media.md)。

```sh
just test ash-voice-agent
ASH_TEST_LIVEKIT_SERVER=/absolute/path/livekit-server just test ash-voice-agent --test bridge -- --ignored
```

桥接测试从现有模型凭据存储和 `connect_voice` 工厂创建会话，再使用真实 LiveKit 服务和本地 GPT-Live 协议模拟服务，验证默认语音模型、指定音色及鉴权头。真实模型账户、计费、网络和多人对话质量需要单独验收。
