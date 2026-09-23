# Operation client

- 执行调用方构造的 HTTP 操作，按显式策略管理重试和退避。
- 处理取消，停止本地等待；不保证已发送请求在服务端停止执行。
- 处理 SSE 分帧与操作遥测。
- 遥测作用域覆盖操作开始到结束；可取消传输线程继承调用方的 OpenTelemetry API 上下文，不依赖 SDK 或 exporter。
- 将单次 HTTP 传输委托给 `http-client`；业务路由和 JSON 由上层协议 crate 负责。
- 测试使用 `http-test-support` 提供的 HTTPS 服务；辅助库仅作为测试依赖。

## 验证

- `just check ash-client`、`just test ash-client`、`just rust-warnings ash-client`。
- `operation_tests.rs` 验证实际 HTTPS 请求发送前/后的取消和禁止重试策略；使用通用字节请求，不引入后端业务类型。
- 取消、重试和网络职责的详细边界见 [`docs/ash-client.md`](../../docs/ash-client.md)。
