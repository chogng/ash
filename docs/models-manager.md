# 模型目录系统

> 物理位置：`ash-rs/models-manager/`
> Rust crate：`ash_models_manager`
> 当前状态：Phase 1 core、Ollama/ChatGPT/xAI/Kimi 及部分 API 连接的动态目录、按供应商分文件的持久缓存已实现；跨 provider 的 Agent 模型选择和完整 App Server snapshot API 尚未实现
> Crate 实现说明：[`ash-models-manager` README](../ash-rs/models-manager/README.md)
> Canonical model contract：[`ash-protocol` model catalog](../ash-rs/protocol/src/model/catalog.rs)
> Provider wire adapter：[`ash-api.md`](ash-api.md)
> Provider runtime：[`model-provider.md`](model-provider.md)
> Operation client：[`ash-client.md`](ash-client.md)
> 底层网络：[`ash-http-client` README](../ash-rs/http-client/README.md)

> 官方资料核对日期：2026-07-25。Provider API 与模型生命周期会持续变化，本文固定架构边界和
> 合并语义；具体 endpoint、字段映射与内置 metadata 必须以实现时的官方文档和 contract test
> 为准。

## 快速理解

模型目录系统回答“当前有哪些模型可选、这些信息有多可信”；它管理发现、内存缓存和合并，不执行
模型调用。当前静态目录、动态 source port、snapshot/generation、singleflight、merge/filter/resolve
已经落地；Ollama、ChatGPT、xAI、Kimi 和部分 API 连接的目录读取已接入，其他 provider discovery 与完整客户端协议仍按后续阶段推进。

| 读者首先会问 | 直接答案 | 深入阅读 |
| --- | --- | --- |
| 模型列表来自哪里？ | 桌面选择器显示内置固定目录；TUI 显示当前连接发现或缓存观察到的模型；目录元数据由来源合并 | [当前实现状态与仓库审计](#2-当前实现状态与仓库审计) |
| 为什么某个模型没有出现？ | 可能是供应商不支持发现、缓存尚未刷新、生命周期过滤或能力不匹配 | [供应商发现策略](#6-供应商发现策略) |
| 什么时候访问供应商？ | 依据新鲜度、显式刷新和缓存状态决定，并使用 singleflight 合并并发刷新 | [何时请求](#7-何时请求) |
| 模型目录能否证明模型支持某项能力？ | 不能；缺失字段表示未知，不能被解释为明确不支持 | [发现能力不是模型能力](#63-发现能力不是模型能力) |
| Agent 请求的模型不可用时怎么办？ | 计划由同一个控制面按明确策略先选择同 provider 兼容模型，再选择其他允许 provider，并把替换警告随运行冻结；当前尚未实现 | [模型选择与替换](#103-模型选择与替换) |
| 谁真正调用模型？ | 已选模型交给模型运行时，目录系统不拥有请求、重试或传输 | [职责与非职责](#3-职责与非职责) |

## 1. 结论

`ash-models-manager` 是 Ash 的模型目录控制面。它统一管理各个 provider 可用模型的发现、
缓存、合并、筛选和面向上层的 catalog snapshot，负责决定：

- 何时请求 provider，何时直接使用缓存或静态 metadata；
- 如何把 provider 动态结果、内置 metadata、用户配置和本地模型状态合并；
- 如何在“不知道”与“明确不支持”之间保持区别；
- 如何按 Agent 所需能力、生命周期和用户策略筛选模型；
- 如何在启动前按准确模型、同 provider、其他允许 provider 的顺序生成确定性的模型选择结果；
- 如何向 App Server、Desktop、CLI、TUI 和 Agent runtime 暴露一致的模型信息。

它不是新的模型调用 client，也不是第二个 provider registry。边界固定为：

```text
provider adapter 负责“如何向某家服务取回原始模型目录”
models manager 负责“何时取、如何缓存、如何合并、如何解释、如何选择和如何发布”
model provider 负责“如何用已选模型执行一次调用”
```

模型列表接口不能被当作完整 metadata authority。各家返回信息差异很大：

- OpenAI、DeepSeek 一类接口主要返回 ID、owner、created 等基础信息；
- Anthropic、Gemini、xAI 能返回部分或较丰富的 capability、token limit、modality、
  alias 或 pricing metadata；
- Hugging Face 的 Hub catalog、Inference Providers router 和实际下游 provider 是不同 scope，
  coverage 需要单独声明；
- 一些 provider 目前只有官方静态模型矩阵，没有文档化的 runtime catalog endpoint；
- OpenAI-compatible 自定义服务对 `GET /models` 的支持和字段质量都不能假定。

因此 manager 必须做字段级 merge，并为每个字段保留来源与可信度；禁止因为某次响应没有某个
字段，就把已有的已知值覆盖成“不支持”，也禁止根据 model ID 字符串猜测工具、推理或上下文
能力。

## 2. 当前实现状态与仓库审计

当前模型相关职责分布如下：

| 位置 | 已有职责 | 不应继续扩张的方向 |
| --- | --- | --- |
| `ash-protocol::model::catalog` | identity、`ModelInfo`、capability、availability/freshness/lifecycle/quality value | 请求调度、缓存、provider DTO、refresh state |
| `ash-model-provider-config` | provider definition、endpoint/default、静态 seed models、配置归一化 | HTTP、凭据读取、动态 discovery、TTL |
| `ash-models-manager` | scope、静态 seed、memory cache、source port、singleflight、merge/filter/resolve、有效模型信息和 snapshot generation；长期拥有 provider 无关的模型候选选择 | provider DTO、secret、调用、Agent 定义解析、Config persistence、UI |
| `ash-model-provider` | provider runtime、adapter 选择、模型调用、manager static resolution consumer | catalog policy、跨 provider merge、UI 查询 |
| `ash-api` | endpoint/request/event 的 Provider wire codec | transport、retry、catalog authority、用户筛选 |
| `ash-http-client` | HTTP execution 与共享 proxy/TLS/target policy | Provider DTO、catalog policy、模型选择 |
| `ash-websocket-client` | WebSocket handshake/message execution | Provider event、session state、catalog policy、模型选择 |
| `ash-client` | operation retry、SSE/NDJSON framing、telemetry | Provider DTO、catalog policy、模型选择 |
| `ash-config` | 用户配置 authority、patch/merge/persistence | provider 请求和进程内 refresh task |
| App Server / clients | 组合、RPC、展示与交互；Local App Server 已投影 shared manager | 各自维护模型表或推断 capability |

`ProviderDefinition.models` 当前只作为启动 seed 和内置 metadata 来源，不兼任动态可用性缓存。
`ModelProviderRuntime::resolve_model` 已消费 manager 的 static resolution；Local App Server 的
`model/list` 的 `discovered` 视图读取同一个 manager clone 中当前 scope 最新成功发现的模型身份；
`builtIn` 视图读取 `STATIC_MODEL_CATALOG`，不读取登录状态或发现结果。Session model validation
仍使用同一个 manager 的静态解析，不另行维护 `ListedOnly` / `AllowUnlisted` 判断。

当前实现边界如下：

| 能力 | 状态 | 实现证据 |
| --- | --- | --- |
| 静态 seed、确定排序、typed resolution | ✅ | `ModelsManager::{static_snapshot,list_static,resolve_static}` |
| 动态 source port、scope 校验、partial/complete merge | ✅ | `ModelCatalogSource`、`commit_discovery`、`apply_discovery` |
| per-scope memory cache、freshness、singleflight | ✅ | `ManagedScope`、`ScopeState`、`ModelsManager::{read,refresh}` |
| 按账户持久缓存和最新发现身份筛选 | ✅ | `ModelCatalogDiskCache`、`ModelsManager::list_discovered` |
| 字段 provenance 与 Unknown 保留 | ✅ | `CatalogRecord`、`ModelMetadataProvenance` |
| 配置生效后的模型信息、上下文裁剪和压缩建议 | ✅ | `ModelCatalogEntry::model_info`；保留原始目录证据，App Server 消费结果 |
| model-provider/App Server 静态目录统一 | ✅ | `ModelProviderRuntime::models_manager`、`ConfigBackedModelService` |
| 真实 provider discovery adapters | 部分具备 | Ollama、ChatGPT、xAI、Kimi 和部分 API 连接已接入；其他 provider 留在后续阶段 |
| Agent 启动时的继承、覆盖和跨 provider 替换 | 尚未完成 | 当前 `resolve` 只校验一个准确 `ModelRef`；尚无统一候选选择、替换记录和客户端警告 |
| persisted observation cache | ✅ | profile 内的 `cache/models/<provider>.json`，按供应商分文件、按账户 scope 隔离、原子写入 |
| backoff/jitter、并发总闸 | 尚未完成 | 后续 core hardening |
| `model/refresh`、`model/updated`、完整 snapshot DTO | 尚未完成 | Phase 3 |

现有 `ModelInfo` 也存在后续需要修正的语义缺口：

- 一个 `ContextWindow` 无法区分 total context、最大输入和最大输出；
- capability 只覆盖 tools、reasoning、parallel tools 和 personality，无法表达 input modality、
  structured output 或 workload kind；
- 没有 availability、freshness、lifecycle、字段来源和诊断信息；
- `Option<u32>` 同时可能表示“未知”“未配置”或“不适用”。

这些缺口应通过 protocol value 演进解决，不能在 manager 对外 API 中重新发明一套同名 DTO。

## 3. 职责与非职责

### 3.1 Manager 拥有

- provider catalog scope 的稳定识别；
- 首次加载、按需 refresh、显式 refresh 和后台 refresh 策略；
- per-scope cache、TTL、stale-while-revalidate、stale-if-error；
- per-scope singleflight、并发上限、退避和抖动；
- provider discovery、内置 metadata、用户 override 和历史 cache 的字段级 merge；
- model lifecycle、availability、metadata quality 和 freshness projection；
- capability/workload/visibility filter；
- `(ProviderId, ModelId)` 的解析、校验和稳定排序；
- 启动前的 provider 无关模型选择：请求模型、同 provider 候选、跨 provider 候选、兼容性检查和替换说明；
- 模型专化 instructions 的资产、revision 与准确模型选择；所有 Agent 共用规则由 `ash-prompts` 拥有，详见 [指令组合](../ash-rs/docs/agent-instructions.md)；
- immutable `ModelCatalogSnapshot` 及 generation 变化；
- cache/refresh/merge 的诊断信息和不含秘密的 telemetry。

### 3.2 Manager 不拥有

- API key、OAuth token、secret persistence 或 credential refresh；
- provider HTTP DTO、认证 header、endpoint 拼接和分页 wire codec；
- completions/responses/messages 请求执行和最终 context 组装；
- prompt/context KV cache 的创建、breakpoint、TTL、usage 解析或计费语义；
- SSE/NDJSON/WebSocket 的 ping、空行、注释帧、读超时和断线重连；
- 本地模型进程的预热、驻留和卸载；
- Config 文件 authority 或 provider definition registry 的注册事务；
- 模型价格账单、quota authority 或 rate-limit enforcement；
- Session、Thread、Turn 的 durable state；
- UI 中 picker 的布局、搜索输入和用户交互；
- 通过真实 inference 请求“试探”模型能力。

价格可以将来作为带来源和更新时间的展示 metadata 进入 snapshot，但不能被当作 billing
authority；实际费用以 provider 账单和调用 usage 为准。

### 3.3 四类不能混用的“缓存/保活”

厂商文档中的 cache、keep-alive 和 heartbeat 不是同一个概念，必须按运行时边界拆开：

| 机制 | 含义 | 所属层 |
| --- | --- | --- |
| Catalog cache | Ash 缓存模型列表、availability 和 metadata observation | `ash-models-manager` |
| Prompt/context cache | 厂商复用 prompt prefix/KV tensor，影响推理延迟、费用和 usage | `ash-api` provider adapter |
| Stream liveness | raw byte activity/读超时属于 `ash-http-client`；SSE/NDJSON frame activity 属于 `ash-client` | Provider event 语义由 `ash-api` 解释 |
| Model residency | 本地模型是否继续驻留 CPU/GPU 内存 | `ash-model-provider` 本地 runtime；wire 参数仍由 `ash-api` 编码 |

官方行为已经证明这些机制不能抽象成 manager 中的统一 `heartbeat`：

- [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) 允许在
  SSE 消息事件之间发送 `ping`；
- [DeepSeek request keep-alive](https://api-docs.deepseek.com/quick_start/rate_limit/) 对非流式
  请求发送空行，对流式请求发送 SSE `: keep-alive` 注释；
- [Ollama streaming](https://docs.ollama.com/api/streaming) 使用
  `application/x-ndjson`，而请求参数
  [`keep_alive`](https://docs.ollama.com/api/generate) 表示模型在内存中的驻留时间。

Prompt cache 同样是调用语义而非 catalog cache：
[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)、
[Claude Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 和
[Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching/) 的启用方式、TTL、
breakpoint 和 usage 字段均不同。Manager 最多把“某模型是否支持某类 prompt cache”作为带来源的
capability metadata 暴露，不能创建、续期或命中厂商推理 cache。

具体依赖边界固定为：

- `ash-protocol` 只在确实需要跨 crate/进程表达时定义 provider-independent 的 cache intent、
  normalized usage 和 stream event value；
- `ash-api` 将 canonical request 转成 `prompt_cache_key`、`cache_control`、`cached_content`
  等 provider wire 字段，解析 cache usage，并过滤/解释 provider-specific 心跳帧；
- `ash-model-provider` 选择具体 `ash-api` endpoint/profile，提供 resolved endpoint、固定 header 和
  retry policy，但不解释某家厂商的 cache breakpoint、TTL 或 SSE event；
- `ash-http-client` 执行 HTTP、transport timeout 和 diagnostics；`ash-client` 执行 operation
  retry 与 SSE/NDJSON framing，但都不解释 Provider event；
- `ash-models-manager` 只维护模型是否支持相关能力的 catalog metadata，不参与一次调用的
  cache 生命周期或流式连接。

## 4. 依赖方向与组合

目标依赖关系中，箭头表示“依赖”：

```text
ash-models-manager
  ├──▶ ash-protocol
  └──▶ ash-model-provider-config

ash-model-provider
  ├──▶ ash-model-provider-config
  ├──▶ ash-models-manager       # implements ModelCatalogSource
  ├──▶ ash-api ───▶ ash-client
  ├──▶ ash-client
  ├──▶ ash-http-client
  └──▶ ash-secrets             # direct-provider credential only

App Server composition
  ├──▶ ash-model-provider
  └──▶ ash-models-manager

ash-chatgpt
  └──▶ ash-model-provider       # subscription authenticated-target adapter
```

具体规则：

- `ash-models-manager` 可依赖 `ash-protocol` 和 `ash-model-provider-config`；
- `ash-models-manager` 不依赖 `ash-model-provider`、`ash-api`、`ash-client`、
  `ash-http-client`、`ash-secrets` 或 App Server；
- manager 定义并拥有 `ModelCatalogSource` port，因为它是该 port 的消费者；
- `ash-model-provider` 实现该 port，复用已有 adapter、normalized endpoint、operation/HTTP
  clients 和 credential materialization；
- App Server composition root 将同一个 provider runtime 分别作为模型调用能力和 catalog source
  注入，不能再建第二个 HTTP client registry；
- provider-specific discovery DTO 留在 `ash-api` 或 `ash-model-provider` 的私有 adapter
  module，不能进入 protocol。

Google 和 Ollama 说明了为什么 discovery endpoint 不能从调用 base URL 盲目拼接：

- 当前 Google 调用走 `.../v1beta/openai`，但原生模型目录是
  `generativelanguage.googleapis.com/v1beta/models`；
- 当前 Ollama OpenAI-compatible 调用走 `http://localhost:11434/v1`，但本地模型目录是
  `/api/tags`，单模型详情是 `/api/show`。

Provider definition 应显式声明 discovery strategy 或由具体 adapter 解析，禁止 manager 用
`trim_end_matches("/v1")` 一类字符串启发式生成 endpoint。

## 5. 核心领域模型

以下是目标语义，不要求第一版逐字采用这些 Rust 名称。

### 5.1 目录范围

模型可用性不仅取决于 `ProviderId`，还可能取决于：

- normalized base URL 和 region；
- credential account、organization、project 或 tenant；
- provider 配置 revision；
- 本地 Ollama daemon 或自定义 gateway 实例；
- Hugging Face 的 provider routing/account 权限。

因此 cache key 不能只是 `ProviderId`：

```rust
pub struct CatalogScopeKey {
    pub provider: ProviderId,
    pub source_scope: CatalogSourceScopeId,
}
```

`CatalogSourceScopeId` 是由 composition/provider layer 生成的 opaque、稳定 fingerprint。它可以
包含 endpoint identity、credential reference identity 和 config revision 的 hash，但不得包含、
记录或向客户端暴露 secret、token、完整认证 header。

凭据内容轮换但 identity 不变时，credential layer 必须提供 revision，使新旧权限不会错误复用
同一 cache。旧 scope 由 LRU/保留期回收，不做危险的全局 cache clear。

### 5.2 发现结果

Source port 返回 provider-neutral、带覆盖范围的结果：

```rust
pub struct DiscoveredCatalog {
    pub scope: CatalogScopeKey,
    pub coverage: DiscoveryCoverage,
    pub models: Vec<DiscoveredModel>,
    pub validator: Option<CatalogValidator>,
    pub cache_hint: CatalogCacheHint,
    pub fetched_at: SystemTime,
}

pub enum DiscoveryCoverage {
    CompleteFor(ModelWorkload),
    Partial,
}

pub enum CatalogCacheHint {
    NotSpecified,
    RevalidateAfter(Duration),
    ImmutableUntilSourceRevision,
}
```

关键语义：

- `CompleteFor(AgentText)` 表示“本响应完整覆盖该 credential/scope 下可用于 Agent text
  workload 的模型”，此时缺席才可影响 availability；
- `Partial` 表示搜索结果、单模型补充信息或 provider 明确不保证完整性，缺席不能形成 tombstone；
- `CatalogValidator` 表达 ETag、Last-Modified 或 provider revision，而不是随意的字符串；
- `CatalogCacheHint` 只转述官方协议或实际 HTTP 响应给出的证据；manager 会用本地最小/最大
  freshness、错误退避和用户策略计算最终刷新时间；
- provider 没有文档化 cache header、revision 或刷新周期时必须返回 `NotSpecified`，不能根据
  其他 OpenAI-compatible 服务的行为类推；
- raw response、认证 header 和 provider request ID 不进入 snapshot。

### 5.3 元数据 patch 与来源

Discovery、内置 catalog 和配置 override 都转换为 patch，而不是直接构造最终 `ModelInfo`：

```rust
pub struct SourcedModelPatch {
    pub model: ModelRef,
    pub source: MetadataSource,
    pub fields: ModelMetadataPatch,
}

pub enum MetadataSource {
    ProviderLive,
    UserConfigured,
    BuiltinCurated,
    ProviderSeed,
    PersistedObservation,
}
```

每个可合并字段内部保留 `value + source + observed_at`。对外可以压缩为
`MetadataQuality` 和少量 warnings，但诊断接口必须能解释“这个 200K context 从哪里来”。

`CapabilitySupport::{Supported, Unsupported, Unknown}` 的三态必须保留。`Unknown` 不是
`Unsupported`，缺失字段也不是否定证据。

### 5.4 快照

所有消费者读取 immutable snapshot：

```rust
pub struct ModelCatalogSnapshot {
    pub scope: CatalogScopeKey,
    pub generation: u64,
    pub freshness: CatalogFreshness,
    pub entries: Vec<ModelCatalogEntry>,
    pub warnings: Vec<CatalogWarning>,
}

pub enum CatalogFreshness {
    Fresh,
    StaleUsable,
    Expired,
    StaticOnly,
}
```

同一 scope 只有在 consumer-visible 内容变化时才递增 generation。单纯 refresh 得到完全相同的
结果，只更新内部 observation time，不制造无意义的 `model/updated`。

排序必须确定，snapshot 中 model ID 不得重复。相同 generation 的序列化结果必须稳定，便于
App Server、Desktop 和 contract tests 比较。

## 6. 供应商发现策略

### 6.1 官方能力矩阵

`Discovery mode` 描述 Ash 如何组合实时 availability 与 curated metadata，不代表厂商承诺了
客户端刷新频率。

| Provider | Discovery mode | 推荐 discovery | 官方响应可提供的信息 | 初始策略 |
| --- | --- | --- | --- | --- |
| OpenAI | Hybrid | [`GET /v1/models`](https://developers.openai.com/api/reference/resources/models/methods/list) | ID、created、owner；官方描述为基础信息 | 动态 availability + 内置能力 metadata |
| Anthropic | Dynamic/Hybrid | [`GET /v1/models`](https://platform.claude.com/docs/en/api/models/list) | ID、display name、token limits，并可返回 thinking、effort、image、structured output 等 capability | 优先使用动态字段，内置补缺 |
| Google Gemini | Dynamic/Hybrid | [`models.list`](https://ai.google.dev/api/models) | display name、input/output limit、generation methods、thinking 等 | 使用原生 Gemini endpoint，不走 OpenAI-compatible base URL |
| xAI | Dynamic/Hybrid | [`GET /v1/language-models`](https://docs.x.ai/developers/rest-api-reference/inference/models) | modality、aliases、fingerprint、部分价格；比 `/v1/models` 丰富 | Agent text 使用 language-models |
| Kimi | Unknown/StaticOnly | 当前可访问的[官方平台文档](https://platform.moonshot.ai/docs/)未确认本设计所需的 authenticated list contract | `Unknown` | 使用 curated metadata；取得官方 reference/fixture 前不猜 `/models` |
| DeepSeek | Hybrid | [`GET /models`](https://api-docs.deepseek.com/api/list-models) | 基础 ID、owner | 动态 availability + 内置能力 metadata |
| Ollama | Dynamic local | [`GET /api/tags`](https://docs.ollama.com/api/tags) + 按需 `/api/show` | 本地已安装模型、family、size、quantization；详情可补 template/model info/capability | 高频短 TTL；只对可见候选按需取详情 |
| Hugging Face | Dynamic/Hybrid | [Router `GET /v1/models`](https://huggingface.co/docs/inference-providers/hub-api) | modality、live provider、context、tools、structured output、价格/延迟等 | 过滤 conversational/live route，限制结果规模 |
| MiniMax | StaticOnly（待核实） | [官方 models guide](https://platform.minimax.io/docs/guides/models-intro) | 静态模型、feature 和 endpoint 信息 | 未确认 authenticated list API 前不猜 `/models` |
| Qwen / Model Studio | StaticOnly（待核实） | [官方模型矩阵](https://help.aliyun.com/en/model-studio/models) | region、API surface、模型能力由静态文档描述 | 未确认官方 inference list 前不假定 `/models` |
| Z.AI | StaticOnly（待核实） | [官方模型矩阵](https://docs.z.ai/guides/overview/overview) | 模型类型、context 和能力由静态文档描述 | 动态 endpoint 需官方文档确认 |
| Xiaomi MiMo | Unknown/StaticOnly | 当前未找到可访问、可核对的官方网络协议 reference | `Unknown` | 仅使用已审阅的 configured metadata；动态 endpoint 需官方文档确认 |
| OpenAI-compatible | Unknown/Hybrid | best-effort `GET /models` | 完全取决于 gateway | adapter capability 检测；失败后转静态/用户配置 |

该表只说明“可从哪里发现什么”，不把某个具体 model ID 固化成架构。内置 metadata 需要带
`reviewed_at` 和官方 source URL，并通过定期维护更新。

上述官方模型列表文档主要规定 endpoint、认证、分页和响应 schema。除非 provider profile
另外引用了明确的 HTTP cache 文档，否则不得认为厂商承诺 `Cache-Control`、ETag、
Last-Modified、固定 TTL、catalog push 或 heartbeat。实现时还必须通过不含秘密的 contract test
记录真实响应头；观察到但未文档化的 header 只能作为优化，不能成为正确性前提。

### 6.2 供应商验证记录

每个内置 provider 必须维护一份可审阅的 profile，可以是对应 adapter module 的测试 fixture 和
文档注释，不要求拆成独立 crate。至少记录：

```text
official_sources
verified_at
discovery_endpoint_and_auth
response_schema_and_pagination
coverage_semantics
static / dynamic / hybrid / unknown
documented_cache_headers_or_revision
observed_cache_headers
refresh_triggers
negative-cache-invalidators
```

其中“官方未说明”和“尚未验证”必须保持为 `Unknown`，不能填写从相似 provider 推导出的默认值。
官方文档变化后，先更新 profile/fixture，再调整 adapter 和内置 metadata。

### 6.3 发现能力不是模型能力

Provider definition 需要显式表达目录能力：

```rust
pub enum ModelDiscoveryStrategy {
    Native(ProviderDiscoveryKind),
    OpenAiCompatible,
    StaticOnly,
    Disabled,
}
```

不能使用 `supports_discovery: bool`，因为 `Native`、best-effort compatible、static-only 和
明确禁用是不同语义。`ProviderDiscoveryKind` 由 provider runtime 解释，manager 不分支判断
Anthropic、Gemini 或 Ollama。

Discovery wire strategy 与 refresh mode 也要分开：前者决定 endpoint/codec，后者由 manager 根据
source profile、HTTP cache hint、本地 policy 和当前错误状态计算。不能因为实现了 `GET /models`
就自动启动固定周期轮询，也不能因为存在静态 seed 就跳过用户显式 refresh。

### 6.4 禁止推理探测

Manager 不通过发送“hello”、空 prompt、tool call 或超小 `max_tokens` 请求探测能力，原因是：

- 会产生费用、配额消耗和外部副作用；
- 失败无法可靠区分“不支持”、参数不兼容、权限或临时故障；
- 会把 catalog refresh 变成真实模型调用；
- 可能把用户凭据用于未明确触发的内容生成。

能力只能来自官方 discovery 字段、经过审阅的内置 metadata 或用户显式 trust override。

## 7. 何时请求

### 7.1 Read 策略

调用方使用具名策略，不传 `fresh: bool`：

```rust
pub enum CatalogReadPolicy {
    CachePreferred,
    RequireFresh,
    CacheOnly,
}
```

语义固定为：

| 当前状态 | `CachePreferred` | `RequireFresh` | `CacheOnly` |
| --- | --- | --- | --- |
| Fresh | 立即返回 | 立即返回，除非调用方显式执行 refresh | 立即返回 |
| StaleUsable | 立即返回并触发后台 refresh | 等待/join refresh | 返回 stale |
| Expired | 等待/join refresh；失败按 stale-if-error policy 决定 | 等待 refresh，失败返回错误 | 返回 expired snapshot |
| 无 cache | 等待首次 discovery | 等待首次 discovery | 返回 cache miss |
| StaticOnly | 返回静态 snapshot | 返回静态 snapshot 和不可动态刷新的状态 | 返回静态 snapshot |

### 7.2 刷新触发条件

允许触发请求的事件：

- App Server 启动后，对 preferred/current provider 做低优先级 warm-up；
- 某个 scope 首次执行 `model/list`；
- cache 从 Fresh 进入 StaleUsable 后的首次读取；
- 用户显式执行 refresh；
- provider config、endpoint、credential revision 或 tenant scope 改变；
- 本地 Ollama picker 打开或本地 daemon 状态恢复；
- provider adapter 明确发送 catalog invalidation（将来可选）。

不得在以下位置隐式阻塞网络：

- protocol deserialize；
- Config reducer/commit；
- Thread reducer 或 rollout recovery；
- 已开始的模型调用中途；
- 仅渲染已有 snapshot 的 UI frame。

Turn 创建 `ModelInvocationSnapshot` 时只解析已经选定的 `ModelRef`。普通 TTL refresh 不改变已经
开始的调用；新 catalog 只影响下一次 picker read 或下一个安全点的 model resolution。

### 7.3 Singleflight 与并发

- 相同 `CatalogScopeKey` 同时最多一个 refresh；
- `RequireFresh` 和首次读取 join 现有 refresh，不重复请求；
- 不同 scope 可以并行，但受全局和 per-provider 并发上限约束；
- 慢 provider 不持有 catalog write lock；网络 I/O 完成后以短临界区 compare-and-swap snapshot；
- refresh result 必须校验 scope generation，旧配置启动的晚到响应不得覆盖新 scope；
- shutdown/cancellation 停止 refresh task，不提交半个分页结果。

分页 discovery 要么产生声明为 `CompleteFor` 的完整结果，要么失败/降级为 `Partial`，不能把只取到
第一页的结果伪装成完整目录。

## 8. 目录缓存语义

本章只讨论 Ash 对模型目录 observation 的缓存，不讨论厂商 prompt/context cache、stream
keep-alive 或本地模型驻留。后三者的 provider-specific 行为分别留在 `ash-api` codec、
`ash-http-client` transport、`ash-client` framing 和本地 runtime。

### 8.1 两层缓存

第一版至少提供：

1. process-local memory cache：读取热路径、singleflight state 和 immutable snapshots；
2. persisted observation cache：改善重启和离线体验，但只是可删除的目录副本。

Ash profile 的 `cache/models/<provider>.json` 由 manager 统一读写，例如 OpenAI/ChatGPT 为 `openai.json`，xAI/Grok 为 `xai.json`。Manager 决定 scope、schema、freshness 和写入时机；同一供应商文件内按接入方式和账户 scope 隔离，各订阅来源只提供已认证的目录读取逻辑。持久层不得成为模型可用性的 authority。损坏或不兼容的供应商文件会在该供应商下一次成功发现时重建。

已有 Codex 登录可通过本地 Codex `model/list` 读取其当前账户校验过的目录，再转换为 Ash 的记录；不直接复制 Codex 缓存中的不透明身份字段。Grok 的本地缓存可能包含凭据，Ash 通过已登录的模型目录请求提取模型信息，不复制原始缓存。Kimi Code 的已知订阅型号通过自己的目录来源写入 `kimi.json`，按登录设备隔离。未来 GLM 与 OpenCode 的订阅来源分别写入 `zai.json` 和 `opencode.json`。

持久记录只保存 normalized metadata、scope fingerprint、官方 source revision 和时间，不保存：

- API key、token、cookie、认证 header；
- raw provider response；
- 完整 endpoint query 中可能包含的秘密；
- provider 返回的非必要账号信息。

### 8.2 Freshness 策略

使用具名 policy：

```rust
pub struct CatalogFreshnessPolicy {
    pub fresh_for: Duration,
    pub stale_while_revalidate_for: Duration,
    pub stale_if_error_for: Duration,
}
```

以下是 Ash 的建议默认值，不是厂商官方 TTL，也不是跨 provider 的协议保证：

| Source | Fresh | 后台刷新可用期 | 临时错误最大 stale |
| --- | --- | --- | --- |
| 远程 provider | 15 分钟 | 24 小时 | 7 天 |
| 本地 Ollama | 2 秒 | 30 秒 | 5 分钟 |
| StaticOnly | 不过期 | 不适用 | 不适用 |
| Unsupported discovery negative cache | 24 小时 | 不适用 | 配置变化时立即失效 |

这些值由 manager policy/config 调整，不进入 `ash-protocol`。测试必须使用注入 clock，禁止真实
sleep。

### 8.3 HTTP 校验器与退避

- provider 官方文档或实际响应支持 ETag/Last-Modified 时使用 conditional request；
- `304` 只延长 freshness，不重建 generation；
- `429`、`5xx`、timeout 和网络错误使用 exponential backoff + jitter；
- `401/403` 不做长时间自动重试，等待 credential/config revision 或用户显式 refresh；
- `404/405/501` 可标记 discovery unsupported，并进入 negative cache；
- 成功请求会清除该 scope 的 transient backoff；
- 用户显式 refresh 可以绕过 TTL，但仍要 join singleflight 和服从最小防抖间隔。

实际响应中观察到但官方未保证的 validator 可以用于性能优化；服务器停止返回 validator 时必须
退回普通 discovery，不能导致目录不可刷新。`Cache-Control` 也必须经过 manager 配置的
minimum/maximum freshness clamp，不能让异常 gateway 无限延长 availability。

### 8.4 Heartbeat 与健康恢复

Models manager 第一版没有通用 heartbeat：

- catalog 请求是有边界的普通 HTTP discovery；transport timeout/cancel 由 `ash-http-client`
  执行，operation retry 由 `ash-client` 执行；
- completions/messages 的 SSE/NDJSON framing 由 `ash-client` 完成，Provider heartbeat event
  由 `ash-api` decoder 消费，不能进入
  `DiscoveredCatalog`；
- Ollama daemon 的存活和模型驻留由本地 provider runtime 管理，manager 只响应
  `source revision changed` 或显式 invalidation；
- 不允许通过定期 inference 请求充当 provider 健康探测。

只有当某 provider 官方提供模型目录 watch/change feed 时，未来才增加 provider-specific
invalidation source。长连接的 transport ping/pong 由 `ash-http-client` 管理，SSE/NDJSON frame
activity 由 `ash-client` 管理；manager 只接收
`CatalogInvalidated { scope, revision }` 这类领域事件。

## 9. 合并规则

### 9.1 身份

唯一 identity 始终是：

```text
(ProviderId, exact ModelId)
```

- 不把不同 provider 的同名模型合并；
- 不 lowercase 或改写 provider model ID；
- alias 仍以调用时的 exact ID 保留；
- 只有 provider 明确返回 alias target 时，UI 才可分组展示；
- stable alias 与 dated/pinned version 不自动互换；
- 历史 Thread 中的 `ModelRef` 即使不再可用也必须可显示。

### 9.2 字段优先级

推荐默认优先级：

```text
用户显式 trust override
    > provider live 的明确字段
    > 内置 curated metadata
    > ProviderDefinition seed
    > persisted observation
    > Unknown
```

但 availability 与 visibility 不使用这条简单顺序：

- availability 由当前 scope 下最近一次完整 provider observation 决定；
- user hidden/disabled 是本地 visibility/policy，不伪装成 provider unavailable；
- 静态 seed 表示“Ash 知道该模型”，不表示当前 credential 一定有权限；
- provider 完整列表缺席可把该 scope 的模型标为 `Unavailable`，但不删除 metadata；
- partial result 缺席不改变 availability；
- persisted observation 在 live refresh 后只能补缺，不能覆盖更新的 live 字段。

### 9.3 Patch 规则

- `Unknown` 不覆盖 `Supported` 或 `Unsupported`；
- provider 明确返回 unsupported 可以覆盖旧的 curated supported；
- 数值 limit 只接受正数并记录其语义类型；
- 冲突的 total/input/output limit 不互相强行换算，产生 warning；
- display name 可由用户自定义，但 exact model ID 永不改变；
- provider 未返回 lifecycle 时，不根据 ID 中是否含 `preview` 直接断言；内置规则可以给出
  `Inferred` label，但不能当作 provider fact；
- model 从 live catalog 消失时保留一段 tombstone retention，供历史显示、配置诊断和 UI
  迁移提示使用。

### 9.4 用户配置分层

用户 override 分为两类，不能混成一个任意 JSON patch：

```text
Policy override
  hidden / pinned / display alias / preferred / allowed lifecycle

Trust override
  context limits / modalities / tools / reasoning / structured output
```

Policy override 不改变事实 metadata。Trust override 用于自定义 gateway 或 provider 文档缺失场景，
必须显式标记为 `UserConfigured`，经过静态 validation，并在诊断中可见。

对于 limit，manager 可以允许用户收紧已知值；若用户扩大 provider 已知上限，应产生
`OverridesProviderLimit` warning，避免静默制造不安全的 context budget。

## 10. 筛选、解析与排序

### 10.1 筛选流程

面向 Agent 模型 picker 的顺序固定为：

```text
scope/provider 选择
→ workload kind
→ provider availability
→ lifecycle / local policy
→ required capabilities
→ 用户搜索
→ 稳定排序
```

第一步先排除 embedding、image-only、speech-only 等不能处理当前 canonical `ModelRequest` 的模型。
不能因为 `/models` 返回了某个 ID，就默认它是聊天模型。

Capability query 使用集合与显式 unknown policy：

```rust
pub struct ModelQuery {
    pub workload: ModelWorkload,
    pub required_capabilities: BTreeSet<ModelCapability>,
    pub unknown_capability: UnknownCapabilityPolicy,
    pub availability: AvailabilityFilter,
}

pub enum UnknownCapabilityPolicy {
    IncludeWithWarning,
    Exclude,
}
```

禁止使用 `tools: bool`、`include_unknown: bool` 等难以扩展的参数组合。

### 10.2 解析不是简单列表查找

Agent runtime 应调用 manager 的 typed resolution：

```text
resolve(ModelRef, ModelRequirements, ResolutionPolicy)
    → ResolvedModel
```

它需要检查：

- provider/config scope 是否匹配；
- model 是否满足 `ListedOnly` / `AllowUnlisted`；
- 当前 workload 和强制 capability 是否满足；
- model 是否明确 unavailable/retired；
- 选择使用的 metadata snapshot generation；
- 是否带有 stale、unknown 或 user-trust warning。

Catalog 不应成为错误的授权替代品：

- `AllowUnlisted` 下，用户显式填写的 model ID 可以继续进入 provider 调用，manager 返回
  unverified metadata；
- `ListedOnly` 下，只接受当前可用或本地明确注册的条目；
- provider 最终仍可能因权限、region 或下线返回错误，runtime 必须保留真实 provider error；
- manager 不把一次调用失败永久改写为 model unavailable，除非随后完整 refresh 证实。

### 10.3 模型选择与替换

> 状态：Proposed。当前 `ModelsManager::resolve` 只校验一个准确模型；本节规定 Agent、工作流和其他上层以后共用的模型选择契约。

`ash-models-manager` 应拥有 provider 无关的候选选择，不能把排序复制到 App Server、Core、Agent 定义或各 provider adapter。`ash-agent-roles` 声明 Agent 的默认值、覆盖权限、替换范围和模型要求；App Server 将这些值连同 Session 或工作流基线转换成通用选择请求，manager 不依赖 `ash-agent-roles`。

计划中的通用输入与结果至少表达：

```rust
pub struct ModelSelectionRequest {
    pub baseline: ModelSelectionTarget,
    pub preferred: Option<ModelRef>,
    pub requested_override: Option<ModelRef>,
    pub override_policy: ModelOverridePolicy,
    pub replacement_policy: ModelReplacementPolicy,
    pub requirements: ModelRequirements,
    pub eligible_scopes: Vec<CatalogScopeKey>,
}

pub struct ModelSelectionDecision {
    pub requested: ModelRef,
    pub selected: ResolvedModelSelection,
    pub substitution: Option<ModelSubstitution>,
}
```

`ModelSelectionTarget` 在进程内绑定准确 `ModelRef` 与 `CatalogScopeKey`；`ResolvedModelSelection` 还包含所选 scope、目录 generation 和已解析 metadata。opaque scope 不进入客户端或持久记录，跨边界只保存不含秘密且足以恢复的 provider、执行 runtime、访问来源和配置 revision。App Server 负责从当前 Session、工作流、已配置 provider 和账号授权生成有序 `eligible_scopes`，但不在其中筛选或排序模型。

选择分为两步。第一步确定请求模型：获准的本次显式覆盖优先于定义偏好，定义偏好优先于基线；禁止覆盖时收到显式请求必须返回类型化错误，不能静默忽略。第二步从目录选择实际模型：

1. 请求的准确模型。
2. 同一 scope、目录明确属于同一模型族的兼容模型。
3. 同一 scope 的其他兼容模型。
4. 同 provider 的其他已允许 scope 中的兼容模型。
5. 其他已允许 provider 的兼容模型。

模型族、替换优先级、scope 顺序和 provider 顺序必须来自 provider 明确事实、内置可审阅 metadata 或用户策略，不能解析模型 ID 猜测。每个候选都要重新检查 workload、工具调用、输入类型、上下文长度、推理等级、结构化输出、执行 runtime、生命周期、账号可用性、区域、组织策略和费用限制。自动替换只能选择目录证明为可用的候选；`Unverified` 或 `Unknown` 可以按策略保留给用户准确指定的模型，但不能成为自动替换目标。

同一个 `ProviderId` 下可以同时存在不同 endpoint、API key、企业租户、用户订阅和本地 runtime，因此“同 provider 优先”必须先保持同一 scope。切换到同 provider 的另一个 scope 仍可能改变凭据、数据边界和计费来源，必须受 `eligible_scopes` 限制，并在选择结果中作为访问来源变化单独记录；它不能被当作普通同模型族替换。

推理等级与服务等级只能在实际模型确定后解析。调用方把某个等级声明为硬要求时，不支持该等级的模型不是兼容候选；只声明偏好时，可以采用所选模型明确公布的默认值并产生警告。不同 provider 的等级名称不能按枚举位置或字面相似度自动映射，也不能把更高费用的服务等级当作无影响替换。

替换成功不是错误。结果必须记录请求模型、实际模型、原因、是否改变访问 scope、是否跨 provider、每个参与 scope 的 generation 和最终推理配置，并在运行开始前向客户端产生非阻塞警告；改变访问 scope 或跨 provider 的警告必须明确显示变化。`ModelReplacementPolicy::None` 表示要求准确模型；它与禁止本次覆盖组合后即可表达严格模型要求，不增加一个同时混合默认值、覆盖权和失败语义的 `Fixed` 类型。

替换只发生在 Agent 或工作流运行创建前。目录刷新不能修改已经冻结的运行，一次 provider 调用失败也不能触发换模型后重放；后者属于可能产生重复工具调用或费用的调用重试问题，不是目录选择。

### 10.4 稳定排序

默认排序建议使用：

1. user pinned/preferred；
2. provider 配置顺序；
3. usable availability；
4. stable/preview/legacy lifecycle；
5. curated family rank；
6. case-preserving display name；
7. exact model ID。

不得通过字符串或语义版本猜测“最大/最新”模型。Provider 的 `latest` alias 作为普通、可能漂移的
alias 展示，并明确 lifecycle，不自动排在 pinned version 之前。

## 11. 向上暴露

### 11.1 协议值

建议在 `ash-protocol` 演进共享值，而不是在 App Server wire 层复制：

```text
ModelCatalogSnapshot
ModelCatalogEntry
ModelAvailability
ModelLifecycle
CatalogFreshness
MetadataQuality
CatalogWarning
TokenLimits
ModelModality / ModelWorkload
ModelSelectionRecord
ModelSubstitution
```

`ModelInfo` 建议收敛为 provider-independent 的模型事实与 Ash 默认 metadata：

- exact `ModelId`、display name、description；
- `TokenLimits { context, input, output }`，每项使用 Known/Unknown/NotApplicable；
- input/output modalities；
- tools、parallel tool calls、reasoning、structured output 等 capability；
- supported/default reasoning effort；
- Ash personality/default 和 auto-compaction recommendation。

Availability、freshness、source quality 和 warnings 属于 `ModelCatalogEntry/Snapshot`，不塞进
可跨 scope 复用的 `ModelInfo`。

`ModelCatalogEntry::model_info` 在 `models-manager/model_info.rs` 合并配置并计算压缩建议，protocol
只保留序列化模型字段。已知窗口限制用户配置窗口；未给出压缩阈值时采用有效窗口的 90%，显式
阈值也受此上限限制。调用方在独立副本上获得有效信息，不改写目录事实和来源。
Context builder 根据有效信息、输出预留和安全余量计算可用输入预算；manager 不执行压缩。
职责对照和当前静态调用预算边界见 [crate 说明](../ash-rs/models-manager/README.md#有效模型信息与职责)。

### 11.2 App Server API

当前已经有 `model/list` 的 `builtIn` / `discovered` 视图和显式 `provider/models/list` 刷新。
后续如需发布完整 catalog snapshot，可在现有视图上扩展 typed query、read policy 和通知：

```text
model/list
provider/models/list
model/updated
```

- `model/list` 保持桌面固定目录与 TUI 发现目录的选择语义，再增加 typed query/read policy 和 snapshot；
- `provider/models/list` 继续作为显式刷新入口，可扩展为返回新 snapshot 或带 last-known snapshot 的 typed error；
- `model/updated` 只在 consumer-visible generation 变化后通知；
- initialize result 可包含 catalog capability/version，不内嵌完整目录；
- App Server 负责 connection subscription 和 DTO 映射，不维护第二份 catalog；
- Desktop 与 TUI 从同一个 App Server 接口选择各自视图，不自行读取 provider 文档或拼 `/models`。

Provider credential 缺失时，静态模型仍可展示为 `AuthenticationRequired/Unverified`；API 不返回
credential account 的秘密信息。普通客户端也不需要看到 opaque cache scope fingerprint。

### 11.3 Agent 运行时

Agent 运行创建前，App Server 把 Session 或工作流模型基线、Agent 定义策略和本次启动参数交给 manager。选择结果进入不可变 `AgentModelSelectionSnapshot`：

```text
requested ModelRef
+ selected ModelRef
+ selected runtime / access source / config revision
+ substitution reason / scope changed / provider changed
+ resolved limits/capabilities
+ participating catalog generations
+ reasoning effort / service tier
+ warnings / policy decisions
```

每次模型调用仍在 invocation safe point 为已经冻结的准确 `selected ModelRef` 建立不可变 provider binding，并记录 provider config revision。刷新 catalog、Session 切换模型或上级 Agent 修改配置都不能改变已经开始的 Agent 运行；下一次调用若发现准确模型无法建立 binding，应返回类型化能力或配置错误，不能在后台重新选择模型。

## 12. 错误与降级

建议错误分类：

| 类别 | 对 cache 的处理 | 对用户的结果 |
| --- | --- | --- |
| Authentication / permission | 当前 availability 降为需认证或未验证；保留 metadata | 展示配置提示，不泄露响应 |
| Discovery unsupported | negative cache；使用 static/config | 正常返回 `StaticOnly` + warning |
| Rate limited / timeout / network | stale-if-error + backoff | 返回 stale snapshot 和刷新诊断 |
| Provider 5xx | stale-if-error + backoff | 同上 |
| Invalid provider payload | 不提交坏 snapshot；保留 last-known | provider schema error |
| Pagination incomplete | 只可提交 Partial，或整体失败 | 不因缺席下架模型 |
| Empty complete result | 提交空 live availability，保留 configured/history tombstone | 明确显示当前 scope 无可用模型 |
| No compatible selection | 不修改 catalog；返回候选检查摘要 | Agent 或工作流不启动，说明准确模型和替换策略均无法满足要求 |
| Cache corrupt/schema mismatch | 丢弃可删除 cache，重新发现 | 不影响 Config/Thread recovery |
| User override invalid | 拒绝该配置事务 | typed config error |

错误对象应携带 provider、scope-safe identity、phase、retryability 和 last-known freshness，但不得
携带 API key、Authorization header 或未经裁剪的 provider body。

## 13. 安全、隐私与可观测性

### 13.1 安全

- 仅对用户已配置或明确使用的 provider 发起 authenticated discovery；
- 不在启动时并发扫描所有内置 provider；
- scope fingerprint 使用抗碰撞 hash，不可由客户端反推出 credential reference；
- provider raw payload 默认不落盘；
- response logging 只记录大小、状态码、字段计数和 schema path；
- 自定义 base URL 继续经过 provider config 的 URL validation 和后续网络 policy；
- persisted cache 使用与本地配置相同或更严格的文件权限；
- cache delete 是可恢复操作，不影响 durable Session/Thread。

### 13.2 遥测

建议指标：

```text
catalog_read_total{provider,result=fresh|stale|miss|static}
catalog_refresh_total{provider,result}
catalog_refresh_duration_ms{provider}
catalog_models_observed{provider,coverage}
catalog_singleflight_join_total{provider}
catalog_snapshot_generation_total{provider}
catalog_metadata_conflict_total{provider,field}
catalog_stale_age_seconds{provider}
```

禁止把 exact custom endpoint、model ID、credential account 或 provider response text 默认放入
低基数 telemetry label。详细诊断留在本地、受控日志。

## 14. 目录结构与公开 API

遵守 workspace 的小模块和公开 API 规则，建议：

```text
ash-rs/models-manager/
├── Cargo.toml
├── README.md
└── src/
    ├── lib.rs                 # 只做显式 re-export
    ├── manager.rs             # read / refresh / resolve orchestration
    ├── source.rs              # ModelCatalogSource port + discovery values
    ├── snapshot.rs            # immutable snapshot/generation
    ├── cache.rs               # cache state + freshness
    ├── merge.rs               # field-level provenance merge
    ├── filter.rs              # query/filter/sort
    ├── selection.rs           # Proposed：provider 无关的候选选择与替换结果
    ├── policy.rs              # named policies
    ├── error.rs
    ├── manager_tests.rs
    ├── cache_tests.rs
    ├── merge_tests.rs
    └── filter_tests.rs
```

模块默认 private，仅导出调用方真正需要的 manager、port、query、policy 和 error。新增 public
trait 必须带 doc comments，说明实现者如何处理 scope、分页、coverage、cancellation 和 secret。

`merge.rs`、`filter.rs` 尽量保持纯函数，使用固定 clock/source input，便于 property test 和
table-driven test。

## 15. 测试要求

### 15.1 契约测试

每个动态 provider adapter 至少保存经过脱敏和裁剪的官方响应 fixture，验证：

- endpoint 与认证/header 选择；
- pagination；
- 文档化及观察到的 cache header/validator 映射，缺失时回到 `NotSpecified`；
- model ID 保真；
- coverage 分类；
- capability/limit mapping；
- unknown field forward compatibility；
- 401、429、5xx 和 schema error。

Fixture 不是 provider 当前模型列表的 authority，只用于 wire contract。

### 15.2 Manager 测试

必须覆盖：

- fresh/stale/expired/cache miss 状态表；
- 相同 scope singleflight、不同 scope 并行；
- refresh 晚到响应不能覆盖新 config revision；
- partial response 缺席不 tombstone；
- complete response 缺席改变 availability 但保留 metadata；
- `Unknown` 不覆盖 known；
- live/curated/user override 冲突与 provenance；
- 401、429、5xx、unsupported discovery 的不同退化；
- deterministic generation 和排序；
- `ListedOnly` / `AllowUnlisted` resolution；
- custom compatible provider 无 `/models` 时仍可使用显式模型；
- persisted cache schema mismatch 可安全丢弃；
- telemetry/log 不含 secret fixture。

测试 module 放在独立 sibling `*_tests.rs` 文件，并通过显式 `#[path = "..._tests.rs"]` 引入。

### 15.3 集成测试

App Server 使用 fake clock、fake source 和 memory cache 验证：

```text
model/list(stale)
→ 立即返回 stale generation N
→ 后台 refresh
→ generation N+1
→ model/updated
→ 下一次 list 返回 fresh N+1
```

不在普通 CI 依赖真实 provider 网络或真实 API key。真实 provider smoke test 必须 opt-in、限频且不
执行 inference。

## 16. 分阶段落地

### 阶段 1：纯目录核心

- ✅ 创建 `ash-models-manager`；
- ✅ 定义 source port、scope、snapshot、read/refresh policy；
- ✅ 从 `ProviderDefinition.models` 读取 seed；
- ✅ 实现 memory cache、singleflight、merge/filter/resolve；
- ✅ 接入 fake source/fake clock 单元测试；
- 部分具备：protocol 已补 availability/freshness/lifecycle/quality；完整 snapshot wrapper 随 Phase 3
  App Server API 一并落地，当前 snapshot 是 manager 的进程内 immutable value。

当前结果：无网络可以从统一 manager 获得确定 catalog，provider runtime 与 Local App Server 已迁移；
其他产品 picker 尚未接入，因此跨 Desktop/CLI/TUI 的完成条件仍留在 Phase 3。

### 阶段 2：高价值动态供应商

按 metadata 质量和现有产品价值优先接入：

1. OpenAI、Anthropic；
2. Gemini、DeepSeek；
3. ✅ Ollama；
4. xAI、Hugging Face；
5. Kimi、MiniMax、Qwen、Z.AI、MiMo 等先使用 curated/static source，在有官方、可验证
   authenticated endpoint 后再接动态 discovery。

每接入一个 provider，先建立第 6.2 节的验证记录，再实现 adapter。同时把 wire DTO/fixture 放到
正确层，不在 manager 中写 provider switch。

完成条件：动态列表失败时可稳定回退静态 snapshot；各 provider 的 coverage 与 Unknown 语义经过
contract test；未文档化 cache header 不成为正确性依赖。

### 阶段 3：App Server 与客户端

- 增加 `model/list`、`model/refresh`、`model/updated`；
- Desktop/CLI/TUI picker 迁移到统一 snapshot；
- provider 配置或凭据 revision 触发新 scope；
- 增加统一 `ModelSelectionRequest` 与 `ModelSelectionDecision`，让 Agent 启动按“准确模型 → 同 scope → 同 provider 的其他允许 scope → 其他允许 provider”选择；
- App Server 冻结请求模型、实际模型、替换原因、推理配置与目录 generation，并让客户端显示非阻塞警告；
- Agent runtime 在安全点使用已经冻结的准确模型，不在调用失败后重新选择。

完成条件：所有产品入口看到相同目录、相同 warning 和相同排序；同一选择请求得到确定结果；同 provider 与跨 provider 替换均有契约测试；refresh 不影响已开始的 Agent 运行或 in-flight invocation。

### 阶段 4：持久缓存与维护流程

- ✅ 增加可删除的 persisted observation cache；
- 内置 metadata 加 source URL、reviewed_at 和维护校验；
- 建立官方文档变化的人工/自动审计流程；
- 根据真实指标调整 TTL、backoff 和 warm-up 范围。

完成条件：重启/离线仍能快速展示 last-known catalog，cache 损坏可删除重建且不影响 durable
产品状态。

## 17. 固定决策

1. `ash-models-manager` 是 catalog control plane，不是 provider invocation runtime。
2. 唯一模型 identity 是 exact `(ProviderId, ModelId)`。
3. 可用性按 endpoint + credential/tenant + config revision scope 缓存。
4. Provider list API 只声明它实际返回的字段；缺失字段保持 `Unknown`。
5. 合并是字段级 patch + provenance，不是整条 `ModelInfo` 后写覆盖前写。
6. 完整 discovery 的缺席与 partial discovery 的缺席语义不同。
7. manager 使用 stale-while-revalidate、singleflight 和 typed read policy。
8. 不用 inference probing 发现模型或能力。
9. 静态 seed 不证明当前账号可用，动态列表也不一定提供完整能力 metadata。
10. Catalog refresh 不修改已开始的 Agent 运行或 model invocation；模型替换只在运行创建前依据显式策略执行，并以警告展示请求模型和实际模型。
11. Persisted catalog 是可删除 projection，不是 Config、Thread 或 billing authority。
12. Provider runtime/认证留在 `ash-model-provider`，wire endpoint/codec 留在 `ash-api`，
    raw HTTP/network policy 留在 `ash-http-client`，retry/framing 留在 `ash-client`。
13. Prompt/context cache、stream heartbeat 和本地模型驻留不属于 catalog manager。
14. Catalog TTL 是可配置的 Ash policy；provider cache hint/validator 只有证据充分时才参与计算。
15. Provider discovery 必须逐家验证；`../pi` 或 OpenAI-compatible 行为不能作为其他厂商的协议
    证明。
16. 不新增独立模型路由 crate；`ash-models-manager` 拥有 provider 无关的候选筛选与选择，`ash-agent-roles` 只声明 Agent 策略，`ash-model-provider` 只调用已经选定的准确模型。
17. 自动替换顺序固定为准确模型、同 scope 兼容模型、同 provider 的其他允许 scope、其他允许 provider；没有兼容候选才失败，任何 scope 或模型替换都不能静默发生。
