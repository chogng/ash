# `ash-model-provider`

> 本 README 解释 provider runtime instantiation、adapter selection 与 immutable model invoker。
> Declarative config 见 [`ash-model-provider-info`](../model-provider-info/README.md)，跨系统
> credential/provider 设计见 [`docs/model-provider.md`](../../docs/model-provider.md)，模型目录实现见
> [`ash-models-manager`](../models-manager/README.md)。

`ash-model-provider` 把 validated declarative config 与 `ModelRef(provider, model)` 解析成
`Arc<dyn ModelInvoker>`。它选择 provider runtime 和 API profile；wire codec 属于 `ash-api`，
operation retry/framing 属于 `ash-client`，HTTP transport 与共享 network policy 属于
`ash-http-client`。WebSocket 连接属于 `ash-websocket-client`；本 crate 已通过
`connect_responses`、`connect_realtime`、`connect_transcription`、`connect_xai_transcription` 和 `connect_voice` 组合协议会话、明确的服务能力与凭据。

## 语音模型会话

- `connect_voice` 接收现有 `ModelProviderConfig`、独立的 `VoiceModelConfig`、指令和共享连接器。
- 语音模型、默认模型和音色由 Provider 的 `voice_models` 声明；运行时不写死模型名称。
- 请求覆盖值先通过 `VoiceModelConfig::with_overrides` 合并已保存的选择，未指定部分使用 Provider 的默认值；明确指定的无效模型或音色会报错。
- 鉴权沿用 `ProviderCredentialService` 与现有密钥存储；文本订阅身份不会替代语音 API 凭据。
- 返回 `VoiceModelSession`，包含已解析的 `ModelRef`、固定音色、会话状态和收发接口。
- 模型或音色变更需要结束旧会话并新建；房间消费者不直接创建 `ash-api::LiveSession`。
- `voice-agent` 消费模型会话并交换房间音频；开发任务仍归 App Server/Core。

`connect_live` 已退场。当前协议由 `ash-api` 的 GPT-Live 实现承担，语音模型选择不经过文本 Agent 的工具能力检查。新增目录条目不会自动证明账户可用性。

当前 `EmbeddingInvoker` / `RerankInvoker` 除 canonical、有序、provider-neutral 调用契约外，已接入
OpenAI-compatible embedding/rerank wire codec、OpenAI/Ollama embedding runtime 和 exact provider
config resolver。本 crate 仍只拥有模型 API 选择、credential materialization、请求适配和执行。
它不决定代码如何切块、查询哪个向量索引、准备哪些 rerank 候选，也不拥有排序、过滤或截断
策略；本地 Codebase 的这些策略属于 `ash-codebase`，远端托管索引则属于具体 provider。

## 公共契约

| Symbol                                                                               | 职责                                                      | 生命周期                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ModelProvider`                                                                      | `ModelRuntimeRequest → ModelInvoker` port                 | composition/invocation safe point                                                                  |
| `ModelProviderRuntime`                                                               | built-in concrete resolver                                | 持有 config registry、shared `ModelsManager`、lazy operation client 和可选 local tokenizer service |
| `ModelRuntimeRequest`                                                                | exact `ModelRef + ModelProviderConfig` 与可选有效 `Model` | immutable selection request                                                                        |
| `ModelInvoker`                                                                       | canonical `ModelRequest → ModelResponse`                  | one immutable provider/model snapshot                                                              |
| `ModelInvoker::image_input_policy`                                                   | 按已解析的模型能力提供图片尺寸与 patch 限制               | 与请求计量和调用使用同一实例                                                                       |
| `ModelInvoker::{input_token_measurement_capability,measure_input_with_cancellation}` | frozen request 的 tokenizer/preflight port                | 与 invocation 相同 immutable snapshot                                                              |
| re-exported `LocalTokenizerBinding` / `LocalTokenizerRegistry`                       | 宿主安装资产后的通用本地 tokenizer 接口                   | composition safe point 构建后注入 runtime                                                          |
| `EmbeddingInvoker`                                                                   | ordered text batch → finite equal-dimension vectors       | one immutable embedding model snapshot                                                             |
| `RerankInvoker`                                                                      | query + ordered documents → ordered finite scores         | one immutable rerank model snapshot                                                                |
| `SemanticModelProvider`                                                              | exact model/config → embedding 或 rerank invoker          | provider transport/credential boundary                                                             |
| `Provider`                                                                           | normalized provider runtime                               | definition、config、private adapter、client                                                        |
| `UnavailableModel`                                                                   | explicit failing invoker                                  | host 无法配置 model 时 fail closed                                                                 |
| `EchoModel`                                                                          | deterministic test/local fixture                          | 不是 production model                                                                              |
| `ModelProviderError`                                                                 | config/model/API/credential/unavailable error             | 保留 failure domain                                                                                |

App Server 在接受每轮执行时，用同一目录快照计算预算并绑定有效模型资料。配置和目录更新影响后续执行，不原地修改已经运行的 `RegisteredModelInvoker`；账号就绪状态在每次调用前重新检查。

## 模型请求配置

`ModelRuntimeRequest::with_info` 接收调用方已解析的有效模型资料，模型身份必须与选择一致；未传入时由 runtime 解析静态目录。绑定后调用与计数均使用捕获的 `Model`，不会重新用静态条目覆盖动态资料。

- 显式请求的 verbosity、摘要与服务档位优先于模型默认值；服务档位未显式指定时应用连接的 fast 配置，再使用模型默认值。
- Responses 编码 `text.verbosity` 与 `reasoning.summary`；摘要 `none` 表示省略参数。明确传入这些字段的 Chat Completions 或 Messages 请求会报错，不静默丢弃。
- 已声明不支持并行工具时关闭请求并行标志；原图能力继续经现有图片处理检查。已声明模态列表时，发送前拒绝不支持的图片或音频输入。
- 工具输出限额只作用于发往模型的副本，每个工具结果的所有文本部分共用一个预算，原始历史和持久记录保持完整。tokens 模式使用共享输出工具的 UTF-8 字节近似，不代表 tokenizer 实测值。
- ChatGPT 远端目录导入明确返回的模态、参数支持与默认值、并行工具、原图能力、容量和截断策略；本地 Codex `model/list` 没有返回的字段保持未声明。

## 内部接口地图

| Symbol                                             | 可见性                 | 当前职责                                                            | 方向约束                                             |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `ModelProviderRuntime::instantiate_normalized`     | private method         | definition lookup + `Provider::instantiate`                         | normalization success 后 provider 必须存在           |
| `LazyOperationClient`                              | private struct         | 第一次 operation 才创建 production HTTP client，并缓存结果          | App Server 启动和 config inspection 不接触 TLS/proxy |
| `Provider::instantiate`                            | crate-private          | enforce definition/config ID equality，materialize adapter          | 不读取 mutable config/credential store               |
| `providers::instantiate`                           | crate-private function | exhaustive `ProviderAdapter` enum dispatch                          | provider selection 唯一 switch                       |
| `ProviderAdapter`                                  | crate-private trait    | endpoint、模型名映射、固定 Header、图片输入限制与 token measurement | 不拥有生成请求执行或响应解析                         |
| `LocalInputTokenCounter`                           | crate-private struct   | 官方预检不可用时把整份请求交给本地计数服务                          | 不下载资产、不按 provider 猜 tokenizer revision      |
| `api_endpoint`                                     | private function       | `ApiProfile → ash_api::ApiEndpoint`                                 | 按 profile，不按 provider name 猜                    |
| provider `*Adapter::new`                           | crate-private          | endpoint 与供应商专属计数配置                                       | one immutable runtime snapshot                       |
| `Provider::resolve_model`                          | private method         | 委托 shared manager 的 static typed resolution                      | 不复制 catalog policy 或做远端请求                   |
| `RegisteredModelInvoker`                           | private struct         | bind exact Provider + resolved Model                                | request 时只应用 normalized defaults                 |
| `RegisteredModelInvoker::invoke_with_cancellation` | private trait impl     | apply defaults、取得共享执行路径的最终结果                          | 不读取 product config                                |

## 运行时调用图

```text
ModelProviderRuntime::runtime(ModelRuntimeRequest)
└─ build_model(config, model_ref)
   ├─ ProviderConfigRegistry::normalize_for
   ├─ instantiate_normalized
   │  ├─ registry.get(definition)
   │  └─ Provider::instantiate
   │     └─ providers::instantiate(adapter kind, normalized config)
   └─ Provider::build_model(model_id)
      ├─ Provider::resolve_model
      │  └─ ModelsManager::resolve_static
      └─ RegisteredModelInvoker { provider, model }

RegisteredModelInvoker::{invoke_with_cancellation, stream_with_cancellation}
└─ Provider::execute_model_with_cancellation
   ├─ 检查账号 + 应用冻结模型配置 + sanitize request + resolve authenticated target
   ├─ ProviderAdapter::{endpoint, model_id}: provider-specific selection
   └─ execute_attempt: dispatch by explicit output_transport
      ├─ streaming: ash_api::ApiEndpoint::stream_with_client_and_cancellation
      └─ unary: ash_api::ApiEndpoint::complete_with_client_and_cancellation
         └─ OperationClient → HttpClient
```

`RegisteredModelInvoker::measure_input_with_cancellation` 复用同一个 `prepare_request`，因此 provider
默认 `max_output_tokens` 与最终 invocation 一致；adapter 再把 canonical input 编成 count endpoint
接受的 wire shape。`ProviderInputTokenCounter` 只 materialize config 已声明且 model policy 允许的
profile/target，adapter 不按 model ID 或 URL 猜能力。OpenAI Responses 声明 remote/exact；Anthropic、
Google、Kimi 与 Z.AI 声明 remote/estimated。`Provider` 统一执行“官方预检 → 本地整请求计数 →
unavailable”的优先级；因此任何 provider 只要注入精确 `ModelRef` binding 都能使用 local/estimated，
不再由各 adapter 复制本地选择逻辑。

`Provider::complete` 再次通过同一个 manager resolve model，因此 direct Provider callers 与 bound
invoker 使用相同 catalog policy。App Server 通过 `ModelProviderRuntime::models_manager()` 获得同一
进程内 manager clone，目录展示与 invocation 不再分别读取 `ProviderDefinition.models`。

## 供应商适配器模式

每个 `src/providers/<name>.rs` 定义 private adapter，通常持有：

- `ApiEndpoint`：由 declarative `ApiProfile` 映射；
- 必要的模型名映射、固定 Header 与专属计数配置。

Adapter 不执行生成请求、不手写 JSON、不解析响应。`Provider` 持有最终 `ResolvedApiTarget`，
统一组织认证、取消和错误处理，并调用 `ash-api` 的协议实现。相同 adapter 可选择不同 profile，
profile 与输出方式由 configuration definition 明确声明。

新增 provider/profile 时同步检查 config enum/definition、`providers::instantiate` exhaustive match、
`api_endpoint`、fixed headers、codec support、fake transport tests 和系统 provider matrix。

## 错误与模型目录

| Path                              | Error                        |
| --------------------------------- | ---------------------------- |
| invalid/unknown/mismatched config | `ModelProviderError::Config` |
| listed-only unknown model         | `ModelNotRegistered`         |
| 供应商上下文上限                  | `ContextOverflow`            |
| 供应商认证或授权失败              | `AuthFailed`                 |
| 无效 canonical/供应商请求         | `InvalidRequest`             |
| 无效供应商响应                    | `InvalidResponse`            |
| 传输、限流、过载或其他 HTTP 状态  | `Api(ApiError)`              |
| explicitly unavailable host model | `Unavailable`                |

`From<ApiError>` 将四个语义类别提升为直接的 `ModelProviderError` variant，其余操作类别保留在 `Api` 中。原始供应商详情只供产品宿主的受控日志使用；跨入 Core 时必须改成无原文的类型化 `CoreError`。

`AllowUnlisted` 由 manager 生成 unverified metadata，不证明 entitlement、capability 或 remote
availability。`ListedOnly` 由 manager 在任何 network call 前拒绝。

## 方向偏差检查

- Core 按 provider ID branch：provider selection 泄漏出 runtime crate；
- runtime 根据 URL 猜 profile：declarative config 被绕过；
- provider adapter 自己序列化 wire JSON：codec ownership 从 `ash-api` 漂移；
- adapter 直接构造 ureq/reqwest client：network substrate/retry ownership 漂移；
- `RegisteredModelInvoker` 读取 mutable config：safe-point snapshot 被破坏；
- `EchoModel` 出现在 production fallback：配置失败被静默掩盖；
- API codec/network layer 读取 secret store：credential materialization 必须停留在 provider runtime。

## 测试、限制与演进

```text
just test ash-model-provider
bazel test //ash-rs/model-provider:model-provider-unit-tests
```

测试使用注入的 `OperationClient` 捕获请求，覆盖 Responses/Chat/Anthropic 配置、结构化工具、
自定义端点、默认值、供应商不匹配、目录策略、固定标头、取消传播和默认 HTTP 传输；lazy client
测试另外断言构造前不访问 transport、只初始化一次，并把初始化失败作为普通 transport error 返回。

当前 completion `ModelInvoker` 已有 concrete provider adapters；embedding/rerank 已有 canonical
invoker、request/response validation、OpenAI-compatible/Ollama runtime resolver，以及本地
`ash-codebase` 和 Tool Search consumers。
所有内置供应商都通过共享路径使用协议流式执行。完整结果调用等待同一次流式执行返回的
`ModelResponse`；增量与最终工具调用、用量和结束原因由 `ash-api` 解析。`ModelInvoker` 必须声明
输出方式并实现流式契约，不能把完整文本包装成增量。显式 `Unary` 端点只接受完整结果调用，流式请求在发送前
返回不支持；Core/App Server 按声明消费最终结果，不合成增量。
每个 immutable provider definition 显式发布输出方式；catalog/Desktop 只消费该声明，
不从 provider 名称或 `ApiProfile` 猜测。
WebSocket eligibility 由独立的 `WebSocketApiProfile` 声明，不能从
`ModelOutputTransport` 或 HTTP compatibility 推断。`connect_responses` 返回调用者拥有的 `ResponsesModelSession`，支持完整请求、准确增量、预热、已存 API key 轮换后的重连及关闭；不自动切换 HTTP 或重放。`connect_realtime` 由独立的 `RealtimeApiProfile` 授权，接受独立的 Realtime 模型 ID，拒绝订阅文本模型，返回公共 Realtime GA 会话。听写由独立的 `TranscriptionApiProfile` 授权：`connect_transcription` 使用 OpenAI Realtime 转写，`connect_xai_transcription` 使用 xAI STT，两者均读取对应供应商的直接 API key；默认 Agent 调用仍走 HTTP。
`ProviderCredentialService` 是供应商 API Key 的唯一所有者：App Server 通过它校验并写入 host 注入的 `SecretStore`，direct 和 semantic runtime 通过它解析 `ApiKeyPolicy` 与 `ApiKeyHeader`。`Provider` 合并 adapter 声明的固定 Header 与认证 Header，并唯一持有最终 `ResolvedApiTarget`；各 provider adapter 只负责 endpoint、模型名映射、固定 Header 和专属计数。Anthropic 的现有 API key 通道使用 `x-api-key`；Google OpenAI 兼容生成接口及其余远端 adapter 使用 Bearer Header；Ollama 不读取 Key，OpenAI-compatible 允许无 Key endpoint。
模型目录读取按供应商放在 `src/catalog/`：`openai.rs` 管 OpenAI API 目录，其下的 `chatgpt.rs` 管 ChatGPT 订阅目录，并优先读取 Codex 当前账户校验后的本地目录；`xai.rs` 读取已登录账户的模型目录，`kimi.rs` 提供已支持的 Kimi Code 型号，`ollama.rs` 读取本地 Ollama。各来源只返回标准化观察结果，缓存由 `ash-models-manager` 按供应商写入 Ash profile。更多 stream profile 与动态 catalog 的长期设计仍在系统文档中演进。

ChatGPT subscription 通过 `ash-chatgpt` 提供的 fresh authenticated target 进入 OpenAI Responses adapter；Agent loop 仍由 Ash Core `TurnExecutor` 持有。该订阅接口拒绝公开 API 的 `prompt_cache_breakpoint` 字段；runtime 选择明确的 `ApiEndpoint::ChatGptResponses`，不改写缓存字段或组装路由头。`ash-api` 统一处理这些协议规则，完整结果、流式调用和认证重试共用同一 API 入口。

Codex 的 `Ultra` 和 Claude Code 的 `Ultracode` 表达产品协作设置，不作为 Ash 模型推理档位。ChatGPT 目录标准化仅保留已识别的 `ReasoningEffort`；目录中 `ultra` 的候选和默认值不会进入推理配置，也不会触发模式切换。TUI 的同名命令别名统一选择 Ash Multitask，保留独立 effort，委托仍由 Core 执行；当前没有启用 OpenAI 托管多 Agent 的请求参数，也没有 Claude Code 执行通道。完整边界见 [Multitask、Ultra 与 Ultracode](../collaboration-mode-templates/collaboration-modes.md#multitaskultra-与-ultracode)。

新增能力应保持 invoker immutable、profile explicit、
provider adapter private，以及 config/catalog/codec/operation/network 分层。

当前 runtime 已为 Ollama 实现 `ModelCatalogSource`，通过独立的 `ash-ollama` 调用 `/api/tags` 与
`/api/show`，并与模型调用共享 operation client。ChatGPT、xAI 与 Kimi 的订阅目录也已接入；其他 provider 的动态 discovery endpoint/DTO 和
credential binding 属于各自的后续适配工作。静态 invocation resolution 已统一进入 manager。

当前 input-token preflight 已贯穿 `ModelInvoker → ProviderAdapter → ash-api → OperationClient` 的
caller-owned cancellation。所有 estimated endpoint 使用额外 1%/至少 32 tokens 的保守记账余量；这
只是 Ash 的预算策略，不是 provider 承诺的硬上界。Google 对不能无损映射到 native request 的远程
图片返回 unavailable；Kimi 当前带 tools/reasoning 的请求返回 unavailable；Z.AI 当前带 Tool
Call/Result 历史的请求返回 unavailable。DeepSeek 的本地 tokenizer adapter 已实现，
使用 2%/至少 64 tokens 的保守余量；宿主通过 `ModelProviderRuntime::with_local_tokenizers` 注入已经
验证的 registry 或 manager。App Server 注入带磁盘缓存和内存 LRU 的 manager；模型资产需由宿主提供固定清单。官方预检或本地计数的非取消
错误不会中止真实模型调用，而是继续降级到下一计量来源。

完整结果与增量调用共用 `Provider::execute_with_cancellation`，caller token 经 `ash-api` 传给
`OperationClient`。取消是独立的
`ModelProviderError::Cancelled`，App Server 不会把它误报为 model failure。同步 HTTP attempt
可能已进入底层 socket；operation 立即停止等待且不 retry，attempt 本身由 transport timeout
有界结束，迟到 response 不会被接受。

流式回归测试覆盖所有 Chat Completions 供应商的响应结束前交付、两种消费方式的结果一致性、
分块工具参数、DeepSeek 缓存用量、取消、截断、接收方错误与禁止重放；Responses 和 Messages
复用已有协议测试。模型准备、下载进度和产品界面仍由各自 owner 负责。

`ProviderCredentialService` 从一次密钥读取分别生成调用和计数凭据。Google `countTokens` 使用 `x-goog-api-key`，不能复制生成接口的 Bearer 头；计数地址仍由明确配置决定。品牌和 OAuth 设备标识由所属 provider／登录能力提供，协议头统一由 `ash-api` 校验合并。

WebSocket 工厂要求调用者传入共享网络策略的 connector，不另建代理/TLS 规则。语音采集、播放及把工具交给授权执行器属于 host；API 只提供配置、收发与状态。协议和验证边界见[端点实现](../../docs/ash-api.md#46-端点归属与-websocket-实现)。

模型输入的最终图片清晰度处理由 `src/image_request.rs` 拥有，仅修改发出的请求副本；不支持或
尚未确认支持 Original 的模型使用 Auto，已确认支持的模型保留 Original。`ModelInvoker` 返回
`ash-utils-image::PromptImageDetailLimits`，表达冻结型号的尺寸与 patch 限制；Core 按请求的
清晰度准备图片。共享 protocol 只定义请求内容，不执行这一步处理。
