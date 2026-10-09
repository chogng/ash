# `ash-http-client`

> 本 README 解释当前同步 HTTP transport 的真实实现与内部接口。Operation retry、SSE framing 和
> deadline 设计见 [`docs/ash-client.md`](../../docs/ash-client.md)。

`ash-http-client` 是 provider-neutral outbound HTTP substrate。它拥有 reusable backend、
proxy route、TLS trust/mTLS、redirect、transport timeout、connection pool、bounded unary/streaming
body 和 safe telemetry。上层通过 `HttpClient` 执行一个已经完整构造的 request，且每次只执行一次。

它还公开构造时冻结的 `OutboundNetworkSnapshot`，供独立
[`ash-websocket-client`](../websocket-client/README.md) 复用 proxy、TLS/mTLS、connect timeout 与 target filtering。
`ReqwestHttpClient::sdk_client_builder` 为必须使用 reqwest 的 SDK 显式选择 ring，并保留 reqwest 原有的系统证书验证器；RMCP 使用此入口，SDK 继续拥有 HTTP framing 与其客户端设置。纯 HTTP 不提前创建系统证书验证器。普通 Ash 调用仍通过 `HttpClient`，不接触后端 TLS 类型。

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
                 private reqwest / ureq
```

Workspace 其他 crate 不应直接创建 `ureq::Agent` 或平行的 proxy/TLS policy。普通 unary HTTP
consumer 可以直接依赖本 crate；需要 operation retry 或 SSE framing 的调用再经过 `ash-client`。

## 公共契约

### 请求与执行

| Symbol                                    | 职责                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `HttpClient`                              | `execute` 或 `execute_streaming` 一次；implementation 不得 retry                 |
| `ReqwestHttpClient`                       | 生产 HTTP 客户端，在异步 I/O runtime 执行并支持取消；同步 trait 的调用者等待结果 |
| `UreqHttpClient`                          | reusable synchronous client；没有 panic-based `Default`                          |
| `HttpMethod::{Get,Post,Patch,Put,Delete}` | 当前支持的 method                                                                |
| `HttpRequest`                             | validated HTTP(S) URL、headers 与 raw body                                       |
| `HttpResponse`                            | status、headers 与 bounded raw body                                              |
| `HttpHeader`                              | name/value pair；`Debug` 永远隐藏 value                                          |
| `HttpClientError`                         | invalid request/configuration 或 sanitized transport failure                     |

包括 3xx/4xx/5xx 在内的 HTTP 状态都是 `HttpResponse` 事实，不是传输错误。是否重试以及如何
解释状态，由上层操作或协议决定。`HttpResponse::retry_after_deadline()` 将秒数或 HTTP 日期格式
的 `Retry-After` 在响应头到达时换算成单调时钟截止时间；上层按剩余时间等待。

`execute_streaming` 必须在响应读取过程中交付 chunk。仅实现 `execute` 的 client 在发送前返回
`InvalidRequest`；默认实现不会读取完整响应后再把 body 当作流交付。

### 配置

| Symbol                          | 当前 contract                                                            |
| ------------------------------- | ------------------------------------------------------------------------ |
| `HttpClientConfig`              | immutable builder-style config snapshot                                  |
| `ProxyPolicy`                   | `Direct`、构造时读取环境、explicit、explicit + bypass                    |
| `ProxyBypass`                   | `NO_PROXY` 风格 exact/suffix/IP/port/`*` rules                           |
| `RedirectPolicy`                | 默认拒绝，或 bounded `Follow { max_hops }`                               |
| `Timeout` / `TransportTimeouts` | connect/read/write/overall 的 disabled/after policy                      |
| `ConnectionPoolPolicy`          | total 与 per-host idle connection 上限                                   |
| `ResponseBodyLimit`             | unary body hard limit，默认 10 MiB                                       |
| `TlsPolicy`                     | system roots、system + custom DER、custom DER only                       |
| `ClientIdentityPolicy`          | no identity 或 DER certificate chain + private key                       |
| `CertificateBundle`             | non-empty DER certificate bundle，debug 只显示数量                       |
| `ClientIdentity`                | DER chain 与 zeroizing private key，debug redacted                       |
| `OutboundNetworkSnapshot`       | HTTP/WebSocket 共用的 immutable proxy/TLS/timeout/target-policy snapshot |
| `OutboundProxyRoute`            | 对一个 HTTP(S)/WS(S) target 的 direct/proxy 决策；proxy debug redacted   |

`HttpClientConfig::default()` 当前使用环境 proxy、拒绝 redirect、30 秒 connect timeout、60 秒
overall timeout、system roots、无 client identity、100/1 idle pool，以及各自 10 MiB 的普通响应和
成功 streaming response limit。`with_response_body_limit` 仍限制 unary 与 streaming 非成功响应；
`with_streaming_response_body_limit` 独立限制成功流，避免大下载同时放大错误页缓冲上限。

环境 proxy 与 bypass 在 `UreqHttpClient::new` / `with_config` 时快照，不在每个 request 重新读取。
两者都返回 `Result`；proxy、自定义证书与 mTLS 静态材料在构造时校验。系统证书验证器在第一次实际
HTTPS request（或 HTTPS proxy route）时惰性创建并缓存结果，因此拒绝 redirect 的纯 HTTP/loopback
不依赖 host certificate store；允许 redirect 的 HTTP route 会预备 TLS，因为目标可能升级到 HTTPS。
验证器构造失败由该次需要 TLS 的 invocation path 处理。桌面端使用操作系统的信任判断，不枚举或导出全部系统证书。

### 遥测

`TelemetryHttpClient` 包装任意 `Arc<dyn HttpClient>`，在调用前通过 `HttpClientTelemetry::start`
创建同步作用域，在调用结束时向 `HttpClientTelemetrySpan::finish` 提交 `HttpClientTelemetryEvent`。
作用域覆盖实际调用，允许遥测实现建立父子 span；事件只有：

- method；
- status class 或 transport failure；
- request/response body byte count；
- elapsed duration。

URL、header、certificate、request/response body 和 provider identity 不在 telemetry type 中。

## 内部接口地图

| Symbol                                                           | 可见性         | 当前职责                                                            | 方向约束                                                              |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `UreqHttpClient::{http_direct_agent,http_proxy_agent}`           | private fields | 不依赖 system roots 的 HTTP direct/proxied reusable pools           | backend type 不进入 public API                                        |
| `UreqHttpClient::{network,https_direct_agent,https_proxy_agent}` | private fields | 共用 policy snapshot，并在首次 HTTPS route 时惰性构造 reusable pool | 成功或失败都缓存                                                      |
| `UreqHttpClient::agent_for`                                      | private method | 消费 shared route 并选择/准备 agent                                 | caller 不手选 route                                                   |
| `OutboundNetworkSnapshot::proxy_route`                           | public method  | 对 HTTP(S)/WS(S) target 应用同一份 proxy/bypass snapshot            | 不解释 provider                                                       |
| `OutboundNetworkSnapshot::connect_tls`                           | public method  | 以 crate-owned stream 应用 TLS/mTLS 与 hostname validation          | 不暴露 rustls stream/config                                           |
| `resolve_proxy`                                                  | private        | materialize proxy URL 与 bypass snapshot                            | `Direct` 不能受环境影响                                               |
| `proxy_url_from_environment`                                     | private        | 固定优先级读取 proxy env                                            | 只在 client 构造时调用                                                |
| `build_agent`                                                    | private        | 应用 proxy、redirect、timeouts、pool、TLS                           | 每个 request 不重新 build agent                                       |
| `build_tls_config`                                               | private        | trust roots + optional client auth                                  | 保持 hostname/chain validation                                        |
| `system_certificate_verifier`                                    | private        | 系统信任验证器与额外 CA                                             | 桌面端委托 OS 校验，构造失败是 `Connection(CertificateConfiguration)` |
| `add_certificate_bundle`                                         | private        | 将 DER roots 加入 rustls store                                      | 不记录 certificate bytes                                              |
| `rule_matches` / `split_authority`                               | private        | `NO_PROXY`-style match                                              | port rule 必须 exact                                                  |
| `is_http_url`                                                    | private        | request construction 的 scheme/authority guard                      | 非 HTTP(S) 在 backend 前拒绝                                          |
| `HttpStatusClass::from_status`                                   | private        | telemetry low-cardinality classification                            | 不暴露 exact URL/status label                                         |

## 构造调用图

```text
UreqHttpClient::new() / with_config(config) → Result
├─ OutboundNetworkSnapshot::new(config)
│  ├─ resolve_proxy
│  │  ├─ proxy_url_from_environment [FromEnvironment]
│  │  └─ ProxyBypass::from_environment
│  └─ validate target-policy/proxy/redirect combination
├─ build_tls_config(SystemTrust::Skip)
├─ build HTTP agent(config, tls, None)
└─ build HTTP proxy agent(config, tls, proxy_url) [when proxy exists]

first HTTPS request / HTTPS proxy route
├─ OutboundNetworkSnapshot::rustls_client_config
│  ├─ build_tls_config(SystemTrust::Use)
│  ├─ add_certificate_bundle     [SystemPlus/CustomOnly]
│  └─ ClientIdentity::private_key [mTLS]
│  └─ system_certificate_verifier [SystemRoots/SystemPlus]
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
└─ ReqwestHttpClient::dispatch
   ├─ cancellable async attempt + bounded result channel
   ├─ acquire target network permit
   ├─ client_for: select a cached pool for this route and HTTP mode
   │  └─ OutboundNetworkSnapshot::proxy_route
   │     └─ ProxyBypass::matches
   │     └─ rule_matches
   ├─ construct private reqwest request + copy headers
   ├─ send request body exactly once
   ├─ follow allowed redirects, rechecking route/permission and removing discarded headers
   ├─ retain HTTP error statuses as responses
   ├─ collect response status + headers
   ├─ stop when received body bytes exceed the configured limit
   └─ reject overflow / return HttpResponse

TelemetryHttpClient::execute
├─ HttpClientTelemetry::start
├─ inner.execute
├─ classify safe outcome + byte counts
└─ HttpClientTelemetrySpan::finish
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

- `SystemRoots` 在首次 HTTPS route 创建系统证书验证器；
- `SystemPlus` 在系统信任规则上增加 DER CA；
- `CustomOnly` 只使用 supplied DER CA；
- optional mTLS key 接受 PKCS#1、PKCS#8 或 SEC1 DER；
- private key 存在 `Zeroizing<Vec<u8>>` 中；
- public config 没有关闭 hostname/certificate validation 的 escape hatch。

PEM/file loading、secret lookup 与 credential rotation 不属于本 crate；caller 在构造 config 前把材料
解析为 DER。

## 错误与安全语义

`HttpClientError` 提供：

- `InvalidRequest`：例如非 HTTP(S) URL；
- `InvalidConfiguration`：proxy/TLS/identity/limit 无效；
- `Connection(HttpConnectionFailure)`：DNS、proxy、TLS、system certificate verifier 初始化、connect 或 timeout 阶段；
- `ResponseTooLarge` / `RedirectLimitExceeded`：响应体或重定向次数超过配置上限，操作层不重试；
- `Transport`：其他 backend send/read failure。

Client construction 同样只返回这些 typed errors；本 crate 不提供会在系统证书或 proxy 初始化失败
时 panic 的 `Default` 实现。

`ReqwestHttpClient` 从 resolver、rustls 和 reqwest 的错误类型识别连接阶段，不匹配平台错误文本；整体截止时间也返回 typed timeout。`UreqHttpClient` 的传输失败仍使用 `Transport`，系统证书验证器构造失败由共享快照返回 `Connection(CertificateConfiguration)`。Backend error 被替换成固定的 crate-owned message，避免 URL、proxy credential、certificate 或 payload 泄漏。App Server 网络诊断使用生产 `ReqwestHttpClient` 的这些分类。

两种 HTTP transport 都逐跳处理 bounded redirects，重新选择目标路由并检查网络权限。
`HttpRequest::without_redirects()` 优先于 client 的 `RedirectPolicy::Follow`；普通和流式入口
都返回原始 3xx 与其缓冲响应体，不联系重定向目标。凭据绑定由上层在构造请求时设置，不能
仅靠猜测认证 header 名称来保护自定义凭据。允许跳转时，后续请求移除 Authorization、Cookie
和 Proxy-Authorization，代理路由仍按新目标重新选择；丢弃 body 时同时移除 Content-Length、
Content-Type、Content-Encoding 和 Transfer-Encoding，并按现有 method 规则避免重放写入 body；
当前没有禁止 HTTPS 降级的规则。

## 方向偏差检查

- `ash-client` 或 provider crate 直接构造 `ureq::Agent`：proxy/TLS/pool ownership 分裂；
- `UreqHttpClient::execute` 出现 retry loop：operation replay authority 下沉；
- `HttpClientError` 包含 backend error/URL/header：redaction 边界被绕过；
- request path 调用 `build_agent` 或读环境变量：config snapshot 与 pool reuse 被破坏；
- Provider JSON/status semantics 进入本 crate：wire protocol ownership 下沉；
- 通过提高 `ResponseBodyLimit` 支持无限流：bounded unary contract 被绕过；
- telemetry 增加 URL、header value、body 或 exact provider/model：低敏感 contract 漂移；
- 通用 HTTP API 暴露 `ureq`/`rustls` type：backend replaceability 消失；异步 TLS 只返回 crate-owned `OutboundTlsStream`。SDK 的 reqwest builder 适配限定在 `sdk_client_builder`。

修改 config field 时同步检查 `HttpClientConfig` builder/getter/default、`build_agent` 或
`build_tls_config`、debug redaction 与 tests。修改 request/response shape 时同步检查
`TelemetryHttpClient`、operation client adapter 与 fake transports。

## 测试

```text
just test ash-http-client
bazel test //crates/http-client:http-client-unit-tests
```

测试使用本地 TCP 与 HTTPS 样例，不访问真实供应商。HTTPS 服务与证书由仅用于测试的
[`http-test-support`](../http-test-support/README.md) 提供；`ureq_client_tests.rs` 验证重定向、整体超时和响应截断，不依赖业务协议。覆盖：

- header/proxy/certificate/private-key debug redaction；
- invalid URL/config；
- one-attempt、non-2xx preservation 与 redirect rejection；
- 两种 transport 的普通与流式入口均遵守请求级 redirect rejection，且未受限制的请求仍能跳转；
- 两种 transport 均覆盖 direct/proxy 双向切换，跳转不转发 proxy credential；POST 转 GET 的普通与流式入口同时丢弃 body 和原 body headers；
- HTTPS 跨来源重定向不发送认证头、响应未完成时触发整体超时、截断响应报脱敏传输错误；
- bypass domain/IP/port matching 和 direct route；
- 纯 HTTP 不创建系统证书验证器，HTTPS 惰性创建并缓存失败；
- 系统信任接受额外 CA，同时拒绝证书域名不匹配；
- custom trust/mTLS invalid material；
- response body hard limit 与 `limit + 1` headroom；
- telemetry 只发出 safe facts；
- reqwest 的 DNS、直连、proxy、TLS 和整体超时分类不含地址或凭据。

`tests/fixtures/system-trust-*.der` 是独立的 P-256/SHA-256 测试 CA 与服务端证书，不含私钥。
服务端证书覆盖 `localhost`，有效期为 2026-01-01 至 2027-01-01；系统信任测试固定在
2026-10-02 校验，遵守操作系统的证书有效期限制，也不随测试运行日期过期。不修改系统信任。

## 当前限制与潜在演进

`HttpClient` 使用 synchronous、one-attempt 契约；unary response fully buffered，成功 streaming response 按 chunk 向 caller-owned sink 施加 backpressure。生产 `ReqwestHttpClient` 在异步 I/O runtime 执行，并在取消或网络权限撤销时丢弃进行中的 future；共享 trait 接收 caller cancellation token。`UreqHttpClient` 保留同步 socket 实现，取消不能强制关闭已经进入它的 socket attempt。WebSocket connection backend 已拆到 `ash-websocket-client`。HTTP 连接错误已有阶段分类；诊断不证明模型操作或 SSE framing 成功。共享网络快照上的 `HttpCompatibilityMode` 为后续 Reqwest 请求选择独立连接池：`Http2` 通过 ALPN 协商 HTTP/2 或 HTTP/1.1，`Http1` 仅使用 HTTP/1.1。切换不打断已开始的请求。此设置不改变 Ureq、WebSocket 或 SDK 自有传输；其他 config-generation rollover manager 仍未实现。

这些能力可以演进，但顺序应保持：先定义 provider-neutral typed contract 与 failure/redaction
invariant，再实现 private backend；不要先暴露 backend-specific future/stream/socket types。Retry、
SSE/NDJSON framing 与 provider event decoding仍分别留在 `ash-client` 和 `ash-api`。
