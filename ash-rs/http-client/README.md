# `ash-http-client`

> 本 README 解释当前同步 HTTP transport 的真实实现与内部接口。Operation retry、SSE framing 和
> deadline 设计见 [`docs/ash-client.md`](../../docs/ash-client.md)。

`ash-http-client` 是 provider-neutral outbound HTTP substrate。它拥有 reusable backend、
proxy route、TLS trust/mTLS、redirect、transport timeout、connection pool、bounded unary/streaming
body 和 safe telemetry。上层通过 `HttpClient` 执行一个已经完整构造的 request，且每次只执行一次。

它还公开构造时冻结的 `OutboundNetworkSnapshot`，供独立
[`ash-websocket-client`](../websocket-client/README.md) 复用 proxy、TLS/mTLS、connect timeout 与 target filtering。
它不解释 provider JSON，不拥有 model operation retry，也不实现 SSE/NDJSON/WebSocket framing。

## 当前实现边界

```text
ash-api / auth / catalog / other HTTP consumers
                       │
             optional ash-client
             retry + framing
                       │ one raw attempt
                       ▼
              ash-http-client
              ├─ proxy selection
              ├─ TLS + mTLS
              ├─ redirects/timeouts
              ├─ connection reuse
              └─ bounded response
                       │
                 private ureq
```

Workspace 其他 crate 不应直接创建 `ureq::Agent` 或平行的 proxy/TLS policy。普通 unary HTTP
consumer 可以直接依赖本 crate；需要 operation retry 或 SSE framing 的调用再经过 `ash-client`。

## 公共契约

### 请求与执行

| Symbol | 职责 |
| --- | --- |
| `HttpClient` | `execute` 或 `execute_streaming` 一次；implementation 不得 retry |
| `UreqHttpClient` | fallible、reusable synchronous production client；没有 panic-based `Default` |
| `HttpMethod::{Get,Post}` | 当前支持的 method |
| `HttpRequest` | validated HTTP(S) URL、headers 与 raw body |
| `HttpResponse` | status、headers 与 bounded raw body |
| `HttpHeader` | name/value pair；`Debug` 永远隐藏 value |
| `HttpClientError` | invalid request/configuration 或 sanitized transport failure |

包括 3xx/4xx/5xx 在内的 HTTP 状态都是 `HttpResponse` 事实，不是传输错误。是否重试以及如何
解释状态，由上层操作或协议决定。

`execute_streaming` 必须在响应读取过程中交付 chunk。仅实现 `execute` 的 client 在发送前返回
`InvalidRequest`；默认实现不会读取完整响应后再把 body 当作流交付。

### 配置

| Symbol | 当前 contract |
| --- | --- |
| `HttpClientConfig` | immutable builder-style config snapshot |
| `ProxyPolicy` | `Direct`、构造时读取环境、explicit、explicit + bypass |
| `ProxyBypass` | `NO_PROXY` 风格 exact/suffix/IP/port/`*` rules |
| `RedirectPolicy` | 默认拒绝，或 bounded `Follow { max_hops }` |
| `Timeout` / `TransportTimeouts` | connect/read/write/overall 的 disabled/after policy |
| `ConnectionPoolPolicy` | total 与 per-host idle connection 上限 |
| `ResponseBodyLimit` | unary body hard limit，默认 10 MiB |
| `TlsPolicy` | system roots、system + custom DER、custom DER only |
| `ClientIdentityPolicy` | no identity 或 DER certificate chain + private key |
| `CertificateBundle` | non-empty DER certificate bundle，debug 只显示数量 |
| `ClientIdentity` | DER chain 与 zeroizing private key，debug redacted |
| `OutboundNetworkSnapshot` | HTTP/WebSocket 共用的 immutable proxy/TLS/timeout/target-policy snapshot |
| `OutboundProxyRoute` | 对一个 HTTP(S)/WS(S) target 的 direct/proxy 决策；proxy debug redacted |

`HttpClientConfig::default()` 当前使用环境 proxy、拒绝 redirect、30 秒 connect timeout、60 秒
overall timeout、system roots、无 client identity、100/1 idle pool，以及各自 10 MiB 的普通响应和
成功 streaming response limit。`with_response_body_limit` 仍限制 unary 与 streaming 非成功响应；
`with_streaming_response_body_limit` 独立限制成功流，避免大下载同时放大错误页缓冲上限。

环境 proxy 与 bypass 在 `UreqHttpClient::new` / `with_config` 时快照，不在每个 request 重新读取。
两者都返回 `Result`；proxy、自定义证书与 mTLS 静态材料在构造时校验。System roots 在第一次实际
HTTPS request（或 HTTPS proxy route）时惰性加载并缓存结果，因此拒绝 redirect 的纯 HTTP/loopback
不依赖 host certificate store；允许 redirect 的 HTTP route 会预备 TLS，因为目标可能升级到 HTTPS。
加载失败由该次需要 TLS 的 invocation path 处理。

### 遥测

`TelemetryHttpClient` 包装任意 `Arc<dyn HttpClient>`，向 `HttpClientTelemetry::record` 发出
`HttpClientTelemetryEvent`。事件只有：

- method；
- status class 或 transport failure；
- request/response body byte count；
- elapsed duration。

URL、header、certificate、request/response body 和 provider identity 不在 telemetry type 中。

## 内部接口地图

| Symbol | 可见性 | 当前职责 | 方向约束 |
| --- | --- | --- | --- |
| `UreqHttpClient::{http_direct_agent,http_proxy_agent}` | private fields | 不依赖 system roots 的 HTTP direct/proxied reusable pools | backend type 不进入 public API |
| `UreqHttpClient::{network,https_direct_agent,https_proxy_agent}` | private fields | 共用 policy snapshot，并在首次 HTTPS route 时惰性构造 reusable pool | 成功或失败都缓存 |
| `UreqHttpClient::agent_for` | private method | 消费 shared route 并选择/准备 agent | caller 不手选 route |
| `OutboundNetworkSnapshot::proxy_route` | public method | 对 HTTP(S)/WS(S) target 应用同一份 proxy/bypass snapshot | 不解释 provider |
| `OutboundNetworkSnapshot::connect_tls` | public method | 以 crate-owned stream 应用 TLS/mTLS 与 hostname validation | 不暴露 rustls stream/config |
| `resolve_proxy` | private | materialize proxy URL 与 bypass snapshot | `Direct` 不能受环境影响 |
| `proxy_url_from_environment` | private | 固定优先级读取 proxy env | 只在 client 构造时调用 |
| `build_agent` | private | 应用 proxy、redirect、timeouts、pool、TLS | 每个 request 不重新 build agent |
| `build_tls_config` | private | trust roots + optional client auth | 保持 hostname/chain validation |
| `system_root_store` | private | 加载 host system roots | failure 是 configuration error |
| `add_certificate_bundle` | private | 将 DER roots 加入 rustls store | 不记录 certificate bytes |
| `rule_matches` / `split_authority` | private | `NO_PROXY`-style match | port rule 必须 exact |
| `is_http_url` | private | request construction 的 scheme/authority guard | 非 HTTP(S) 在 backend 前拒绝 |
| `HttpStatusClass::from_status` | private | telemetry low-cardinality classification | 不暴露 exact URL/status label |

## 构造调用图

```text
UreqHttpClient::new() / with_config(config) → Result
├─ OutboundNetworkSnapshot::new(config)
│  ├─ resolve_proxy
│  │  ├─ proxy_url_from_environment [FromEnvironment]
│  │  └─ ProxyBypass::from_environment
│  └─ validate target-policy/proxy/redirect combination
├─ build_tls_config(SystemRoots::Skip)
├─ build HTTP agent(config, tls, None)
└─ build HTTP proxy agent(config, tls, proxy_url) [when proxy exists]

first HTTPS request / HTTPS proxy route
├─ OutboundNetworkSnapshot::rustls_client_config
│  ├─ build_tls_config(SystemRoots::Load)
│  ├─ add_certificate_bundle     [SystemPlus/CustomOnly]
│  └─ ClientIdentity::private_key [mTLS]
│  └─ system_root_store          [SystemRoots/SystemPlus]
└─ build and cache HTTPS direct/proxy agent

WebSocket secure route
└─ OutboundNetworkSnapshot::connect_tls
   └─ reuse cached rustls client config without exposing backend types
```

一份 client 对应一份不可变 config generation。配置、certificate 或 proxy 变化应创建新 client；
不要原地修改正在复用连接的 generation。

## 请求调用图

```text
HttpClient::execute(request)
└─ UreqHttpClient::execute
   ├─ agent_for
   │  └─ OutboundNetworkSnapshot::proxy_route
   │     └─ ProxyBypass::matches
   │     └─ rule_matches
   ├─ construct private ureq request + copy headers
   ├─ send request body exactly once
   ├─ retain HTTP error statuses as responses
   ├─ collect response status + headers
   ├─ read at most configured limit + 1 byte
   └─ reject overflow / return HttpResponse

TelemetryHttpClient::execute
├─ inner.execute
├─ classify safe outcome + byte counts
└─ HttpClientTelemetry::record
```

`ResponseBodyLimit::new` 拒绝 `usize::MAX`，因为 execute 需要额外一字节检测 overflow。提高 limit
不是 streaming 的替代方案。

## Proxy、TLS 与 secret 约束

Environment proxy priority 当前为：

```text
ALL_PROXY → all_proxy → HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy
```

`NO_PROXY`/`no_proxy` 支持 `*`、exact host/IP、domain suffix 和 optional port。Explicit proxy URL
的 `Debug` 输出为 `[REDACTED]`；invalid proxy error 不回显 URL 或 credential。

TLS 使用 rustls：

- `SystemRoots` 在首次 HTTPS route 加载 host roots；
- `SystemPlus` 在 system roots 上增加 DER CA；
- `CustomOnly` 只使用 supplied DER CA；
- optional mTLS key 接受 PKCS#1、PKCS#8 或 SEC1 DER；
- private key 存在 `Zeroizing<Vec<u8>>` 中；
- public config 没有关闭 hostname/certificate validation 的 escape hatch。

PEM/file loading、secret lookup 与 credential rotation 不属于本 crate；caller 在构造 config 前把材料
解析为 DER。

## 错误与安全语义

`HttpClientError` 只有：

- `InvalidRequest`：例如非 HTTP(S) URL；
- `InvalidConfiguration`：proxy/TLS/identity/limit 无效；
- `Transport`：backend send/read/body-limit failure。

Client construction 同样只返回这些 typed errors；本 crate 不提供会在系统证书或 proxy 初始化失败
时 panic 的 `Default` 实现。

当前 error taxonomy 不区分 DNS、connect、proxy、TLS 或 timeout phase。Backend error 被替换成
sanitized crate-owned message，避免 URL、proxy credential、certificate 或 payload 泄漏。

Redirect follow 直接使用 backend 的 bounded redirect policy。当前尚未实现 crate-owned 的
cross-origin sensitive-header stripping、scheme-downgrade rule 或 body replay classifier；不能在
上层文档中把这些未来要求写成已有保证。安全敏感调用默认应保持 `RedirectPolicy::Reject`。

## 方向偏差检查

- `ash-client` 或 provider crate 直接构造 `ureq::Agent`：proxy/TLS/pool ownership 分裂；
- `UreqHttpClient::execute` 出现 retry loop：operation replay authority 下沉；
- `HttpClientError` 包含 backend error/URL/header：redaction 边界被绕过；
- request path 调用 `build_agent` 或读环境变量：config snapshot 与 pool reuse 被破坏；
- Provider JSON/status semantics 进入本 crate：wire protocol ownership 下沉；
- 通过提高 `ResponseBodyLimit` 支持无限流：bounded unary contract 被绕过；
- telemetry 增加 URL、header value、body 或 exact provider/model：低敏感 contract 漂移；
- public API 暴露 `ureq`/`rustls` type：backend replaceability 消失；异步 TLS 只返回 crate-owned `OutboundTlsStream`。

修改 config field 时同步检查 `HttpClientConfig` builder/getter/default、`build_agent` 或
`build_tls_config`、debug redaction 与 tests。修改 request/response shape 时同步检查
`TelemetryHttpClient`、operation client adapter 与 fake transports。

## 测试

```text
just test ash-http-client
bazel test //ash-rs/http-client:http-client-unit-tests
```

测试使用本地 TCP 与 HTTPS 样例，不访问真实供应商。HTTPS 服务与证书由仅用于测试的
[`http-test-support`](../http-test-support/README.md) 提供；`ureq_client_tests.rs` 验证重定向、整体超时和响应截断，不依赖业务协议。覆盖：

- header/proxy/certificate/private-key debug redaction；
- invalid URL/config；
- one-attempt、non-2xx preservation 与 redirect rejection；
- HTTPS 跨来源重定向不发送认证头、响应未完成时触发整体超时、截断响应报脱敏传输错误；
- bypass domain/IP/port matching 和 direct route；
- 纯 HTTP 不加载 system roots，HTTPS 惰性加载并缓存失败；
- custom trust/mTLS invalid material；
- response body hard limit 与 `limit + 1` headroom；
- telemetry 只发出 safe facts。

## 当前限制与潜在演进

当前实现是 synchronous、one-attempt HTTP；unary response fully buffered，成功 streaming response
按 chunk 向 caller-owned sink 施加 backpressure。它使用 bounded transport timeout，但不直接接收
caller cancellation token；上层 `ash-client` 可以在取消后停止等待并丢弃
迟到 response，不能强制关闭已经进入 `ureq` 的 socket attempt。WebSocket connection backend 已拆到
`ash-websocket-client`；async HTTP port、per-phase diagnostics、custom redirect security policy 和
config-generation rollover manager 仍未实现。

这些能力可以演进，但顺序应保持：先定义 provider-neutral typed contract 与 failure/redaction
invariant，再实现 private backend；不要先暴露 backend-specific future/stream/socket types。Retry、
SSE/NDJSON framing 与 provider event decoding仍分别留在 `ash-client` 和 `ash-api`。
