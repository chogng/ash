# ash-realtime-voice

`ash-realtime-voice` 管理听写会话。App Server 校验发起连接的权限和麦克风占用，把转写通知送回该连接；`voice-host` 进程采集 16 kHz 或 24 kHz PCM 音频。一次听写从持续输入音频、接收临时文本，到结束输入、收齐最终文本并回写，构成完整的一轮。`src/local.rs` 和 `src/cloud.rs` 各自负责这一轮的输入与返回结果。

默认 feature 只包含本地识别。App Server 显式启用 `cloud`，引入云端转写所需的模型供应商和 WebSocket 依赖；TUI 的本地麦克风路径不引入这些依赖。

Ash Code TUI 的 `/voice` 使用 `LocalSpeechSession` 在终端所在机器上采集和识别，按停顿产出完整话语并交给 TUI 发送到当前 Thread。模型回复在终端显示为文字；`/dictate` 则把识别文字填入草稿。TUI 连接远端 App Server 时，`/voice` 的麦克风和音频处理仍留在本机。

双向音频语音对话的每轮还要关联用户音频、模型音频、输入与输出转写，以及完成或打断。现有 `voice-agent` 负责持续的双向传输；模型事件尚无响应 ID，停止播报后需要新建模型会话，双向音频的产品入口尚未接通。

本地听写默认使用 [Paraformer-large-online ONNX 包](https://www.modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx/summary)，模型 ID 为 `paraformer-large-online-ec6a3c64`。第一次启动时下载该版本的量化编码器、解码器、CMVN 和词表，校验原始文件的 SHA-256，再把编码器所需的前端元数据写入 ONNX 文件。模型位于 Ash home 的 `dictation-models/<模型 ID>/`；录音和识别由 sherpa-onnx 流式执行。

本地模型可以按 ID 更换。Workbench 和 Sessions 的“模型 → 语音输入”可准备默认模型，或将兼容的流式 Paraformer 包导入所选的新 ID。源目录包含 `encoder.onnx`、`decoder.onnx`、`tokens.txt` 和内容为 `{"format":"sherpa-online-paraformer-v1"}` 的 `dictation-model.json`。Rust 在临时目录中复制、验证并实际加载，成功后发布到 Ash home；同一模型的安装受跨进程文件锁保护，已安装包不被覆盖。取消或关闭连接会停止操作并清理未完成的临时目录，已发布包保留。三端使用同一份模型包和识别实现；Electron 桌面在设置中修改 `dictation.localModel`，Rust 桌面在 `[gui]` 中设置 `dictationLocalModel = "<新 ID>"`。模型 ID 只接受字母、数字、`_` 和 `-`。不同 ONNX 模型架构仍需要各自的识别适配，不能仅替换文件名。

云端听写明确选择供应商。OpenAI 使用 `gpt-live-transcribe`、24 kHz PCM 和 Realtime 转写协议；xAI 使用 `grok-voice-transcribe-2.0`、16 kHz PCM 和 STT WebSocket 协议。两者分别使用对应供应商的直接 API 凭据，与当前文字模型接入和订阅凭据无关。停止时提交音频并等待最终文本；App Server 的停止响应也携带最终文本，使响应和通知交错到达时不会丢失输入。Electron 桌面的 `dictation.backend` 和 Rust 桌面的 `[gui].dictationBackend` 选择 `local` 或 `cloud`；云端供应商分别由 `dictation.cloudProvider` 和 `[gui].dictationCloudProvider` 选择 `openAi` 或 `xai`，默认 OpenAI。云端语音对话另由 `voice-agent`、`model-provider` 和 GPT-Live 负责，目前没有通过本 crate 启动。

识别器目前在 App Server 的会话工作线程中运行，麦克风采集位于独立的 `voice-host` 进程。一个 App Server 进程同时只允许一条听写会话；App Server 还阻止听写与通话同时占用麦克风。连接关闭会停止其听写会话。

代码入口按职责分开：`src/lib.rs` 管会话归属、启停和最终文本；`src/local.rs` 管本地流式识别；`src/cloud.rs` 管 OpenAI 云端转写；`src/xai.rs` 管 xAI 云端转写；`src/models.rs` 管连接所属的模型操作及取消；`src/model_package.rs` 管模型安装、文件校验与识别器加载。准备状态按检查、每文件真实下载字节数、加载和最终结果报告，模型准备本身不获取麦克风。

验证入口：`just check ash-realtime-voice`、`just test ash-realtime-voice`、`just rust-warnings ash-realtime-voice`；云端实现另运行 `just test ash-realtime-voice --features cloud` 与 `just rust-warnings ash-realtime-voice --features cloud`。设置 `ASH_TEST_DICTATION_CACHE_DIR` 可运行被忽略的默认模型下载和加载测试。设置 `ASH_TEST_DICTATION_MODEL_DIR` 与 `ASH_TEST_DICTATION_WAV` 可验证实际导入后的识别，WAV 为 16 kHz，断言文本包含“了解这个项目的进度”。设置 `ASH_TEST_DICTATION_MODEL_DIR` 与 `ASH_TEST_VOICE_HOST_PATH` 可运行真实麦克风采集及会话释放测试，测试不保存录音；这项只验收设备采集和生命周期，不能代替口述识别质量测试。代理和云端账户仍需要目标环境验收。
