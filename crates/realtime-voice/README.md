# ash-realtime-voice

`ash-realtime-voice` 管理听写会话。App Server 校验发起连接的权限和麦克风占用，把转写通知送回该连接；`voice-host` 进程采集 16 kHz 或 24 kHz PCM 音频。本地及 API 听写可提供临时文本，订阅听写停止录音后上传并返回最终文字。

默认 feature 提供本地识别协调与识别客户端；Sherpa ONNX 的加载、流和推理由本 crate 的 `ash-realtime-voice` 程序（`host` feature）拥有，首次需要识别时启动，基础后端不链接推理库。可选包的安装与选择见 [Remote distribution](../../remote-server/README.md)。App Server 显式启用 `cloud`，引入云端转写所需的模型供应商和 WebSocket 依赖。

Electron 的转写服务、对应型号、麦克风和语言在 Voice input 设置中管理；API 凭据仍由 Models 中的连接配置唯一持有。每个云端 API 服务目前只支持当前实现指定的单一型号，不提供任意模型 ID 输入。

## Codex 订阅听写

2026-10-16 已实测确认订阅听写可复用当前 Codex 登录：Ash 的 `ChatGptOAuth` 以 `Codex` 管理模式只读取得认证，向 `POST https://chatgpt.com/backend-api/transcribe` 上传合成 WAV，返回的 `text` 正确包含预期的 `coding assistant`。请求使用 multipart 的 `file` 与 `language`，不指定公开 API 的转写模型。源 `auth.json` 指纹保持一致，没有刷新登录、采集麦克风或记录音频正文。协议来自本机安装的官方 Codex 扩展 `26.1007.21434` 的听写实现；这里的成功结果只代表当前账号的实际验证。

在 Voice input 的听写服务中选择“Codex 订阅”（`dictation.backend = "codex"`），账号使用 Models 中的 Codex 登录，不需要 API Key 或型号选择。聊天、编辑器和终端沿用现有听写入口及各自的文字插入行为；停止后等待最终文本，通知和停止响应交错到达时只插入一次。终端仍不会自动按 Enter。

`ash-chatgpt::ChatGptDictation` 唯一持有订阅接口和认证，`model-provider` 复用已装配的 OAuth owner；`src/subscription.rs` 以 24 kHz 单声道 PCM16 采集到内存，停止后释放设备、编码 WAV 并上传，不保存录音。每次录音最多 3 分钟，超限会丢弃并报错。录音开始时固定账号的用户及工作区身份，上传前和接收结果后重新核对；过期、注销或账号切换会阻止继续上传或回填。没有流式临时文字，也不指定 `gpt-live-transcribe`。

`dictation/cancel` 按发起连接与 resource ID 取消，使用独立调度，能够打断正在等待 `dictation/stop` 的上传。取消、隐藏输入、释放服务及关闭连接均丢弃音频和迟到文字。资源管理器在停止期间保留取消 authority，并在设备／上传 worker 释放后清理；原来的本地及 API 模式继续使用各自实现。HTTP 不跟随重定向，不自动重放音频，也不因语音失败切换账号。TypeScript 的选择仍由本地 profile 的 `settings.json` 持有，旧的 `local`、`cloud` 值与默认值不变。

订阅听写的复现入口为 `ash-chatgpt` 的 ignored test `live_codex_subscription_dictation_transcribes_synthetic_audio`，通过正式 `ChatGptDictation` 实现调用。设置 `ASH_TEST_DICTATION_WAV` 为合成 WAV（测试上限 2 MiB，内容含 `coding assistant`），运行 `just test ash-chatgpt live_codex_subscription_dictation_transcribes_synthetic_audio -- --ignored --nocapture`。设置 `ASH_TEST_DICTATION_LANGUAGE=zh` 时改用包含“语音输入”的合成中文 WAV；中英文均已通过正式实现实测。普通测试不会上传音频，实测不输出 token、转写正文或上游原始错误。模块测试覆盖中文返回、身份切换、错误与不重试；资源测试覆盖取消对停止等待的打断；前端测试覆盖停止回填、去重、取消、输入释放及两套设置页。真实麦克风设备仍需产品环境验收。

## 实时通话协议验证

实时语音对话是另一条协议。`POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas` 接受 `{ sdp, session }` JSON，`gpt-live-1-codex` 返回有效音频 SDP，Chromium 静音 peer 可进入 `connected` 并发送 RTP，但数据通道返回 `forbidden`，具体提示为 `Voice session access denied.`，没有转写或任务委托；补齐官方会话关联头后仍然如此。V3 侧带 `wss://api.openai.com/v1/live/<call_id>` 返回 HTTP 404。本机官方客户端自建通话使用 `/backend-api/wham/realtime/calls`；同参数对比得到 SDP，但本次媒体连接随后失败、事件通道超时，不能据此判断授权结果。上述失败不能推翻已经成功的订阅听写，也不能区分实时通话的账号开放范围、客户端认证或其他服务端策略。

本地 Codex `codex-rs/core/src/realtime_conversation.rs` 的独立 WebSocket 路径仍要求 API Key，WebRTC 则通过当前模型连接的认证创建通话，再用相同身份附着控制侧带。其 WebRTC 校验只允许 conversational 模式与 V1/V3，不支持 transcription 模式；V3 默认型号为 `gpt-live-1-codex`。不能把这些通话约束套到独立的 `/transcribe` 听写接口。官方也区分[实时语音对话](https://learn.chatgpt.com/docs/features/voice)和语音听写，桌面 Voice 消耗订阅额度。

会话创建的显式实测入口为 `ash-chatgpt` 的 ignored test `live_tests::live_codex_voice_call_accepts_silent_webrtc_offer`。调用方设置 `ASH_TEST_VOICE_OFFER` 和 `ASH_TEST_VOICE_ANSWER`，前者是有效的静音音频 SDP offer，后者必须是尚不存在的可写文件；运行 `just test ash-chatgpt live_tests::live_codex_voice_call_accepts_silent_webrtc_offer -- --ignored --exact --nocapture`，将 answer 应用到原 peer 并在验证后关闭。该测试会创建真实订阅语音会话，普通测试不会运行，不输出 token、SDP 或上游原始错误，不重试请求。

事件与控制的复现入口为 `node crates/model-provider/tests/subscription_voice_probe.mjs <synthetic.wav> <dataChannel|sideband> [codex|desktop]`，默认 `codex` 路由，`desktop` 明确选择官方客户端使用的 `wham` 路由；需已安装仓库 Playwright Chromium。WAV 内容为“Please delegate this task to the coding assistant. Reply with the word ready. Do not run commands or edit files.”，上限 2 MiB；不读取麦克风。脚本显式运行 `ash-model-provider` 的 ignored test `subscription_voice_transcribes_delegates_and_closes`，由 Rust 读取原账号并创建会话；浏览器只接收 SDP，验证音频、转写、委托内容与结束事件，不执行 Core 任务。它会创建真实语音会话，必须显式选择事件传输，不在失败后自动切换。普通测试保持跳过。产物位于仓库忽略的 `.tmp/subscription-voice-events-*`，日志只包含事件类型、连接状态、布尔结果、限制后的错误码及脱敏截断的错误解释。

实时通话产品适配仍需先验证可工作的模型会话、侧带事件、输入与输出音频、转写和任务委托；通过后沿 `voice/start` 和语音 provider 增加订阅传输适配。Codex 凭据继续只读，由 Codex 管理刷新；Ash 独立 `chatgpt-plan` 授权不在本次证据范围内。验收还需覆盖无权益、令牌过期、注销取消、断连释放麦克风和通话结束。不能只解除 `model-provider` 的订阅限制来接入这两个不同的协议。

## 现有听写实现

Ash Code TUI 的 `/voice` 通过 App Server 把识别文字填入当前草稿，由用户审阅、编辑后发送给现有编码任务。TUI 不直接运行本地连续语音识别会话，也不提供实时语音对话入口。

双向音频语音对话的每轮还要关联用户音频、模型音频、输入与输出转写，以及完成或打断。现有 `voice-agent` 负责持续的双向传输；模型事件尚无响应 ID，停止播报后需要新建模型会话，双向音频的产品入口尚未接通。

本地听写默认使用 [Paraformer-large-online ONNX 包](https://www.modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx/summary)，模型 ID 为 `paraformer-large-online-ec6a3c64`。通过模型准备操作下载该版本的量化编码器、解码器、CMVN 和词表，校验原始文件的 SHA-256，再把编码器所需的前端元数据写入 ONNX 文件。模型位于 Ash home 的 `dictation-models/<模型 ID>/`；录音和识别由 sherpa-onnx 流式执行。

本地模型可以按 ID 更换。Workbench 和 Sessions 的“设置 → 语音”可下载默认模型、查看已安装包和大小、选择或删除模型，或将兼容的流式 Paraformer 包导入所选的新 ID。源目录包含 `encoder.onnx`、`decoder.onnx`、`tokens.txt` 和内容为 `{"format":"sherpa-online-paraformer-v1"}` 的 `dictation-model.json`。Rust 在临时目录中复制、验证并实际加载，成功后发布到 Ash home；同一模型的安装受跨进程文件锁保护，已安装包不被覆盖。模型准备属于 App Server 进程；关闭设置或发起连接不会取消操作，其他产品窗口会收到模型状态变化通知并读取当前阶段。只有明确取消才停止操作并清理未完成的临时目录，已发布包保留。删除仅移除 Ash 管理的包文件，保留导入源目录；准备中或语音使用中拒绝删除。三端使用同一份模型包和识别实现；Electron 桌面在设置中修改 `dictation.localModel`，Rust 桌面在 `[gui]` 中设置 `dictationLocalModel = "<新 ID>"`。模型 ID 只接受字母、数字、`_` 和 `-`。不同 ONNX 模型架构仍需要各自的识别适配，不能仅替换文件名。

云端听写明确选择供应商。OpenAI 使用 `gpt-live-transcribe`、24 kHz PCM 和 Realtime 转写协议；xAI 使用 `grok-voice-transcribe-2.0`、16 kHz PCM 和 STT WebSocket 协议。两者分别使用对应供应商的直接 API 凭据，与当前文字模型接入和订阅凭据无关。停止时提交音频并等待最终文本；App Server 的停止响应也携带最终文本，使响应和通知交错到达时不会丢失输入。Electron 桌面的 `dictation.backend` 和 Rust 桌面的 `[gui].dictationBackend` 选择 `local` 或 `cloud`；云端供应商分别由 `dictation.cloudProvider` 和 `[gui].dictationCloudProvider` 选择 `openAi` 或 `xai`，默认 OpenAI。云端语音对话另由 `voice-agent`、`model-provider` 和 GPT-Live 负责，目前没有通过本 crate 启动。

识别器运行在本机独立的 `ash-realtime-voice` 进程中，App Server 的会话工作线程持有识别客户端，麦克风采集位于独立的 `voice-host` 进程。一个 App Server 进程同时只允许一条听写会话；App Server 还阻止听写与通话同时占用麦克风。连接关闭会停止其听写会话。

代码入口按职责分开：`src/lib.rs` 管会话归属、启停和最终文本；`src/local.rs` 管本地流式识别；`src/cloud.rs` 管 OpenAI 云端转写；`src/xai.rs` 管 xAI 云端转写；`src/subscription.rs` 管订阅录音与停止后上传；`src/models.rs` 管进程所属的模型操作、共享快照及取消；`src/model_package.rs` 管模型安装、文件校验与识别器加载。准备状态按检查、每文件真实下载字节数、加载和最终结果报告，模型准备本身不获取麦克风。

验证入口：`just check ash-realtime-voice`、`just test ash-realtime-voice`、`just rust-warnings ash-realtime-voice`；云端实现另运行 `just test ash-realtime-voice --features cloud` 与 `just rust-warnings ash-realtime-voice --features cloud`。设置 `ASH_TEST_DICTATION_CACHE_DIR` 可运行被忽略的默认模型下载和加载测试。设置 `ASH_TEST_DICTATION_MODEL_DIR` 与 `ASH_TEST_DICTATION_WAV` 可验证实际导入后的识别，WAV 为 16 kHz，断言文本包含“了解这个项目的进度”。设置 `ASH_TEST_DICTATION_MODEL_DIR` 与 `ASH_TEST_VOICE_HOST_PATH` 可运行真实麦克风采集及会话释放测试，测试不保存录音；这项只验收设备采集和生命周期，不能代替口述识别质量测试。代理和云端账户仍需要目标环境验收。
