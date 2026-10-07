# 订阅计划接入与额度

Ash Code 的订阅区目前提供 ChatGPT、Kimi、Super Grok、BigModel Coding Plan、Z.AI Coding Plan、BigModel Start Plan 和 Z.AI Start Plan 七个账户入口，另有独立的 Kimi Desktop 和 Kimi Code CLI 模型连接。本页说明它们分别使用什么凭据、能否查询账户额度，以及 `/usage` 何时刷新。入口名称不表示 Ash 已核实用户购买的具体套餐或上游服务权限；登录控制面见[登录与账户系统](login.md)，模型请求如何选择接入方式见[模型调用系统](model-provider.md#6-供应商凭据边界)。

## 当前支持范围

| 接入                                 | 身份与凭据                                                        | 模型接入                                                                                              | `/usage`                                       |
| ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ChatGPT                              | `chatgpt-subscription` 账户；复用或维护 Codex 兼容登录            | `openai` 的 ChatGPT 订阅 Responses 服务                                                               | 套餐、额度窗口、点数                           |
| Kimi                                 | `kimi-subscription` 账户；Ash 设备码登录和 profile SecretStore    | `kimi` 的 Kimi Coding API                                                                             | 套餐与上游返回的五小时、每周、每月额度         |
| Kimi Desktop                         | `kimi-desktop` 连接；只读使用桌面端的 Kimi Code 运行配置          | `kimi-desktop` 的桌面端 Code 网关                                                                     | 尚未接入账户和额度查询                         |
| Kimi Code CLI                        | `kimi-cli` 连接；只读使用 CLI 的 OAuth 凭据文件                   | `kimi-cli` 的 CLI 配置端点                                                                            | 尚未接入账户和额度查询                         |
| Super Grok                           | `xai-subscription` 账户；Ash 设备码登录，或只读使用已有 Grok 登录 | `xai` 的 Grok 订阅代理                                                                                | 套餐、使用比例、周期和余额                     |
| BigModel                             | 只读复用 ZCode 个人版 Coding Plan 账号，或在 Ash 浏览器登录       | `open.bigmodel.cn` 的 Coding Plan 端点                                                                | 上游返回的额度窗口与重置时间；套餐等级未提供   |
| Z.AI                                 | 只读复用 ZCode 个人版 Coding Plan 账号，或在 Ash 浏览器登录       | `api.z.ai` 的 Coding Plan 端点                                                                        | 上游返回的额度窗口与重置时间；套餐等级未提供   |
| BigModel Start Plan、Z.AI Start Plan | 当前区域与账户匹配的 ZCode JWT，或 Ash 浏览器登录                 | ZCode Start Plan 的 Anthropic Messages 接口；BigModel 真实生成、工具与多轮已验证，Z.AI 仅模拟服务验证 | 有效套餐名称、模型桶的使用比例、可用状态和周期 |

BigModel 与 Z.AI 使用[官方 ZCode](https://zcode.z.ai/en/docs/configuration) 的账号授权；已在 ZCode 登录时直接使用它的请求凭据，否则在 Ash 登录并自动取得请求凭据。用户不填写 Coding Plan Key。

订阅账户与开发者 API 使用各自的凭据和计费路径。已就绪订阅用于该供应商的模型目录和文本请求；Coding Plan 与 Start Plan 各自使用独立的账户、连接 ID、内部请求凭据和端点。登录就绪不证明上游套餐资格。稳定供应商 ID、入口名称及账户 ID 的区别见[订阅入口与 API 入口](login.md#订阅入口与-api-入口)。

## 入口名称、实际套餐与凭据归属

`/config → Providers` 订阅区中的 ChatGPT、Kimi、Super Grok、BigModel、Z.AI 是固定的**接入入口名称**，不是用户当前购买的套餐。账户页的“计划”和 `/usage` 中的套餐只在对应上游提供等级时显示；Ash 不根据入口名称、可用模型或本地“已启用”状态写死一个等级。上游没有提供等级时，账户页不显示“计划”。

| 入口       | 登录资料由谁维护                                                                                               | 账户页“计划”的来源                                                                                                                                                                                      | 变化后如何更新                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT    | 检测到 Codex 时只读使用其认证存储；否则 Ash 创建并维护 Codex 兼容认证记录，不向 profile SecretStore 复制 token | 当前 ID token 的 `chatgpt_plan_type`；`/usage` 另从额度接口读取 `plan_type`                                                                                                                             | 后台观察认证存储变化；Codex 管理的凭据由 Codex 更新，Ash 管理的凭据由 Ash 续期；每次打开 `/usage` 重新查额度                                    |
| Kimi       | Ash 的 profile SecretStore；`ash-kimi` 负责续期                                                                | Kimi Coding API `/me` 的 `user_level_name`；未提供时为 `null`                                                                                                                                           | 后台观察凭据并定期查询账户资料；每次打开 `/usage` 重新查套餐与额度                                                                              |
| Super Grok | Ash 设备码登录保存在 profile SecretStore；没有 Ash 登录时，只读使用后端主机的 `~/.grok/auth.json`              | Grok Build `/v1/settings` 的 `subscription_tier_display`，其次是该接口的 `subscription_tier` 或 `/v1/user?include=subscription` 的 `subscriptionTier`；显示服务端返回的完整名称，例如 `SuperGrok Heavy` | 后台观察凭据并定期查询账户和设置；复用 Grok 文件时，Ash 只在内存中保存与当前令牌对应的脱敏账户资料，令牌变化后自动更新；`/usage` 重新查当期数据 |
| BigModel   | 只读使用 ZCode 凭据文件；Ash 自己登录时保存在 profile SecretStore                                              | 当前无法查询实际套餐等级                                                                                                                                                                                | 后台观察账户凭据；每次模型请求重新读取当前凭据；打开 `/usage` 时查询额度；上游资格由实际请求判定                                                |
| Z.AI       | 只读使用 ZCode 凭据文件；Ash 自己登录时保存在 profile SecretStore                                              | 当前无法查询实际套餐等级                                                                                                                                                                                | 后台观察账户凭据；每次模型请求重新读取当前凭据；打开 `/usage` 时查询额度；上游资格由实际请求判定                                                |

读取其他客户端的认证文件，不等于把它导入成 Ash 自己维护的凭据。只读复用时，原客户端仍负责刷新或替换其 token；Ash 每次使用前读取当前凭据，不复制外部 refresh token，也不写回外部认证文件。Ash 自己发起登录时，才由相应供应商适配器保存并维护 Ash 管理的凭据。账户名称、邮箱和等级进入的是脱敏账户状态；认证凭据和额度结果不作为普通 `/config` 配置项保存。Grok Build 的 `/v1/settings` 是服务端 HTTP 接口，不是 Ash 的 `/settings` 命令；用户仍在 `/config` 查看连接，在 `/usage` 主动查询额度。

### Ash Code 订阅页操作

七个订阅页都用 `l` 退出当前账户；退出入口不在可点击列表中。已连接时页面直接展示账户和可取得的套餐信息，不额外列出“已登录”。请求执行中和未连接时不提供退出快捷键。

七种订阅的退出都调用对应的 `account/logout`。Ash 自己登录的 BigModel 与 Z.AI 账户可在 Ash 删除；只读复用的 ZCode 账户须在 ZCode 退出，Ash 不删除外部文件。BigModel API 和 Z.AI API 的连接及密钥不受影响。

## 账户额度与刷新

Ash Code 的 `/usage` 打开“Usage”（中文为“额度”）面板，统计范围是供应商账户。本线程累计 token 消耗与参考成本在 `/status` 查看，最近请求的上下文占用在 `/context` 查看；三个命令的完整职责见 [TUI 命令说明](../crates/tui/README.md#命令与补全)。

`account/rateLimits/read` 支持七个订阅入口，按 `{ provider, accountId }` 查询指定账户；接口字段、身份检查和错误见 [App Server 账号接口](ash-app-server-api.md#11-account-与登录)。ChatGPT 返回额度窗口的已使用比例、UTC 重置时间和点数；Kimi 返回上游实际提供的五小时、每周或每月窗口；Super Grok 返回上游周期、使用比例和余额。BigModel 与 Z.AI 查询 Coding Plan monitor 的额度窗口；接口没有返回的套餐、额度或重置时间保持“未提供”。Start Plan 返回有效套餐名称和各模型额度桶的使用比例、可用状态与周期。各供应商的额度含义不同，界面分别展示。

`ash-subscriptions` 负责后台观察周期，并在账户变化时重新读取模型目录。更新 Kimi 和 Super Grok 的账户展示资料时，由 `ash-login` 核对当前账户并提交脱敏状态；供应商适配器读取远端资料。模型发现仍由模型目录服务执行，额度仍在打开 `/usage` 时查询。

每次运行 `/usage` 都读取当前已登录账户，并为七个订阅入口中每个就绪的账户查询一次额度。面板中的页签切换和重绘只使用这次查询的结果；关闭后再次运行 `/usage` 才会重新查询。当前没有定时刷新，也不读取或保存本地额度缓存文件。Codex 兼容的 `auth.json` 只用于认证，不提供额度数据。

这个命令由用户主动打开，请求次数取决于打开次数，因此保持即时查询，不为它增加本地额度缓存。若以后提供常驻额度显示，再由账户侧维护按账户区分、带更新时间的共享数据，并确定刷新时机；本地保存的上次结果只能作为带时间标记的旧值展示，不能当作当前余额。

各供应商有哪些套餐，见[订阅套餐一览](models/plans-and-pricing.md)。

## ChatGPT

ChatGPT 账户如何登录、复用 Codex 凭据、刷新及断开，见[ChatGPT 订阅账户](models/chatgpt.md)。

## Kimi Code

Ash 的 Kimi 账户使用设备码登录，凭据由 Ash 维护，可查询账户、套餐和实际返回的额度窗口。Kimi Desktop 与 Kimi Code CLI 连接只读使用各自的凭据，用于模型调用，不进入账户页或 `/usage`。详情见[Kimi Code 连接](models/kimi.md)。

## Super Grok

Super Grok 可以在 Ash 登录，也可以只读使用已有的 Grok 登录；支持查询套餐与额度。详情见[Super Grok 订阅账户](models/supergrok.md)。

## GLM：BigModel 与 Z.AI

两个 Coding Plan 优先只读使用本机 ZCode 账号；没有对应账号时可通过浏览器在 Ash 登录。两者访问各自端点，实际套餐权限由上游请求判定。两个 Start Plan 从 billing balance 读取有效模型权益，并检查模型请求的验证码策略。六个连接的区别见[GLM 接入](models/glm.md)。
