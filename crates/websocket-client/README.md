# `ash-websocket-client`

- 提供 WebSocket 握手、受限 text/binary 消息、Ping/Pong 和关闭。
- 复用 `ash-http-client::OutboundNetworkSnapshot` 的代理、TLS/mTLS、超时与网络目标策略。
- 使用传输层消息类型，不向上暴露 Tungstenite。
- 拒绝非法请求头、URL 凭据及覆盖 Host/Upgrade 等传输层字段；诊断不输出凭据、URL 或服务端错误体。
- 握手拒绝保留 HTTP 状态，便于上层区分认证失败与其他连接失败。
- 不解释模型事件、不保存会话历史、不决定推理重试。

当前上层调用链为 `model-provider → ash-api 的 Responses/Realtime 会话 → websocket-client`。协议 JSON、终态、会话复用与取消语义属于 API/运行时；网络连接由本 crate 提供。

```text
just test ash-websocket-client
```

测试使用本地 WebSocket 和 HTTP CONNECT 代理，覆盖消息往返、握手拒绝、请求头校验与脱敏。协议和 Luna 实连测试见[模型 API 协议](../../docs/ash-api.md#46-端点归属与-websocket-实现)。
