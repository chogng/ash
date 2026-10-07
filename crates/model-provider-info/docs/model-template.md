# GPT、Claude、Gemini、GLM、Kimi、Grok 通用模型声明规范

通用模板可以覆盖这六家，但必须同时描述**模型规格、参数约束和接入差异**。统一字段名后，还要知道它适用于哪个型号、哪个协议、什么条件，以及如何编码成请求。每个模型都使用同一套结构，按官方证据填写；字段多或提示词长，都不能单独证明完整性。

本文供维护模型目录、请求构造器和模型设置界面的开发者使用。官方文档核对日期为 **2026-10-05**。下面的完整字段结构是设计建议，不代表 Rust 协议和请求构造器已支持所有字段。服务等级的 ID、名称、说明及默认值，以及服务等级／速度／高速型号三种加速声明，已经通过 `settings.service_tiers`、`default_service_tier`、`acceleration` 接入当前目录、请求和模型设置卡。模型简介、带说明的推理档位和从实际解析声明生成的 JSON Schema 也已接入；当前可解析字段和已有调用链见 [crate README](../README.md#统一静态模型清单)。

官方字段对照覆盖标题中的六家；产品目录也包含 DeepSeek、Meta 等供应商，具体条目以 [模型目录](../models/) 为准。接入配置规则见 [模型接入配置](../../../docs/config.md#模型接入配置)。

请求字段、消息顺序、提示词内容与思考历史的远端校验于 **2026-10-06** 单独核对，见 [第 11 节](#11-远端请求校验2026-10-06-核对)。该节区分官方接口要求、仓库已有实测和当前编码缺口，不把生成成功等同于工具续答兼容。

## 1. 声明归属

`models/<provider>.json` 放在 `model-provider-info` 合理：模型规格、完整基础提示词、参数支持声明属于共享数据。`models-manager` 负责目录来源、刷新、合并和选择。通用规范不要求把端点、认证和全部厂商请求 JSON 塞进模型条目。

| 内容           | 维护位置与职责                                                         | 例子                                                     |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 模型事实       | `model-provider-info/models/<provider>.json`，以准确厂商＋模型 ID 为键 | 上下文、模态、型号级推理档位、生命周期                   |
| 接入声明       | `model-provider-info` 的接入定义；约束按模型＋接入协议绑定             | 地址、协议版本、生成/计数/流式操作、必需请求头、接入限制 |
| 请求编码       | `ash-api` 定义协议类型和编解码，`model-provider` 选择并调用            | `reasoning.effort` 与 `output_config.effort` 的不同结构  |
| 目录与有效能力 | `models-manager` 合并有来源的规格；调用方结合已选接入进行校验          | 模型会看图，但所选接入没有图像输入协议                   |
| Ash 执行策略   | 模型条目的独立 `host_policy` 部分；Core 和宿主执行                     | 执行上下文预算、压缩阈值、工具结果截断预算               |
| 基础提示词     | 模型条目的 `model_messages.system_instructions`，完整正文              | 工作原则、工具使用和结果报告                             |
| 运行时事实     | 账户、凭据、会话与调用记录的各自负责方                                 | 账户权限、实际服务等级、缓存命中、token 用量             |

有效能力必须同时满足模型声明、所选接入协议和 Ash 已实现的调用能力；账户权限在运行时确认。API、订阅代理和第三方托管接入分别声明，不能从厂商公共 API 继承全部能力。

自定义兼容端点按其明确声明的协议和约束接入；通用 tokenizer 资产绑定与聊天模板执行独立于推理接入，安装和绑定见 [tokenizer 文档](../../model-tokenizer/README.md)。第三方托管接入还需记录实际服务商与路由约束，通用声明规范应区分模型事实与托管接入能力。

## 2. 官方接口逐家对照

### 2.1 消息、输出预算和结构化输出

下面列 HTTP JSON 字段，不把 SDK 的辅助参数名当作请求字段。表中的字段存在，不代表同一家所有型号都接受。

| 模型家族／协议             | 输入与系统指导                                       | 输出 token 上限                                | 结构化输出／工具定义                                                                                                                    | 官方依据                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT／Responses             | `input`、`instructions`                              | `max_output_tokens`，包含推理 token            | `text.format`；函数工具为 `tools[]` 的 `name`、`parameters`、`strict` 等字段                                                            | [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)                                                                           |
| Claude／Messages           | `messages`、顶层 `system`；常规对话按内容块组织      | 必填 `max_tokens`，思考也占此预算              | `output_config.format`；工具为 `name`、`input_schema`，结果为 `tool_result` 内容块                                                      | [Messages](https://platform.claude.com/docs/en/api/messages/create)、[结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)                         |
| Gemini／Interactions       | `input`、`system_instruction`                        | `generation_config.max_output_tokens`          | `response_format`；`tools`，`generation_config.tool_choice`                                                                             | [Interactions reference](https://ai.google.dev/api/interactions-api)                                                                                                                |
| Gemini／GenerateContent    | `contents`、`systemInstruction`；模型 ID 在 URL 中   | `generationConfig.maxOutputTokens`             | `generationConfig.responseFormat`；旧字段 `responseMimeType`、`responseSchema` 需按版本区分；`tools.functionDeclarations`、`toolConfig` | [GenerateContent reference](https://ai.google.dev/api/generate-content)                                                                                                             |
| GLM／Z.AI Chat Completions | `messages`，含 `system`、`user`、`assistant`、`tool` | `max_tokens`，上限按型号                       | 当前 reference 列 `response_format.type=text/json_object`；工具为 `tools[].function`                                                    | [Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)                                                                                                              |
| Kimi／Chat Completions     | `messages`，多模态内容使用内容数组                   | `max_completion_tokens`；`max_tokens` 已标弃用 | `response_format.type=text/json_object/json_schema`；`tools[].function`                                                                 | [Chat API](https://platform.kimi.ai/docs/api/chat)                                                                                                                                  |
| Grok／Responses            | `input`，有类型的输出项                              | `max_output_tokens`                            | `text.format`；Chat／xAI SDK 指南另使用 `response_format`，两者按协议区分                                                               | [协议对照](https://docs.x.ai/developers/model-capabilities/text/comparison)、[结构化输出的 Responses 示例](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) |

Gemini 已推荐 Interactions，GenerateContent 仍受支持。Ash 当前 Google 生成接入使用 OpenAI 兼容 Chat Completions，因此还要独立描述它的 `messages`、`reasoning_effort` 和兼容接口约束；上表的两套 Google 字段不能直接送到该接入。[官方接口选择](https://ai.google.dev/gemini-api/docs/interactions-overview)、[兼容接口](https://ai.google.dev/gemini-api/docs/openai)

JSON 对象输出和按 JSON Schema 约束输出是两种能力。参数 schema、响应 schema 的支持子集也要分别记录；“支持 JSON”不能推出支持任意 schema。Claude 官方明确区分响应格式约束与工具 `strict`，并列出 schema 限制。[Claude 结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

### 2.2 思考模式、深度、预算和返回内容

| 家族   | 模式与深度字段                                                                                                   | 数值思考预算                                                        | 思考内容与历史                                                                                                                                 | 必须保留的型号差异                                                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT    | Responses `reasoning.effort`；允许值、默认值按型号                                                               | 不把 effort 换算成固定 token 数                                     | 摘要和继续对话所需的不透明内容分别声明                                                                                                         | GPT-6 Astra 不接受 `none`；不能给整个 GPT 家族一个通用关闭开关。[推理指南](https://developers.openai.com/api/docs/guides/reasoning)                                                                                                   |
| Claude | `thinking.type`、`output_config.effort`                                                                          | 较早的扩展思考型号使用 `thinking.budget_tokens`                     | 思考块及签名按协议要求保存、重放                                                                                                               | Opus 5.5 自适应思考常开；Sonnet 5.5 的 `between_tools` 只适用于 `low/medium/high`。[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Gemini | Interactions `generation_config.thinking_level`；GenerateContent `generationConfig.thinkingConfig.thinkingLevel` | Gemini 2.5 的 GenerateContent 使用 `thinkingBudget`；取值语义按型号 | Interactions `generation_config.thinking_summaries`；GenerateContent `generationConfig.thinkingConfig.includeThoughts`；摘要与思考签名分开处理 | Gemini 3 与 2.5 的控制不同；`minimal` 不能统一解释成关闭。[思考指南](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[Interactions reference](https://ai.google.dev/api/interactions-api)                           |
| GLM    | `thinking.type`、顶层 `reasoning_effort`                                                                         | 当前引用不提供可普遍套用的独立 budget 字段                          | `reasoning_content`；`thinking.clear_thinking` 控制历史保留                                                                                    | GLM-5.3 只允许开启，深度为 `low/high/max`；5.2 还接受会映射为其他行为的兼容值。[型号迁移规则](https://docs.z.ai/guides/overview/migrate-to-glm-new)                                                                                   |
| Kimi   | K3 顶层 `reasoning_effort`；K2.x 使用 `thinking`                                                                 | 当前引用不提供通用独立 budget 字段                                  | Preserved Thinking 要求原样返回完整 assistant 消息，包括 `reasoning_content`                                                                   | K3 为 `low/high/max`、默认 `max`、思考常开；K2.6 可关闭；K2.7 Code 常开。[型号参数](https://platform.kimi.ai/docs/api/models-overview)、[思考历史](https://platform.kimi.ai/docs/guide/use-thinking-models)                           |
| Grok   | Responses `reasoning.effort`；SDK 示例也会出现 `reasoning_effort`                                                | 当前引用不提供通用独立 budget 字段                                  | Responses `reasoning.encrypted_content` 是不透明历史；Chat 接口不返回对应密文                                                                  | 4.6/4.7 有 `xhigh`，4.5 的有效深度只有 `low/medium/high`；不可关闭。[推理指南](https://docs.x.ai/developers/model-capabilities/text/reasoning)                                                                                        |

必须分别描述四件事：是否思考、投入多深、允许用多少 token、是否返回摘要或历史凭据。同名 effort 不保证跨型号、跨厂商有相同投入。思考预算和整次响应预算还要描述共享关系，避免把推理 token 与可见输出预算重复计算。

Claude 的常规系统指导使用顶层 `system`；新型号另有带 beta 头的逐消息 effort 变更协议。不能把这类专门的 `role=system` 消息当成普通系统文本，也不能只靠一个“支持 system role”布尔值描述。[逐消息 effort](https://platform.claude.com/docs/en/build-with-claude/effort)

### 2.3 约束实例：单个布尔值无法表达

| 官方规则                                                                             | 模板需要记录什么                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kimi K3 温度固定为 1、`top_p` 固定为 0.95，其他值报错；K2.6 的固定温度随思考模式变化 | `mutability=fixed`、固定值、模式条件、非法值处理；固定参数通常省略发送。[参数表](https://platform.kimi.ai/docs/api/models-overview)                                                  |
| GLM `do_sample=false` 时 `temperature/top_p` 失效                                    | 参数之间的条件和 `ignored` 行为；官方 `stop` 正文与 schema 数量限制还存在差异，填入前需核实，不能挑较宽的限制。[Chat reference](https://docs.z.ai/api-reference/llm/chat-completion) |
| Grok 推理模型拒绝 presence/frequency penalty 和 stop                                 | 所选型号＋协议的明确拒绝规则；传值前报错。[Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)                                                                |
| Claude Sonnet 5.5 在 `between_tools` 下不允许会话中变更 effort                       | 模式与 effort 的允许组合，以及跨轮变更限制。[Effort](https://platform.claude.com/docs/en/build-with-claude/effort)                                                                   |
| Kimi K3 支持 `tool_choice=required`，K2.6 和 K2.7 Code 不支持                        | 型号级枚举，不能在厂商级统一开启 required。[参数表](https://platform.kimi.ai/docs/api/models-overview)                                                                               |
| Google 接口 schema 说明部分参数并非每个型号都能配置                                  | 接口字段声明与型号可用集合分别保存。[GenerationConfig](https://ai.google.dev/api/generate-content)                                                                                   |

### 2.4 缓存、会话和加速

这些能力属于具体接入操作，不能统一缩成 `cache=true` 或 `fast=true`。

| 能力     | 已核对的官方差异                                                                                                                     | 模板要求                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缓存控制 | OpenAI 新型号有 `prompt_cache_options` 与显式断点；Claude 有内容块 `cache_control`；Google GenerateContent 使用 `cachedContent` 引用 | 区分自动缓存、显式断点、缓存资源；分别记录 TTL、断点数量和操作范围。[OpenAI reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)、[Google reference](https://ai.google.dev/api/generate-content) |
| 状态保存 | Grok Responses 使用 `store`、`previous_response_id`；Gemini Interactions 使用 `store`、`previous_interaction_id`                     | 保存开关、关联 ID、历史重放与保留期限分别声明；缓存不是会话存储。[xAI 对照](https://docs.x.ai/developers/model-capabilities/text/comparison)、[Gemini 概览](https://ai.google.dev/gemini-api/docs/interactions-overview)                                                                                               |
| 加速     | xAI `service_tier=priority` 是调度等级，响应报告实际等级；Kimi Highspeed 是不同模型 ID                                               | 分开记录请求等级、响应实际等级、型号切换；不得由名字含 Flash 推出可切换 Fast。[xAI Priority](https://docs.x.ai/developers/advanced-api-usage/priority-processing)、[Kimi 型号规则](https://platform.kimi.ai/docs/api/models-overview)                                                                                  |
| 传输     | xAI Responses 有单独 WebSocket 协议；Google Live 与文本生成是独立操作                                                                | HTTP、SSE、WebSocket、实时语音分别绑定协议和凭据范围；不能由 HTTP 兼容推导 WebSocket。[xAI WebSocket](https://docs.x.ai/developers/advanced-api-usage/websocket-mode)、[Google Live](https://ai.google.dev/api/live)                                                                                                   |

## 3. 通用字段目录

以下是建议覆盖的语义范围。各字段组的支持状态独立维护；无证据的属性省略具体值，并保留 `unknown`。字段名是提案，不是第二份手写 Rust 类型定义或现有 JSON Schema。

### 3.1 模型事实

| 字段组     | 建议字段                                                                             | 含义与边界                                                                    |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 身份       | `vendor_id`、`model_id`、`display_name`、`family`、`version`                         | 保留准确上游身份；别名与实际返回型号分开                                      |
| 生命周期   | `lifecycle.status`、`released_at`、`deprecated_at`、`retired_at`、`replacement`      | 日期仅填官方确认值；替代型号不触发自动换模                                    |
| token 规格 | `limits.context_tokens`、`max_input_tokens`、`max_output_tokens`、`budget_semantics` | 上下文容量、输入上限、响应上限独立；写清推理、工具参数是否计入响应预算        |
| 输入       | `input.modalities`、`media_constraints`、`instruction_channels`、`assistant_prefill` | text/image/audio/video/document；文件格式、尺寸、数量、时长；系统指导承载方式 |
| 输出       | `output.modalities`、`modality_combinations`                                         | 能否输出音频或图像与输入能力分开；记录允许同时请求的组合                      |
| 证据       | `evidence`                                                                           | 每组值对应官方链接、型号/接口/区域、文档版本、复核日期和验证状态              |

文件上传接口接收 PDF，不自动说明模型支持整份文档的所有页数、视觉内容或同一种计数方式。图片细节等级、视频帧处理、音频时长与文件资源生命周期都由所选接入补充。

### 3.2 参数与能力约束

| 字段组     | 建议字段                                                                                             | 需要描述的规则                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 思考       | `reasoning.mode`、`effort`、`token_budget`、`summary`、`history`、`change_scope`                     | 模式、真实深度、预算、返回内容、历史保留、跨轮修改条件各自独立                |
| 采样       | `sampling.temperature`、`top_p`、`top_k`、`seed`、`presence_penalty`、`frequency_penalty`、`enabled` | 范围、固定值、默认值、互斥/失效条件；seed 不声明成确定性保证                  |
| 停止与候选 | `generation.stop_sequences`、`candidate_count`、`logprobs`、`top_logprobs`                           | 个数/长度限制、联动条件、推理模式限制                                         |
| 输出格式   | `output.format`、`schema_profile`、`verbosity`                                                       | text、JSON 对象、JSON Schema、模态格式；schema 支持子集与普通文本长度控制分开 |
| 客户端工具 | `tools.function_calling`、`choice`、`parallel_calls`、`strict_arguments`、`schema_profile`、`limits` | 允许选择的模式、指定函数、调用数量/名称长度、参数结构、并行开关               |
| 工具历史   | `tools.history`、`result_modalities`、`call_id_policy`                                               | Call/Result 配对、返回角色/内容块、必须保留的推理信息、工具错误表达           |
| 托管工具   | `server_tools`                                                                                       | 检索、执行、MCP 等逐工具注册；厂商工具名称、版本与访问权限由接入绑定          |
| 缓存       | `cache.automatic`、`explicit_breakpoints`、`resource_reference`、`ttl`、`invalidation`               | 三种机制不合并；说明哪些字段变化会影响缓存                                    |
| 会话       | `state.store`、`continuation`、`history_replay`、`compaction`                                        | 存储默认、保留期限、前序引用、摘要/签名/密文重放、服务端压缩操作              |
| 服务等级   | `execution.service_tiers`、`speed`、`accelerated_model`、`background`                                | 调度等级、速度参数、型号切换分别描述；后台执行与流式返回独立                  |

### 3.3 接入和响应契约

| 字段组     | 建议字段                                                                                     | 归属与作用                                                                 |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 操作绑定   | `connection_id`、`protocol`、`api_version`、`operation`、`model_binding`、`required_headers` | 模型＋接入＋操作的唯一身份；区分 URL 模型 ID 与 body 字段，不保存秘密      |
| 参数映射   | `parameter_bindings`、`value_mappings`、`conditional_rules`                                  | 保留字段路径与文档化值映射；由有类型的 codec 执行，JSON 不编写任意转换脚本 |
| 流式       | `transport`、`stream.events`、`termination`、`usage_delivery`                                | 帧协议、增量类型、成功终止证据、何时报告完整 usage                         |
| token 计数 | `token_count.operation`、`accuracy`、`coverage`                                              | 生成前计数是否涵盖工具、模态、系统指导；完成后的 usage 不能代替计数操作    |
| 用量       | `usage.input`、`output`、`reasoning`、`cache_read`、`cache_write`、`accounting_semantics`    | 原始字段位置、包含关系和未知值；不把 reasoning 再加到已含它的 output       |
| 完成原因   | `finish_reasons`、`incomplete_reasons`、`tool_continuation`                                  | 正常结束、预算用尽、工具等待、拒绝等与协议事件对应                         |
| 错误       | `errors.parameter_rejection`、`rate_limit`、`retry_after`、`request_id`                      | 记录协议能提供的证据；实际重试与取消由调用负责方执行                       |

账户 RPM/TPM 配额、已用量、当前额度和实时模型可用性是运行时数据，不写死进模型事实。价格使用独立、带日期的计价记录，见 [计价设计](../../docs/model-accounting.md)。

## 4. 参数描述器

每个可配置参数复用一种描述器，减少重复，又保留限制。`support` 使用 `true / false / null`：分别表示已确认支持、已确认不支持、尚无足够证据；省略字段同样表示未知。布尔与空值表达支持状态，范围、固定值和支持条件由各自字段描述。

| 属性                                     | 建议类型                                | 规则                                             |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `support`                                | `boolean 或 null`                       | `true` 支持、`false` 不支持、`null` 或省略为未知 |
| `value_type`                             | 有类型的值类别                          | boolean、integer、number、enum、schema 等        |
| `mutability`                             | `configurable / fixed`                  | 固定参数仍有有效值，但界面不能提供可调滑块       |
| `allowed_values`／`range`／`fixed_value` | 枚举、边界或固定值                      | 范围含单位与开闭边界；三者按类型选择             |
| `upstream_default`                       | 已确认的值                              | 官方未声明时省略；与 Ash 偏好分开                |
| `required`                               | boolean 或有类型条件                    | 例如 Messages 的输出上限必填                     |
| `conditions`                             | 参数路径＋操作符＋有类型值              | 描述模式、其他参数、协议版本与 beta 头限制       |
| `invalid_value_behavior`                 | `reject / ignored / documented_mapping` | 区分错误、无效和明确的兼容映射                   |
| `change_scope`                           | 请求/轮次/会话约束                      | 说明是否可在会话中修改以及历史影响               |
| `evidence`                               | 证据 ID 列表                            | 约束、默认值和支持范围均有对应来源               |

描述器不允许用通用 `extra_body` 或任意 JSON 覆盖绕过校验。文档化映射必须明确列出接受值和最终行为；“接受七个字符串”不等于“七个深度”。参数未知时不能给用户显示已验证的开关；用户明确选择不受支持的值，应在请求前解释原因，不静默丢弃或换成另一个值。

## 5. JSON 结构示例

以下以 Kimi K3 的少量已确认字段展示结构。它是**提案示例**，不是可直接替换当前 `models/<provider>.json` 的条目。未确认的媒体限制、输出预算计数细节及其他参数继续保持未知。

```json
{
  "schema_version": 1,
  "models": [
    {
      "vendor_id": "kimi",
      "model_id": "kimi-k3",
      "display_name": "Kimi K3",
      "reasoning": {
        "mode": {
          "support": true,
          "value_type": "enum",
          "mutability": "fixed",
          "fixed_value": "enabled",
          "evidence": ["kimi-parameters-2026-10-05"]
        },
        "effort": {
          "support": true,
          "value_type": "enum",
          "mutability": "configurable",
          "allowed_values": ["low", "high", "max"],
          "upstream_default": "max",
          "invalid_value_behavior": "reject",
          "evidence": ["kimi-parameters-2026-10-05"]
        },
        "history": {
          "support": true,
          "policy": "preserve_complete_assistant_message",
          "evidence": ["kimi-thinking-2026-10-05"]
        }
      },
      "sampling": {
        "temperature": {
          "support": true,
          "value_type": "number",
          "mutability": "fixed",
          "fixed_value": 1.0,
          "invalid_value_behavior": "reject",
          "evidence": ["kimi-parameters-2026-10-05"]
        }
      }
    }
  ],
  "bindings": [
    {
      "vendor_id": "kimi",
      "model_id": "kimi-k3",
      "connection_id": "kimi",
      "protocol": "kimi_chat_completions",
      "api_version": "v1",
      "operation": "generate",
      "parameter_bindings": {
        "reasoning.effort": {
          "request_path": ["reasoning_effort"],
          "encoding": "enum_identity"
        }
      },
      "history_codec": "kimi_preserved_thinking",
      "evidence": ["kimi-chat-2026-10-05"]
    }
  ],
  "evidence": {
    "kimi-parameters-2026-10-05": {
      "url": "https://platform.kimi.ai/docs/api/models-overview",
      "reviewed_at": "2026-10-05",
      "scope": {"model_id": "kimi-k3", "protocol": "kimi_chat_completions"},
      "verification": "official_documentation"
    },
    "kimi-thinking-2026-10-05": {
      "url": "https://platform.kimi.ai/docs/guide/use-thinking-models",
      "reviewed_at": "2026-10-05",
      "verification": "official_documentation"
    },
    "kimi-chat-2026-10-05": {
      "url": "https://platform.kimi.ai/docs/api/chat",
      "reviewed_at": "2026-10-05",
      "verification": "official_documentation"
    }
  }
}
```

示例把声明和绑定并列展示，便于阅读；长期存储仍按第 1 节职责归属。`enum_identity` 与 `history_codec` 表示协议层注册的有类型行为，不能把普通字符串当作可执行代码。`host_policy` 和 `model_messages` 独立维护，不因 API 中存在同名字段而混在一起。

证据至少区分官方文档、脱敏协议测试和真实服务验证。查到文档只能证明来源；本次未持有六家账户逐个实连，也未验证所有旧型号和区域组合。厂商总表的参数全集不能直接复制成每个型号的能力。

## 6. Ash 策略与提示词模板

| 内容         | 建议结构                                                | 如何生效                                                                                 |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 执行预算     | `host_policy.context_options`、`default_context_tokens` | Ash 选择本次预算，受模型/接入容量约束                                                    |
| 自动压缩     | `host_policy.auto_compact_token_limit`                  | Core 使用预算阈值；区别于厂商压缩 API                                                    |
| 工具输出限额 | `host_policy.tool_output_limit`，带计量方法和单位       | 保留完整原始结果，限制给模型的文本；当前 token 限额使用 UTF-8 字节近似，不能标为准确计数 |
| 请求偏好     | `host_policy.request_defaults`                          | Ash 默认 effort/verbosity 等必须通过所选接入校验；不改写官方默认值                       |
| 基础指导     | `model_messages.system_instructions`                    | 模型专用完整正文，按新 Turn 冻结；不保存账户、工具清单或本次项目状态                     |

`model_messages` 保存本地模型指令声明，包含必填字符串 `system_instructions`，以及可选的 `tools.<tool>.description`、`collaboration_modes.<mode>`、`multi_agent.root/subagent`，没有手写版本号。工具参数由工具实现维护，模型文本追加到当前可用工具的说明；模式和身份指导按实际状态选择，保留宿主规则。省略可选字段表示没有额外指导，已声明文本不得空白，全部文本合计最多 64 KiB。`models-manager` 按每段正文的 SHA-256 摘要标识冻结资产，历史保留当时的全文及分组。该容器不直接作为供应商请求发送；Core 组装指令后由接入层编码，具体字段见第 2 节。Codex 的 `persistent_instructions` 是 persistent mode 的额外 developer 指令，省略或 `null` 使用其内置正文，空字符串关闭这项指导；Ash 当前没有对应字段。Role、权限、项目、工具参数和实际协作状态由各自负责方维护。

基础正文可以统一包含工作目标、工具和结果使用、编辑与验证、权限边界、任务完成和报告规则。型号专用指导只写有官方依据或评测证据的差异。Role、权限、项目指令、动态工具和用户当前任务由运行时加入；提示词不能开启推理档位、扩大 API 上限或授予工具权限。现有规则见 [Agent 指令设计](../../docs/agent-instructions.md)。

## 7. 与当前 Ash 的逐项缺口

当前类型以 [StaticModelSpec](../src/static_model_spec.rs)、[ModelSettings](../../protocol/src/model/parameters.rs) 和 [接入定义](../src/definition.rs) 为准。当前目录的 [JSON Schema](../models.schema.json) 从 Rust 解析声明生成，App Server 的 JSON Schema 和 TypeScript 类型从共享协议生成，避免另建一份手工类型。当前服务等级格式与示例见 [可解析的模型设置](../README.md#统一静态模型清单)。

| 范围           | 当前状态                                                                       | 规范要求补充                                                         |
| -------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 身份与基础正文 | 已有准确身份、显示名、可选简介、完整提示词；冻结版本由正文摘要生成             | 字段级来源、适用型号/接入版本与复核状态                              |
| 上下文         | 已有容量、执行预算选项、压缩阈值                                               | 独立输入/输出上限、计数语义；模型事实与 Ash 执行策略明确分组         |
| 模态           | `ModelSettings` 有 text/image/audio 输入列表；前端图片附件消费该字段                                   | video/document、输出模态、组合、媒体限制与操作范围                   |
| 推理           | 已有带可选说明的支持档位与默认档位                                             | 模式、数值预算、合法组合、摘要与历史重放、跨轮变化规则               |
| 请求设置       | 已有 verbosity、摘要；服务等级含 ID、名称、说明与默认值，加速机制独立声明      | 通用参数描述器、采样/停止/输出格式/schema 子集；默认值分清官方和 Ash |
| 工具           | 已有工具和并行能力标记、工具输出预算                                           | 工具选择、strict、schema 子集、数量限制、结果/历史协议               |
| 接入           | 已有 API profile、独立流式/语音协议、计数声明                                  | 型号＋操作级参数绑定和限制；Google 新协议需独立实现后才可声明已接入  |
| 退役公告       | 已有连接范围内的公告与可选确定日期，菜单徽标消费（见第 10 节）                 | 其他接入公告来源尚未自动接入；静态清单不声明接入特定日期             |
| 缓存与状态     | 协议实现已有部分缓存、会话行为；思考历史重放存在已确认的编码缺口（见第 11 节） | 可审阅的型号/操作声明，TTL、失效条件、历史与实际 usage 语义          |

Chat 输入从所选模型的 `settings.input_modalities` 判断图片入口和发送条件：明确的列表不含 image 时禁用；省略或 null 表示未知，保留现有入口，不从厂商或型号名称推断。自动选择模型时没有确定型号，也按未知处理。上传、剪贴板和截图共用浏览器解码、最长边 2048 像素的缩放及原始字节去重；20 MB 输入限额属于 Ash 的前端资源限制，不替代接入层的媒体规格校验。

完整性的检查单位是“实际能否按正确条件构造请求并解析结果”。Codex 的展示顺序、升级提示、搜索工具选择等还包含自身产品策略；这些字段要有 Ash 的明确负责方和调用用途，不能为了增加行数照抄。

## 8. Codex 字段与 Ash 的对应关系

Codex 的完整模型字段定义在相邻源码 `codex-rs/protocol/src/openai_models.rs` 的 `ModelInfo`，内置实例在 `codex-rs/models-manager/models.json`；`codex-rs/app-server-protocol/src/protocol/v2/model.rs` 的 `Model` 是供客户端选择模型的较小结果。它们是 Codex 自己的契约，不是跨供应商的标准。下面按当前本地源码逐项列出对应关系；没有对应消费者的字段不加入 Ash 目录。

| Codex `ModelInfo` 字段                                                                                      | Ash 对应字段或负责方                                                            | 当前处理                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `slug`、`display_name`、`description`                                                                       | `model_id`、`display_name`、`description`                                       | 静态、动态目录保留；简介可省略                                                           |
| `supported_reasoning_levels`、`default_reasoning_level`                                                     | `supported_reasoning_efforts[{effort,description}]`、`default_reasoning_effort` | 保留档位顺序及说明；Codex `xhigh` 对应 JSON `extraHigh`，请求仍按协议编码                |
| `service_tiers`、`default_service_tier`                                                                     | `settings.service_tiers[{id,name,description}]`、`default_service_tier`         | 原样保留请求 ID；默认值必须引用列表成员                                                  |
| `additional_speed_tiers`                                                                                    | `settings.acceleration`                                                         | Ash 用明确的等级、速度参数或高速型号声明加速；不复制另一份速度列表                       |
| `input_modalities`                                                                                          | `settings.input_modalities`                                                     | 现有 text/image/audio；不推断尚无协议的模态                                              |
| `support_verbosity`、`default_verbosity`                                                                    | `settings.verbosity`、`default_verbosity`                                       | 支持情况与默认值分开，未知状态保持未知                                                   |
| `supports_reasoning_summary_parameter`、`default_reasoning_summary`                                         | `settings.reasoning_summary`、`settings.default_reasoning_summary`              | 已接入声明、动态导入和请求；`none` 表示不请求推理摘要，不关闭推理                        |
| `supports_image_detail_original`                                                                            | `capabilities.image_detail_original`                                            | 保留明确能力声明                                                                         |
| `context_window`、`max_context_window`                                                                      | `context_window`、`max_context_window`                                          | 容量和 Ash 执行预算分开；动态 Codex 导入用已声明最大容量作为上限                         |
| `auto_compact_token_limit`                                                                                  | `auto_compact_token_limit`                                                      | 已接入；省略或 `null` 时按有效上下文的 90% 计算，显式值受该阈值限制                      |
| `effective_context_window_percent`                                                                          | Core 上下文预算计算                                                             | 目录没有同名字段；预算算法由 Core 维护，不能直接搬入 Codex 的保留比例                    |
| `comp_hash`                                                                                                 | Core 压缩兼容性与历史协议                                                       | 尚未接入；Codex 用于判定压缩历史兼容性，不是 token 阈值，也不复制固定值 `3000`           |
| `truncation_policy`                                                                                         | `settings.tool_output_limit`                                                    | 保留计量方式与限额；token 限额的当前估算语义见模型计价文档                               |
| `visibility`、`priority`                                                                                    | 动态目录适配与客户端可见性设置                                                  | Codex 订阅导入过滤隐藏项并保留排序；不把账户展示策略写进静态型号规格                     |
| `supported_in_api`、`available_access_programs`                                                             | 接入定义、凭据与运行时权限                                                      | API 和订阅接入独立校验；型号元数据不证明账户权益                                         |
| `availability_nux`、`upgrade`                                                                               | 产品展示与型号生命周期                                                          | 尚无对应的 Ash 展示消费者，不复制 Codex 提示                                             |
| `model_specialty`                                                                                           | 专用型号分类，以及权限和审批策略                                                | 尚未接入；Codex 的 `cyber` 会影响前缀规则和审批行为，不作为普通展示标签导入              |
| `model_messages`                                                                                            | `model_messages` 的基础、工具、模式与根／子 Agent 指导；Core 与各功能负责方     | 模型专用文本进入目录并随选择冻结；实际工具参数、模式、Role 与权限由所属模块维护          |
| `include_skills_usage_instructions`、`include_plugin_usage_instructions`、`include_apps_usage_instructions` | Skills、插件和连接工具指令组装                                                  | 属于 Ash 功能策略，不从型号名字或 Codex 标志开关功能                                     |
| `shell_type`、`apply_patch_tool_type`                                                                       | Shell、文件修改工具与工具运行时                                                 | 使用 Ash 工具契约，不复制 Codex 工具实现选择                                             |
| `web_search_tool_type`、`supports_search_tool`、`experimental_supported_tools`                              | 搜索和工具声明、工具注册                                                        | 工具开放、协议和权限由工具负责方校验，不由静态目录授权                                   |
| `supports_experimental_context`                                                                             | Core 上下文管理                                                                 | 尚无对应型号开关，不声称支持 Codex 的实验协议                                            |
| `use_responses_lite`                                                                                        | 接入 API profile 与 `ash-api`                                                   | 尚未实现该协议，不能只增加目录布尔值                                                     |
| `supports_reasoning_effort_updates`                                                                         | 接入历史编码与请求构造器                                                        | 尚无同名能力声明；当前 effort 通过普通请求参数发送                                       |
| `auto_review_model_override`                                                                                | Provider 审批模型默认值、`agent.approvalReviewModel`                            | 已有自动／显式选择；显式引用包含 provider、model 和可选连接，不导入 Codex 的型号覆盖字段 |
| `guardian`、`node_repl_auto_review_required`、`node_repl_disabled`                                          | Guardian、权限和 REPL 功能                                                      | 属于 Ash 执行策略；不能从外部目录改写安全或工具配置                                      |
| `tool_mode`、`multi_agent_version`、`multi_agent_reasoning_effort`                                          | 工具模式与协作功能                                                              | 不导入 Codex 的协作选择；Ultra 不是 Ash 模型推理档位                                     |
| `used_fallback_model_metadata`                                                                              | Codex 内部解析标记                                                              | 不属于 JSON 型号声明，也不写入 Ash 目录                                                  |

当前 GPT 长上下文声明使用默认 `272000`、最大 `872000`；与相邻 Codex 目录一致的旧型号 `gpt-5.5` 保持默认和最大均为 `272000`。容量按具体型号声明，不能给整个 provider 统一开启长上下文。`long_context = true` 使用所选连接的最大容量，`false` 使用默认容量；最大容量不高于默认容量时不提供开关。

`comp_hash` 若要成为 Ash 的跨 provider 契约，需要同时接入目录合并、压缩历史保存、恢复和切换模型时的兼容性判断。兼容性必须包含 provider 和连接来源，不能因为两个厂商都返回 `3000` 就认定它们的历史可互用。审批模型与专用型号的限制则由各自的执行策略负责；目录中的 `null` 不能代替这些调用链。

Codex 示例 JSON 还可能含有不在这份 `ModelInfo` 中的字段，例如 `prefer_websockets`、`supports_parallel_tool_calls`、`minimal_client_version`、`requires_sandboxed_review`。因此复制示例不能代替核对实际消费类型。Ash 已有并行工具声明；传输由接入定义负责，客户端版本与审批限制由相应功能负责。Ash 的 Schema 拒绝未声明字段。

修改当前目录请使用 [README 的可解析示例](../README.md#统一静态模型清单)，并运行 `just generate-model-catalog-schema --check`。本文第 3–6 节的通用参数、绑定和来源结构仍是未实现的设计建议，不能直接写入 `models/<provider>.json`。

## 9. 落地时的验证要求

1. 同一语义只定义一份 Rust 契约；静态 JSON、动态模型信息与插件声明在各自入口校验。
2. 每个接入用本地协议测试证明字段路径、文档化值映射、必填项和合法组合。默认值不得超过范围；未知字段、冲突配置和不支持的用户值在发送前失败。
3. 工具往返测试保留 Call/Result ID、顺序和厂商要求的思考历史；签名或密文不得由文本摘要替代。
4. 流式测试覆盖完整终止、预算用尽、工具等待、取消、错误和最终 usage；零用量与未知用量分别表达。
5. 界面与 TUI 只提供有效可配置项；固定温度、不能关闭的思考模式和不支持的服务等级都按声明呈现。切换模型不能带入旧型号的非法设置。
6. 真实服务验证单独记录接入、型号、版本、日期和脱敏结果；本地 schema 与请求测试不能证明账户权益或模型质量。

## 10. 当前已实现的退役公告（2026-10-06 核对）

模型退役提示采用共享协议 `ModelRetirement { shutdown_date: Option<String> }`：
外层没有公告时不显示徽标；对象存在且日期为 null 表示已公告但日期尚未确定；
具体日期必须是有效的 YYYY-MM-DD。生命周期的 Legacy、Preview 分类不能证明即将退役。

| 接入                             | 官方证据与差异                                                                                                                                                                             | Ash 处理                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| OpenAI API 模型列表              | [models/list](https://developers.openai.com/api/reference/resources/models/methods/list) 返回可选 `shutdown_date`，null 表示未公告                                                         | 当前连接目录读取确定日期，null 撤回旧公告  |
| Claude API 模型列表              | [models/list](https://platform.claude.com/docs/en/api/models/list) 未声明同等停用日期字段；[退役公告](https://platform.claude.com/docs/en/docs/about-claude/model-deprecations) 是独立来源 | 不从 ID 或发布时间推断，不自动导入网页公告 |
| Gemini API                       | [models](https://ai.google.dev/api/models) 未声明同等字段；[退役表](https://ai.google.dev/gemini-api/docs/deprecations) 的日期可能只表示最早停用时间                                       | 不把最早日期当作确定日期；当前未自动导入   |
| GLM、Kimi、Grok、Ollama 当前接入 | 现有目录适配器未提供退役证据；没有核实通用公告接口                                                                                                                                         | 维持未知，不因为型号旧或没有发现而显示退役 |
| ChatGPT、Kimi、Grok 等订阅连接   | 与公开 API 的目录及可用范围独立，当前适配器未提供退役公告                                                                                                                                  | 不继承公开 API 的日期                      |

公告是连接目录事实，不能作为请求参数、访问权限或自动换模策略。
`models/<provider>.json` 当前没有可填写的退役字段；避免将某一 API 的停用计划扩散到同型号的所有接入。
来源补丁用现有 `Patch<ModelRetirement>` 区分省略、明确 null 和公告对象，
models-manager 合并并记录来源，App Server 输出可选 retirement，前端适配为 camelCase。
确定日期和无日期公告、撤回公告均有真实菜单消费者；原始公告的检索与维护仍归目录来源，
不在 Renderer 抓取网页或维护另一份型号时间表。

## 11. 远端请求校验（2026-10-06 核对）

远端会校验实际 HTTP 请求中的字段、值和消息结构；部分协议还会检查思考历史或提示词内容。固定厂商提示词并不是所有模型接入的共同要求。目前有明确仓库实测证据要求固定系统文本块的是 **BigModel Start Plan**；其他已查接口主要限制参数、历史和工具往返格式。

本节覆盖当前目录相关的 GPT、Claude、Gemini、GLM、Kimi、Grok、DeepSeek 和 Meta 接入。官方文档与源码在 2026-10-06 核对，本次没有重新进行账户实连。旧型号、其他区域、私有网关和未列出的账户配置不自动继承表中结论。“未发现固定正文要求”表示当前证据没有声明这项要求，不是已经通过实测排除服务端检查。

### 11.1 校验的对象

| 对象            | 需要区分的行为                                                                         | 对 Ash 的意义                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 本地模型声明    | `model_messages.system_instructions`、工具说明、模式和 Agent 身份指导属于 Ash 本地数据 | 不把 `model_messages` 容器或目录字段原样发送。Core 组装指导，`ash-api` 编码成端点实际支持的字段 |
| 请求字段        | 字段名、嵌套位置、类型、枚举、范围、必填项和参数组合                                   | 本地字段同义不代表远端接受同名 JSON；未知或不支持字段可能被拒绝，也可能被忽略                   |
| JSON 对象键顺序 | 本次未发现这些文本生成端点要求 `model`、`messages` 等键按固定顺序排列                  | 不为没有证据的键顺序限制设计新字段；不能把这一结论扩展到 multipart 或其他传输协议               |
| 数组与历史顺序  | 消息、内容块、并行工具调用和结果属于有序内容                                           | 保留协议要求的顺序、Call/Result ID 和不透明元数据，不按 UI 展示需要重排模型历史                 |
| 提示词内容      | 自定义指导、输出模式要求的文本、端点要求的固定文本、内容审核是不同约束                 | 支持自定义 system/developer 指导不证明任意请求都被接受；内容审核也不等于固定模板检查            |
| 缓存与思考历史  | 缓存未命中影响成本或速度；思考签名或必需历史缺失可能使续答报错                         | 历史校验不能只归入缓存，保持提示词不变也不能弥补签名或推理字段丢失                              |

[RFC 8259](https://datatracker.ietf.org/doc/html/rfc8259) 将 JSON 对象定义为无序键值集合，将数组定义为有序序列。这是格式语义，不是对所有网关实现的保证。以下表格只记录有证据的端点行为。

### 11.2 各接入的已知规则

| Provider、型号与接入                                                        | 请求字段、顺序或历史校验                                                                                                                                                                       | 提示词内容与证据边界                                                                                                                                     | 依据                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT 公开 API；具体能力按型号                                                | 开启 `strict` 的结构化输出会拒绝不支持的 JSON Schema                                                                                                                                           | `json_object` 模式要求上下文出现 `JSON`，否则报错；这是输出模式的内容条件，没有据此要求 Codex 的固定系统正文                                             | [结构化输出与 JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)                                                                                                                                                                                            |
| GPT 官方订阅 SIWC；`api.openai.com/v1/responses`                            | 要求 `store: false`、`stream: true` 和数组 `input`；拒绝显式 system 消息；不接受 `temperature`、`max_output_tokens` 等字段；函数或 custom 工具用 namespace 或 `additional_tools` 输入项        | 官方明确支持自定义 `instructions` 或 developer 消息；限制属于此订阅接入，不能套给普通 API key 或旧 Codex 后端                                            | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)                                                                                                                                                                                                  |
| GPT 的 Codex 订阅后端；`chatgpt.com/backend-api/codex`                      | 与 SIWC 公共 Responses 路由分开核对；本次未取得覆盖全部服务端校验的公开契约                                                                                                                    | 现有适配器传递 Ash 指导，不能仅凭客户端源码证明不存在固定文本检查；保持待确认                                                                            | [Ash ChatGPT 路由](../../chatgpt/src/oauth.rs)、[接入选择](../../model-provider/src/provider.rs)                                                                                                                                                                                                         |
| Claude `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-fable-5-1`；Messages | 回传 thinking 的签名绑定其之前的 system、tools 和消息。前缀改变时，2026-08-31 起新建账户或显式采用 `prefix_mismatch_behavior: error` 的请求会返回 400；部分扩展字段要求对应 beta header        | 约束的是旧思考块与历史是否匹配，未发现必须使用 Claude Code 固定正文的要求。没有更改前缀时可以继续追加工具结果和新用户消息                                | [Thinking block no longer matches the conversation](https://platform.claude.com/docs/en/api/errors#thinking-block-no-longer-matches-the-conversation)                                                                                                                                                    |
| Gemini 3 系列；GenerateContent 与 OpenAI 兼容 Chat Completions              | 当前工具调用轮次须回传思考签名；兼容接口位置为 `tool_calls[].extra_content.google.thought_signature`。缺失签名会 400；并行调用按 `FC1, FC2, FR1, FR2` 重放，交错为 `FC1, FR1, FC2, FR2` 会 400 | 支持自定义系统指导；未发现固定正文要求。Gemini 2.5 的签名要求不同，不继承 Gemini 3 规则；Interactions 的 thought step 也不使用此字段路径                 | [Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)、[兼容接口](https://ai.google.dev/gemini-api/docs/openai)                                                                                                                                                |
| Kimi `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`；公开 Chat Completions        | K3、K2.7 Code 必须保留历史 assistant 的 `reasoning_content`；K2.6 工具循环需保留本轮思考，跨轮保留由 `thinking.keep` 决定。字段及允许值按型号区分                                              | 官方 CLI 支持自定义系统提示词，未发现统一固定正文要求；公开 API 规则不自动证明 Desktop 网关或 OAuth 订阅接入的全部行为                                   | [Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models)、[自定义 Agent](https://moonshotai.github.io/kimi-cli/en/customization/agents.html)                                                                                                                                           |
| Kimi Code；`api.kimi.com/coding/v1`，以及 Desktop／CLI 独立连接             | 官方支持第三方 Coding Agent；具体网关仍需验证字段、思考历史和工具续答                                                                                                                          | 官方要求保留客户端真实身份。支持第三方工具及可自定义提示词是正面证据，不能用于保证所有网关均无其他限制；Desktop 网关仍待单独确认                         | [第三方 Agent 接入](https://www.kimi.com/en/help/kimi-code/third-party-agents)、[Ash 接入范围](../../kimi/README.md)                                                                                                                                                                                     |
| GLM 标准 API／Coding Plan；GLM-5.3 等型号                                   | 无效参数有接口错误；Coding Plan 默认开启思考保留，标准 API 默认关闭。启用保留时须回传完整、未修改的 `reasoning_content`；文档说明乱序或编辑影响质量和缓存，未据此保证一定返回 400              | 未发现固定正文要求；GLM-5.3、5.3 Flash 强制思考，不能套用其他型号的关闭开关。此规则不涵盖 Start Plan 网关                                                | [Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode)、[错误码](https://docs.z.ai/api-reference/api-code)                                                                                                                                                                                 |
| BigModel Start Plan；仓库实测型号 `glm-5.3-flash`；Anthropic 兼容网关       | 2026-10-02 实测缺少两个固定 system 文本块或将它们合并均返回 HTTP 405／3012；保留两个独立块后生成、工具往返和多轮会话成功                                                                       | 确实有固定文本与分块要求；这些是仓库既有实测，不是官方长期接口承诺。Z.AI Start Plan 相同适配有模拟覆盖，尚未实连确认                                     | [GLM 实测记录](../../../docs/models/glm.md#start-plan)、[固定块选择](../../model-provider/src/providers/start_plan.rs)                                                                                                                                                                                   |
| DeepSeek `deepseek-flash`、`deepseek-v4-pro`；思考模式 Chat Completions     | 请求带 `tools` 时，所有后续请求都须完整回传历史 `reasoning_content`，包括没有调用工具的轮次；缺失会 400。思考模式中的 `temperature`、presence/frequency penalty 被接受但不生效                 | 未发现固定正文要求；明确区分字段被接受与参数实际生效                                                                                                     | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)                                                                                                                                                                                                                                     |
| Grok／SuperGrok 代理；Grok Build Responses 调用链                           | 官方客户端源码记录推理内容缺少 `type: reasoning_text` 会 400，reasoning 的输出字段 `status` 不能直接作为输入回传。公开 API 的 effort 允许值也按 Grok 4.5／4.6／4.7 区分                        | 未找到代理强制固定正文的证据；客户端源码不能证明服务端没有其他校验。源码对照固定在 `37949780c144e37df692e3d669051a21fec24f20`，不冒充 Ash 当前适配器版本 | [官方请求源码](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-sampling-types/src/conversation/responses.rs#L171)、[型号推理规则](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[Ash 代理范围](../../supergrok/README.md) |
| Meta `muse-spark-1.3`；Chat Completions                                     | 不支持的参数返回 400，例如 `n > 1`、`modalities` 和误用 Responses 的 `text.format`；工具调用与结果配对、对话结构校验较严格                                                                     | 官方示例支持自定义 developer 指导，未发现 Muse Code 固定正文要求；不把 Messages／Responses 的规则自动套到此接入                                          | [Chat completion](https://dev.meta.ai/docs/protocols/chat-completions)                                                                                                                                                                                                                                   |
| Ollama、自定义 OpenAI 兼容服务、第三方模型托管                              | 本次没有逐端点核对；字段名兼容不能证明值、工具 schema 和历史处理兼容                                                                                                                           | 保持未知，不能从兼容协议或模型名字推断固定提示词与否                                                                                                     | [接入配置](../../../docs/config.md#模型接入配置)                                                                                                                                                                                                                                                         |

### 11.3 Ash 当前编码缺口

以下是 2026-10-06 对当前工作区的静态代码核对，不是本次复现的远端错误，也不把已有的第一轮生成测试写成完整兼容证明。

| 调用路径                  | 观察到的实现                                                                                                                                                                                     | 尚未完成的行为与影响                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Chat Completions 思考历史 | [响应解析](../../ash-api/src/endpoint/chat_completions.rs)读取 `reasoning_content`，但 `convert_message` 只编码角色、普通内容和工具调用，没有回传该字段                                          | Kimi／DeepSeek 的必需思考历史、GLM 的保留思考不能由当前编码完整重放；第一轮成功不代表工具续答成功 |
| Gemini 兼容接口的工具签名 | 同一 `convert_message` 只重建工具 ID、类型、函数名和参数，没有保留 `extra_content.google.thought_signature`                                                                                      | 签名没有进入完整保存与重放链路；Gemini 3 工具续答有明确协议风险                                   |
| Claude thinking 块        | [SSE 解码](../../ash-api/src/sse/anthropic_messages.rs)收集 signature；[最终响应解析](../../ash-api/src/endpoint/anthropic.rs)将 thinking 转成普通推理文本，未完整保留签名块及 redacted thinking | 尚未建立完整 thinking 历史的持久化、恢复和回传链路；SSE 能读取签名不等于运行时能重放它            |

### 11.4 设计与验收

接入约束由 `model-provider-info` 描述，`model-provider` 选择实际连接，`ash-api` 按该端点编码和解析。Core 继续拥有 Ash 的工具执行与任务编排。模型条目的提示词不承担远端字段白名单，也不能用提示词修复缺失的签名或推理字段。不透明思考数据必须能随会话完整保存、恢复，并按来源协议重放；不能用可见摘要替代。

后续验证以 **连接、端点、具体型号及配置** 为单位，保留日期、上游版本、脱敏错误码与终止结果：

1. 核对实际发送 JSON 的字段名、位置、类型和允许值；区分被拒绝、被忽略与实际生效，不能只看 HTTP 200。
2. 验证自定义 Ash 指导、真实工具调用、工具结果和续答的完整链路，再验证多轮与会话恢复。模型列表或无工具的短回复只证明对应操作。
3. 对协议要求的数组顺序、签名、推理历史和 Call/Result 配对做边界验证；保存完整模型返回，不丢弃字段后重建近似历史。
4. 只有文档或明确测试支持的固定文本、客户端版本及请求头才作为接入限制记录。未知限制标为待确认；新增声明不能代替实际编码和验收。

本节仅记录调研、已有验证和待补能力，没有修改上述编码缺口，也没有为 SIWC、旧 Codex 后端、Kimi 各网关和所有套餐新增实连验证。
