# OpenTelemetry trace WebSocket

- 接收 OpenTelemetry SDK 已完成的 span，向本机查看器实时推送 JSON。
- 独立负责编码、鉴权、连接和监听线程的生命周期。
- 不依赖 App Server、诊断存储或界面；不读取环境变量、不写磁盘、不向外部 collector 上传。
- 最多 8 个连接，共享 256 帧缓冲，每帧最多 64 KiB；慢连接收到丢帧数量，发送或握手超过 5 秒则关闭。
- 无查看器时跳过编码；新连接从当前时刻开始，不回放历史。
- SDK shutdown 关闭全部连接，最后一个 exporter 释放时回收监听线程；clone 共享同一个监听器。

## 接入

- `Exporter::bind(SocketAddr, AccessToken)` 只接受 loopback 地址，不要求调用方已有 Tokio runtime。
- 令牌使用宿主生成的 32 个随机字节，编码为 64 位十六进制，通过 `AccessToken::from_str` 校验。
- 将 exporter 交给 SDK，或通过 `ash_otel::Telemetry::with_exporter` 保留 Ash 本地诊断并同时推送。
- App Server 普通入口与 managed profile 入口读取 `ASH_TRACE_WEBSOCKET_ADDR` 和 `ASH_TRACE_WEBSOCKET_TOKEN`；两个变量必须同时提供，默认关闭。
- 地址格式为 `127.0.0.1:4319` 或 `[::1]:4319`，端口为 `0` 时由系统分配；实际地址写入 stderr，不输出令牌。
- 嵌入宿主使用 `LocalAppServerOptions::with_trace_exporter`；多个目录共享 profile 时使用 `LocalProfileRuntime::with_trace_exporter`，只装配一次。

## 连接与帧

- 路径必须为 `/`，不接受 query 参数。
- 非浏览器客户端使用 `Authorization: Bearer <token>`。
- 浏览器使用 `new WebSocket(url, ['ash-trace-v1', 'ash-trace-token.' + token])`；服务端只回传 `ash-trace-v1`，持有令牌的查看器可跨 Origin 连接。
- 首帧为 `{"type":"ready","version":1}`，表示订阅已经建立。
- `span` 帧包括 `sequence`、trace/span/parent ID、类别、名称、时间、属性、事件、links、状态、scope 与 resource。SDK 的属性、事件和 link 丢弃计数一起传输。
- 序号、纳秒时间及整型/浮点属性使用十进制字符串；属性为 `{"key":"outcome","value":{"type":"string","value":"failed"}}`。类型支持 `bool`、`int`、`double`、`string` 及各自的 `[]` 数组。
- 慢连接落后于缓冲时收到 `{"type":"lagged","dropped":7}`；超过大小限制的 span 返回 exporter 错误，不截断成不完整 JSON。
- 这是 Ash 版本化查看协议，不是 OTLP。`flush` 只保证完成本地发布，不代表查看器已读取；关闭时不保证剩余帧送达。
- Ash 当前只采集 RPC、模型调用和 HTTP 的类别、结果、耗时；`diagnostics/read` 仍由诊断存储提供有界摘要，查看器界面由消费方负责。

## 验证

- `just check ash-otel-trace-websocket`
- `just test ash-otel-trace-websocket`
- `just rust-warnings ash-otel-trace-websocket`
- App Server 接线：`just test ash-app-server --lib trace_websocket`
