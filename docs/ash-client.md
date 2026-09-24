# 模型调用操作层

> - 物理位置：`ash-rs/ash-client/`
> - Rust crate：`ash_client`
> - 层次：Ash API operation client、retry 与 stream framing
> - 当前状态：typed unary request/response、安全 retry loop、增量 SSE framer 和 telemetry wrapper
>   已实现；底层 HTTP port 与 production backend 已在 `ash-http-client`
> - 底层网络：[`ash-http-client` README](../ash-rs/http-client/README.md)
> - API 协议层：[`ash-api.md`](ash-api.md)
> - Provider runtime：[`model-provider.md`](model-provider.md)

> 标准依据：
> [WHATWG Server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html)、
> [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)、
> [W3C Trace Context](https://www.w3.org/TR/trace-context/) 和
> [OpenTelemetry HTTP semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/)。

## 快速理解

`ash-client` 是 Provider-neutral 的 API operation client。它把调用方已经构造完成的 request
通过共享 `ash-http-client` 执行，并统一处理：

- operation retry safety、classifier、attempt loop、backoff、jitter 和 `Retry-After`；
- 包含全部 attempt/backoff 的 overall operation deadline；
- SSE 与 NDJSON framing；
- wire/frame activity 与 idle policy 的组合；
- framed stream backpressure；
- operation、attempt 和 stream telemetry。

它不创建 HTTP backend，也不拥有 proxy、TLS、证书、redirect、连接池或 transport logging。
这些能力统一属于 [`ash-http-client`](../ash-rs/http-client/README.md)，本文件不重复其规则。

它也不知道 OpenAI、ChatGPT、Codex、Anthropic 或任何 `ModelRequest`。Provider JSON、event 和
error 语义属于 `ash-api`。

```text
model-provider
  ├── resolve target/auth/retry safety
  ├──▶ ash-api encode
  └──▶ ash-client operation
          ├── retry/framing/operation telemetry
          └──▶ ash-http-client
                  └── proxy/TLS/redirect/timeout/pool/backend

ash-client 负责“怎样执行并组织一个 Ash API operation”
ash-api    负责“这个 API 的 bytes/event 表示什么”
```

当前实现仍直接导出 `HttpHeader`、`ClientRequest`/`ClientResponse`、`HttpClient` 和
`UreqHttpClient`。这是新底层 crate 落地前的迁移状态，不是长期 ownership；现有
`RetryPolicy`、SSE framer 和 operation telemetry 是保留在 `ash-client` 的能力。

| 调用中发生的事情 | 本层是否负责 | 说明 |
| --- | --- | --- |
| 按明确策略重试一次操作 | ✅ | 包含退避、抖动和总截止时间 |
| 把字节流切成 SSE 或 NDJSON 记录 | ✅ | 不解释记录中的供应商语义 |
| 选择模型、服务地址或凭据 | ❌ | 由模型调用系统决定 |
| 解释 OpenAI 或 Anthropic 事件 | ❌ | 由模型 API 协议层负责 |
| 处理代理、TLS 和连接池 | ❌ | 由网络层负责 |

## 2. 拥有与不拥有

### 2.1 拥有

- operation request context；
- typed replay safety 和 retry policy；
- retry classifier、attempt state machine、backoff、jitter 与 `Retry-After`；
- operation overall deadline 和 attempt budget 分配；
- WHATWG SSE framing；
- NDJSON record framing；
- UTF-8、CRLF/LF、chunk boundary 和 frame/record hard limit；
- byte/frame activity timestamp；
- framed stream bounded channel 和 backpressure；
- attempt、retry、framing 与 stream operation telemetry；
- transport facts 到 operation error 的安全映射。

### 2.2 不拥有

- HTTP backend、DNS/TCP、proxy、TLS、证书、redirect 或连接池；
- transport attempt timeout、raw response body limit 或 HTTP redaction；
- Provider registry、Provider ID 或模型选择；
- base URL 默认值和 credential lookup；
- OAuth login、token persistence、refresh 或 revoke；
- API relative endpoint path；
- Provider request/response JSON；
- `data:` JSON 的 schema；
- Anthropic `ping`、OpenAI terminal event 或 `[DONE]` 的语义；
- prompt cache 参数；
- tool/reasoning/usage/stop reason 归一化；
- 是否 fallback model/provider；
- catalog refresh/merge；
- Agent Turn、Thread 或 durable state。

## 3. 与上下层的接口

`ash-api` 构造 protocol request 并消费 operation result；`ash-client` 只包装 operation policy：

```text
ash-api::endpoint + ash-api::requests
        │ encoded request + response decoder
        ▼
ash-client
        │ HttpRequest
        ▼
ash-http-client
        │ HttpResponse | raw byte stream
        ▼
ash-client retry/framing
        │ response facts | SseFrame | NdjsonRecord
        ▼
ash-api decoder
        │
        ▼
canonical ModelResponse | ModelStreamEvent
```

目标 public shape 可以是：

```rust
pub struct ClientOperation {
    pub request: ash_http_client::HttpRequest,
    pub retry: RetryPolicy,
    pub deadline: OperationDeadline,
    pub telemetry: OperationTelemetry,
}

pub struct ClientOperationResponse {
    pub response: ash_http_client::HttpResponse,
    pub attempts: AttemptSummary,
    pub timing: OperationTiming,
}
```

示例名称不要求逐字实现，但 `ash-client` 不复制 URL/header/body、proxy、TLS 或 pool 类型，也不能
直接返回 `serde_json::Value`。JSON decoding 是 API 协议职责。

普通 OAuth exchange、catalog discovery、Plugin/MCP request 等不需要 operation retry/framing 的
调用方可以直接使用 `ash-http-client`，不强制经过本 crate。

## 4. 重试

### 4.1 机制和策略分开

`ash-client` 拥有 retry 机制，但不猜测 operation 是否可以重放：

```text
caller/API/runtime
  提供 RetryPolicy + RetryClassifier
        ↓
ash-client
  分配 attempt budget
        ↓
ash-http-client execute one attempt
        ↓
ash-client classify → wait → next attempt
```

建议 typed safety：

```rust
pub enum RetrySafety {
    Never,
    Idempotent,
    ExplicitIdempotencyKey,
}

pub struct RetryPolicy {
    pub safety: RetrySafety,
    pub max_attempts: NonZeroU8,
    pub backoff: BackoffPolicy,
    pub retry_after: RetryAfterPolicy,
}
```

禁止使用 `retry: bool`。调用点必须清楚表达为什么允许重放。

认证恢复不属于普通 retry loop。收到 `401 Unauthorized` 时，client 返回 response facts；
`ash-model-provider` 只可按 direct-provider credential 的正式语义执行一次受限 rebuild/refresh。
client 不读取 `ash-secrets`、不持有 refresh token，也不根据 401 自行重试。ChatGPT 与 Kimi 订阅凭据刷新分别归 `ash-chatgpt` 与 `ash-kimi`；`ash-client` 只执行 adapter 已解析的单次 operation。

`ash-client` 不提供带登录状态的 `OAuthClient` facade。未来一个 officially supported OAuth adapter
需要普通 HTTP execution 时，它可使用 `ash-http-client`，但其生命周期属于 `ash-login` 和 exact
provider adapter，而不是 operation retry/framing layer。

RFC 9110 指出，client 不应自动重试非幂等请求，除非它知道请求语义实际幂等或能确定原请求未被
应用。因此：

- inference POST 默认 `Never`；
- catalog GET 可以由其调用方选择 `Idempotent` operation policy；
- 显式 idempotency key 只有在 Provider 文档确认语义后才能启用；
- client 不根据“未收到 response byte”猜测 POST 安全；
- 一次 auth recovery 不能嵌套出第二套无限 retry；
- retry budget 同时受 max attempts 和 operation deadline 限制。

### 4.2 尝试分类器

Classifier 可以使用：

- `ash-http-client` 返回的 transport failure phase；
- 是否已发送完整 request body；
- 是否已收到 response headers/body/frame；
- HTTP status；
- `Retry-After`；
- 调用方从 bounded error body 得到的 typed classification；
- 是否已经向消费者发布 semantic output。

Client 不解析 Provider error JSON。需要 body-aware classification 时，`ash-api` 提供受限的
classifier hook；hook 只能返回 retry decision 和低敏感 evidence，不把 raw body 写入 telemetry。

### 4.3 退避

- exponential backoff 必须 bounded；
- jitter 必须可测试并可注入；
- `Retry-After` 同时支持秒数与 HTTP 日期，在响应头到达时计算截止时间；读取响应体和传递错误耗掉的时间不再重复等待；解析失败时使用本地 policy，不 panic；
- 超出 overall operation deadline 时不启动新 attempt；
- cancellation 立即中止 backoff 并传递给活跃 transport attempt；
- 测试使用 fake clock，不真实 sleep。

## 5. SSE 与 NDJSON

### 5.1 SSE 分帧

`ash-client::stream::sse` 消费 `ash-http-client` 的 raw byte stream，并按 WHATWG event stream
format 处理：

- UTF-8；
- CRLF、CR 和 LF；
- `event`、`data`、`id`、`retry` field；
- 多行 `data` 拼接；
- comment line；
- 空行 dispatch；
- 跨任意 byte chunk boundary；
- EOF 和尾部不完整 event；
- frame/buffer hard limit。

SSE 的 `retry:` field 可以作为 frame evidence 保留，但不能自动触发 inference stream 重连。
EventSource 的自动重连语义不能直接套用到可能计费、可能已经产生副作用的模型 POST；只有具体 API
文档定义 resumable stream，并由 runtime 显式选择策略时，client 才能重新连接。

输出是 Provider-neutral frame：

```rust
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

pub enum SseFrame {
    Event(SseEvent),
    Comment,
}
```

具体 API decoder 决定：

- `event: ping` 是否只是 liveness；
- `data: [DONE]` 是否终止；
- `response.output_text.delta` 如何映射；
- 未知 event 是否可忽略；
- 何时形成 canonical completed。

### 5.2 NDJSON 分帧

NDJSON framer 只输出 bounded JSON record bytes，不解析 Ollama `done` 或 `error`：

```rust
pub struct NdjsonRecord {
    pub bytes: BoundedBytes,
}
```

空行、尾部不完整 JSON、超限 record 和 invalid UTF-8 形成 client framing error；record 中字段的
语义错误由 `ash-api` 返回。

### 5.3 活性

`ash-http-client` 维护 raw wire activity 和 transport idle timeout；`ash-client` 维护：

- `last_frame_activity`；
- first frame time；
- operation 是否已经发布 frame。

Client 不维护“模型是否有语义进展”。Anthropic `ping`、comment heartbeat 和长 reasoning 都可能
维持连接但不产生 text。`last_semantic_progress` 由 API/runtime 在解码后维护。

## 6. 操作 deadline、取消与背压

Deadline 分层：

| Owner | Deadline |
| --- | --- |
| `ash-http-client` | DNS/connect/TLS/first-byte/idle/single-attempt |
| `ash-client` | 包含 retry/backoff 的 overall operation |
| runtime | Turn、auth recovery 或产品流程 deadline |

Operation client 在每次 attempt 前计算 remaining budget，并把 bounded attempt deadline 交给
`ash-http-client`。任一上层 deadline 结束后不能启动新 attempt。

unary 与 streaming 路径的 cancellation 都从 runtime 贯穿 operation preflight、活跃 attempt 的
本地等待和 retry timer。streaming attempt 使用有界 channel 把 raw chunks 交给调用线程，取消或
consumer failure 会断开接收端；已经发布任意 chunk 的 attempt 发生 transport failure 后绝不重放，
避免重复 delta。取消返回独立 `ClientError::Cancelled`，不会包装成 retryable network failure，也
不会启动下一次 attempt。由于 `ash-http-client` 仍使用同步 `ureq`，已经进入 socket read 的 worker
不能被 token 强制关闭；它由 bounded transport timeout 收束，迟到的 chunk 或 response 不再被接受。

当前生产 wire streaming 已覆盖 OpenAI Responses、OpenAI-compatible Chat Completions 与 Anthropic
Messages SSE。三种 endpoint 都使用原生 wire stream；其他 SSE profile、NDJSON 与 WebSocket 仍需按
真实协议逐项接入。

Raw stream 的 socket/buffer backpressure 属于 `ash-http-client`；SSE/NDJSON framed channel 的
backpressure 属于 `ash-client`。Client 不能合并或丢弃它不理解的 Provider payload。

## 7. 遥测

Telemetry 分为两层：

| `ash-http-client` | `ash-client` |
| --- | --- |
| DNS/connect/TLS/HTTP timing | operation duration |
| proxy/redirect/pool evidence | attempt count |
| request/response byte count | retry reason/backoff |
| status class/transport error | first frame/frame count |
| transport timeout/cancel | framing/operation outcome |
| HTTP redaction policy | low-cardinality API metadata |

业务调用方只提供低基数 operation metadata，例如：

```text
operation.kind = model_inference | model_catalog
api.profile = openai_responses | anthropic_messages
provider.kind = openai | anthropic | custom
```

禁止把 exact model ID、URL、header value、credential、prompt、tool arguments/output、reasoning、
raw response body 或 stream payload 放进 operation log/label。底层完整规则以
[`ash-http-client` README](../ash-rs/http-client/README.md#telemetry) 为准。

## 8. 错误

目标 operation error 只增加本层语义：

```rust
pub enum ClientError {
    Transport(ash_http_client::HttpClientError),
    OperationDeadlineExceeded,
    Cancelled,
    Framing(StreamFramingError),
    RetryExhausted(RetryExhaustedError),
}
```

Provider error 不是 `ClientError`，由 `ash-api` 解码。Error 可以包含 attempt、phase 和 bounded
timing evidence，但不能复制 transport secret 或 raw body。

## 9. 目标目录

```text
ash-rs/ash-client/
├── BUILD.bazel
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── operation/
    │   ├── mod.rs
    │   ├── request.rs
    │   ├── response.rs
    │   ├── deadline.rs
    │   └── operation_tests.rs
    ├── retry/
    │   ├── mod.rs
    │   ├── policy.rs
    │   ├── classifier.rs
    │   ├── backoff.rs
    │   └── retry_tests.rs
    ├── stream/
    │   ├── mod.rs
    │   ├── sse.rs
    │   ├── ndjson.rs
    │   ├── activity.rs
    │   ├── limits.rs
    │   ├── sse_tests.rs
    │   └── ndjson_tests.rs
    ├── telemetry/
    │   ├── mod.rs
    │   ├── operation.rs
    │   ├── attempt.rs
    │   ├── stream.rs
    │   └── telemetry_tests.rs
    └── error.rs
```

Backend、proxy、TLS、redirect、raw HTTP types 和 pool implementation 都不出现在该目录；它们属于
`ash-http-client`。

## 10. 公共接口

长期 public API 只导出：

- `AshClient` 或等价 operation executor；
- `ClientOperation` / `ClientOperationResponse`；
- `SseFrame` / `SseEvent`；
- `NdjsonRecord`；
- `RetryPolicy` / `RetrySafety`；
- operation deadline/cancellation value；
- `ClientError` 和安全 attempt evidence；
- 必要的 operation telemetry context。

HTTP request/response/client/config/error 来自 `ash-http-client`，不在本 crate 建立平行 value。
新增 public trait 必须说明实现者对 retry、operation deadline、framing、redaction 和 backpressure
的责任。

## 11. 测试

- retry max attempts、jitter、`Retry-After` 和 overall budget；
- non-idempotent request 默认不 replay；
- cancellation during backoff/attempt/stream；
- transport failure phase 到 classifier 的映射；
- 任意 byte fragmentation 与 UTF-8 split；
- SSE multiline data、comment、CRLF/LF 和 EOF；
- NDJSON blank line、oversized/incomplete record；
- framed channel backpressure；
- operation telemetry 低基数和 secret negative tests；
- fake clock/fake `ash-http-client`，不访问真实 Provider。

Proxy、TLS、redirect、HTTP timeout 和 pool tests 只属于 `ash-http-client`，不在本 crate 重复。

## 12. 迁移顺序

1. 建立 `ash-http-client` 的 raw HTTP value、client/config/error port。
2. 将 `HttpHeader`、raw request/response、`HttpClient` 和 `UreqHttpClient` 从本 crate 迁出。
3. 本 crate 改为依赖 `ash-http-client` 并保留现有 unary behavior。
4. 把 operation retry loop 改为执行一个或多个 bounded transport attempts。
5. 增加 live raw stream execution 后接入现有 SSE framer。
6. 增加 NDJSON framer、operation deadline 与 framed backpressure。
7. 拆分 transport telemetry 与 operation telemetry。
8. 更新 `ash-api` 和 `model-provider`，删除旧 raw transport compatibility surface。

当前处于开发阶段，迁移时直接更新全部调用方，不建立旧 `UreqHttpClient` public API 的长期兼容层。

## 13. 固定决策

1. `ash-client` 是 API operation client，不是 workspace HTTP backend。
2. `ash-http-client` 独占 proxy、TLS、redirect、attempt timeout、pool 和 transport redaction。
3. `ash-client` 拥有 retry 机制，调用方提供 typed retry safety/policy。
4. `ash-client` 拥有 SSE/NDJSON framing，不解释 Provider event。
5. Inference POST 默认不透明 retry。
6. Wire activity、frame activity 与 semantic progress 分开。
7. Client 不依赖 Provider registry、config、Core 或 App Server。
