# 模型供应商配置

> - 物理位置：`ash-rs/model-provider-config/`
> - Rust crate：`ash_model_provider_config`
> - 层次：声明配置层
> - 当前状态：基础实现已包含声明式默认 `ApiProfile` 和独立 input-token count binding；invocation
>   WebSocket profile 也已使用独立的 fail-closed capability；多 profile allow-list 与用户 override
>   仍待实现
> - Crate 实现与修改路径：[`ash-rs/model-provider-config/README.md`](../ash-rs/model-provider-config/README.md)
> - Provider runtime：[`model-provider.md`](model-provider.md)
> - API 协议层：[`ash-api.md`](ash-api.md)

## 快速理解

模型供应商配置只描述“允许怎样配置”，并以确定性方式校验和归一化；它不读取凭据、不访问网络，
也不执行模型请求。

内置模型固定登记，接入独立配置，每次调用为每个厂商选择一条已就绪连接。`ModelRef` 表示厂商＋模型，`ModelConnectionId` 表示接入。GLM 全部使用 `glm` 模型厂商；`bigmodel`、`zai` 和两个 Coding Plan 服务 ID 是四个独立接入，凭据与端点各自保留。配置文件以 `connections` 保存接入；实际选择由运行时根据凭据状态决定。规则见[登录与账户系统](login.md#1-结论)。

| 读者首先会问 | 直接答案 | 深入阅读 |
| --- | --- | --- |
| 这里保存什么？ | 可序列化的供应商定义、API 配置档案、默认值和唯一静态模型目录 | [静态模型元数据](#7-静态模型元数据) |
| 用户覆盖如何生效？ | 按字段规则合并后进行确定性规范化，相同输入必须得到相同结果 | [合并与规范化](#5-合并与规范化) |
| 可以在这里读取 API key 吗？ | 不可以；配置只能保存不敏感的凭据引用 | [拥有与不拥有](#2-拥有与不拥有) |
| 可以探测端点是否可用吗？ | 不可以；网络、凭据和运行时状态不能参与静态配置校验 | [Base URL 边界](#6-base-url-与端点的边界) |
| 当前完成到哪里？ | 已有基础声明、默认 HTTP `ApiProfile` 和独立 WebSocket profile，多档案允许列表与用户覆盖仍待实现 | [当前实现审计](#3-当前实现审计) |

## 1. 结论

`ash-model-provider-config` 描述“一个 Provider 可以怎样被配置”。它只包含可序列化、可校验、
可生成 schema 的声明值，不创建 HTTP client，不读取 credential，也不执行模型调用。

这里的“静态”主要指校验不依赖运行时状态；其中 built-in model 目录确实由一个 Rust 常量维护：

- 值可以在进程外持久化和传输；
- 校验不依赖网络、credential 或当前进程状态；
- 相同 definition、用户配置和 override 必须得到相同的 normalized config；
- 任何 secret、连接、重试计数或动态 catalog observation 都不能进入该层。

一句话边界：

```text
model-provider-config 负责描述和归一化
model-provider        负责解析并运行
ash-api              负责协议编解码
ash-client           负责 API operation retry/framing
ash-http-client      负责底层网络传输
```

## 2. 拥有与不拥有

### 2.1 拥有

- `ProviderId` 对应的声明式 Provider definition；
- Provider display name 和非敏感静态 metadata；
- 默认 base URL 或“必须由用户配置”的 endpoint policy；
- runtime adapter identity；
- 允许选择的 API profile 及默认 profile；
- exact WebSocket API profile；未声明时必须保持 unavailable；
- input-token count profile、独立 target 与 model eligibility policy；
- base URL normalization 规则；
- 唯一 `STATIC_MODEL_CATALOG`、由它投影的 seed models 和 model catalog policy；
- 非敏感调用默认值，例如最大输出 token；
- 用户按模型 ID 提供的 context window 与 automatic compaction threshold；
- 用户 `ModelProviderConfig`；
- definition、用户配置和 override 的确定性 merge；
- 静态 validation、JSON Schema 和配置错误。

### 2.2 不拥有

- API key、OAuth token、cookie 或签名；
- credential reference 的解析和 refresh；
- resolved runtime header；
- DNS、TCP、TLS、proxy、HTTP client 或连接池；
- retry、deadline、cancellation、SSE 或 telemetry；
- Provider request/response DTO；
- prompt cache 的运行时资源和 usage；
- 动态模型 discovery、TTL、availability 或 catalog snapshot；
- `ModelInvoker`、运行中请求或可变 Provider 状态。

## 3. 当前实现审计

当前 crate 已有：

- `ModelProviderConfig`；
- `ModelContextConfig`；
- `NormalizedModelProviderConfig`；
- `ProviderDefinition`；
- `ApiProfile`（definition 的显式默认 API profile）；
- `WebSocketApiProfile`（与 HTTP compatibility 分离的 Responses WebSocket 协议）；
- `RealtimeApiProfile`（与文本调用分开声明的 Realtime GA 协议）；
- `InputTokenCountDefinition` 与 normalized count target/model policy；
- `ProviderConfigRegistry`；
- `ProviderAdapter`；
- `EndpointPolicy`；
- `ModelCatalogPolicy`；
- built-in Provider definitions；
- `STATIC_MODEL_CATALOG` 与 `StaticModelSpec`；
- 静态校验、registry merge 和 schema tests。

当前需要演进的地方：

| 当前形态 | 问题 | 目标 |
| --- | --- | --- |
| `ProviderAdapter` 同时近似 Provider 名称和 runtime 实现 | 容易与 `ash-api::Api` 再建一套分派 | 明确它是 runtime adapter identity，API endpoint 由 runtime 选择 |
| `EndpointPolicy` 只描述 base URL | 名称容易被理解为 `/messages` 等协议 endpoint | 改称或文档化为 `BaseUrlPolicy` 语义 |
| definition 目前只有一个 `api_profile` | 无法表达 Google、xAI、Ollama 等多个正式 API profile | 扩展为 typed default/allowed API profile policy |
| count binding 已独立声明 profile/target/models | invocation 与 count 可能不共享 base path | 保持 definition 显式，禁止 runtime 剥 URL 或猜 model 前缀 |
| Responses WebSocket 与 Realtime profile 分别声明 | HTTP 或文本订阅支持不代表语音服务可用 | runtime 分别校验能力与凭据；实连证据按服务记录 |
| 静态模型与接入分离 | 远端目录不能代表内置目录 | 模型固定可选，请求只使用明确选中的接入 |

协议、端点与认证声明属于接入；模型自身规格只维护一份。

## 4. 目标配置模型

以下类型表达目标语义，名称可在实现时调整：

```rust
pub struct ProviderDefinition {
    pub id: ProviderId,
    pub display_name: String,
    pub runtime_adapter: RuntimeAdapterKind,
    pub base_url: BaseUrlPolicy,
    pub api_profiles: ApiProfilePolicy,
    pub websocket_api_profile: WebSocketApiProfile,
    pub realtime_api_profile: RealtimeApiProfile,
    pub input_token_count: Option<InputTokenCountDefinition>,
    pub model_catalog_policy: ModelCatalogPolicy,
    pub seed_models: Vec<Model>,
    pub defaults: ProviderDefaults,
    pub base_url_normalization: BaseUrlNormalization,
}

pub struct ApiProfilePolicy {
    pub default: ApiProfileConfig,
    pub allowed: BTreeSet<ApiProfileConfig>,
}

pub enum ApiProfileConfig {
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
    GeminiInteractions,
    GeminiGenerateContent,
    OllamaChat,
}
```

`ApiProfileConfig` 是可序列化的配置值，不是 `ash-api` runtime object。`ash-model-provider`
负责把它映射为具体 endpoint implementation，配置 crate 不依赖 `ash-api`。

当前 `WebSocketApiProfile::{Unavailable, OpenAiResponses}` 只表达 exact wire eligibility。OpenAI
definition 声明 `OpenAiResponses`；xAI 的 definition 已使用 Responses HTTP，但尚未声明已验证的
WebSocket profile，因此保持 `Unavailable`。Generic OpenAI-compatible 也始终默认 unavailable，不能从
HTTP compatibility 推导 WebSocket。

`RealtimeApiProfile::{Unavailable, OpenAiRealtime}` 独立声明公共 Realtime GA 协议。OpenAI 内置定义启用它，其他定义默认不可用；反序列化旧定义时缺少 `realtimeApiProfile` 也保持不可用。该声明表示协议可用性，不代表账户已经获得服务权限。运行时还需使用对应凭据与模型；Luna 等 ChatGPT 文本订阅不能用于公共 Realtime。实现及验证范围见[端点实现](ash-api.md#46-端点归属与-websocket-实现)。

`TranscriptionApiProfile::{Unavailable, OpenAiRealtime, XaiStt}` 单独声明流式语音转写协议。OpenAI 直接 API 接入使用 Realtime 转写，xAI 直接 API 接入使用 STT WebSocket；ChatGPT 和 Super Grok 订阅接入不提供这项能力。缺少 `transcriptionApiProfile` 的定义默认不可用。语音转写始终使用对应供应商的直接 API 凭据，与当前文字模型接入无关。

ChatGPT 订阅接入复用 typed `OpenAiResponses` codec，但不复用 Platform target 或 API key。接入的 `ModelConnectionRuntime::ChatGptSubscription` 使 `ash-model-provider` 从 `ash-chatgpt` 获取固定 target 与 fresh OAuth headers；用户配置不得覆盖为任意 URL。

Provider-specific compatibility 也必须 typed：

```rust
pub enum ProviderCompatibilityConfig {
    ProviderDefault,
    OpenAiCompatible(OpenAiCompatibilityConfig),
}
```

不能增加如下通用逃生口：

```rust
provider_options: serde_json::Value
```

它会绕过 schema、validation、secret 审计和 profile 配对检查。

## 5. 合并与规范化

输入优先级固定为：

```text
built-in ProviderDefinition
    ↓
registered definition replacement/extension
    ↓
user ModelProviderConfig
    ↓
invocation-independent host override
    ↓
NormalizedModelProviderConfig
```

Normalization 必须：

- 验证 Provider 是否已注册；
- 选择明确的 API profile；
- 验证 profile 在该 definition 的 allowed set 中；
- 解析默认或用户 base URL；
- 按声明规则 trim/保留 trailing slash；
- 验证 HTTP(S) scheme，但不做 DNS 或网络请求；
- 合并非敏感 defaults；
- 保留“未知”和“未配置”的区别；
- 返回不可含 secret 的 `ProviderConfigError`。

Normalization 不得：

- 根据 URL 猜 Provider 或 API profile；
- 读取环境变量或 credential store；
- 请求 `/models` 验证模型；
- 探测 endpoint 是否在线；
- 将配置缺失静默替换为另一个 Provider；
- 根据 model ID 字符串猜 capability。
- 根据 HTTP `ApiProfile` 或 compatible 标签自动开启 WebSocket。

## 6. Base URL 与端点的边界

三种概念必须分开：

| 概念 | Owner | 示例 |
| --- | --- | --- |
| 默认 base URL | `model-provider-config` | `https://api.anthropic.com` |
| resolved runtime target | `model-provider` | base URL + credential/runtime headers |
| relative API endpoint | `ash-api` | `POST /v1/messages` |

配置层禁止把完整 invocation URL 当成通用字符串模板，也禁止通过删除 `/v1` 猜测 catalog 或原生
endpoint。Google 和 Ollama 的 invocation/catalog 地址可能不共享同一个 base path，必须由
definition/runtime 显式声明。

## 7. 静态模型元数据

`STATIC_MODEL_CATALOG` 是产品内置文本模型的唯一声明点。每个条目只声明厂商、模型 ID、显示名、上下文窗口、能力和推理参数等模型规格。订阅/API 重复条目合并；`access` 和 `runtime` 不属于模型条目。1M 上下文直接写 `context_window = 1_000_000`。

`builtin_connections()` 声明每个接入的厂商、认证类型、执行适配器、端点、协议、计数能力和限制。`ProviderConfigRegistry::with_configs` 选择保存的接入定义并规范化参数；上游 ID 差异由 `NormalizedModelProviderConfig::upstream_model` 精确映射，未声明差异的模型保持相同 ID，不猜名称前缀。

`model/list` 返回固定内置目录，不接受视图分支。远端目录由 `models-manager` 管理，作为接入范围内的观察和自定义接入发现能力，不作为内置模型调用许可。没有远端记录的内置模型仍能发请求，服务返回的认证、权限或模型错误直接交给调用方。

配置文件版本 7 将旧 `providers` 转为独立 `connections`。版本 8 将旧 GLM 模型引用统一为 `glm`，合并重复收藏，并删除旧的 `activeConnections` 字段；四条连接和凭据键仍按原服务 ID 独立保存。

## 8. 依赖方向

```text
ash-protocol
      ▲
      │ shared IDs/model metadata
ash-model-provider-config
      ▲
      │ normalized declaration
ash-model-provider
```

允许：

- `ash-model-provider-config → ash-protocol`；
- `ash-model-provider → ash-model-provider-config`。

禁止：

```text
ash-model-provider-config → ash-model-provider
ash-model-provider-config → ash-api
ash-model-provider-config → ash-client
ash-model-provider-config → ash-http-client
ash-model-provider-config → credentials
ash-model-provider-config → Core/App Server
```

## 9. 修改入口

静态模型在 `src/model_catalog.rs`，接入声明在 `src/connection.rs`，端点和协议细节在 `src/providers/`。用户配置和规范化结果在 `src/config.rs`，注册和校验在 `src/registry.rs`。测试使用相邻的 `*_tests.rs`，不另建重复目录。

## 10. 验收

- 所有 public 配置值可序列化、反序列化并生成 schema；
- normalization 是确定性的；
- unknown Provider、非法 URL、非法 profile 组合返回 typed error；
- debug/error 不含 secret；
- config crate 没有网络、credential 或 runtime dependency；
- built-in definitions 的 ID、base URL 和默认 profile 有 contract tests；
- 自定义 OpenAI-compatible 配置必须显式选择 compatible profile；
- 未配置行为不会通过 `bool` 或含糊 `Option` 控制。

## 11. 固定决策

1. 本 crate 是声明配置层，不是运行时。
2. 内置模型随 Ash 版本维护，不根据登录状态或远端目录增删。
3. 默认 base URL 属于本 crate，resolved target 不属于。
4. API profile 可以被声明，但具体 `ash-api` endpoint object 由 runtime 选择。
5. Secret、transport、retry、SSE、telemetry 和动态 catalog 永不进入本 crate。
6. Provider-specific option 必须 typed，禁止任意 JSON escape hatch。

旧配置在升级时迁移为 `connections`，旧的 `activeConnections` 被移除；可继续会话中的模型与角色引用迁移为统一厂商身份，已完成调用的服务和计费记录保持原样。目录配置和 Agent 定义只取得读取权限时，在导入会话前转换旧模型身份，不改写目录文件，也不借旧服务名选择接入。
