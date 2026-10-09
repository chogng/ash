# Operation client

- 执行调用方构造的 HTTP 操作，按显式策略管理重试和退避。
- 重试判断保留底层错误类型；参数、配置、应用网络权限、证书验证器初始化错误，以及响应或重定向超限不会重试。
- 处理取消，停止本地等待；不保证已发送请求在服务端停止执行。
- 流消费者拒绝数据会取消该 attempt，生产 Reqwest 传输随之关闭活跃 I/O；不会取消调用方或其他操作。
- 处理 SSE 分帧与操作遥测。
- 承载认证方提供的只读目标、身份、凭据版本和请求用途；统一检查目标来源与请求头冲突。
- 绑定目标构造的 HTTP 请求拒绝重定向；登录、刷新和设备认证仍由各供应商负责。
- 遥测作用域覆盖操作开始到结束；可取消传输线程继承调用方的 OpenTelemetry API 上下文，不依赖 SDK 或 exporter。
- 将单次 HTTP 传输委托给 `http-client`；业务路由和 JSON 由上层协议 crate 负责。
- 测试使用 `http-test-support` 提供的 HTTPS 服务；辅助库仅作为测试依赖。

## 验证

- `just check ash-client`、`just test ash-client`、`just rust-warnings ash-client`。
- `target_tests.rs` 验证来源绑定、用途、头冲突与目标 Debug 脱敏。
- `client_tests.rs` 覆盖普通、可取消与流式入口的错误分类和重试次数。
- `operation_tests.rs` 验证实际请求发送前/后的取消、凭据绑定重定向限制和禁止重试策略；流消费者失败时检查 socket 关闭与调用方取消域仍然有效。使用通用字节请求，不引入后端业务类型。
- 取消、重试和网络职责的详细边界见 [`docs/ash-client.md`](../../docs/ash-client.md)。
