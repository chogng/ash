# `ash-model-provider-info`

> 本 README 解释模型与接入声明、校验和规范化。跨系统配置模型和
> 演进见 [`docs/model-provider-info.md`](../../docs/model-provider-info.md)；请求实现见
> [`ash-model-provider`](../model-provider/README.md)。

本 crate 统一维护模型规格、完整基础提示词、供应商与接入声明，以及用户接入配置的校验和规范化。配置存储、模型目录和请求实现共享这些声明，不需要为读取它们引入供应商客户端。

| 内容                                       | 归属                  |
| ------------------------------------------ | --------------------- |
| 模型规格、基础正文、接入协议与配置规则     | `model-provider-info` |
| 目录发现结果、刷新、缓存、模型与提示词选择 | `models-manager`      |
| 凭据读取、客户端、连接与实际请求           | `model-provider`      |

原 `crates/model-provider-config` 已改名为本目录，Cargo package 为 `ash-model-provider-info`，消费方统一使用 `model-provider-info` dependency key 和 `model_provider_info` Rust 路径。`ModelProviderConfig` 等类型仍表达接入配置，不因 crate 改名而改变配置格式或协议字段。

## 公共模型

| Symbol                                       | 职责                                    | 关键语义                                                                                       |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ModelProviderConfig`                        | 用户/host 可配置值                      | provider、connection、base URL、max output 与 per-model context metadata                       |
| `ModelContextConfig`                         | 单模型的 Core budget metadata           | positive context window、optional auto-compact limit                                           |
| `ProviderDefinition`                         | provider-owned declaration              | adapter identity、HTTP/WebSocket API profile、endpoint/catalog/defaults、API Key policy/header |
| `NormalizedModelProviderConfig`              | runtime-ready immutable config          | provider/profile/base URL 已确定                                                               |
| `ProviderConfigRegistry`                     | definition authority                    | validate、register、merge、selection、normalize                                                |
| `STATIC_MODEL_CATALOG` / `StaticModelSpec`   | 内置文本模型目录                        | 唯一 model/provider ID、context、capabilities、reasoning、defaults 和完整基础提示词            |
| `ProviderAdapter`                            | serializable adapter identity           | 不是 runtime trait/object                                                                      |
| `ApiProfile`                                 | declarative wire profile                | runtime 显式解析为 `ash-api::ApiEndpoint`                                                      |
| `WebSocketApiProfile`                        | Responses WebSocket 能力                | 默认 `Unavailable`；不得从 HTTP compatibility 推断                                             |
| `RealtimeApiProfile`                         | 独立语音会话协议能力                    | 默认 `Unavailable`；与文本 WebSocket 和订阅身份分开授权                                        |
| `TranscriptionApiProfile`                    | OpenAI／xAI 流式听写协议能力            | 默认 `Unavailable`；直接 API 接入各自声明，订阅接入不可用                                      |
| `LiveApiProfile`                             | GPT-Live 会话协议能力                   | 明确声明，不能从文本协议推断                                                                   |
| `VoiceModelCatalog` / `VoiceModelDefinition` | Provider 的独立语音目录                 | 模型、支持的音色与默认值                                                                       |
| `VoiceModelConfig`                           | 可序列化的语音选择                      | 与文本模型选择分开，不含密钥                                                                   |
| `InputTokenCountDefinition`                  | provider-owned preflight declaration    | profile、target 与明确 model policy                                                            |
| `NormalizedInputTokenCountConfig`            | runtime-ready count snapshot            | 已解析 base URL；不包含 client 或准确度策略                                                    |
| `EndpointPolicy`                             | provider default 或 configured-only     | 不执行 DNS/network validation                                                                  |
| `ModelCatalogPolicy`                         | listed-only 或 allow-unlisted           | 声明 static gate，由 `ash-models-manager` 执行 canonical resolution                            |
| `ApiKeyPolicy`                               | unsupported、optional 或 required       | 只声明 host secret binding 要求，不持有密钥                                                    |
| `ApiKeyHeader`                               | Bearer、`x-api-key` 或 `x-goog-api-key` | 只声明 direct request 的认证 Header 形状，不读取密钥                                           |
| `ApprovalReviewModelDefault`                 | automatic review default                | active model 或 provider-declared model                                                        |
| `ProviderConfigError`                        | static/normalization error              | 不包含 transport/auth failure                                                                  |

`model_provider_config_schema()`、`provider_definition_schema()` 与 `model_catalog_schema()` 从 Rust types 生成 JSON Schema；
schema 没有第二份手写来源。

`ProviderConfigRegistry::with_configs` 只接受内置接入、已注册供应商或具有完整声明的自定义接入。未知供应商返回 `UnknownProvider`；插件定义必须先注册，不能仅靠配置中的 ID 声明。配置存储在保存、导入和严格读取时校验连接，规则见 [模型接入配置](../../docs/config.md#模型接入配置)。

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
├── static_model_spec.rs # models.json 行与参数的解析声明、转换和编辑器字段说明
├── model_catalog.rs # 校验、规范化 models.json 并生成 ProviderDefinition.models
├── registry.rs     # registration、merge、selection、normalization
├── providers/      # provider endpoint、adapter、profile 与 transport declarations
├── error.rs
└── lib.rs
```

| Symbol                                     | 可见性                                | 当前职责                                                              | 方向约束                                               |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `ModelProviderConfig::validate_static`     | public method                         | zero output/context limits 与 configured URL shape                    | 不依赖 registry或网络                                  |
| `ProviderDefinition::validate`             | public method                         | name、default endpoint、profile pairing、defaults、catalog uniqueness | definition 自身必须独立有效                            |
| `InputTokenCountDefinition::validate`      | crate-private method                  | count URL、non-empty/unique model list                                | 不探测远端 model availability                          |
| `STATIC_MODEL_CATALOG`                     | public static                         | 产品内置文本模型及静态 metadata                                       | 文本模型在 models.json 声明；语音目录归 `voice_models` |
| `attach_static_models`                     | crate-private function                | catalog rows → provider models                                        | registry validation 前自动执行                         |
| `ProviderConfigRegistry::register`         | public method                         | validate + reject duplicate                                           | built-in/plugin 定义走相同路径                         |
| `ProviderConfigRegistry::merge`            | public method                         | prevalidate incoming + explicit conflict policy                       | merge 不能 partial apply                               |
| `ProviderConfigRegistry::with_configs`     | public method                         | 将接入配置组装为 immutable registry                                   | 未知供应商报错；自定义声明和已注册插件定义保留         |
| `ProviderConfigRegistry::normalize`        | public method                         | config + definition → normalized snapshot                             | endpoint/default/profile precedence 在此唯一实现       |
| `normalize_for`                            | public method                         | 先 enforce selected/configured provider identity                      | 防止 model ref 与 config 串线                          |
| `automatic_approval_review_model`          | public method                         | provider default 或 active model fallback                             | 不证明远端 entitlement                                 |
| `validate_model_selection`                 | public compatibility/preflight method | 显式配置校验                                                          | 内置模型请求不依赖远端目录成员资格                     |
| `normalize_base_url`                       | crate-private function                | apply explicit normalization rule                                     | 不追加 API route                                       |
| `is_http_url`                              | crate-private function                | 最小 HTTP(S) shape check                                              | 不是 full URL/network validator                        |
| `providers::builtin`                       | crate-private function                | built-in definitions                                                  | 每个 provider 在 sibling module 独立定义               |
| `default_provider` / `configured_provider` | private helpers                       | shared definition constructors                                        | 不隐藏 provider-specific profile/default differences   |

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

自定义 provider 的 `model_context` 键同时声明进入产品模型列表的模型 ID，每个条目独立设置上下文窗口；内置 provider 的该字段仍只覆盖元数据。模型测试验证实际调用，不把目录条目当作可用性证据。

`model_aliases` 将界面使用的模型 ID 映射到请求中的上游 ID。映射只应用一次，目标 ID 是原样发送的值；`model_context` 仍按界面中的 ID 绑定上下文预算。两个字段不包含 API key。

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
`countTokens` 使用单独声明的官方计数地址；Anthropic 选择 `AnthropicMessages` 并声明默认 max
tokens。Kimi、Google 和 Z.AI 的额外 allow-unlisted count model 是 transport definition 数据；进入产品
模型列表由 `STATIC_MODEL_CATALOG` 提供；计数支持范围由每条接入显式声明，不按模型 ID 前缀猜测。
Provider matrix 和官方依据由系统文档维护，本 README 只固定 definition construction pattern。

OpenAI definition 另外声明 `WebSocketApiProfile::OpenAiResponses`。其他 built-in definition 的 Responses WebSocket profile 当前均为
`Unavailable`，包括 HTTP-compatible provider。xAI 的 API 和订阅接入使用 HTTP Responses，
但没有启用 Responses WebSocket。真实调用仍需 runtime target 和 `ash-api` codec/session client 共同允许。

Meta 使用 `meta` API Key 连接和 `https://api.meta.ai/v1`，按[官方 API 文档](https://dev.meta.ai/docs/overview)使用 Responses 协议与 Bearer 认证。Muse Spark 1.3 的标准层模型 ID、上下文窗口和推理档位来自[模型目录](https://dev.meta.ai/docs/models)与[推理文档](https://dev.meta.ai/docs/reasoning)。

## 统一静态模型清单

六家官方接口对照、通用字段结构和当前缺口见 [通用模型声明规范](docs/model-template.md)。该文档区分当前可解析字段、Codex 字段对应关系和未实现的通用参数设计；当前格式由 Rust 契约和生成的 Schema 定义。

JSON 的层级和编辑字段由 [`static_model_spec.rs`](src/static_model_spec.rs) 的解析类型定义，字段注释进入生成 Schema。目录、共享模型声明、模型列表结果和模型偏好请求的字段统一使用 `snake_case`，包括嵌套字段和加速机制标签 `service_tier`；目录与模型设置拒绝旧的驼峰字段。前端适配器转换为 TypeScript 业务类型的 `camelCase` 字段。请求参数值和推理档位值保留各自约定，例如等级 ID `priority` 和档位 `extraHigh`。共享协议按数据职责组织，阅读关系见 [protocol 目录说明](../protocol/README.md#modelsjson-从哪里定义)。这两个入口一起维护：修改文件名不会自动改变 JSON，修改解析声明必须重新生成 Schema。

产品内置文本模型统一登记在 [`models.json`](models.json)。一个条目包含准确 provider/model 身份、规格和 `model_messages` 的基础、工具、模式与根／子 Agent 指导，每个模型的正文可以独立修改。目录不填写 revision；`models-manager` 根据每段正文的 SHA-256 摘要生成冻结资产的版本标识。`STATIC_MODEL_CATALOG` 是该文件一次解析、校验后的进程共享数据，不再有 Rust 模型清单或模板枚举。

```json
{
  "provider_id": "provider-id",
  "model_id": "model-id",
  "display_name": "Display Name",
  "description": "A short description of the model",
  "context_window": 200000,
  "max_context_window": 1000000,
  "capabilities": {
    "tools": true,
    "reasoning": true
  },
  "supported_reasoning_efforts": [
    { "effort": "low", "description": "Fast responses with lighter reasoning" },
    { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
    { "effort": "high", "description": "Greater reasoning depth for complex problems" }
  ],
  "default_reasoning_effort": "medium",
  "model_messages": {
    "system_instructions": "Complete Agent base instructions for this model.\n",
    "tools": {
      "spawn_agent": { "description": "Delegate one bounded task and verify its result." }
    },
    "collaboration_modes": {
      "plan": "Inspect the task and produce a concrete plan within the active constraints."
    },
    "multi_agent": {
      "root": "Own the overall outcome and verify delegated results.",
      "subagent": "Complete the assigned task and return results and verification evidence."
    }
  }
}
```

条目放在顶层 `models` 数组中。顶层 `$schema` 引用 `./models.schema.json`，编辑器可以检查字段名、类型和枚举并提供补全。Schema 从实际 JSON 解析声明生成，运行时仍负责重复 ID、默认值引用和上下文预算等跨字段校验。修改解析契约后运行：

```sh
just generate-model-catalog-schema
just generate-model-catalog-schema --check
```

`description` 是可选的模型简介；每个推理选项包含请求值 `effort` 和可选的 `description`。缺少说明表示未知，不生成型号能力或固定 token 预算；已填写说明不能空白，同一档位不能重复。App Server revision 16／capability version 19 使用 `snake_case` 模型字段，并以 `default_reasoning_effort` 表示目录默认档位，旧客户端会在初始化时拒绝不兼容的版本，服务端与客户端需一起更新。目录、App Server、桌面和 TUI 保留这些信息，模型选择器显示简介，推理菜单向读屏提供档位说明，TUI 推理面板显示档位说明。已与 Codex 准确匹配的型号保留原始简介和说明，其他型号使用 Ash 的通用档位说明；同名档位不保证跨供应商有相同推理投入。

只有身份、显示名和完整提示词必填；省略上下文容量表示未知，能力字段使用 `true / false / null`，分别表示已确认支持、已确认不支持、未知；省略能力同样表示未知，也不会按厂商或模型名称猜测。`capabilities` 只填写已知的 `tools`、`reasoning`、`parallel_tool_calls`、`image_detail_original` 或 `fast_mode`，没有已知能力时省略整个对象。没有推理档位、默认推理档位或特殊压缩阈值时，分别省略 `supported_reasoning_efforts`、`default_reasoning_effort` 和 `auto_compact_token_limit`。人格字段不属于这个目录。重复身份、未知字段、缺失提示词、空白正文、零上下文窗口或不支持的默认推理档位会使目录校验失败。

`default_reasoning_effort` 声明该模型在 Ash 中的默认档位，省略后没有目录默认值，不会自动设为 `medium`。用户配置中的 `model_reasoning_effort` 保存用户选择，单次请求中的 `reasoning_effort` 保存本次选择；优先级为单次请求、用户配置、模型目录默认值。目录解析器只接受 `default_reasoning_effort`；Codex 返回的 `default_reasoning_level` 和 `supported_reasoning_levels` 由供应商接入层转换。

`settings` 保存会影响真实调用的模型声明：输入模态、verbosity 和推理摘要参数的支持情况及默认值、服务等级选项及默认值、加速机制、工具输出限额。`verbosity` 和 `reasoning_summary` 同样使用 `true / false / null`，省略表示未知。目录解析后转换为 Rust 的三态枚举；运行时、插件与传输契约仍使用 `CapabilitySupport`。类型与校验由 [`ModelSettings`](../protocol/src/model/parameters.rs) 定义；省略的字段表示没有证据。默认值必须有相应支持声明，列表必须非空且不重复，工具输出限额必须大于零。静态 JSON、插件定义与动态目录在各自入口校验这些约定。

已与本地 Codex 清单准确匹配的 8 个 OpenAI 型号补入已声明的模态、verbosity、摘要和工具输出预算，并补齐并行工具与原图能力。服务等级的 `id` 保存供应商请求值，`name` 和 `description` 保存展示名称及说明；`Fast` 是名称，OpenAI 的等级 ID 是 `priority`，不再同时声明 `fast` 和 `priority` 两个选项。声明不证明账号权益。没有证据的字段继续保持未知。Codex 的模型简介和推理档位说明已进入这份数据；升级提示、展示排序、搜索工具类型及尚无调用方的字段不写入模型规格。

服务等级和加速声明使用以下可解析格式：

```json
{
  "service_tiers": [
    { "id": "default", "name": "Standard", "description": "Standard processing" },
    { "id": "priority", "name": "Fast", "description": "Faster responses, increased usage" }
  ],
  "default_service_tier": "default",
  "acceleration": { "type": "service_tier", "service_tier": "priority" }
}
```

以上对象放在条目的 `settings` 中。ID 唯一，ID、名称与说明不能空白；`default_service_tier` 和服务等级加速选项都必须引用已声明的 ID。默认值是 Ash 的请求默认值，不代表供应商的默认配置。速度倍数未经实测时，说明不承诺固定倍数；说明也不参与价格计算。

| 加速机制 | `settings.acceleration`                                                                                                               | 真实请求                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 服务等级 | `{"type":"service_tier","service_tier":"priority"}`                                                                                   | 发送准确的 `service_tier`；Anthropic 调度选项使用它自己的 `auto` ID    |
| 速度参数 | `{"type":"speed","speed":"fast","name":"Fast","description":"Faster responses, increased usage"}`                                     | 独立的 `speed=fast` 和所属接口的 beta Header；不伪造一个 Fast 服务等级 |
| 高速型号 | `{"type":"model","model":"kimi-k2.7-code-highspeed","name":"Fast","description":"Uses a separate high-speed model, increased usage"}` | 从冻结的模型声明选择高速型号，再应用所选连接的上游 ID 别名             |

Astra 的 `settings.service_tiers` 声明 `ultrafast`；这是模型能力，不能直接赋予 ChatGPT 账号资格。订阅账号还需要通过[套餐及工作区授权](../../docs/models/plans-and-pricing.md#astra-ultra-fast-的套餐资格)，API Key 按 API 条件处理。

每个接入的 `modelAcceleration` 按模型保存准确的选项 ID。服务等级沿用原始 ID，速度参数使用 `speed:fast`，高速型号使用 `model:<型号>`。目录中的非默认服务等级以及速度或型号声明形成可选列表；`disabledAccelerationOptions` 按模型独立禁用各档位，禁用 Fast 不会连带禁用 Ultra Fast。后端在保存、HTTP 调用、WebSocket 连接和预热前校验选项。显式请求等级或速度优先于同类参数的加速偏好，也必须通过接入限制；清除选择使用声明的请求默认等级。配置文件 schema 9 将旧 `fastModels` 一次性迁移成原声明的选项 ID，未知映射或冲突会报错并保留原文件。服务等级 ID 原样传到请求字段，只有 ChatGPT 订阅的显式 `default` 按接口约定省略。预先计数不发送等级、速度或加速 beta Header。订阅连接仍单独限制是否可加速，不能从公开 API 能力推断。

Ultra Fast 是加速档位，与 Ultra 的协作意图分别设置。TUI 的 `/effort` 负责推理档位和 Multitask；更改加速档位不会修改这两项，Max、Multitask 和加速可以同时使用。

前端模型设置卡读取加速选项的名称和说明，保留键盘开关、焦点和保存行为，并把说明提供给读屏。内置文案通过现有 NLS 提供英文和中文；供应商自定义文案保留原文。实际型号、实际服务等级与证据进入调用/计价记录，详情见 [模型计价](../docs/model-accounting.md#加速调用如何进入计价)。

内置完整正文在保留各模型原有指导的基础上，包含任务完成、环境调查、工具使用、编辑、验证、权限、委托和结果报告规则。正文长度不证明模型效果，质量与额外输入成本仍需真实模型对照评测。

`context_window` 是默认上下文预算，`max_context_window` 是长上下文开启后的最大预算；最大值不得小于默认值，未知默认值不能声明最大值。省略最大值表示没有更大的档位。长上下文默认关闭，用户偏好保存 `modelContext.<model>.longContext` 布尔值；手工 `contextWindow` 数值与布尔偏好互斥。后端根据当前连接的目录容量限制有效预算，GUI 和 TUI 不根据型号或容量猜测开关。压缩推荐使用有效预算的 90%，显式压缩阈值也受这一上限限制。

`model_messages` 中的 `system_instructions` 必填；`tools`、`collaboration_modes` 和 `multi_agent` 可省略，省略表示没有额外的模型专用指导，保留所属模块的现有规则。声明的正文不得空白，全部文本合计最多 64 KiB。`tools` 按准确工具名声明，只接受 `description`；`collaboration_modes` 只接受 `agent`、`plan`、`debug`、`multitask`、`ask`；`multi_agent` 只接受 `root`、`subagent`。这些字段不能声明工具参数、开关或授权。

Core 在现有工具说明之后加入模型专用 `description`，保留工具参数、动态角色信息和原绑定。只有本次实际可用的工具会得到这段说明，Code Mode 的 `ALL_TOOLS` 同样使用冻结的模型说明。当前模式选择一段模式指导，Thread 的真实父子关系选择根或子 Agent 指导；额外正文保留宿主的模式限制、Role 与权限。上下文检查与执行使用同一组装路径，并将工具说明计入工具预算。

`model_messages` 是本地模型指令声明，不是聊天消息数组，也不会整块发给供应商。Core 将基础、当前模式和身份指导与运行时指令组装成 `ModelRequest.instructions`，工具指导进入对应的工具说明；Responses 编码为顶层 `instructions`，Claude Messages 编码为顶层 `system`，Chat Completions 编码为 `system` 消息。当前 Gemini 接入使用 Chat Completions；官方 Gemini 协议的字段对照见通用模型声明规范。

`ash-models-manager` 按准确身份选择正文，在新 Turn 接受前冻结所选基础提示词及分组指导；没有登记的模型使用 [`base_prompt.md`](../prompts/templates/agent/base_prompt.md)。权限、Role、协作模式、项目指令与工具由运行时另行加入。目录自身不含凭据、执行适配器或端点；订阅和 API 共享同一个厂商＋模型身份。JSON 通过 `include_str!` 编译嵌入，资源清单在 `BUILD.bazel`，修改后需重编译并重启。

`connection.rs` 维护 `ModelConnectionDefinition`，包含独立 `ModelConnectionId`、所属厂商、订阅/API 类型和执行声明。端点、协议、认证、计数能力和限制属于接入的 transport 定义。GLM 四个服务 ID 共享 `glm` 厂商的唯一模型目录，凭据仍各自独立。`NormalizedModelProviderConfig::upstream_model` 显式处理上游 ID 差异。

后端 profile 以 `connections` 保存所有接入；每次模型绑定时按就绪凭据选择订阅优先的连接。GLM 的顺序为 BigModel Coding Plan、Z.AI Coding Plan、BigModel API、Z.AI API。模型列表固定可选，远端目录缺项不能阻止内置模型请求。请求错误不触发本次模型或接入替换。

`InputTokenCountTarget::InvocationBase` 会跟随显式 endpoint override，适合 count 与 invocation 同一
service surface 的 provider。`ProviderDefault` 只在 invocation 也使用 provider 默认 endpoint 时启用；
一旦用户配置代理或私有 endpoint，normalization 会关闭该 count binding，避免把同一请求绕过代理发到
官方服务。

新增 provider 时同步：

1. 选择对应的 `ProviderAdapter`；有独立请求行为时才增加 variant；
2. 新建 private `providers/<name>.rs::definition`；
3. 加入 `providers::builtin()`；
4. 复用该协议的 runtime adapter；有独立行为时增加对应 mapping；
5. 增加 definition/normalization/runtime tests；
6. 更新系统 provider matrix 与 schema fixture。

## 方向偏差检查

- 声明层依赖 `ash-api`/HTTP/secret：runtime state 下沉；
- `ProviderAdapter` 直接存 trait object：declaration 不再 serializable；
- runtime 根据 provider name 猜 API profile：显式 declaration 被绕过；
- runtime 根据 HTTP compatibility 猜 WebSocket：handshake/event/session contract 被绕过；
- runtime 根据 model ID 前缀或 invocation URL 拼 count endpoint：显式 count declaration 被绕过；
- normalization 追加 `/responses` 等 route：endpoint/profile ownership 混淆；
- allow-unlisted 被描述为远端可用：static evidence 被夸大；
- merge conflict 造成 partial registry mutation：config snapshot 不再原子。

## 测试、限制与演进

```text
just test ash-model-provider-info
bazel test //crates/model-provider-info:model-provider-info-unit-tests
```

测试覆盖 serde/schema、defaults、configured-only endpoint、invalid URL/output/context tokens、HTTP/WebSocket
profile pairing、merge semantics、
automatic review model、统一静态目录映射与 metadata contract、catalog gate、built-in completeness 与 provider mismatch。

当前 URL validator 只接受具有非空 authority 的 HTTP(S) shape，不解析 credential、DNS、route 或
reachability。Catalog 也是 declarative snapshot，不代表 account entitlement。未来可以扩充 schema、
definition source 与 catalog metadata，但必须保持 runtime-free、deterministic normalization 和显式
profile selection。
