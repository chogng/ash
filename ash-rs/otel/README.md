# OpenTelemetry

- 在 App Server 的 RPC、模型调用和 HTTP transport 中记录固定类别、结果与耗时。
- 生产 provider 使用 OpenTelemetry SDK，将 span 导出到有界 `ash-diagnostics`；最近 256 条记录和分类累计值可通过 `diagnostics/read` 查看。
- `Telemetry::with_exporter` 接收宿主提供的附加 exporter；实时查看由独立的 [otel-trace-websocket](../otel-trace-websocket/README.md) 负责，此 crate 不依赖 WebSocket。
- 不记录 URL、请求参数、聊天、模型输出、路径、请求头或凭据；默认不向外部 collector 发请求。
- `ash-analytics` 单独拥有默认关闭的使用统计；`ash-feedback` 负责用户确认后的快照上传。
- provider 随所属后端资源释放，读取反馈前显式 flush；`mock` feature 仅保留隔离的 SDK 测试 exporter。
- 验证：`just test ash-otel`；mock 可用 `just test ash-otel --features mock` 验证。
