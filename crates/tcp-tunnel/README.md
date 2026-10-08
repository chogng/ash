# HTTP/3 TCP tunnel

`ash-tcp-tunnel` 提供通过 HTTP/3 CONNECT 代理建立 TCP 字节流的 Rust 接口。它是独立底层库，尚未接入 Ash 产品，不提供 CLI 命令，也不读取 stdin、profile、策略文件或账户存储。

`ProxyClient` 持有一条经过 TLS 校验的 QUIC/HTTP/3 连接，多个目标字节流共用这条连接。调用方提供获准的 HTTPS origin、TLS 根证书、敏感凭据以及 `async-utils` 取消令牌。每次 CONNECT 的非 2xx 响应以 `Error::Rejected(status)` 返回；只有收到成功响应后，`open_stream` 才返回实现 Tokio `AsyncRead` / `AsyncWrite` 的 `TunnelStream`。

## 使用与归属

```rust,ignore
use async_utils::CancellationSource;
use tcp_tunnel::ConnectTarget;
use tcp_tunnel::Credentials;
use tcp_tunnel::ProxyClient;
use tcp_tunnel::ProxyConfig;

// approved_origins 与 roots 来自调用方的信任策略；库不获取或保存凭据。
let config = ProxyConfig::new(proxy_origin, &approved_origins, roots)?;
let cancellation = CancellationSource::new();
let credentials = Credentials::bearer(&token, http::HeaderMap::new())?;
let client = ProxyClient::connect(config, credentials, cancellation.token()).await?;
let stream = client.open_stream(
    ConnectTarget::parse("server.example:22")?,
    cancellation.token(),
).await?;

// 把 stream 交给消费字节流的协议调用方。
// 需要外部进程访问时，可以按需创建回环监听。
let forward = client.listen_loopback(
    ConnectTarget::parse("server.example:22")?,
    "127.0.0.1:0".parse()?,
).await?;
let local_address = forward.local_addr();

stream.close().await?;
forward.close().await?;
client.close().await?;
```

| 内容                                        | 负责方                                  |
| ------------------------------------------- | --------------------------------------- |
| 代理与目标选择、origin 授权、TLS 根证书来源 | 调用方                                  |
| 登录、凭据保存与刷新                        | 调用方；刷新后调用 `update_credentials` |
| QUIC、CONNECT、字节传输和任务清理           | 本库                                    |
| 断线重连、重试时机及业务请求恢复            | 调用方                                  |
| 日志、JSON、产品状态与用户提示              | 调用方根据类型化结果处理                |

凭据更新只影响更新后提交的新 CONNECT；已经建立的流不会重新授权。扩展元数据只接受非转发用途的 `x-` 头，不能覆盖 Authorization、转发头或主机头，也不接受重复扩展头。Bearer、元数据数量和大小在接口边界校验，敏感头标记为 sensitive。凭据的 Debug 输出和公开错误不包含敏感值或代理返回的原始文本。

## 生命周期与传输约定

- `connect` 的成功只表示代理连接已建立。`listen_loopback` 的成功只表示本地端口已监听。目标是否可用，由每个 CONNECT 的响应决定。
- `open_stream` 的取消令牌覆盖建立过程和返回流的整个生命周期；丢弃尚未完成的 future 也会取消该次请求。连接的取消令牌覆盖所有流和监听。
- 一个 `TunnelStream`、`LocalForward` 或 `ProxyClient` 被丢弃后会请求取消。各自的 `close().await` 等待所属资源清理完成；关闭客户端也等待其流及监听清理，不要求结束共享 Tokio runtime。
- 流保留两侧独立的半关闭语义：写侧 shutdown 发送 FIN，读侧仍可接收；代理关闭响应方向后仍可继续上传。每个方向使用有界缓冲，保留背压。异常断开返回 I/O 错误，不当作成功 EOF。
- 收到 GOAWAY 后，在新 CONNECT 被拒绝时报告 `Draining`，已接受的流继续运行。在 GOAWAY 到达期间被代理以 `H3_REQUEST_REJECTED` 重置的新请求报告 `RequestRejected`。调用方可显式建立另一条代理连接；本库不自动重连、排队或重放 TCP 数据。
- DNS/QUIC 握手和每次 CONNECT 分别受截止时间约束。默认各为十秒，可通过 `ProxyConfig::with_timeouts` 指定。多地址解析依序尝试；总体截止时间覆盖整个连接过程。
- 回环转发只允许 loopback 监听，单个连接的失败通过 `ForwardEvent` 报告，不终止监听。事件通道有界，落后订阅者会收到 `Lagged`。连接状态可通过 `ProxyClient::subscribe` 观察。

接口定义和调用约束见 [lib.rs](src/lib.rs)、[config.rs](src/config.rs)、[forward.rs](src/forward.rs)。HTTP/3 CONNECT 的字节流与半关闭语义依据 [RFC 9114 §4.4](https://www.rfc-editor.org/rfc/rfc9114.html#section-4.4)。HTTP/3 依赖固定到支持 CONNECT 与 GOAWAY 的提交；Cargo 和 Bazel 构建入口均包含此 crate。来源归属保留在 `LICENSE` 和 `NOTICE`。

## 验证

```text
just check ash-tcp-tunnel
just test ash-tcp-tunnel
just rust-warnings ash-tcp-tunnel
bazel test //crates/tcp-tunnel:tcp-tunnel-unit-tests --lockfile_mode=off
just dependencies
```

测试使用真实本地 QUIC/HTTP/3 代理和 TCP 服务，覆盖 TLS 校验、2xx 就绪门槛、类型化拒绝、凭据更新、并发流与大数据传输、两侧半关闭、握手及 CONNECT 取消与超时、丢弃请求、端口释放、共享 runtime 存活、GOAWAY 和断线后不重放。
