# OpenTelemetry

- 在 App Server 的 RPC、模型调用和 HTTP transport 中记录固定类别、结果与耗时。
- span 覆盖调用开始到结束，在同步作用域中附着上下文；模型请求的可取消工作线程和 Core 执行队列逐任务传递 OpenTelemetry API 上下文，保持 RPC → 模型 → HTTP 父子关系。
- `TelemetrySpan::finish` 写入最终结果，提前退出按失败结束；释放作用域恢复父上下文，不跨异步等待持有线程作用域。
- 生产 provider 使用 OpenTelemetry SDK，将 span 导出到有界 `ash-diagnostics`；最近 256 条记录、分类累计值及生产业务指标可通过 `diagnostics/read` 查看。
- `Diagnostics::metrics()` 共享实例级 `SdkMeterProvider`：MCP 调用、Skill 激活、Guardian 审查记录次数、结果、错误类别和耗时；Guardian 另记录 provider 报告的 token 用量，以及真实流式输出的首 token 耗时。App Server 按冻结模型的真实传输方式转发增量事件，避免桥接层吞掉首 token。累计读数直接来自 SDK，不维护第二份聚合状态；每项 instrument 最多 128 组标签，超限仍保留 overflow 总量。
- 动态 server/tool/skill/model 标签只进入本地诊断及用户审阅的反馈内容，统一使用公共 ASCII/256 字节清洗；不使用错误正文、参数、路径或凭据作标签。独立 Windows 沙箱服务的安装指标由 `ash-windows-sandbox metrics` 读取。
- `Telemetry::with_exporter` 接收宿主提供的附加 exporter；实时查看由独立的 [otel-trace-websocket](../otel-trace-websocket/README.md) 负责，此 crate 不依赖 WebSocket。
- 不记录 URL、请求参数、聊天、模型输出、路径、请求头或凭据；默认不向外部 collector 发请求。
- `ash-analytics` 单独拥有默认关闭的使用统计；`ash-feedback` 负责用户确认后的快照上传。
- provider 随所属后端资源释放，读取反馈前显式 flush；`mock` feature 仅保留隔离的 SDK 测试 exporter。
- 验证：`just test ash-otel`；mock 可用 `just test ash-otel --features mock` 验证。
