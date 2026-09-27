# `ash-model-provider-config`

> 本 README 解释 provider declaration、registry validation 与 normalization。跨系统配置模型和
> 演进见 [`docs/model-provider-config.md`](../../docs/model-provider-config.md)；runtime
> instantiation 见 [`ash-model-provider`](../model-provider/README.md)。

本 crate 拥有 serializable、runtime-free 的 provider configuration。它不持有 API client、
credential、secret、connection pool 或 process-local adapter。

## 公共模型

| Symbol | 职责 | 关键语义 |
| --- | --- | --- |
| `ModelProviderConfig` | 用户/host 可配置值 | provider、connection、base URL、max output 与 per-model context metadata |
| `ModelContextConfig` | 单模型的 Core budget metadata | positive context window、optional auto-compact limit |
| `ProviderDefinition` | provider-owned declaration | adapter identity、HTTP/WebSocket API profile、endpoint/catalog/defaults、API Key policy/header |
| `NormalizedModelProviderConfig` | runtime-ready immutable config | provider/profile/base URL 已确定 |
| `ProviderConfigRegistry` | definition authority | validate、register、merge、selection、normalize |
| `STATIC_MODEL_CATALOG` / `StaticModelSpec` | 内置文本模型目录 | 唯一 model/provider ID、context、capabilities、reasoning、defaults |
| `ProviderAdapter` | serializable adapter identity | 不是 runtime trait/object |
| `ApiProfile` | declarative wire profile | runtime 显式解析为 `ash-api::ApiEndpoint` |
| `WebSocketApiProfile` | Responses WebSocket 能力 | 默认 `Unavailable`；不得从 HTTP compatibility 推断 |
| `RealtimeApiProfile` | 独立语音会话协议能力 | 默认 `Unavailable`；与文本 WebSocket 和订阅身份分开授权 |
| `LiveApiProfile` | GPT-Live 会话协议能力 | 明确声明，不能从文本协议推断 |
| `VoiceModelCatalog` / `VoiceModelDefinition` | Provider 的独立语音目录 | 模型、支持的音色与默认值 |
| `VoiceModelConfig` | 可序列化的语音选择 | 与文本模型选择分开，不含密钥 |
| `InputTokenCountDefinition` | provider-owned preflight declaration | profile、target 与明确 model policy |
| `NormalizedInputTokenCountConfig` | runtime-ready count snapshot | 已解析 base URL；不包含 client 或准确度策略 |
| `EndpointPolicy` | provider default 或 configured-only | 不执行 DNS/network validation |
| `ModelCatalogPolicy` | listed-only 或 allow-unlisted | 声明 static gate，由 `ash-models-manager` 执行 canonical resolution |
| `ApiKeyPolicy` | unsupported、optional 或 required | 只声明 host secret binding 要求，不持有密钥 |
| `ApiKeyHeader` | Bearer、`x-api-key` 或 `x-goog-api-key` | 只声明 direct request 的认证 Header 形状，不读取密钥 |
| `ApprovalReviewModelDefault` | automatic review default | active model 或 provider-declared model |
| `ProviderConfigError` | static/normalization error | 不包含 transport/auth failure |

`model_provider_config_schema()` 与 `provider_definition_schema()` 从 Rust types 生成 JSON Schema；
schema 没有第二份手写来源。

## 语音选择

- `ProviderDefinition.voice_models` 声明语音模型目录，`resolve_voice` 完成目录与音色校验。
- `VoiceModelConfig::with_overrides` 按字段合并请求覆盖值与已保存选择；`resolve_voice` 为未指定字段应用目录默认值。
- 未知模型、不支持的音色、重复目录条目或无效默认值会报错，不改用其他模型。
- OpenAI 的语音目录默认选择 `gpt-live-1` 和 `marin`；内置音色与该 Provider 的语音声明一起维护。
- 语音模型不加入文本 Agent 的 `STATIC_MODEL_CATALOG`，不因此获得工具、上下文窗口或文本订阅能力。
- `VoiceModelConfig` 提供配置契约；产品设置持久化与选择界面尚未接入。

## 文件与内部接口

```text
src/
├── connection.rs   # 接入 ID、厂商、认证类型与执行声明
├── config.rs       # user config、normalized config、URL helpers
├── definition.rs   # provider declaration 与 validation
├── input_token_count.rs # count profile、target、model policy 与 normalized snapshot
├── model_catalog.rs # sole built-in model list 与 ProviderDefinition projection
├── registry.rs     # registration、merge、selection、normalization
├── providers/      # provider endpoint、adapter、profile 与 transport declarations
├── error.rs
└── lib.rs
```

| Symbol | 可见性 | 当前职责 | 方向约束 |
| --- | --- | --- | --- |
| `ModelProviderConfig::validate_static` | public method | zero output/context limits 与 configured URL shape | 不依赖 registry或网络 |
| `ProviderDefinition::validate` | public method | name、default endpoint、profile pairing、defaults、catalog uniqueness | definition 自身必须独立有效 |
| `InputTokenCountDefinition::validate` | crate-private method | count URL、non-empty/unique model list | 不探测远端 model availability |
| `STATIC_MODEL_CATALOG` | public constant | 产品内置文本模型及静态 metadata | 文本模型在这里声明；语音目录归 `voice_models` |
| `attach_static_models` | crate-private function | catalog rows → provider models | registry validation 前自动执行 |
| `ProviderConfigRegistry::register` | public method | validate + reject duplicate | built-in/plugin 定义走相同路径 |
| `ProviderConfigRegistry::merge` | public method | prevalidate incoming + explicit conflict policy | merge 不能 partial apply |
| `ProviderConfigRegistry::normalize` | public method | config + definition → normalized snapshot | endpoint/default/profile precedence 在此唯一实现 |
| `normalize_for` | public method | 先 enforce selected/configured provider identity | 防止 model ref 与 config 串线 |
| `automatic_approval_review_model` | public method | provider default 或 active model fallback | 不证明远端 entitlement |
| `validate_model_selection` | public compatibility/preflight method | 显式配置校验 | 内置模型请求不依赖远端目录成员资格 |
| `normalize_base_url` | crate-private function | apply explicit normalization rule | 不追加 API route |
| `is_http_url` | crate-private function | 最小 HTTP(S) shape check | 不是 full URL/network validator |
| `providers::builtin` | crate-private function | 13 个 built-in definitions | 每个 provider 在 sibling module 独立定义 |
| `default_provider` / `configured_provider` | private helpers | shared definition constructors | 不隐藏 provider-specific profile/default differences |

## 规范化调用图

```text
ProviderConfigRegistry::normalize(config)
├─ ModelProviderConfig::validate_static
├─ registry.get(config.provider)
├─ choose base URL
│  ├─ non-empty configured override
│  ├─ EndpointPolicy::ProviderDefault
│  └─ ConfiguredOnly without value → MissingBaseUrl
├─ normalize_base_url(definition rule)
├─ is_http_url
├─ choose max_output_tokens
│  └─ config value overrides provider default
├─ normalize input token count
│  ├─ InvocationBase → normalized invocation base
│  ├─ ProviderDefault + no override → declared count base
│  └─ ProviderDefault + endpoint override → disabled
└─ NormalizedModelProviderConfig
```

`model_context` 不进入 `NormalizedModelProviderConfig`，因为它不改变 transport endpoint。本 crate
负责配置声明与校验；`ash-models-manager::ModelCatalogEntry::model_info` 按准确模型身份合并配置，
以目录已知窗口为上限裁剪，并给出压缩阈值建议。Local App Server 将有效信息转换为 Core 预算。
没有可信窗口时由供应商管理上下文，不在本 crate 猜测模型规格。

```text
ProviderConfigRegistry::merge(incoming, policy)
├─ validate every incoming definition
├─ preflight all conflicts when RejectConflicts
└─ extend map only after preflight succeeds
```

Merge 必须 preflight 后一次 extend；在循环中边验证边插入会造成 error 后 registry 部分变化。

## 内置供应商定义

每个 `providers/<name>.rs::definition()` 返回不含文本模型清单的 `ProviderDefinition`，可声明独立语音目录。例如 OpenAI 选择
`OpenAiResponses` 与同 base 的 count profile；Google invocation 使用 compatible base，但
`countTokens` 使用单独声明的 native base；Anthropic 选择 `AnthropicMessages` 并声明默认 max
tokens。Kimi、Google 和 Z.AI 的额外 allow-unlisted count model 是 transport definition 数据；进入产品
模型列表由 `STATIC_MODEL_CATALOG` 提供；计数支持范围由每条接入显式声明，不按模型 ID 前缀猜测。
Provider matrix 和官方依据由系统文档维护，本 README 只固定 definition construction pattern。

OpenAI definition 另外声明 `WebSocketApiProfile::OpenAiResponses`。其他 built-in definition 当前均为
`Unavailable`，包括 HTTP-compatible provider；xAI 的上游 Responses WebSocket 也不会覆盖当前
Chat Completions definition。真实调用仍需 runtime target 和 `ash-api` codec/session client 共同允许。

## 统一静态模型清单

产品内置文本模型只在 `src/model_catalog.rs` 的 `STATIC_MODEL_CATALOG` 中声明。模型自身不带认证方式、执行适配器或端点；订阅和 API 共享同一个厂商＋模型身份。

```rust
static_model! {
    provider: "provider-id",
    id: "model-id",
    name: "Display Name",
    context_window: 1_000_000,
    capabilities: { tools: supported, reasoning: supported },
    reasoning: [low, medium, high],
    model_reasoning_effort: medium,
    default_personality: pragmatic,
}
```

`connection.rs` 维护 `ModelConnectionDefinition`，包含独立 `ModelConnectionId`、所属厂商、订阅/API 类型和执行声明。端点、协议、认证、计数能力和限制属于接入的 transport 定义。GLM 四个服务 ID 共享 `glm` 厂商的唯一模型目录，凭据仍各自独立。`NormalizedModelProviderConfig::upstream_model` 显式处理上游 ID 差异。

后端 profile 以 `connections` 保存所有接入；每次模型绑定时按就绪凭据选择订阅优先的连接。GLM 的顺序为 BigModel Coding Plan、Z.AI Coding Plan、BigModel API、Z.AI API。模型列表固定可选，远端目录缺项不能阻止内置模型请求。请求错误不触发本次模型或接入替换。

`InputTokenCountTarget::InvocationBase` 会跟随显式 endpoint override，适合 count 与 invocation 同一
service surface 的 provider。`ProviderDefault` 只在 invocation 也使用 provider 默认 endpoint 时启用；
一旦用户配置代理或私有 endpoint，normalization 会关闭该 count binding，避免把同一请求绕过代理发到
官方服务。

新增 provider 时同步：

1. 增加 `ProviderAdapter` variant；
2. 新建 private `providers/<name>.rs::definition`；
3. 加入 `providers::builtin()`；
4. 在 runtime crate 增加对应 adapter mapping；
5. 增加 definition/normalization/runtime tests；
6. 更新系统 provider matrix 与 schema fixture。

## 方向偏差检查

- config crate 依赖 `ash-api`/HTTP/secret：runtime state 下沉；
- `ProviderAdapter` 直接存 trait object：declaration 不再 serializable；
- runtime 根据 provider name 猜 API profile：显式 declaration 被绕过；
- runtime 根据 HTTP compatibility 猜 WebSocket：handshake/event/session contract 被绕过；
- runtime 根据 model ID 前缀或 invocation URL 拼 count endpoint：显式 count declaration 被绕过；
- normalization 追加 `/responses` 等 route：endpoint/profile ownership 混淆；
- allow-unlisted 被描述为远端可用：static evidence 被夸大；
- merge conflict 造成 partial registry mutation：config snapshot 不再原子。

## 测试、限制与演进

```text
just test ash-model-provider-config
bazel test //ash-rs/model-provider-config:model-provider-config-unit-tests
```

测试覆盖 serde/schema、defaults、configured-only endpoint、invalid URL/output/context tokens、HTTP/WebSocket
profile pairing、merge semantics、
automatic review model、统一静态目录投影与 metadata contract、catalog gate、built-in completeness 与 provider mismatch。

当前 URL validator 只接受具有非空 authority 的 HTTP(S) shape，不解析 credential、DNS、route 或
reachability。Catalog 也是 declarative snapshot，不代表 account entitlement。未来可以扩充 schema、
definition source 与 catalog metadata，但必须保持 runtime-free、deterministic normalization 和显式
profile selection。
