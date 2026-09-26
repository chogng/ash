# `ash-models-manager`

> 本 README 是 crate 当前实现的权威说明。跨 crate 的目录语义、provider 调研和分阶段演进见
> [`docs/models-manager.md`](../../docs/models-manager.md)；provider declaration 见
> [`ash-model-provider-config`](../model-provider-config/README.md)，调用 runtime 见
> [`ash-model-provider`](../model-provider/README.md)。

- 从 `ProviderDefinition.models` 读取静态模型，合并按 scope 隔离的动态发现结果。
- 管理目录刷新、缓存、并发请求合并和 snapshot generation。
- 负责模型筛选、准确模型解析和配置生效后的模型信息。
- 选择模型专化指令；共同 Agent 规则由 `ash-prompts` 拥有。
- 不持有凭据、调用客户端、Config 存储或 UI 状态。

## 公共契约

| Symbol | 调用方用途 | 关键语义 |
| --- | --- | --- |
| `ModelsManager` | read、refresh、list、resolve | clone 共享同一个进程内 scope/cache authority |
| `CatalogScopeKey` | 标识 provider + endpoint/account/config revision | source scope 必须是不含秘密的一向指纹 |
| `ModelCatalogSource` | provider runtime 实现 discovery port | 返回完整或 partial observation，不提交半页结果 |
| `ModelCatalogSnapshot` | 上层读取 immutable catalog | 仅消费者可见内容变化时 generation 递增 |
| `CatalogReadPolicy` | `CachePreferred` / `RequireFresh` / `CacheOnly` | 禁止用 `fresh: bool` 模糊表达阻塞语义 |
| `CatalogQuery` | list filter | availability 与 unknown capability policy 显式命名 |
| `ModelRequirements` | invocation-safe resolution | unknown、unsupported、unavailable 和 retired 分开处理 |
| `DiscoveredCatalog` | source 的一次完整提交 | `models` 保留来源展示顺序；`CompleteAgentCatalog` 缺席可下架，`Partial` 缺席不改变 availability |
| `ModelMetadataPatch` | provider 明确返回的字段 | `Unknown` 不覆盖已有 known metadata |
| `ResolvedModel` | exact model + catalog generation + warnings | `AllowUnlisted` 产生 unverified synthetic metadata |
| `ModelCatalogEntry::model_info` | 取得配置生效后的 `ModelInfo` | 校验 provider 身份、裁剪上下文和压缩阈值；不修改原始条目 |
| `ModelInstructionCatalog` | 按准确 provider/model 选择指导 | 返回 Generic 或冻结的专化资产；拒绝重复与无效定义 |
| `ModelInstructionProfile` | 登记代码维护的模型指导 | 记录准确模型和有版本的 PromptArtifact，不授予工具或权限 |

`CatalogSourceScopeId` 不是 endpoint 或 credential reference。Host 必须先对 normalized endpoint、tenant、
credential revision 和 provider config revision 生成不可逆、无秘密的稳定指纹；任一输入变化都使用新
scope。晚到的旧请求只可能提交到旧 scope。

订阅目录的展示排序由来源负责：有明确优先级时稳定排序，没有时保留返回顺序。Manager 合并与
持久缓存保留该顺序，App Server 的发现列表按顺序显示；它不参与自动选模。各订阅来源的现行
规则见[列表展示顺序](../../docs/models-manager.md#104-列表展示顺序)。

## 模块与内部所有权

```text
src/
├── manager.rs      # read/refresh/singleflight 与 list/resolve orchestration
├── cache.rs        # per-scope state、clock/freshness 与 snapshot generation rebuild
├── disk_cache.rs   # profile 内按供应商分文件保存目录 observation
├── source.rs       # consumer-owned discovery port 与 observation patch
├── snapshot.rs     # immutable snapshot、generation、provenance、warning
├── model_info.rs   # 解析结果、未收录模型信息、配置覆盖和压缩阈值建议
├── merge.rs        # seed/live 字段级合并与 complete/partial availability
├── filter.rs       # capability/availability query 与 resolution checks
├── instructions.rs # 准确模型的指令选择与资产校验
├── policy.rs       # freshness/read named policy
├── scope.rs        # opaque scope identity
├── error.rs        # typed manager failures
└── manager_tests.rs
```

| Private symbol | 当前职责 | 不能扩张到 |
| --- | --- | --- |
| `ManagedScope` | 一个 scope 的 snapshot state 与 async refresh gate | provider transport 或 Config mutation |
| `ScopeState` | records、validator、freshness evidence、last refresh result | durable Config/Thread authority |
| `ModelsManager::ensure_scope` | lazy seed snapshot construction | network discovery |
| `ModelsManager::commit_discovery` | scope/duplicate validation 后原子提交 observation | provider payload decoding |
| `rebuild_snapshot` | 比较 consumer-visible contents 后决定 generation | 每次 read 无条件 bump generation |
| `CatalogRecord` | 合并中的 `ModelInfo`、availability、lifecycle、provenance | 暴露 provider raw DTO |
| `apply_discovery` | complete/partial availability 与 live patch merge | 按 model ID 猜 capability |
| `matches_query` / `validate_requirements` | list 与 resolve 的 canonical gate | UI 搜索或排序偏好 persistence |

如果 manager 开始拼 discovery URL、读取 API key、发送 inference、解释 SSE，或者 provider runtime/UI
重新实现 `ListedOnly` / `AllowUnlisted` 判断，说明 ownership 已漂移。

同样，后续如果 App Server、Core 或 provider adapter 各自实现“准确模型 → 同 provider → 其他 provider”的候选顺序，也表示模型选择 ownership 已经漂移。该能力应扩展在本 crate 内，不能另建模型路由 crate；上层只提交 provider 无关的基线、偏好、覆盖规则、替换范围和能力要求。

## 执行路径

静态路径不访问网络：

```text
ModelsManager::static_snapshot / list_static / resolve_static
└─ ensure_scope(CatalogScopeKey::provider_seed)
   ├─ ProviderConfigRegistry::get
   ├─ seed_records(ProviderDefinition.models)
   └─ ModelCatalogSnapshot { generation: 1, freshness: StaticOnly }
```

动态刷新路径：

```text
ModelsManager::refresh(scope, source)
├─ capture refresh_serial
├─ await per-scope AsyncMutex
├─ serial changed → join prior result
├─ ModelCatalogSource::discover(previous validator)   # 不持有 catalog write lock
├─ validate exact scope + duplicate IDs
├─ apply_discovery
│  ├─ Partial: 仅 observed model → Available
│  └─ CompleteAgentCatalog: 缺席 record → Unavailable
└─ rebuild_snapshot
   └─ visible contents changed → generation + 1
```

不同 scope 使用不同 refresh gate，可以并行。相同 scope 的并发调用只执行一次 source request；等待者
复用同一成功 snapshot 或同一 typed error。future 被 drop 即为 cancellation，未返回完整 outcome 前不
修改 snapshot。

## 合并、缓存与失败

当前合并来源是 provider seed 与 provider live observation。Live 的明确字段覆盖 seed；
`ContextWindow::Unknown` 和 `CapabilitySupport::Unknown` 不擦除 known 值。Provenance 与
`ModelMetadataQuality` 随 snapshot entry 暴露。Static seed 的 availability 是 `Unverified`，不是
账号 entitlement 证明。

Freshness 使用 manager policy 与 source 明确给出的 cache hint 中更保守的时长：

| 状态 | `CachePreferred` | `RequireFresh` | `CacheOnly` |
| --- | --- | --- | --- |
| Fresh | 立即返回 | 立即返回 | 立即返回 |
| StaleUsable | 返回并后台 refresh | 等待/join refresh | 返回 stale |
| Expired | 等待/join refresh | 等待/join refresh | 返回 expired |
| 只有静态 seed | 离线时返回；有动态 source 时首次发现 | 有 source 时刷新，否则报错 | 返回 static |

Authentication/permission failure 把先前 `Available` 降为 `Unverified` 并保留 metadata；unsupported、
rate limit、transient、invalid payload 均保留 last-known records，并产生不包含 secret/raw body 的 warning。
Explicit `refresh` 仍返回 typed error，调用方可另行读取 last-known snapshot。

## 集成义务

- `ash-model-provider-config` 提供 immutable `ProviderConfigRegistry` 和 seed，不依赖本 crate。
- `ash-model-provider` 持有并公开同一个 `ModelsManager` clone；`Provider::resolve_model` 消费 manager
  的 static resolution，不再维护第二套 catalog gate。
- Local App Server 从 provider runtime 取得该 manager；`model/list` 的 `discovered` 视图只列出
  最新成功发现或当前账户持久缓存观察到的模型身份；`builtIn` 视图读取内置固定目录，Session
  model validation 调用 manager。
- 动态 provider adapter 应在 `ash-model-provider`/`ash-api` 边界实现 `ModelCatalogSource`，本 crate
  不增加 provider switch。

## 测试、修改影响与当前限制

```text
just test ash-models-manager
bazel test //ash-rs/models-manager:models-manager-unit-tests
```

单元测试使用 fake source/fake clock，覆盖确定排序、listed/allow-unlisted、partial/complete 缺席、
Unknown merge、fresh/stale/expired、304 generation 稳定和 per-scope singleflight。修改 merge、freshness、
scope 或 resolution 时必须同步相应 table test、本文和系统文档；新增 protocol-visible 字段还要同步
App Server DTO/schema fixture。

当前实现有 per-scope 进程内缓存及按供应商文件、账户 scope 隔离的持久发现记录；尚无全局/per-provider 并发上限、退避抖动或用户 trust/policy override。Ollama、ChatGPT、xAI、Kimi 和部分 API 连接已接入动态目录；不支持发现的供应商在 TUI 中没有发现条目。App Server 的 `model/list` DTO 投影 identity、display name、access、context、capabilities 与 defaults；本 crate 的 availability、generation、freshness 和 warnings 都不进入产品模型列表，也不作为发送消息的门禁。App Server 还没有 `model/updated` 通知；显式刷新使用 `provider/models/list`。

跨 provider 模型选择同样尚未实现：当前 `ModelsManager::resolve` 只校验一个准确 `ModelRef`，没有候选排序、`ModelSelectionDecision`、替换原因或客户端警告。计划实现必须复用本 crate 的同一批 snapshot 与 `ModelRequirements`，只在 Agent 或工作流运行创建前选择一次；准确模型不可用时先检查同 catalog scope 的已验证兼容候选，再检查同 provider 的其他允许 scope，最后检查其他允许 provider。选择结果冻结后，catalog refresh 或真实调用失败都不能触发后台换模型。完整行为与类型边界见 [`docs/models-manager.md`](../../docs/models-manager.md#103-模型选择与替换)。

## 有效模型信息与职责

- `entry.info()` 返回原始目录信息；`entry.model_info(&provider_config)` 返回配置生效后的独立副本。
- 先校验 provider 身份和配置。自定义连接的窗口优先，否则按准确 ModelId 读取 `model_context`。
- 配置窗口不能超过目录已知窗口。未配置压缩阈值时建议使用有效窗口的 90%；显式阈值同样受此上限限制。
- 未知窗口保持未知，除非配置明确提供。配置不推断工具能力、不改变 availability，也不改写 snapshot、provenance 或 generation。
- App Server 的模型列表使用当前条目计算有效信息；调用预算使用共享 manager 的静态解析结果。输出预留、安全余量和真正执行压缩由 App Server/Core 负责。
- `ModelInfo` 的序列化字段仍由 protocol 定义；压缩建议的计算从 protocol 移入本 crate。

与 Codex 的职责对应：

| Codex 位置 | Ash 归属 |
| --- | --- |
| `model-provider-info` 的供应商声明、默认值和校验 | `model-provider-config` |
| `model-provider-info` 的凭据读取、请求 Header 和 API target 转换 | `model-provider`、登录服务和 client |
| `models-manager/model_info` 的模型信息与配置覆盖 | 本 crate 的 `model_info.rs` |
| 模型专化指导 | 本 crate 的 `instructions.rs`；共同规则在 `prompts` |

现有 crate 已提供供应商配置和调用依赖隔离，无需再建立同职能的 `model-provider-info`。
Codex 针对未知模型写入的固定规格不适用于这里的多供应商目录。

## Agent 指令边界

- 共同规则归 `ash-prompts::AGENT_INSTRUCTIONS`；这里的模板只补充模型表达和工具调用指导。
- `ModelInstructionCatalog::built_in()` 返回共享的内置初版目录，当前覆盖静态模型目录中的 16 个准确 provider/model 身份。
- `ModelInstructionCatalog::new` 校验自定义目录；`default()` 明确创建空目录，已知模型也使用 Generic。
- `resolve` 只做准确匹配，不按 provider、型号前缀、显示名或 API 地址推断；同一正文可以由多个准确条目共用。
- App Server 和委托工具默认使用内置目录。嵌入方可在环境创建前通过 `with_model_instructions` 整体替换它，包含用空目录建立 Generic 对照。
- 每次选择记录准确模型、正文、id/revision 和摘要；结构校验通过不代表模型效果已评测。

### 初版模板与修改入口

| 文件 | 当前登记 | 指导重点 |
| --- | --- | --- |
| [gpt.md](templates/instructions/gpt.md) | OpenAI 的 GPT-6 Astra、GPT-5.6/sol/terra/luna、GPT-5.5 | 结果与范围、适量验证、保留交付证据 |
| [claude.md](templates/instructions/claude.md) | `anthropic/claude-sonnet-4-20250514` | 从建议推进到所需产物，限制额外抽象和改动 |
| [gemini.md](templates/instructions/gemini.md) | `google/gemini-3.6-flash` | 长上下文中的当前任务、直接输出与证据定位 |
| [function_calling.md](templates/instructions/function_calling.md) | 当前 Grok、Qwen、Kimi、DeepSeek、GLM、MiniMax、MiMo 共 8 个准确条目 | 结构化调用、参数与自然语言分开、收到结果后继续 |

完整登记项与 revision 在 [instructions.rs](src/instructions.rs) 的 `BUILT_INS`。工具调用模板是框架适配初稿，不表示这些模型有相同的内部行为或已经完成各自的优化。

1. 调整措辞：编辑对应 Markdown，并提升同一组 `PromptArtifact` 的 revision。
2. 单独适配某个模型：增加一份 Markdown 和一个登记组，把该模型的准确条目移入新组；不能让同一模型同时属于两个组。
3. 编译并重启宿主。普通 Default 根会话的新 Turn 重新选择指导；已冻结的角色/子 Agent 继续使用旧快照，验证新内容时创建新的相应 Agent。
4. 运行 `just test ash-models-manager`、`just test ash-app-server built_in_model_guidance` 和 `just check ash-app-server`。测试检查静态目录覆盖、重复/无效条目、准确匹配、主/子 Agent 接线与共同规则保留。

初版已按当前需求启用，质量、延迟和成本收益尚未实测。来源、假设与后续评测见 [模型初版指导](../docs/agent-instructions.md#内置模型指导初版)。供应商请求参数、推理元数据、历史重放与工具协议由 provider adapter 和 Core 拥有，模板不替代它们。

新增资产由 `BUILD.bazel` 的 `templates/instructions/*.md` 清单编译打包，`.gitattributes` 固定 LF。正文上限 64 KiB；模型族匹配、工具条件模板和运行时模板语言不在本接口中。
