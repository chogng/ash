# 订阅套餐一览

ChatGPT 套餐与 Astra Ultra Fast 于 2026-10-06 按官方资料核对；其他服务沿用 2026-09-26 的核对结果。第三列表示 Ash 能否读取当前账户返回的套餐名称；第四列比较订阅连接和对应的开发者按量 API 是否按相同规则扣费。✅ 表示相同，❌ 表示不同。上游返回的名称不一定能区分表中每个细分档次。

| 服务                                                                        | 套餐                                                 | Ash 可读取当前套餐 | 和按量 API 一样计费？ |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ | --------------------- |
| [ChatGPT 个人](https://chatgpt.com/pricing/)                                | Free、Go、Plus、Pro $100 / $200 / $500               | ✅                 | ❌                    |
| [ChatGPT 组织](https://openai.com/business/pricing/)                        | Business Standard、Business Premium、Enterprise、Edu | ✅                 | ❌                    |
| [Kimi Code 新套餐](https://www.kimi.com/code/docs/en/kimi-code/models.html) | Go、Plus、Pro、Max、Ultra                            | 部分具备           | ❌                    |
| [Kimi Code 旧套餐](https://www.kimi.com/help/membership/membership-pricing) | Andante、Moderato、Allegretto、Allegro               | 部分具备           | ❌                    |
| [Super Grok](https://x.ai/news/grok-bot-more-plans)                         | Free、SuperGrok、SuperGrok Plus、SuperGrok Heavy     | ✅                 | ❌                    |
| [BigModel Coding Plan](https://zcode.z.ai/cn)                               | Lite、Pro、Max                                       | ❌                 | ❌                    |
| [Z.AI Coding Plan](https://zcode.z.ai/en)                                   | Lite、Pro、Max                                       | ❌                 | ❌                    |

ChatGPT 的 Student 是学生优惠，不是独立套餐。Kimi 仅在 `/coding/v1/me` 返回 `user_level_name` 时显示该名称；Ash 不根据其他字段推断具体档次。

订阅连接消耗套餐额度或积分；开发者按量 API 按自己的价目表收费。两边即使用了相同数量的 token，也不能直接算成相同费用。BigModel 和 Z.AI 第三列的 ❌ 表示 Ash 当前无法读取套餐名称；Ash 通过[ZCode 账号授权](https://zcode.z.ai/en/docs/configuration)接入 Coding Plan，仍消耗套餐额度。[OpenAI 官方说明](https://learn.chatgpt.com/docs/pricing)、[Kimi 官方 FAQ](https://www.kimi.com/en/help/kimi-api/api-troubleshooting) 和 [xAI 官方 FAQ](https://docs.x.ai/developers/faq/accounts)均区分订阅与开发者 API 的账单。开发者 API 单价见[模型价格表](ash-host-models.md)。

## Astra Ultra Fast 的套餐资格

Ash 的内置目录目前为 GPT-6 Astra 提供 Ultra Fast。模型支持与账号资格分别判断；API Key 不使用 ChatGPT 套餐作为资格条件。

| 连接与套餐                                           | Ultra Fast 资格                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| ChatGPT Pro $100、Pro $200、Plus、Free、Go、Business | 不提供；购买额外 credits 不改变资格                                       |
| ChatGPT Pro $500                                     | 支持，仍受当前账号的服务端限制                                            |
| Enterprise                                           | 需要符合积分或 USD 按量协议，并由工作区管理员开启；旧的固定限额协议不支持 |
| Edu                                                  | 需要符合条件的积分套餐及工作区授权                                        |
| OpenAI API Key                                       | Astra 已开放，额度按 API usage tier 计算，和 ChatGPT Pro 档位无关         |

要求在美国以外执行推理的工作区不支持 Ultra Fast；工作区所在地区本身不能决定资格。订阅套餐、工作区授权和区域条件见[官方速度说明](https://learn.chatgpt.com/docs/agent-configuration/speed#ultrafast-mode)，API 条件见[API Ultra Fast](https://developers.openai.com/api/docs/guides/ultrafast-mode)。

Ash 保留账号返回的原始套餐标识：`prolite`、`pro`、`promax` 分别对应 Pro $100、$200、$500，不能把 `pro` 当成所有 Pro 套餐。`models.json` 为 Astra 声明 `ultrafast` 能力；ChatGPT 账号服务在订阅目录刷新时读取 cloud-managed requirements，按优先级合并独立的 Fast / Ultra Fast 限制。Enterprise / Edu 只有明确授权后才提供 Ultra Fast。此权限只存在于账号观察状态，不写入用户配置。

目录缓存包含用户、工作区和套餐身份。账号或套餐变更立即使旧授权失效；工作区权限随现有订阅观察周期刷新，授权观察有效期为五分钟。界面、偏好保存、HTTP 调用和 WebSocket 连接/预热都使用当前账号的可用档位；已保存但失去资格的 Ultra Fast 请求被拒绝，用户可以清除选择。
