# OpenTelemetry trace WebSocket

- 接收 OpenTelemetry SDK 已完成的 span，向本机查看器实时推送标准 OTLP JSON。
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
- 浏览器使用 `new WebSocket(url, ['ash-trace-v2', 'ash-trace-token.' + token])`；服务端只回传 `ash-trace-v2`，持有令牌的查看器可跨 Origin 连接。
- 首帧为 `{"type":"ready","version":2,"format":"otlp-json"}`，表示订阅已经建立。
- 数据帧为标准 `ExportTraceServiceRequest` JSON，顶层为 `resourceSpans`；由官方 `opentelemetry-proto` 类型转换并序列化，不加自定义 span 外壳。
- trace/span/parent ID 使用十六进制，纳秒时间和 int64 属性保留十进制字符串精度；枚举使用数字，属性遵循 OTLP AnyValue 编码。resource、scope、事件、links、状态和丢弃计数随 span 传输。
- 慢连接落后于缓冲时收到 `{"type":"lagged","dropped":7}`；超过大小限制的 span 返回 exporter 错误，不截断成不完整 JSON。
- WebSocket 握手与控制帧属于 Ash 查看协议；数据内容与导出文件遵循 [OTLP JSON](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)。此监听器不是 OTLP HTTP/gRPC collector。`flush` 只保证完成本地发布，不代表查看器已读取；关闭时不保证剩余帧送达。
- Ash 采集 RPC、模型调用和 HTTP 的类别、结果、耗时与父子关系；`diagnostics/read` 仍由诊断存储提供有界摘要。

## Ash 开发者工具

- 配置上述环境变量并启动 App Server 后，在命令面板执行 `Developer: Open trace viewer`（中文：`开发者：打开 Trace 查看器`）。
- 输入监听地址和令牌后连接；Web 与 Electron 使用同一个 Workbench 查看器。
- 时间线展示相对开始时间、耗时和父子层级；名称、结果、trace ID 可筛选；详情展示可复制的标准 OTLP JSON。
- 导出仅包含筛选后保留的 span，可供接受 OTLP JSON 的工具导入。
- 最多保留 2,000 条 span 和 8 MiB，服务端丢帧和本地淘汰计入丢弃数量；断开保留采集，重新连接开始新采集。
- 令牌和采集不持久化，关闭编辑器释放连接；Alt+F1 打开键盘与连接帮助。

## 验证

- `just check ash-otel-trace-websocket`
- `just test ash-otel-trace-websocket`
- `just rust-warnings ash-otel-trace-websocket`
- App Server 接线：`just test ash-app-server --lib trace_websocket`
- 查看器单测：`pnpm --dir app-ts test:unit --run src/ash/workbench/contrib/trace/test/browser/traceConnection.test.ts`。
- 查看器交互：`pnpm --dir app-ts test:smoke:browser areas/trace/trace.spec.ts`、`pnpm --dir app-ts test:smoke:ui areas/trace/trace.spec.ts`。
- 实际产品采集与导出：`pnpm --dir app-ts test:smoke:browser:full areas/trace/trace.spec.ts`、`pnpm --dir app-ts test:smoke:desktop areas/trace/trace.spec.ts`，命令负责准备产品包。
