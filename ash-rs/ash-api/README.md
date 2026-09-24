# `ash-api`

> 本 README 解释 endpoint dispatch、wire codec 与 streaming event decoder 的实现边界。
> Provider/runtime 的系统关系与演进见 [`docs/ash-api.md`](../../docs/ash-api.md)。

`ash-api` 负责模型 API 的端点协议：

- 在 `ash-protocol` 的模型值与供应商 JSON 之间转换。
- 按端点维护路径、协议头和字段支持。
- 实现 Responses、Chat Completions、Anthropic Messages 的 HTTP／SSE 调用与响应解码。
- 实现 Responses WebSocket 续接和 Realtime GA 文本／音频事件会话。
- 实现 OpenAI、Anthropic、Gemini、Kimi 和 Z.AI 的输入 token 计数协议。

上层提供 `ModelRequest` 与带凭据的 `ResolvedApiTarget`。Provider、模型、凭据和 base URL 的选择属于运行时；HTTP／WebSocket 连接、TLS、代理与 SSE 分帧分别由底层客户端承担。

## Crate 边界

```text
ash-model-provider
  └─ 选择 ApiEndpoint + ResolvedApiTarget
       └─ ash-api
          ├─ canonical request → provider JSON
          ├─ provider JSON → canonical response
          ├─ framed SSE event → ModelStreamEvent
          │    ├─ ash-client：operation retry 与 SSE framing
          │    └─ ash-http-client：HTTP transport
          └─ Responses／Realtime JSON 会话
               └─ ash-websocket-client：WebSocket transport
```

本 crate 直接 re-export `ash-protocol` 的 `ModelRequest`、`ModelResponse`、`Message`、
`ContentPart`、`ToolDefinition`、`ToolCall` 等 canonical types。不要在这里创建第二套
request/response domain model。

## 公共契约

| Symbol | 职责 | 不负责 |
| --- | --- | --- |
| `ApiEndpoint` | 指定 concrete endpoint family 并 dispatch codec | provider 或 model selection |
| `ApiProtocol` | 暴露 endpoint 使用的 normalized protocol family | URL/provider 推断 |
| `ApiEndpoint::complete_with_client` | 校验 canonical request，执行 unary encode/call/decode | retry、credential refresh |
| `ApiEndpoint::count_input_tokens_with_client` | dispatch OpenAI Responses / Anthropic token-count codec | 准确度解释、调用频率、预算策略 |
| `InputTokenCountEndpoint` | dispatch concrete provider preflight codec | model eligibility、exact/estimated 判断、保守余量 |
| `ResponsesEventDecoder` | Responses SSE／WebSocket 事件与终态解码 | SSE 分帧、重连 |
| `ResponsesWebSocketSession` | 顺序请求、预热、前缀校验与增量续接 | 持久化历史、全局连接池 |
| `RealtimeSession` | GA 文本／音频／工具事件、取消与会话状态 | 音频采集、播放、工具执行 |
| `AnthropicMessagesSseDecoder` | Messages content-block lifecycle 与 canonical delta | transport liveness、tool JSON accumulation |
| `ApiError` | request、transport、status 与 response codec failure | provider selection error |

`ApiEndpoint` 是 wire contract，不是 vendor identity。同一 provider 可以暴露多个 profile；相同
compatible profile 也不能据此假设 cache、usage、error 或 streaming 语义完全相同。

## 内部接口地图

| Symbol | 可见性 | 当前职责 | 方向约束 |
| --- | --- | --- | --- |
| `ApiEndpoint::method` | crate-private | 当前所有 endpoint 使用 `POST` | transport method 不由 provider adapter 重写 |
| `ApiEndpoint::relative_path` | crate-private | `responses`、`chat/completions`、`v1/messages` | path 属于 endpoint protocol |
| `ApiEndpoint::headers` | crate-private | 按端点组装版本和会话路由头 | 不读凭据存储，不按 URL 推断通道 |
| `headers::build` | private | JSON/SSE 媒体类型、大小写去重、冲突与非法字符检查 | 不修改调用者 target，不在错误中输出值 |
| `validate_request` | private | 拒绝空 model/input 与零 max tokens | 在任何 transport 调用前执行 |
| `requests::post_json` | crate-private | JSON serialization、`ClientRequest`、status 与 JSON parse | 不选择 retry policy或 codec |
| `requests::require_materialized_images` | crate-private | 在 codec 前拒绝未经过 attachment authority 物化的 durable 引用 | 不读取附件 store 或本地路径 |
| `endpoint::*::complete` | crate-private | 对应 endpoint 的 build/call/parse pipeline | endpoint dispatch 的唯一 codec target |
| `requests::{google_count_tokens,kimi_estimate_tokens,zai_tokenizer}` | crate-private | provider count request/response JSON | 不声明准确度或调用频率 |
| `endpoint::*::build_request` | private | canonical input → endpoint JSON | 不读取 provider config |
| `endpoint::*::parse_response` | private | endpoint JSON → canonical output/usage/stop reason | malformed response fail closed |
| `ResponsesEventDecoder::decode_event` | private | event type dispatch、delta extraction、terminal transition | 不解释 raw SSE bytes |
| `AnthropicMessagesSseDecoder::{start_message,start_block,decode_block_delta,stop_block,stop_message}` | private | enforce message/block state machine | lifecycle 不能下沉到 UI |
| `ContentBlockKind` | private | 将 block kind 与允许的 delta kind 绑定 | unknown block 可以忽略，known mismatch 必须拒绝 |

## Unary 调用图

```text
ApiEndpoint::complete_with_client(target, model, request, client)
├─ validate_request
└─ endpoint::*::complete
   ├─ build_request
   └─ requests::post_json
      ├─ serde_json::to_vec
      ├─ ClientRequest::new
      │  ├─ ApiEndpoint::method
      │  ├─ ApiEndpoint::relative_path
      │  └─ ApiEndpoint::headers
      ├─ OperationClient::execute
      ├─ reject non-2xx as ApiError::HttpStatus
      └─ serde_json::from_slice
         └─ parse_response
```

Token preflight 使用相同 canonical `ModelRequest`，发送到 profile 声明的 concrete count endpoint，
并只返回 `InputTokenCount`。OpenAI/Anthropic count 复用对应 invocation builder；Kimi/Z.AI 从 Chat
Completions builder 中只保留各自文档允许的 input 字段；Gemini 把 canonical request 显式转换为
`generateContentRequest`。本 crate 不把 exact/estimated 契约编码进 wire value；准确度由
`ash-model-provider` adapter 声明。普通 Chat Completions 没有标准 count endpoint，不能把任意
compatible provider 自动当作可计量。

三套 codec 都处理 canonical messages、tools、tool choice、reasoning、usage、响应模型、实际服务等级和 stop reason，但
只共享 mechanical helpers；不能因为 JSON 外形相似就合并 protocol-specific semantics。

## 流式处理解码器

Decoder 接收 `ash-client::SseFrame`，说明 SSE field parsing 已经完成。它们输出
`ash_protocol::ModelStreamEvent`：

```text
SseFrame::Event
└─ Decoder::decode
   ├─ parse event.data JSON
   ├─ determine event type
   ├─ validate lifecycle/schema
   └─ emit TextDelta / ReasoningDelta / no event

end of stream
└─ Decoder::finish
   └─ require protocol terminal state
```

`ResponsesEventDecoder`：

- text 与 reasoning-summary delta 分别映射为 canonical delta；
- `response.completed` 进入 terminal；
- `response.failed`/`response.incomplete` 返回 failure；
- terminal 后的任何 event、或 terminal 前 EOF 都是 invalid response；
- unknown optional event 与 non-event frame 被忽略。

`AnthropicMessagesSseDecoder`：

- 要求 `message_start → content_block_* → message_stop`；
- 用 `BTreeMap<u64, ContentBlockKind>` 跟踪并行 block index；
- text/thinking delta 映射为 canonical delta；
- ping 不形成输出；message-level usage/stop reason、signature 与 tool input JSON fragment 进入
  terminal response assembly；
- 未 start 的 delta、重复 block、unknown stop、open block 上的 message stop、terminal 前 EOF 都被拒绝。

`OpenAiChatCompletionsSseDecoder`：

- 按 choice 与 tool-call index 重组 text 和 function argument fragment；
- 接受独立 usage chunk，并要求 `[DONE]` terminal；
- finish reason、usage 和重组后的 Tool Calls 进入 terminal response；
- malformed chunk、terminal 前 EOF、terminal 后事件与不一致的 indexed Tool Call 都被拒绝。

三种 endpoint 都由 `ApiEndpoint::stream_with_client_and_cancellation` 发起原生 wire stream，经过
`ash-client` framing 后边解码边投递 canonical delta，并返回权威 terminal `ModelResponse`。

Anthropic request builder 在 wire clone 上为最后一个 tool、system content 末尾和 `prompt_cache_prefix_end` 指定的消息末尾添加 ephemeral cache control；OpenAI Responses 映射 `prompt_cache_key`。adapter 不修改 canonical `ModelRequest`。`ModelUsage.input_tokens` 统一表示包含缓存读写的总输入，缓存读取与写入分别进入 `cached_input_tokens` 和 `cache_write_input_tokens`；Anthropic 组合三类输入，DeepSeek 使用独立的 Chat usage 档案读取顶层 hit 字段。Core 如何选择 key 和可复用前缀见[上下文系统](../../docs/core-context.md#9-上下文窗口与供应商变更)。

## 错误语义

| Condition | `ApiError` |
| --- | --- |
| canonical request 不满足基本 invariant | `InvalidRequest` |
| `OperationClient` transport/operation failure | `Transport` |
| HTTP 400 或供应商错误体中的 `invalid_request` | `InvalidRequest` |
| HTTP 401/403 或供应商错误体中的认证失败 | `AuthFailed` |
| 供应商错误体中的上下文上限 | `ContextOverflow` |
| HTTP 429 | `RateLimited { retry_at }`，保存响应头到达时计算的单调时钟截止时间 |
| HTTP 5xx/529 或供应商错误体中的过载 | `Overloaded` |
| 其他非 2xx | `HttpStatus(status)` |
| response JSON、field 或 stream lifecycle 无效 | `InvalidResponse` |

`requests::response_error` 与 `requests::stream_error` 在 HTTP 和 SSE 边界识别 OpenAI、Anthropic 与 Google 的已知错误码和消息。供应商错误体最多保留 4 KiB，且不包含凭据请求头；产品边界只把原始详情写入受控诊断日志，并在生成持久化 Turn 错误前移除。`From<ash_client::ClientError>` 将分帧失败映射为 `InvalidResponse`，其余客户端失败映射为 `Transport`。

## 方向偏差检查

- Codec 根据 provider name 或 URL 选择：profile ownership 从 provider config 漂移；
- Provider adapter 手写 request JSON：wire ownership 从本 crate 漂移；
- `requests::post_json` 自己重试：operation replay policy 下沉；
- Decoder 接收 socket bytes 或管理 reconnect：framing/transport ownership 下沉；
- Decoder 在 lifecycle validation 前向 UI 输出 event：invalid provider sequence 可能成为可信状态；
- 本 crate 读取 credential/config store：composition authority 下沉；
- 新建本地 canonical request type：`ash-protocol` 不再是唯一 domain source。

修改 endpoint 时同步检查 `ApiEndpoint` variants、`protocol`、`relative_path`、headers、request module、
provider `ApiProfile` mapping、unary tests 与 streaming decoder support。修改 canonical model field 时
同步检查三套 `build_request`、三套 `parse_response` 和 contract fixtures。

## 测试、限制与演进

```text
just test ash-api
bazel test //ash-rs/ash-api:ash-api-unit-tests
```

当前 tests 重点覆盖三个 SSE decoder 的 delta mapping、Tool Call fragment assembly、usage、
unknown optional event、terminal EOF、malformed JSON 与 Anthropic block lifecycle。统一 provider
conformance fixture 还覆盖 instructions、Tool Call/Result、图片、refusal、错误分类、未物化附件拒绝
和 prompt-cache scope，并通过 injected `OperationClient` 验证 request 与 response shape。

当前 HTTP/SSE 与 Responses WebSocket、Realtime GA 会话已有调用实现。NDJSON、WebRTC、GPT-Live 和更多服务操作不在本轮实现范围。新增能力必须继续保持 canonical domain、wire codec、
operation framing、transport 四层分离。

## 请求头契约

- `OpenAiResponses` 支持公开 API 显式缓存断点；`ChatGptResponses` 从请求的缓存分组生成 `session-id`，省略显式断点，拒绝 token preflight。
- `XaiChatCompletions` 从缓存分组生成 `x-grok-conv-id`，通用兼容端点不继承此规则。
- JSON 请求统一发送 Content-Type；实际流式请求选择 SSE Accept，其余调用选择 JSON Accept。
- 同名同值头合并，冲突值和非法字符在发送前拒绝，认证头和调用者 target 不被改写。
- 结构化工具结果和图片能力与缓存断点支持分别处理。
- 供应商审查、来源与验证方式见[模型 API 协议](../../docs/ash-api.md#14-供应商配置档案验证矩阵)。

端点物理归属、公开类型迁移、WebSocket 能力与测试见[端点归属与 WebSocket 实现](../../docs/ash-api.md#46-端点归属与-websocket-实现)。Responses 的路径／头／字段和 JSON 事件解码在 `endpoint/responses.rs` 与其子模块；Chat、Anthropic、计数和 semantic 分别有同级 owner。
