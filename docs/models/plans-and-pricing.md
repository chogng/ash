# 订阅套餐一览

以下是 2026-09-26 核对的公开套餐名称。第三列表示 Ash 能否读取当前账户返回的套餐名称；第四列比较订阅连接和对应的开发者按量 API 是否按相同规则扣费。✅ 表示相同，❌ 表示不同。上游返回的名称不一定能区分表中每个细分档次。

| 服务 | 套餐 | Ash 可读取当前套餐 | 和按量 API 一样计费？ |
| --- | --- | --- | --- |
| [ChatGPT 个人](https://chatgpt.com/pricing/) | Free、Go、Plus、Pro 5×、Pro 20× | ✅ | ❌ |
| [ChatGPT 组织](https://openai.com/business/pricing/) | Business Standard、Business Premium、Enterprise、Edu | ✅ | ❌ |
| [Kimi Code 新套餐](https://www.kimi.com/code/docs/en/kimi-code/models.html) | Go、Plus、Pro、Max、Ultra | ❌ | ❌ |
| [Kimi Code 旧套餐](https://www.kimi.com/help/membership/membership-pricing) | Andante、Moderato、Allegretto、Allegro | ❌ | ❌ |
| [Super Grok](https://x.ai/news/grok-bot-more-plans) | Free、SuperGrok、SuperGrok Plus、SuperGrok Heavy | ✅ | ❌ |
| [BigModel Coding Plan](https://zcode.z.ai/cn) | Lite、Pro、Max | ❌ | ❌ |
| [Z.AI Coding Plan](https://zcode.z.ai/en) | Lite、Pro、Max | ❌ | ❌ |

ChatGPT 的 Student 是学生优惠，不是独立套餐。

订阅连接消耗套餐额度或积分；开发者按量 API 按自己的价目表收费。两边即使用了相同数量的 token，也不能直接算成相同费用。BigModel 和 Z.AI 第三列的 ❌ 表示 Ash 当前无法读取套餐，不代表官方没有账号登录：[ZCode 支持账号授权](https://zcode.z.ai/en/docs/configuration)，Ash 目前通过手动填写 Coding Plan Key 接入，仍消耗套餐额度。[OpenAI 官方说明](https://learn.chatgpt.com/docs/pricing)、[Kimi 官方 FAQ](https://www.kimi.com/en/help/kimi-api/api-troubleshooting) 和 [xAI 官方 FAQ](https://docs.x.ai/developers/faq/accounts)均区分订阅与开发者 API 的账单。开发者 API 单价见[模型价格表](ash-host-models.md)。
