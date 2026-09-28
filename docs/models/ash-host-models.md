# 开发者 API 模型价格

这张表列出 Ash 内置模型目录中 OpenAI、Anthropic、Google、Qwen、DeepSeek 当前仍提供的**开发者 API 按量连接**模型，并保留已核价的其他供应商型号；核对时间为 2026-09-26。模型列使用 Ash 的模型 ID。订阅连接是否按相同规则计费，见[订阅套餐一览](plans-and-pricing.md)。

表内输入、输出、缓存读、缓存写金额均按每 100 万 token 计，Google 的缓存存储费另按每 100 万 token·小时计。输入表示未命中缓存的输入；缓存读表示命中缓存的输入。“上下文”列标出最大上下文窗口；按上下文档位变价的型号直接列出对应档位，顺序与价格栏一致。

## 推理档位

下表汇总 Ash 内置模型供应商的推理控制名称。档位数量按**有效推理行为**统计；同一家不同型号可能只支持其中一部分。`关闭`表示不启用推理，不算推理档位。供应商文档会更新，以下依据于 2026-09-27 核对。

| 供应商 | 推理档位数与名称 | 型号差异和控制方式 |
| --- | --- | --- |
| OpenAI | API 最多 7 档：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；ChatGPT Work/Codex 另有 `Ultra` | API 值由具体型号决定；例如 GPT-6 Astra 不支持 `none`。`Ultra` 是产品界面选择，使用 maximum reasoning，并可能运行额外 agent；它不是 API 的 `reasoning.effort` 值。`pro` 也是独立模式。[API 档位](https://developers.openai.com/api/docs/guides/reasoning) · [Work/Codex Ultra](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing) |
| Anthropic | 最多 5 档：`low`、`medium`、`high`、`xhigh`、`max` | 支持范围因型号而异；较早的型号可能使用 thinking token budget，而非 effort 档位。[官方文档](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Google | 最多 4 档：`minimal`、`low`、`medium`、`high` | Gemini 3 各型号支持集合不同；Gemini 2.5 使用数值 `thinkingBudget`，不与这些档位等同。[官方文档](https://ai.google.dev/gemini-api/docs/thinking) |
| xAI | 3 或 4 档：`low`、`medium`、`high`、`xhigh` | Grok 4.5 支持前三档；Grok 4.6 及更新型号支持四档。不能关闭推理。[官方文档](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Qwen | 新版常用 3 档：`low`、`medium`、`xhigh`；另可关闭 | 新型号可用 `reasoning_effort` 或数值 `thinking_budget`。部分兼容标签会映射到这三档；旧型号支持范围不同。[官方文档](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions) |
| Kimi | K3 为 3 档：`low`、`high`、`max`；部分型号只有开/关 | K3 思考常开；K2.6 可切换思考模式。开关不计作 effort 档位。[官方文档](https://www.kimi.ai/help/kimi-api/api-model-selection) |
| DeepSeek | 3 档：`low`、`high`、`max`；另可关闭 | DeepSeek V4 默认开启思考；`none` 关闭。其他兼容值会折叠映射到这些档位。[官方文档](https://api-docs.deepseek.com/guides/thinking_mode/) |
| GLM | 因型号不同为 3、6 或 7 档 | GLM-5.3：`low`、`high`、`max`；GLM-5.2：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；GLM-5.1：前述集合去掉 `max`。GLM-5.3 思考不能关闭。[官方文档](https://docs.z.ai/guides/overview/migrate-to-glm-new) |
| MiniMax | M3/M2.x 没有可调的推理深度档位 | M3 使用自适应思考，可按型号开关；M2.x 不能关闭。虽然部分端点接受 `reasoning_effort`，当前这些型号不会据此调节深度。[官方文档](https://platform.minimax.io/docs/api-reference/text-chat-openai) |
| MiMo | 0 个深度档位；2 种有效模式：关闭、开启 | 接口接受 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`，但不支持自定义深度；除 `none` 外都只表示开启。[官方文档](https://mimo.mi.com/docs/en-US/api/chat/responses) |

这些标签不能跨供应商直接比较，也不能用供应商级的固定枚举替代型号级支持列表。请求构造应依据所选型号和接入协议。

OpenAI 双价按“输入 ≤272K / 输入 >272K 至 1.05M”顺序排列，表中简写为“272K / 1M”。第二档从输入超过 272K 起适用，直到这些型号约 1.05M 的输入上限；整次会话按第二档计费，不要求请求正好达到 1M。GPT-5.5 和 GPT-5.4 的长上下文缓存读价未由官方单独公布。

Anthropic Claude 4.6 及更新型号默认支持 1M 上下文，长上下文不另设价格档；Haiku 4.5 和 Sonnet 4.5 的上下文上限为 200K。Claude Opus 5 仍可通过 API 调用，但已标为 legacy，官方建议迁移到 Opus 5.5；其单价见表。各型号单价仍不同，表中价格在各自支持的上下文范围内不因长度改变。

| 供应商 | 模型 | 上下文 | 输入单价 | 输出单价 | 缓存读单价 | 缓存写单价 | 官方来源 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| OpenAI | `gpt-6-astra` | 272K / 1M | &#36;10/&#36;20 | &#36;50/&#36;75 | &#36;1/&#36;2 | &#36;12.5/&#36;25 | [模型详情](https://developers.openai.com/api/docs/models/gpt-6-astra) |
|  | `gpt-6-sol` | 272K / 1M | &#36;2/&#36;4 | &#36;10/&#36;15 | &#36;0.2/&#36;0.4 | &#36;2.5/&#36;5 | [模型详情](https://developers.openai.com/api/docs/models/gpt-6-sol) |
|  | `gpt-6-luna` | 272K / 1M | &#36;0.1/&#36;0.2 | &#36;0.5/&#36;0.75 | &#36;0.01/&#36;0.02 | &#36;0.125/&#36;0.25 | [模型详情](https://developers.openai.com/api/docs/models/gpt-6-luna) |
|  | `gpt-5.6-sol` | 272K / 1M | &#36;4/&#36;8 | &#36;20/&#36;30 | &#36;0.4/&#36;0.8 | &#36;5/&#36;10 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
|  | `gpt-5.6-terra` | 272K / 1M | &#36;2/&#36;4 | &#36;12/&#36;18 | &#36;0.2/&#36;0.4 | &#36;2.5/&#36;5 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
|  | `gpt-5.6-luna` | 272K / 1M | &#36;0.2/&#36;0.4 | &#36;1.2/&#36;1.8 | &#36;0.02/&#36;0.04 | &#36;0.25/&#36;0.5 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |
|  | `gpt-5.6` | 272K / 1M | &#36;4/&#36;8 | &#36;20/&#36;30 | &#36;0.4/&#36;0.8 | &#36;5/&#36;10 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
|  | `gpt-5.5` | 272K / 1M | &#36;5/&#36;10 | &#36;30/&#36;45 | &#36;0.50/官方未单列 | &#36;5/&#36;10 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.5) |
|  | `gpt-5.4` | 272K / 1M | &#36;2.5/&#36;5 | &#36;15/&#36;22.5 | &#36;0.25/官方未单列 | &#36;2.5/&#36;5 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.4) |
|  | `gpt-5.4-mini` | 400K | $0.75 | $4.50 | $0.075 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.4-mini) |
|  | `gpt-5.4-nano` | 400K | $0.20 | $1.25 | $0.02 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.4-nano) |
|  | `gpt-5.3-codex` | 400K | $1.75 | $14.00 | $0.175 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.3-codex) |
|  | `gpt-5.2` | 400K | $1.75 | $14.00 | $0.175 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.2) |
|  | `gpt-5.1` | 400K | $1.25 | $10.00 | $0.125 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5.1) |
|  | `gpt-5` | 400K | $1.25 | $10.00 | $0.125 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5) |
|  | `gpt-5-mini` | 400K | $0.25 | $2.00 | $0.025 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5-mini) |
|  | `gpt-5-nano` | 400K | $0.05 | $0.40 | $0.005 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-5-nano) |
|  | `gpt-4.1` | 1.05M | $2.00 | $8.00 | $0.50 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-4.1) |
|  | `gpt-4.1-mini` | 1.05M | $0.40 | $1.60 | $0.10 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
|  | `gpt-4o` | 128K | $2.50 | $10.00 | $1.25 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-4o) |
|  | `gpt-4o-mini` | 128K | $0.15 | $0.60 | $0.075 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/gpt-4o-mini) |
|  | `o3` | 200K | $2.00 | $8.00 | $0.50 | 按输入价 | [模型详情](https://developers.openai.com/api/docs/models/o3) |
| Anthropic | `claude-fable-5-1` | 1M | $10.00 | $50.00 | $0.25 | $12.50 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-opus-5-5` | 1M | $4.00 | $20.00 | $0.20 | $5.00 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-opus-5` | 1M | $5.00 | $25.00 | $0.50 | $6.25 | [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview) |
|  | `claude-sonnet-5` | 1M | $2.00 | $10.00 | $0.20 | $2.50 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-haiku-4-5-20251001` | 200K | $1.00 | $5.00 | $0.10 | $1.25 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-opus-4-8` | 1M | $5.00 | $25.00 | $0.50 | $6.25 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-opus-4-7` | 1M | $5.00 | $25.00 | $0.50 | $6.25 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-opus-4-6` | 1M | $5.00 | $25.00 | $0.50 | $6.25 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-sonnet-4-6` | 1M | $3.00 | $15.00 | $0.30 | $3.75 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
|  | `claude-sonnet-4-5-20250929` | 200K | $3.00 | $15.00 | $0.30 | $3.75 | [Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing) |
| Google | `gemini-3.8-flash` | 1M | $0.75 | $3.75 | $0.075 | 存储 $0.50/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.7-flash` | 1M | $0.75 | $3.75 | $0.075 | 存储 $0.50/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.6-flash` | 1M | $0.75 | $3.75 | $0.075 | 存储 $0.50/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.5-flash` | 1M | $1.50 | $9.00 | $0.15 | 存储 $1.00/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.5-flash-lite` | 1M | $0.30 | $2.50 | $0.03 | 存储 $1.00/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.1-flash-lite` | 1M | $0.25 | $1.50 | $0.025 | 存储 $1.00/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3.1-pro-preview` | 1M | $2.00 | $12.00 | $0.20 | 存储 $4.50/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
|  | `gemini-3-flash-preview` | 1M | $0.50 | $3.00 | $0.05 | 存储 $1.00/小时 | [Gemini 定价](https://ai.google.dev/gemini-api/docs/pricing) |
| xAI | `grok-4.7` | 500K | $2.00 | $6.00 | $0.50 | 按输入价 | [模型详情](https://docs.x.ai/developers/models/grok-4.7) |
|  | `grok-4.6` | 500K | $2.00 | $6.00 | $0.50 | 按输入价 | [模型详情](https://docs.x.ai/developers/models/grok-4.6) |
|  | `grok-4.5` | 500K | $2.00 | $6.00 | $0.30 | 按输入价 | [模型详情](https://docs.x.ai/developers/models/grok-4.5) |
| 阿里云（人民币） | `qwen3.8-max` | 1M | ¥12.00 | ¥36.00 | ¥1.00 | ¥15.00 | [模型定价](https://help.aliyun.com/en/model-studio/qwen3-8-max) |
|  | `qwen3.8-flash` | 1M | ¥0.80 | ¥2.70 | ¥0.10 | ¥1.25 | [模型定价](https://help.aliyun.com/en/model-studio/qwen3-8-flash) |
|  | `qwen3.7-max` | 1M | ¥12.00 | ¥36.00 | ¥1.20 | ¥15.00 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.7-plus` | 1M | ¥2.00 | ¥8.00 | ¥0.20 | ¥2.50 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.7-flash` | 1M | ¥0.20 | ¥0.80 | ¥0.02 | ¥0.25 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.6-plus` | 1M | ¥2.00 | ¥12.00 | ¥0.20 | ¥2.50 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.6-flash` | 1M | ¥1.20 | ¥7.20 | ¥0.12 | ¥1.50 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.5-plus` | 1M | ¥0.80 | ¥4.80 | ¥0.08 | ¥1.00 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3.5-flash` | 1M | ¥0.20 | ¥2.00 | ¥0.02 | ¥0.25 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3-max` | 262K | ¥2.50 | ¥10.00 | ¥0.25 | ¥3.125 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3-coder-next` | 262K | ¥1.00 | ¥4.00 | — | — | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3-coder-plus` | 1M | ¥4.00 | ¥16.00 | ¥0.40 | ¥5.00 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen3-coder-flash` | 1M | ¥1.00 | ¥4.00 | ¥0.10 | ¥1.25 | [模型定价](https://help.aliyun.com/en/model-studio/model-pricing) |
|  | `qwen-plus` | 1M | ¥0.80 | ¥2.00 | ¥0.08 | ¥1.00 | [Qwen Plus 定价](https://help.aliyun.com/en/model-studio/qwen-plus) |
| 阿里云（美元） | `qwen3.8-max` | 1M | $2.00 | $6.00 | 控制台单列 | $2.50 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.8-flash` | 1M | $0.15 | $0.47 | 控制台单列 | $0.1875 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.7-max` | 1M | $2.50 | $7.50 | $0.25 | $3.125 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.7-plus` | ≤256K / 256K–1M | $0.40/$1.20 | $1.60/$4.80 | $0.04/$0.12 | $0.50/$1.50 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.7-flash` | ≤32K / 32K–256K / 256K–1M | $0.03/$0.10/$0.20 | $0.13/$0.40/$0.80 | $0.003/$0.01/$0.02 | $0.0375/$0.125/$0.25 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.6-plus` | ≤256K / 256K–1M | $0.50/$2.00 | $3.00/$6.00 | $0.05/$0.20 | $0.625/$2.50 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.6-flash` | ≤256K / 256K–1M | $0.25/$1.00 | $1.50/$4.00 | $0.025/$0.10 | $0.3125/$1.25 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.5-plus` | ≤256K / 256K–1M | $0.40/$0.50 | $2.40/$3.00 | $0.04/$0.05 | $0.50/$0.625 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3.5-flash` | 1M | $0.10 | $0.40 | $0.01 | $0.125 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3-max` | ≤32K / 32K–128K / 128K–256K | $1.20/$2.40/$3.00 | $6.00/$12.00/$15.00 | $0.12/$0.24/$0.30 | $1.50/$3.00/$3.75 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3-coder-next` | 262K | 未列价 | 未列价 | — | — | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3-coder-plus` | ≤32K / 32K–128K / 128K–256K / 256K–1M | $1.00/$1.80/$3.00/$6.00 | $5.00/$9.00/$15.00/$60.00 | $0.10/$0.18/$0.30/$0.60 | $1.25/$2.25/$3.75/$7.50 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen3-coder-flash` | ≤32K / 32K–128K / 128K–256K / 256K–1M | $0.30/$0.50/$0.80/$1.60 | $1.50/$2.50/$4.00/$9.60 | $0.03/$0.05/$0.08/$0.16 | $0.375/$0.625/$1.00/$2.00 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
|  | `qwen-plus` | ≤256K / 256K–1M | $0.40/$1.20 | $1.20/$3.60 | $0.04/$0.12 | $0.50/$1.50 | [国际站定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
| Kimi | `kimi-k3` | 1M | $3.00 | $15.00 | $0.30 | $3.00 | [Kimi 定价](https://platform.kimi.ai/docs/pricing/chat) |
|  | `kimi-k2.7-code` | 256K | $0.95 | $4.00 | $0.19 | — | [Kimi 定价](https://platform.kimi.ai/docs/pricing/chat) |
|  | `kimi-k2.7-code-highspeed` | 256K | $1.90 | $8.00 | $0.38 | — | [Kimi 定价](https://platform.kimi.ai/docs/pricing/chat) |
|  | `kimi-k2.6` | 256K | $0.95 | $4.00 | $0.16 | — | [Kimi 定价](https://platform.kimi.ai/docs/pricing/chat) |
| Kimi（人民币） | `kimi-k3` | 1M | ¥20.00 | ¥100.00 | ¥2.00 | ¥20.00 | [Kimi 人民币定价](https://platform.kimi.com/docs/pricing/chat) |
|  | `kimi-k2.7-code` | 256K | ¥6.50 | ¥27.00 | ¥1.30 | — | [Kimi 人民币定价](https://platform.kimi.com/docs/pricing/chat) |
|  | `kimi-k2.6` | 256K | ¥6.50 | ¥27.00 | ¥1.10 | — | [Kimi 人民币定价](https://platform.kimi.com/docs/pricing/chat) |
| DeepSeek | `deepseek-flash`（DeepSeek-V4.1-Flash） | 1M | $0.30 | $1.20 | $0.006 | 按输入价 | [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
|  | `deepseek-flash`（DeepSeek-V4.1-Flash） | 1M | $0.15 | $0.60 | $0.003 | 按输入价 | [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
|  | `deepseek-v4-pro` | 1M | $1.32 | $3.96 | $0.044 | 按输入价 | [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
|  | `deepseek-v4-pro` | 1M | $0.66 | $1.98 | $0.022 | 按输入价 | [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
| DeepSeek（人民币） | `deepseek-flash`（DeepSeek-V4.1-Flash） | 1M | ¥2.00 | ¥8.00 | ¥0.04 | 按输入价 | [DeepSeek 人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
|  | `deepseek-flash`（DeepSeek-V4.1-Flash） | 1M | ¥1.00 | ¥4.00 | ¥0.02 | 按输入价 | [DeepSeek 人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
|  | `deepseek-v4-pro` | 1M | ¥9.00 | ¥27.00 | ¥0.30 | 按输入价 | [DeepSeek 人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
|  | `deepseek-v4-pro` | 1M | ¥4.50 | ¥13.50 | ¥0.15 | 按输入价 | [DeepSeek 人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| Z.AI | `glm-5.3` | 1M | $1.40 | $4.40 | $0.26 | — | [Z.AI 定价](https://docs.z.ai/guides/overview/pricing) |
|  | `glm-5.3-flash` | 1M | $0.15 | $0.50 | $0.03 | 限时免费（缓存存储） | [Z.AI 定价](https://docs.z.ai/guides/overview/pricing) |
|  | `glm-5.3-flashx` | 1M | $0.37 | $1.25 | $0.075 | 限时免费（缓存存储） | [Z.AI 定价](https://docs.z.ai/guides/overview/pricing) |
|  | `glm-5.2` | 1M | $1.40 | $4.40 | $0.26 | 限时免费（缓存存储） | [Z.AI 定价](https://docs.z.ai/guides/overview/pricing) |
|  | `glm-5.1` | 200K | $1.40 | $4.40 | $0.26 | 限时免费（缓存存储） | [Z.AI 定价](https://docs.z.ai/guides/overview/pricing) |
| 智谱（人民币） | `glm-5.3` | 1M | ¥8.00 | ¥28.00 | ¥2.00 | 限时免费（缓存存储） | [BigModel 人民币定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
|  | `glm-5.3-flash` | 1M | ¥0.80 | ¥2.80 | ¥0.23 | 限时免费（缓存存储） | [BigModel 人民币定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
|  | `glm-5.3-flashx` | 1M | ¥2.00 | ¥7.00 | ¥0.57 | 限时免费（缓存存储） | [BigModel 人民币定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
|  | `glm-5.2` | 1M | ¥8.00 | ¥28.00 | ¥2.00 | 限时免费（缓存存储） | [BigModel 人民币定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
|  | `glm-5.1` | <32K / ≥32K（上限200K） | ¥6.00/¥8.00 | ¥24.00/¥28.00 | ¥1.30/¥2.00 | 限时免费（缓存存储） | [BigModel 人民币定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
| Xiaomi（人民币） | `mimo-v2.6-pro` | 1M | ¥3.00 | ¥6.00 | ¥0.025 | 限时免费 | [MiMo 国内定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go) |
|  | `mimo-v2.6-flash` | 1M | ¥1.00 | ¥2.00 | ¥0.02 | 限时免费 | [MiMo 国内定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go) |
| Xiaomi（美元） | `mimo-v2.6-pro` | 1M | $0.435 | $0.87 | $0.0036 | 限时免费 | [MiMo 海外定价](https://mimo.mi.com/docs/en-US/pricing) |
|  | `mimo-v2.6-flash` | 1M | $0.14 | $0.28 | $0.0028 | 限时免费 | [MiMo 海外定价](https://mimo.mi.com/docs/en-US/pricing) |

## 如何读这张表

- 这是公开基准价，不是一次实际调用的完整账单。OpenAI 长上下文、Fast/Batch/Flex、缓存写入、区域处理；Anthropic 缓存写入与批处理；Google 缓存存储；xAI 超过 200K 上下文与 Priority；Qwen 思考模式和长输入，都会改变费用。各项精确规则见供应商原价目表与 [Ash 计价设计](../../ash-rs/docs/model-accounting.md#首版价目表基线)。
- DeepSeek 高峰为周一至周五 UTC 01:00–04:00 和 06:00–10:00，中国法定节假日全天按谷价；其余时间也按谷价。MiMo 的旧 `v2.5` 型号计划于 2026-10-21 下线，表中使用 `v2.6`。
- DeepSeek 官方价目表分别以美元和人民币列价；两种币种各按官方页面原价记录，不作汇率换算。`deepseek-flash`（API 调用 ID）映射到当前模型版本 DeepSeek-V4.1-Flash；旧 ID `deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 虽仍可请求，但对应型号已退役，请求由 DeepSeek-V4.1-Flash 提供服务并按 Flash 价格计费。表中高峰和谷时段分别占一行。
- Xiaomi MiMo API 官方分别列出国内人民币价和海外美元价；表内照录两套原价，不作换算。缓存写官方标为限时免费。
- 阿里云人民币行记录北京区域人民币原价；美元行记录新加坡国际站的 `International` 部署原价，不作汇率换算。两站的可用模型、上下文档位和价格可能不同；分档价格按表内上下文顺序对应。显式缓存创建按输入价的 125% 计算、命中价通常为输入价的 10%；`qwen3.8-max` 和 `qwen3.8-flash` 的命中价例外，英文文档要求以控制台为准；`qwen3-coder-next` 未列入国际站美元价目表，也未列入官方缓存支持列表。详见[国际站模型定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing)和[显式缓存计费规则](https://www.alibabacloud.com/help/en/model-studio/context-cache)。
- 阿里云 OpenAI 兼容 API 端点：北京人民币区为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，新加坡国际站为 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。Ash 当前内置 Qwen 供应商默认使用北京端点。阿里云建议生产环境改用工作空间专属端点：北京 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，新加坡 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。两区 API Key 不通用；原生 DashScope API 使用相同区域域名并将路径换为 `/api/v1`。详见[官方端点说明](https://www.alibabacloud.com/help/en/model-studio/base-url)。
- Z.AI 国际站以美元列价，智谱 BigModel 国内开放平台以人民币列价；表中分别记录两站原价，不作汇率换算。国内 `glm-5.1` 按输入长度 32K 分档，表内价格顺序对应“<32K / ≥32K”；目录中的 `glm-5-turbo` 未见于官方当前 API 价目表，不把名称相近的 `GLM-5-Turbo` 当作同一 ID。
- Kimi 官方中文开放平台以人民币列出 K3、K2.7 Code 和 K2.6 价格，国际站以美元列价；两边按各自公布价格记录，不作汇率换算。人民币价目页未列 `kimi-k2.7-code-highspeed`，因此不推算该型号人民币价。K3 的缓存写按 5 分钟和 1 小时 TTL 分档；K2 系列官方价格页列出缓存命中价，未单列缓存写价。`kimi-k2.5` 和 `moonshot-v1` 系列已于 2026-08-31 下线。MiniMax 型号未列入本表；其他未列模型也不能从相近型号推算价格。核对入口见 Kimi [官方模型列表](https://platform.kimi.ai/docs/models)、[国际站美元计价](https://platform.kimi.ai/docs/pricing/chat)、[中文站人民币计价](https://platform.kimi.com/docs/pricing/chat) 与 MiniMax [官方价格页](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise)。
- OpenAI GPT-5.6 及后续型号的缓存写按独立写入价计；更早型号没有单列写入价，表中的“按输入价”表示写入请求仍按普通输入 token 计费。[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)说明了这两种计费方式。Anthropic 缓存写列使用 5 分钟缓存价；1 小时缓存另有价格，见[Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing)。
- Google 的“缓存写”格展示缓存存储费，单位为每 100 万 token·小时，不是一次性写入价格；[Gemini 缓存文档](https://ai.google.dev/gemini-api/docs/generate-content/caching)按缓存量和保存时长计费。xAI 和 DeepSeek 的缓存自动生成，“按输入价”表示未命中部分按普通输入价计；Z.AI 的缓存存储费目前由官方标为限时免费。MiMo 缓存写入由[官方标为限时免费](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)。
- Ash 的模型目录只说明有哪些模型与能力；账户是否能调用某个模型由对应服务决定。
