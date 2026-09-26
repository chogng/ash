# 模型 API 协议

> - 物理位置：`ash-rs/ash-api/`
> - Rust crate：`ash_api`
> - 层次：模型 API 协议层
> - 当前状态：OpenAI Responses、OpenAI-compatible Chat Completions 与 Anthropic Messages 已具备
>   unary codec、原生 HTTP/SSE invocation、canonical delta 与 terminal response assembly；独立
>   Responses WebSocket 与公共 Realtime GA 已有协议会话和显式 runtime 入口
> - Crate codec 与 decoder 实现：[`ash-rs/ash-api/README.md`](../ash-rs/ash-api/README.md)
> - Canonical contract：[`protocol.md`](protocol.md#6-provider-independent-model-contract)
> - Provider runtime：[`model-provider.md`](model-provider.md)
> - Operation client：[`ash-client.md`](ash-client.md)
> - 底层网络：[`ash-http-client` README](../ash-rs/http-client/README.md)
> - WebSocket transport：[`ash-websocket-client` README](../ash-rs/websocket-client/README.md)
> - Provider credential：[`model-provider.md`](model-provider.md#6-供应商凭据边界)
> - Secret persistence：[`secrets.md`](secrets.md)
> - Model catalog control plane：[`models-manager.md`](models-manager.md)
> - Subscription runtime adapter：[`subscriptions.md`](subscriptions.md)

> Provider 官方资料核对日期：2026-09-10。请求字段、事件类型、缓存语义和错误结构会持续变化；
> 实现必须以官方文档和脱敏 contract fixture 为准，不能仅凭 OpenAI-compatible 标签推断。

## 快速理解

`ash-api` 是纯模型 API 协议层。它接收 provider-independent canonical model value，负责：

- 定义 API relative endpoint、HTTP method 和协议 headers；
- 将 canonical request 编码为具体 API request body；
- 将 unary response/error 解码为 canonical response/error；
- 将已经完成 framing 的 SSE event 解码为 canonical stream event；
- 解释 Provider 级 terminal、heartbeat、usage、tool、reasoning 和 prompt-cache 字段；
- 提供 catalog endpoint 的 request/response codec。

它不再拥有 Provider registry，也不再实现 transport、retry、SSE framing 或 telemetry。

目标横向结构是：

```text
endpoint/    requests/    sse/
```

三者同级：

- `endpoint/` 描述 method、relative path、required headers 和所绑定的 codec；
- `requests/` 描述 request/unary response/error JSON；
- `sse/` 描述具体 API 的 SSE event schema、lifecycle 和 canonical assembly。

HTTP backend 与共享 proxy/TLS policy 属于 `ash-http-client`；WebSocket handshake/message backend
属于 `ash-websocket-client`；operation retry、SSE/NDJSON framing 和 operation telemetry 属于
`ash-client`。

| 需要处理的内容 | 本层是否负责 | 交给谁 |
| --- | --- | --- |
| 把统一模型请求编码成供应商 JSON | ✅ | 本层 |
| 解释供应商响应、错误和流式事件 | ✅ | 本层 |
| 选择供应商、模型和凭据 | ❌ | 模型调用系统 |
| 判断是否安全重试并执行等待 | ❌ | 模型调用操作层 |
| 建立 HTTP 连接、代理和 TLS | ❌ | 网络层 |
| 推进 Agent Turn 和工具循环 | ❌ | 会话与执行系统 |

## 2. 四层关系

```text
ash-model-provider-config
  声明 Provider、默认 base URL、允许的 API profile
                │
                ▼
ash-model-provider
  解析 credential/target，选择 API endpoint 和 retry policy
                │
                ▼
ash-api
  endpoint + requests + SSE protocol codec
                │
                ▼
ash-client
  operation retry + framing + telemetry
                │
                ▼
ash-http-client
  HTTP execution + shared network policy
                │
                └──── ash-websocket-client
                      WebSocket execution
```

依赖与控制流不是同一个方向。Rust 依赖建议为：

```text
ash-http-client
       ▲
       │
ash-client      ash-protocol
      ▲              ▲
      └──── ash-api ─┘
               ▲
               │
      ash-model-provider
```

规则：

- `ash-client` 不依赖 `ash-api`；
- `ash-http-client` 不依赖 `ash-client` 或 `ash-api`；
- `ash-api` 可以使用 operation client 的 request/response/SSE value；
- `ash-api` 不依赖 model-provider/config/models-manager/Core；
- model-provider 选择 `ash-api` endpoint 并注入 resolved runtime values；
- Provider registry 只存在于 model-provider。

## 3. 当前实现审计

当前 crate 已实现：

- 精确到响应语义的 `ApiEndpoint`，以及供上层描述共同调用族的 `ApiProtocol`；
- `endpoint/`、`requests/`、`sse/` 三个顶级 codec 模块；
- OpenAI Responses unary codec；
- Anthropic Messages unary codec；
- OpenAI-compatible Chat Completions unary codec；
- OpenAI Responses 原生 HTTP/SSE invocation 与 canonical text/reasoning delta decoder；
- Anthropic Messages 原生 HTTP/SSE lifecycle decoder（text/thinking/tool fragment、`ping`、usage、terminal validation）；
- OpenAI-compatible Chat Completions 原生 HTTP/SSE decoder（indexed Tool Call 重组、usage-only chunk、`[DONE]`）；
- 基础 text/tool/reasoning/usage/stop reason 映射；
- API endpoint fixtures；
- Responses WebSocket 顺序会话与 Realtime GA 文本／音频会话；
- HTTP 通过 `ash-client::OperationClient` 调用，WebSocket 通过 `ash-websocket-client` 建连。

需要修正：

| 当前设计 | 目标 |
| --- | --- |
| 分散的生成端点路径、头和请求实现 | 三套生成 codec 已合并归属到 `endpoint/` 对应模块 |
| `JsonHttpTransport` / `UreqJsonHttpTransport` | 已替换为 `ClientRequest`/`ClientResponse` 与 `HttpClient` |
| `ResolvedApiTarget` 同时承担 runtime 和协议职责 | 仍需将其演进为 typed client request；API 只追加协议 path/header |
| transport 直接返回 `serde_json::Value` | client 已返回 status/headers/body bytes，API 负责 JSON |
| provider facade 与 wire codec 两套目录 | Provider facade 已只留在 model-provider；API dispatch 只按 endpoint/profile |

HTTP 调用、Responses WebSocket 与公共 Realtime GA 会话已有实现；NDJSON codec 和更多服务协议仍未完成，
不能把 transport 可用描述成模型协议已接通。

## 4. `endpoint / requests / sse`

### 4.1 `endpoint/`

Endpoint 是一个具体在线 operation contract，例如：

- OpenAI `POST /v1/responses`；
- OpenAI Chat `POST /v1/chat/completions`；
- Anthropic `POST /v1/messages`；
- Gemini `POST ...:generateContent`；
- Gemini `POST ...:streamGenerateContent?alt=sse`；
- Ollama `POST /api/chat`；
- Anthropic `GET /v1/models`；
- Ollama `GET /api/tags`。

Endpoint 拥有：

```text
HTTP method
relative path/path builder
query schema
protocol-required headers
request media type
expected response media type
request encode/response decode
protocol-specific field validation
stream event codec
operation retry evidence
```

Endpoint 不拥有：

- 默认 base URL；
- credential headers；
- proxy、redirect 或 connection pool；
- retry attempt loop；
- SSE byte framing。

Endpoint path 必须相对。它不能替换 resolved target 的 scheme/host，也不能通过字符串修剪猜测另一
API 的地址。

### 4.2 `requests/`

生成端点的请求与响应实现已经和端点放在一起：`endpoint/responses.rs`、`chat_completions.rs` 与 `anthropic.rs`。字段能力、缓存映射和用量解释都由对应端点维护。

`requests.rs` 保留共同的 JSON HTTP 调用、错误分类和附件校验；`requests/` 保留工具 schema 校验及 Google／Kimi／Z.AI 的独立计数 codec。没有独立职责的请求文件无需从端点再拆一份。

每个 request codec 必须对 canonical intent 做三选一：

1. 准确编码；
2. 以文档化等价语义编码；
3. 返回 typed `UnsupportedFeature` / `InvalidRequest`。

不能静默丢弃 tool choice、reasoning、image、strict schema、parallel tool call 或 cache intent。

### 4.3 `sse/`

`sse/` 保留 Anthropic 与 Chat Completions 的 SSE 事件实现。Responses 事件已归入 `endpoint/responses/events.rs`，供 SSE 和 WebSocket 共用。事件解码不处理 TCP chunk、换行或 `data:` 拼接；SSE 入口消费 `ash-client` 已完成分帧的 `SseFrame`：

```rust
/// Decodes already-framed SSE values for one concrete API profile.
///
/// Implementations validate provider event lifecycles and emit only canonical model events.
pub trait SseDecoder {
    type State;

    fn decode(
        &self,
        state: &mut Self::State,
        frame: &ash_client::SseFrame,
    ) -> Result<Vec<ModelStreamEvent>, ApiError>;
}
```

名称仅表达目标语义。具体 API 可以使用 enum/associated type，避免不必要的 dynamic dispatch。

`sse/` 拥有：

- event name 和 `data` JSON schema；
- Provider event lifecycle；
- `ping`/comment/terminal 的协议解释；
- text/reasoning/tool arguments/usage delta；
- 未知 optional event 的 forward compatibility；
- 跨 event canonical assembler；
- EOF 时 terminal validation；
- 最终 response 与 unary response 的语义一致性。

`sse/` 不拥有：

- HTTP connection；
- retry/backoff；
- byte buffer；
- CRLF/LF 和 multiline `data` framing；
- idle timer；
- transport metrics backend。

### 4.4 非 SSE 流

协议会话跟随端点归属：Responses WebSocket 在 `endpoint/responses_websocket.rs`，Realtime GA 在 `endpoint/realtime.rs`。`websocket.rs` 只处理有界 JSON 消息收发和取消／超时，真实握手与帧传输由独立的 `websocket-client` crate 提供。

Ollama 的 NDJSON 不能交给 SSE decoder。后续实现应消费 `ash-client::NdjsonRecord`，把事件解释放在对应端点；无需为目录齐全预建另一套分派。

### 4.5 OpenAI Platform 与 ChatGPT 订阅服务端点清单

OpenAI Platform 与 ChatGPT subscription 分别选择 `OpenAiResponses` 和 `ChatGptResponses`，共用消息／SSE codec。API 层按端点组装路由头和支持的缓存字段；runtime 只选择通道，`ash-chatgpt` 持有 OAuth 与账户凭据。订阅端点不发送显式缓存断点、不提供 token preflight，并保留模型支持的结构化工具结果。

Platform API key 不能访问 subscription target，ChatGPT OAuth token 也不能用于 Platform target。任意 custom OpenAI-compatible URL 不得冒充 subscription service。新增 compact、images、memories、search 或 realtime 能力时，仍需独立验证其公开 contract；Responses codec 的复用不能推导其他 endpoint 兼容。


对照本地 Codex 源码 `818f1cca8c` 的 `codex-rs/codex-api/src/endpoint`，差距不能仅按文件数判断：

| Codex 操作 | Ash 当前状态 | 处理结论 |
| --- | --- | --- |
| responses + responses_websocket | HTTP／SSE 已有；本轮补齐顺序 WebSocket 会话 | 共用请求和事件解码，先验证主推理链 |
| realtime_websocket | 本轮补齐公共 Realtime GA JSON 会话 | Codex 的 v1／v2／frameless 协议分别对待，未宣称兼容 |
| realtime_call | 未实现 WebRTC calls 和 sideband | 需要 SDP、call ID 及产品音频生命周期；不属于本轮 WebSocket 文本连接 |
| models | 已有 model-provider catalog discovery，路径与 JSON 尚在 catalog adapter | 后续将线上的模型列表协议归入 API；刷新、合并和缓存仍在 models-manager |
| images | API crate 未实现独立生成／编辑操作 | 需要图片请求／结果契约及对应模型验证；图片输入支持不能代替生成 |
| memories/trace_summarize | 未实现 Codex 对应服务操作 | 本地记忆和 checkpoint 不代表拥有该云端接口 |
| alpha/search | 未实现 Codex 对应搜索操作 | 需明确服务授权与结果契约，不能等同普通模型工具调用 |
| session | Ash 已有 OperationClient、认证解析及显式会话组合 | 沿现有职责复用，不再复制一套 Provider／认证／重试框架 |

这次实现优先补足两条 WebSocket 协议调用链。其余服务差距在表中保留，新增时仍需完整的请求、响应、错误和实际调用者，不能用空端点声明“已支持”。

### 4.6 端点归属与 WebSocket 实现

端点的路径、协议头、字段支持和调用代码已移到同一模块。公共入口仍是 `ApiEndpoint`；不按 provider 复制通用请求头，也不新增 crate。

| 原路径（ash-api/src 下） | 当前归属 |
| --- | --- |
| requests/openai_responses.rs | endpoint/responses.rs |
| requests/openai_chat_completions.rs | endpoint/chat_completions.rs |
| requests/anthropic_messages.rs | endpoint/anthropic.rs |
| input_token_count_endpoint.rs | endpoint/token_count.rs |
| semantic.rs | endpoint/semantic.rs |
| sse/openai_responses.rs | endpoint/responses/events.rs |
| sse/mod.rs | sse.rs |

对应测试随 owner 移动。公开的 `OpenAiResponsesSseDecoder` 更名为 `ResponsesEventDecoder`，同时解码已分帧的 SSE 和 WebSocket JSON；现有调用方已更新。`headers.rs` 保留协议合并与媒体类型规则，通用 Header 语法校验由 HTTP 请求构造边界保证，WebSocket 请求复用该校验并禁止覆盖传输层握手头。

| 能力 | 本轮实现与证据 | 明确边界 |
| --- | --- | --- |
| Responses WebSocket | 建连、response.create、文本／工具／用量事件、显式预热、增量续接；本地集成及 Luna／low 实连通过 | 每个对象顺序处理一个响应；未实现 stream_id 多路复用 |
| Realtime GA WebSocket | session.created/update、文本、PCM16 24kHz 音频、VAD 配置、工具结果、取消、音频截断、状态与用量 | 本地服务验证；未实连 Realtime 模型，不包含采集和播放 |
| 底层连接 | 复用代理、TLS、帧限制；取消、截止时间、Ping/Pong、关闭、握手 HTTP 状态和脱敏 | 不重放模型请求，不切换另一种传输 |
| Codex 私有语音／GPT-Live | 已对照其协议差异 | 未把 frameless、session.start 或私有 handoff 当成 Realtime GA |
| WebRTC calls／client secrets、音频产品入口 | 本轮未实现 | 需要独立服务操作和具体产品 owner |

`ResponsesWebSocketSession` 接收完整 `ModelRequest`。只有模型设置、工具、指令和先前输入／输出前缀一致时，才发送 `previous_response_id` 与新增输入。已知的服务端 reasoning 留在该响应链内，不从摘要重建；回滚、压缩、不同设置或不能准确比较的输出会开始完整请求，不引用旧 response ID。引用只是该连接的派生状态，不写成 Thread 历史或 Agent 身份。

`warm_up` 明确发送 `generate:false`，返回服务端 response ID 和可用的用量，不伪造助手输出；后续相同请求可以发送空增量。`ResponsesConnectionStats` 记录实际发出的请求与输入条目，用于观察传输，不代替计费。

空闲超时按连接消息计算，Ping／Pong 也会刷新期限；模型暂时没有文本输出不等于连接失活。取消、无终态断线、格式错误、消费者错误或放弃进行中的 invoke 都使 Responses 连接退场；没有自动 HTTP 重试或推理重放。重新创建连接后从完整历史开始。Realtime 的 receive 可以与音频输入队列轮流轮询；明确取消会关闭连接。生成完成与播放完成分别处理，response.done 必须查看 completed/cancelled/failed/incomplete 状态。

运行时提供 `connect_responses` 和 `connect_realtime`，由调用者拥有返回的会话。Responses 会在每次调用前核对认证，凭据变动时丢弃旧连接和增量基线。`WebSocketApiProfile` 与 `RealtimeApiProfile` 分别授权两个协议，旧配置缺字段不会自动启用 Realtime；ChatGPT 的 Luna 订阅不能授权公共 Realtime 服务。

普通 Agent 模型调用仍使用现有 HTTP 路径。这里提供的是明确可调用的 API／runtime 会话，未把一个共享 Provider 变成全局连接池，也未新增桌面或 TUI 语音入口。

官方依据：[Responses WebSocket](https://developers.openai.com/api/docs/guides/websocket-mode)、[Realtime GA](https://developers.openai.com/api/docs/guides/realtime)、[语音 WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime)、[Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)。Realtime GA 不发送旧 realtime=v1 beta 头。GPT-Live 是另一套 session.start／音频生命周期，不能混用这两套事件。

验证命令：

```text
just test ash-api --test websocket
just test ash-api --test provider_adapters
just test ash-model-provider --lib
just test ash-websocket-client
just test ash-http-client
just test ash-model-provider-config --lib
just generate-protocol
just test ash-app-server-protocol --lib
just check ash-app-server -p ash-model-provider -p ash-api
just test ash-model-provider --lib live_luna_websocket_uses_two_responses_on_one_caller_owned_session -- --ignored --nocapture
```

Luna 实连使用只读 Codex 凭据、固定 low、合成文本。同一连接两轮请求成功，发送统计为 2 次请求、1 次增量、合计 2 个输入条目。样本仅 28／44 个输入 token，不能作为大前缀缓存命中测试。Realtime 的真实认证、音频和延迟需要对应模型及 API 凭据；本地 PCM／事件测试不能替代实连。

## 5. 供应商运行时联动

`ash-api` 不知道当前 Provider registry，但可以提供包含兼容差异的 endpoint profile：

```text
model-provider::providers::deepseek
  → 选择 OpenAI Chat endpoint
  → 选择 DeepSeek-compatible request/SSE/error profile

model-provider::providers::xai
  → 显式选择 Responses 或 Chat endpoint

model-provider::providers::google
  → 显式选择 Interactions、GenerateContent 或 compatible Chat
```

Provider-specific wire quirk 的实现仍属于 API 协议层，例如：

- DeepSeek prompt cache hit/miss usage；
- DeepSeek SSE comment heartbeat；
- Anthropic `ping` 和 content block lifecycle；
- Z.AI HTTP/business error 双层状态；
- MiniMax `base_resp`；
- Ollama NDJSON `done`/`error`。

但选择哪个 quirk/profile 的责任属于 model-provider。`ash-api` 不通过 Provider ID、URL 或 model
name 自行选择。

可以用 typed profile：

```rust
pub enum OpenAiChatProfile {
    Baseline,
    DeepSeek,
    Xai,
    QwenCompatible,
    Zai,
    MiniMax,
}
```

这个 enum 表达 wire 差异，不是 Provider registry。没有实质差异的 profile 不需要提前创建。

## 6. 与 `ash-client` 的边界

### 6.1 请求

```text
model-provider
  ResolvedTarget + runtime headers
        │
ash-api::endpoint
  relative path + protocol headers
        │
ash-api::requests
  body bytes
        │
ash-client::ClientOperation
        │
ash_http_client::HttpRequest
```

Header ownership：

| Header | Owner |
| --- | --- |
| Authorization、API key、tenant/deployment | model-provider/credential runtime |
| Content-Type、Accept | ash-api endpoint |
| Anthropic version/beta feature, session-id, x-grok-conv-id | ash-api endpoint/typed request |
| traceparent、tracestate | client/HTTP telemetry |
| User-Agent、x-goog-api-client、OAuth 设备标识 | product/provider/login runtime |

`headers::build` 按实际调用设置 JSON/SSE 媒体类型。大小写无关的同名同值头合并；冲突值、非法名称和控制字符在发送前报错，错误不回显值。每次调用及认证重试均重走该入口，不修改共享 target。

### 6.2 Unary 响应

`ash-client` 通过 `ash-http-client` 返回：

```text
status + headers + bounded bytes + attempt/timing evidence
```

`ash-api::requests` 决定：

- success JSON schema；
- error JSON schema；
- HTTP 200 body 是否仍表示业务错误；
- request ID/retry evidence 的安全提取；
- canonical response/error。

### 6.3 流式处理响应

```text
ash-client
  bytes → SseFrame/NdjsonRecord
        │
ash-api::sse/ndjson
  frame → canonical ModelStreamEvent
```

底层 transport idle timer 在任意合法 wire activity 时更新；operation client 维护 frame activity。
API decoder 维护 semantic progress，并过滤不应暴露为模型输出的 heartbeat。

### 6.4 重试

`ash-client` 执行 retry，`ash-api` 只提供协议事实：

- HTTP status；
- `Retry-After`；
- Provider error code/type；
- 是否出现 terminal/semantic event；
- operation 是否有文档化 idempotency evidence。

Model-provider 选择最终 typed policy。API 不 sleep、不创建 attempt loop，也不 fallback。

### 6.5 遥测

`ash-http-client` 拥有 HTTP 与共享 outbound policy diagnostics；`ash-websocket-client` 拥有
WebSocket transport failure/redaction；`ash-client` 拥有 operation/attempt/stream telemetry。API
只提供低基数 protocol classification：

```text
api.profile
api.operation
api.result_class
api.stream.event_class
api.stream.heartbeat_class
```

API 不记录 raw request/response/SSE payload。Exact model ID、prompt、tool arguments 和 secret 不得
进入默认 telemetry。

## 7. Canonical 契约

Canonical values 由 `ash-protocol` 拥有。`ash-api` 只引用或显式 re-export 必要类型：

```text
ModelRequest
├── instructions
├── input: Message | ToolResult
├── tools / tool choice
├── reasoning intent
├── output limit
└── sampling intent

ModelResponse
├── output: Text | Refusal | Reasoning | ToolCall
├── usage
└── stop reason
```

以下内容不进入 protocol：

- Provider JSON DTO；
- HTTP status/header/URL；
- SSE event name、NDJSON object；
- Provider raw error；
- prompt-cache 原始字段；
- profile compatibility toggle。

只有两个以上独立组件需要相同语义时，才将新 value 提升到 protocol。

## 8. 流式处理、heartbeat 与完成语义

状态机：

```text
Created
  → Decoding
       ├─ Heartbeat*
       ├─ SemanticEvent*
       └─ Terminal
  → Completed
  → Failed
  → Cancelled
```

分工示例：

| Wire input | `ash-client` | `ash-api` | Canonical output |
| --- | --- | --- | --- |
| Anthropic `event: ping` | 生成 `SseEvent`、更新 frame activity | 识别为 heartbeat | 无 |
| DeepSeek `: keep-alive` | 生成 comment frame、更新 activity | profile 确认为 liveness | 无 |
| `data: [DONE]` | 生成 data event | profile 校验 terminal | `Completed` |
| OpenAI typed delta | 生成 data event | 解码/组装 | text/tool/usage delta |
| Ollama JSON line | 生成 NDJSON record | 解码 `done/error` | delta/completed/error |

EOF 不自动等于成功。需要文档化 terminal event/marker 的 API，在 terminal 之前 EOF 必须返回
truncated stream。

`last_wire_activity` 属于 client；`last_semantic_progress` 属于 API/runtime。不能因为模型长时间
reasoning 而把“无文本”误判为连接死亡。

## 9. Prompt/上下文缓存

Prompt cache 的 wire 语义属于 `requests/`：

- OpenAI Responses 当前映射 Session 级 prompt cache key；retention 尚未进入 canonical request；
- Anthropic 当前把 tools、system 和 canonical 可复用输入前缀映射为 ephemeral `cache_control`，并解析 creation/read usage；
- Gemini implicit cache 和 explicit cached-content reference；
- xAI Chat header 与 Responses body key 的差异；
- DeepSeek/Qwen/Z.AI 自动缓存 usage。

统一 usage 不是对 wire 字段做同名复制：`input_tokens` 表示包含缓存读取与缓存写入的总输入，
`cached_input_tokens` 表示缓存读取，`cache_write_input_tokens` 表示缓存写入。OpenAI Responses 的
总输入可直接读取；Anthropic 必须把 `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` 相加；DeepSeek 的 `prompt_tokens` 已是 hit 与 miss 之和，缓存读取来自
`prompt_cache_hit_tokens`。DeepSeek 因未报告缓存写入量而保持该项未知。缓存占比只在总输入与缓存
读取都完整时由上层计算，adapter 不制造请求级“命中率”。

不能强行统一为一个 `cache: bool`。Canonical contract 可以表达最小 provider-independent intent，
精确配置使用 typed profile option。

Ollama `keep_alive` 是模型 residency request 字段，不是 prompt cache，也不是 stream heartbeat。

Models manager 只把 cache capability 当 metadata，不参与一次 invocation 的 cache 生命周期。

## 10. 目录协议格式

Catalog request/response codec 也按同一结构组织：

```text
endpoint/anthropic/models.rs
requests/catalog/anthropic.rs
```

API 层负责：

- GET path/query/header；
- 分页 token 保真；
- JSON DTO；
- response headers 中 ETag/Last-Modified/Cache-Control evidence；
- Provider-neutral observation page。

它不负责 refresh、TTL、SWR、singleflight、merge、filter 或 availability interpretation。调用链：

```text
models-manager::ModelCatalogSource
        ▲
model-provider runtime adapter
        │
ash-api catalog codec
        │
ash-client
```

Inference endpoint 与 catalog endpoint 可能不共享 base URL，model-provider 必须显式解析 target。

## 11. 错误

目标错误只表达协议事实：

```rust
pub enum ApiError {
    InvalidRequest(InvalidRequestError),
    UnsupportedFeature(UnsupportedFeatureError),
    Provider(ProviderError),
    InvalidResponse(InvalidResponseError),
    InvalidStream(InvalidStreamError),
    Client(ash_client::ClientError),
}
```

所有权：

- `ash-http-client`：DNS/TCP/TLS/proxy/HTTP/attempt deadline/cancellation；
- `ash-client`：operation deadline/retry/framing；
- `ash-api`：Provider error body/event、invalid JSON、invalid lifecycle；
- model-provider：Provider/model/target identity 和 runtime resolution；
- Agent runtime：retry/fallback/用户提示/Turn outcome；
- App Server：stable product error mapping。

Provider error message 默认不是稳定公共 API，不能未经清洗直接展示或记录。

## 12. 目标目录

端点拥有完整协议操作，共用代码按职责复用。当前主要归属如下，省略测试和不影响分层的小文件：

```text
ash-rs/ash-api/src/
├── lib.rs
├── endpoint.rs
├── endpoint/
│   ├── responses.rs
│   ├── responses/events.rs
│   ├── responses_websocket.rs
│   ├── realtime.rs
│   ├── chat_completions.rs
│   ├── anthropic.rs
│   ├── token_count.rs
│   └── semantic.rs
├── requests.rs
├── requests/
│   ├── openai_tools.rs
│   ├── google_count_tokens.rs
│   ├── kimi_estimate_tokens.rs
│   └── zai_tokenizer.rs
├── sse.rs
├── sse/
│   ├── anthropic_messages.rs
│   └── openai_chat_completions.rs
├── headers.rs
├── websocket.rs
├── token_count.rs
└── error.rs
```

新的在线操作有明确调用者和协议证据时，添加对应端点；不要同时创建仅用于转发的 endpoint、request、response 三套空文件。模块入口使用同名 `.rs`，不用 `mod.rs`。当一份实现出现独立的事件生命周期、请求构造或响应组装职责时再拆子模块；对应测试随实现归属移动。

## 13. 公共接口

只导出：

- endpoint/profile selector；
- typed invocation options；
- canonical encode/decode entry point；
- streaming decoder/handle 所需窄接口；
- catalog observation page；
- structured `ApiError`；
- 必要的 canonical value re-export。

不导出：

- Provider registry；
- concrete HTTP client；
- raw Provider DTO；
- 任意 JSON option；
- telemetry backend；
- credential/header store。

新增 public trait 必须说明实现者对 validation、terminal lifecycle、unknown event、secret redaction
和 final-response parity 的责任。

## 14. 供应商/配置档案验证矩阵

以下是当前 Rust 调用路径，不将厂商提供但 Ash 尚未实现的接口列为已支持。统一契约测试覆盖全部 13 个内置 provider，真实服务验证单独记录。

| 通道 | 当前生成协议／认证 | 特有头或边界 | 本轮验证 |
| --- | --- | --- | --- |
| OpenAI API | Responses / Bearer | 按模型支持显式缓存断点 | 契约、传输 |
| ChatGPT 订阅 | ChatGptResponses / OAuth | session-id；省略显式断点，拒绝计数 | Luna／low 实连、契约 |
| Anthropic API key | Messages / x-api-key | anthropic-version=2023-06-01；不自动添加 beta | 官方契约、传输 |
| Google | 兼容 Chat / Bearer | x-goog-api-client；countTokens 独立使用 x-goog-api-key | 官方契约、传输 |
| xAI | XaiChatCompletions / Bearer | x-grok-conv-id；Responses 则使用 body cache key | 官方契约、传输 |
| Qwen | 兼容 Chat / Bearer | 不混入 DashScope 专用 SSE 头 | 官方示例、传输 |
| DeepSeek | Chat / Bearer | hit/miss 用量与通用 Chat 分开解析 | 官方示例、传输 |
| Kimi Open Platform | Chat / Bearer | 与 Kimi Code OAuth 分开 | 官方示例、传输 |
| Kimi Code | Chat / OAuth | 设备和客户端标识由登录能力提供 | 本地登录／传输契约，未实连 |
| Ollama | 本地兼容 Chat / 无认证 | 不继承保存的远端 API key | 本地契约、传输 |
| Hugging Face | 路由 Chat / Bearer | router 契约不代表所有下游已验证 | 官方示例、传输 |
| Z.AI | 兼容 Chat / Bearer | 保留语言偏好；tokenizer 为独立操作 | 既有契约、传输，未新增实连 |
| MiniMax | 兼容 Chat / Bearer | 不由兼容标签启用 Anthropic 接口 | 官方示例、传输 |
| MiMo | 兼容 Chat / Bearer（官方 SDK 示例） | 官方 curl 也展示 api-key；不据此判定 Bearer 无效 | 官方示例、传输 |
| 自定义兼容端点 | 按配置选择协议／凭据 | 不根据 URL 或模型名继承订阅能力 | 契约、真实本地 HTTP |

本轮修正了共享 JSON/SSE 请求头缺失、Google 生成与计数认证混用、xAI Chat 未映射缓存分组的问题。API 不读取密钥存储；credential service 从同一次密钥读取分别生成两个操作的认证头，计数不再搬用完整的生成 target。

### 14.1 来源与外部实现

- OpenAI 公开缓存参数依据 [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)；订阅端点另以 Codex 的 `codex-api/src/requests/headers.rs`、`endpoint/responses.rs` 和 Luna 实测核对。
- Anthropic：[API overview](https://platform.claude.com/docs/en/api/overview)。现有 x-api-key 仍受支持；多 workspace key 需要额外 workspace 选择，当前配置没有该能力，不能宣称此类账户已覆盖。
- Google：[OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)、[API keys](https://ai.google.dev/gemini-api/docs/api-key)、[countTokens](https://ai.google.dev/api/tokens)。生成兼容接口与标准计数接口分别验证。
- xAI：[Maximizing Cache Hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits)。Chat 请求头和 Responses body 参数明确区分。
- [DeepSeek](https://api-docs.deepseek.com/)、[Kimi](https://platform.kimi.ai/docs/api/overview)、[Qwen](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-api-reference)、[Hugging Face](https://huggingface.co/docs/inference-providers/en/index)、[MiniMax](https://platform.minimax.io/docs/api-reference/text-chat-openai)、[MiMo](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)提供各自认证和端点示例。
- Zed 本地检出 `dfec59fb1c8e`：`crates/open_ai/src/open_ai.rs`、`crates/anthropic/src/anthropic.rs` 在 API 模块组装头；`open_ai/src/chat_completion_transport_tests.rs` 检查 method、URI、认证、自定义头。这种职责和测试方式可复用，具体字段仍以供应商来源为准。
- [Warp BYOLLM/BYOK](https://docs.warp.dev/enterprise/enterprise-features/bring-your-own-llm)区分直连 key 和企业 IAM。工作区没有 Warp 源码，公开产品说明不足以验证具体请求头实现，不能替代供应商契约。

### 14.2 如何测试

1. 记录实际服务通道、认证、endpoint、媒体类型、路由／版本／beta 头，以及官方来源和核对日期。
2. 只有真实协议差异才新增 `ApiEndpoint`，不靠 URL、模型前缀或失败后改另一种 header 猜通道。
3. 假凭据配合 `OperationClient` 捕获真实构造请求，检查必需和禁止字段、大小写冲突、取消、认证重试、任务隔离及 target 不变。
4. 真实本地 HTTP 服务检查最终请求头与请求体，覆盖 JSON、SSE 和计数路径；不能仅测拼接辅助函数。
5. 使用对应供应商测试账户和低成本模型实连，验证认证、完成事件、工具往返和用量。缓存测试固定模型／参数／前缀，比较首轮、重复、fork、恢复，并核对原始服务端计数。

Luna 能验证 OpenAI 订阅通道和共享执行链，不能证明 Gemini、Claude、Grok 等服务接受请求。官方文档决定契约，本地测试防止回归，对应服务实连确认可用性；三者用途不同。未实连的 provider 不以 mock 成功冒充实连通过。

## 15. 测试

### 15.1 端点

- method、relative path、query；
- required protocol headers；
- header 冲突和 secret redaction；
- expected response media type；
- endpoint/profile 绑定；
- custom target 不能被 endpoint 替换 origin。

### 15.2 请求

- canonical request → exact wire fixture；
- unary fixture → canonical response；
- tool/reasoning/image/usage/stop reason；
- prompt cache 参数和 usage；
- unsupported intent 不静默丢弃；
- HTTP 200 business error；
- malformed/oversized/unknown response；
- catalog pagination token 保真。

### 15.3 SSE/NDJSON

- 从 `ash-client::SseFrame` 开始测试，不在 API crate 重复 byte fragmentation 测试；
- text/reasoning/tool argument 顺序；
- Anthropic `ping`；
- DeepSeek comment heartbeat；
- `[DONE]` 和 typed terminal event；
- unknown optional event；
- stream error event；
- EOF before terminal；
- final assembled response 与 unary fixture 等价；
- Ollama `done/error` NDJSON object。

Byte fragmentation、CRLF/LF、multiline data 和 retry timing 的测试属于 `ash-client`；transport
idle deadline、proxy/TLS、pool 和 HTTP diagnostics 的测试属于 `ash-http-client`。

## 16. 迁移计划

### 阶段 1：建立共享客户端分层

- 在 `ash-http-client` 建立 HTTP request/response/config port；
- 把 `HttpHeader`、raw request/response bytes 和 `UreqHttpClient` 迁入底层 crate；
- `ash-client` 保留 operation retry 与 framing；
- 保住现有同步 unary 行为；
- `ash-api` 开始依赖 operation client port。

### 阶段 2：拆端点与请求

- 已将 `Api` Provider enum 的分派移到 model-provider；
- 已建立 OpenAI Responses、Anthropic Messages、OpenAI Chat endpoint；
- 已把现有 JSON conversion 物理移入 `requests/`；
- 已删除 Provider 级空 facade。

### 阶段 3：SSE 纵向切片（已完成首批端点）

- 在 client 实现 SSE framing；
- 已在 API 实现 OpenAI Responses `sse/` decoder；
- 已接 Anthropic Messages decoder 与 `ping`/content-block lifecycle；
- 已接 OpenAI-compatible Chat Completions decoder、Tool Call fragment assembly 与 `[DONE]`；
- 三种 endpoint 均由 model-provider 暴露 canonical stream，并返回 terminal response。

### 阶段 4：兼容差异与 NDJSON

- DeepSeek comment heartbeat/usage；
- Ollama native NDJSON；
- Google native profiles；
- 逐家补 error/cache/stream fixtures。

### 阶段 4.5：ChatGPT 订阅服务接口面

- 建立 [`ash-chatgpt`](subscriptions.md#chatgptcodex-兼容登录)，提供设备码授权、Codex 兼容凭据管理与固定请求目标；
- 将 Platform API key、ChatGPT subscription OAuth 和 custom-compatible target 设为互斥 binding；
- 复用已验证的 Responses codec，并为 subscription target、headers、refresh 和 streaming 建立脱敏 contract fixture；
- 其他 endpoint 必须逐项验证，不能从 Responses 兼容性推断。

### 阶段 5：目录协议格式

- 实现 list endpoint/request/response codec；
- model-provider 实现 models manager source；
- manager 负责 refresh/cache/merge。

## 17. 固定决策

1. `ash-api` 是协议层，不是 Provider registry。
2. 路径、协议头、字段能力和请求实现跟随端点归属；共享助手按实际职责保留。
3. 协议会话使用各自的事件模型；Responses 的 SSE／WebSocket 共用一份事件解码。
4. Raw transport 与 network policy 属于 `ash-http-client`；retry、SSE framing 和 operation
   telemetry 属于 `ash-client`。
5. `ash-api::sse` 只解释已经 framed 的 API event。
6. Provider/profile 选择属于 `ash-model-provider`。
7. Config 只声明 profile，不持有 runtime API object。
8. Canonical values 属于 `ash-protocol`。
9. Prompt cache 字段映射属于对应端点，catalog cache 属于 models manager。
10. Inference retry safety 由 runtime policy 显式选择，client 执行。
11. Provider error 不以 raw JSON/String 穿透产品 API。
12. OpenAI Responses、OpenAI-compatible Chat Completions 与 Anthropic Messages 已接通 live HTTP/SSE
    execution；Responses WebSocket 与 Realtime GA 会话已有实现；NDJSON 和未验证
    provider profile 仍须按真实协议另行实现。
13. ChatGPT subscription 不共享 Platform base URL、credential 或 custom endpoint override；只复用经过验证的 Responses codec。
14. ChatGPT subscription OAuth wire、token/header value 与固定 backend target 属于 `ash-chatgpt`，不进入本 crate 的公共 value。

## 18. 官方资料索引

### OpenAI

- [Responses usage](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Responses WebSocket](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Models](https://developers.openai.com/api/docs/models)
- [Codex Memories](https://developers.openai.com/codex/memories)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- 本地 Codex source snapshot：`../codex/codex-rs/codex-api/src/endpoint/`（验证
  `memories/trace_summarize`、Responses/Realtime WebSocket 和 service target contract）

### Anthropic

- [Messages usage](https://platform.claude.com/docs/en/api/typescript/messages)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [API errors](https://platform.claude.com/docs/en/api/errors)
- [List models](https://platform.claude.com/docs/en/api/models/list)

### Google Gemini

- [Interactions and text generation](https://ai.google.dev/gemini-api/docs/text-generation)
- [`streamGenerateContent`](https://ai.google.dev/api/generate-content)
- [Models API](https://ai.google.dev/api/models)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching/)

### xAI

- [Streaming](https://docs.x.ai/developers/model-capabilities/text/streaming)
- [Prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching)
- [Model APIs](https://docs.x.ai/developers/rest-api-reference/inference/models)

### Qwen / Alibaba Cloud 模型 Studio

- [Streaming output](https://help.aliyun.com/en/model-studio/stream)
- [Context cache](https://help.aliyun.com/en/model-studio/context-cache)
- [Models and regional endpoints](https://help.aliyun.com/en/model-studio/models)

### DeepSeek

- [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Rate limit and request keep-alive](https://api-docs.deepseek.com/quick_start/rate_limit)
- [List models](https://api-docs.deepseek.com/api/list-models)
- [Context caching](https://api-docs.deepseek.com/news/news0802/)

### Ollama

- [Native chat](https://docs.ollama.com/api/chat)
- [NDJSON streaming](https://docs.ollama.com/api/streaming)
- [Streaming errors](https://docs.ollama.com/api/errors)
- [List installed models](https://docs.ollama.com/api/tags)

### 其他

- [Hugging Face Chat Completion](https://huggingface.co/docs/inference-providers/tasks/chat-completion)
- [Z.AI Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)
- [Z.AI context caching](https://docs.z.ai/guides/capabilities/cache)
- [MiniMax OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [MiniMax Anthropic-compatible API](https://platform.minimax.io/docs/api-reference/text-anthropic-api)

Kimi 与 MiMo 保持 configured compatible endpoint，直到取得完整官方 streaming/cache/catalog
reference 或经授权的脱敏 contract fixture。
