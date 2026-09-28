# ash-realtime-voice

`ash-realtime-voice` 管理设备所在进程的听写会话。App Server 校验调用权限并把事件送回发起连接；听写 crate 负责麦克风独占、识别会话及资源释放。窗口关闭时，App Server 按连接关闭对应会话。

当前识别器使用 Windows 系统听写。一个进程同时只有一个活动听写会话；资源 ID 与发起连接共同确定停止权限。识别器报告结束后，下次启动会先释放上一会话。`stop` 返回前完成识别器停止，因此该会话不会再产生后续事件。非 Windows 平台目前返回不支持。

本地听写选用 [Paraformer-large-online 的 ONNX 导出版](https://www.modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx/summary)。接入时需将模型文件、配置、CMVN 和词表作为同一版本的资产管理，并处理 16 kHz 音频特征、逐块推理状态与转写文本。当前尚未实现这些步骤，识别器仍为 Windows 系统听写。

`voice-host` 负责需要 PCM 音频的设备采集、重采样和处理；`realtime-voice` 负责听写模型资产、识别器和会话。听写链路没有 WebRTC 传输；LiveKit 房间传输仍由 `livekit-client` 负责。

输入分类器使用 `candle-onnx` 运行内嵌的 ONNX 模型。Paraformer-large-online 的模型修订 `ec6a3c64e290b719409e8c06cc2ac504e747c8eb` 中，`model_quant.onnx` 和 `decoder_quant.onnx` 都使用 `DynamicQuantizeLinear` 与 `MatMulInteger`，当前仓库的 `candle-onnx` 执行器不支持这两个算子，不能直接运行这两张图。仓库目前没有引入 ONNX Runtime；接入模型时需要确定推理运行库并验证流式识别结果。两个模型各自的前后处理和会话状态由所属领域负责，只有出现实际共用的运行库代码时才抽取通用 crate。

验证入口：`just check ash-realtime-voice`、`just test ash-realtime-voice`、`just rust-warnings ash-realtime-voice`。真实麦克风、系统权限和具体识别模型需要在目标设备上验收。
