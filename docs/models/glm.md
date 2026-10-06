# GLM：BigModel 与 Z.AI 接入

BigModel 和 Z.AI 各有 Coding Plan、Start Plan 与开发者 API 三种接入，共六个独立连接。两个 Coding Plan 会只读使用本机 ZCode 已登录的个人版 Coding Plan 账号；没有对应账号时，按[官方 ZCode](https://zcode.z.ai/en/docs/configuration) 的流程打开浏览器，在 Ash 内登录并保存请求凭据。订阅页不要求填写 Key。开发者 API 仍单独录入 API key。`/usage` 查询 Coding Plan 额度，以及 Start Plan 返回的套餐名称、模型额度与周期。Coding Plan 的实际套餐等级仍未提供。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)。

## 连接与请求目标

| 入口                 | 连接 ID                | 请求目标                                                             |
| -------------------- | ---------------------- | -------------------------------------------------------------------- |
| BigModel Coding Plan | `bigmodel-coding-plan` | `https://open.bigmodel.cn/api/coding/paas/v4`                        |
| Z.AI Coding Plan     | `zai-coding-plan`      | `https://api.z.ai/api/coding/paas/v4`                                |
| BigModel Start Plan  | `bigmodel-start-plan`  | `https://zcode.z.ai/api/v1/zcode-plan/anthropic`，Anthropic Messages |
| Z.AI Start Plan      | `zai-start-plan`       | 同一 Start Plan 服务，使用 Z.AI 账户                                 |
| BigModel API         | `bigmodel`             | BigModel 标准 API 端点                                               |
| Z.AI API             | `zai`                  | Z.AI 标准 API 端点                                                   |

ZCode 登录保存在其用户目录的 `~/.zcode/v2/credentials.json`，Ash 每次调用前直接读取当前账号和请求密钥，不复制到 Ash，也不修改 ZCode 文件；若设置了 `ZCODE_DATA_BASE_DIR`，则读取该目录下的 `.zcode/v2/credentials.json`。Ash 自己发起的登录分别保存账户和内部请求凭据。两个开发者 API 连接各自保存用户输入的密钥。模型引用统一使用 `glm` 厂商 ID；六条连接按 BigModel Coding Plan > Z.AI Coding Plan > BigModel Start Plan > Z.AI Start Plan > BigModel API > Z.AI API 选择已就绪的一条。已有的 Z.AI API 密钥不会自动用于 Coding Plan。选择与请求规则见[供应商凭据边界](../model-provider.md#6-供应商凭据边界)。

Coding Plan 自动获取 Ash 内部请求密钥时，只有一个机构或项目就直接使用；有多个时只接受名称恰好为“默认机构”或“默认项目”的唯一条目。无法明确选择时登录失败，不会按列表顺序创建密钥。

## Start Plan

桌面端在“Manage Accounts → Add account”选择 BigModel Start Plan 或 Z.AI Start Plan；Ash Code 在 `/config → Providers` 的订阅区提供相同的两个入口。浏览器授权使用官方 ZCode CLI OAuth 流程，Start Plan 保存返回的 ZCode JWT，不创建 Coding Plan API key。

只读复用 ZCode 时，后端要求 `oauth:active_provider` 对应当前区域，并核对 `zcodejwttoken` 的账户身份与同一次文件读取取得的账户一致。ZCode 全局 JWT 不能被另一个区域的账户拿来发起请求。Ash 使用自己的持久化 UUID 设备标识及 `User-Agent: Ash/*`。

Start Plan 的模型请求在 Anthropic `system` 数组前加入两个固定的 ZCode 兼容文本块，随后保留 Ash 原有的系统指令。服务端要求这两个文本块分别传递；将它们合并成一个字符串也会被拒绝。`model-provider` 仅为两个 Start Plan 连接选择兼容文本，`ash-api` 负责将其编码为独立系统块；用户消息、工具定义、工具调用和结果不改写。固定文本也计入本地输入 token 测量。

`/api/v1/zcode-plan/billing/balance` 是套餐、模型权益与额度的来源。已过期、尚未开始和不属于当前有效套餐的额度桶不授予模型权限；用尽的有效额度仍可显示。每次模型调用先检查当前权益和 `/api/v1/client/configs` 的验证码策略，再向 `/api/v1/zcode-plan/anthropic/v1/messages` 发送请求。额度、策略请求遵循调用取消，并在发布结果前核对账户及凭据代次。

“0.67 系数 / 150% 配额”活动属于 Coding Plan：[官方客户端配置](https://zcode.z.ai/api/v1/client/configs)将其文案放在 `codingPlanBillingDiscount` 中，Start Plan 的体验额度另由 `startPlanPreview` 描述。不能将 Coding Plan 活动系数用于 Start Plan 的本地用量或余额显示。实际扣量由服务端决定，Ash 展示 billing balance 返回的值。

2026-10-02 对当前 Start Plan 通道的 `ZCode Trust Build` 权益做真实扣量对照：GLM-5.3-Flash 在 Ash 请求头下报告 300 个输入 token 和 70 个输出 token，余额扣减 370；使用 ZCode 协议请求头对照时报告 298 个输入 token 和 12 个输出 token，余额扣减 310。两次均无缓存命中，均按 1:1 扣减，没有观察到 0.67 折算。这是该账户当时权益的实测结果，不代表其他活动或后续政策。

后续安排：等有有效的正式 Coding Plan 订阅后，再考虑 Ash 的 0.67 优惠接入。届时重新核对活动政策、账号资格和 [ZCode 官方权益网关](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts)，通过真实请求比较模型用量与额度扣减；生成成功本身不能证明折扣生效。目前暂缓这项接入工作。

当前实现仅在服务端明确允许免验证码模型请求时继续调用；要求验证码时返回需要在 ZCode 验证的错误，尚未接入 Ash 内的验证码交互。[ZCode 3.14.4 更新说明](https://zcode.z.ai/cn/changelog)宣布关闭模型请求验证码校验；2026-10-02 实测配置也返回 `skip_model_request: true`。本次 HTTP 405 / 3012 错误并非由缺少验证码交互引起。

2026-10-02 使用隔离 Ash 配置目录中的 BigModel 网页登录凭据进行对照：普通请求、双认证和 ZCode 请求头均返回 HTTP 405、业务码 3012；保留 Ash 请求头并加入两个固定系统文本块后，生成成功。仅身份开场白、仅设备元数据和合并后的系统字符串仍失败；日期消息、桌面上下文和额外缓存标记不是本次成功所需条件。文本参考 [Magpie 的 ZCode 兼容实现](https://github.com/yetone/magpie/commit/901fd87ec066f8f067e8bafdfa9247979f1e1189)，并通过逐项实测收窄。

修复后使用 BigModel Start Plan 的 `glm-5.3-flash` 模型，真实 Rust `model-provider` 调用链已验证流式回复、工具调用、工具结果续答以及多轮对话；Ash 自己的系统指令仍生效。真实 App Server 会话也已通过普通回复、`read_file` 工具往返及下一轮记住文件内容的验证。Z.AI Start Plan 的相同调用链有模拟服务覆盖，尚未使用真实 Z.AI 账号验证。上游对兼容文本的要求不是公开接口契约，后续变更仍需用真实生成测试确认。

可显式运行 `just test ash-model-provider live_bigmodel_start_plan_uses_the_ash_model_pipeline -- --ignored` 重新验证只读复用路径；该测试使用当前 BigModel ZCode 凭据，并核对外部文件未变。

验证 Ash 自有网页登录可运行 `just test ash-model-provider live_bigmodel_start_plan_ash_login_streams_and_continues_tools -- --ignored`；设置 `ASH_START_PLAN_VALIDATION_HOME` 指向已完成网页登录的隔离 Ash 配置目录，并将 `ZCODE_DATA_BASE_DIR` 指向不含 ZCode 凭据的目录。测试执行真实生成与工具往返，不输出凭据。

## 状态与退出

两个 Coding Plan 支持 `account/rateLimits/read`，并在账户就绪时出现在 `/usage` 中。查询使用当前账户的 Coding Plan 请求密钥，读取对应区域的 `/api/monitor/usage/quota/limit`。界面显示接口实际返回的五小时、每周与 MCP 额度及重置时间；未返回的字段保持“未提供”，不根据入口名称推断套餐等级。上游是否允许模型请求，仍以实际调用结果为准。[Z.AI 官方用量插件](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)使用相同额度接口。

在订阅页按 `l` 断开 Coding Plan 或 Start Plan 时，Ash 为该连接保存本地断开状态，并删除该连接在 Ash 保存的内部请求凭据。复用 ZCode 账号时也可单独在 Ash 断开，无需退出 ZCode；外部文件保持不变。后台刷新、ZCode 换账号和 Ash 重启不会重新接入，只有用户再次登录该连接才清除断开状态。其他订阅账户和两个 API 连接的密钥不受影响。配置和选择规则见[登录与账户系统](../login.md#订阅入口与-api-入口)。

只有 Start Plan 的账户也可能在 ZCode 文件中留有 Coding Plan 请求密钥。密钥存在不代表已购买 Coding Plan；按上述优先级，未断开的 Coding Plan 会先被选中，可能返回 HTTP 429，而 Start Plan 本身仍可用。此时在 Ash 断开未开通的 Coding Plan，下一轮会选择已登录的 Start Plan；失败的请求不会自动换连接重发。未来开通正式 Coding Plan 后，再在 Ash 登录对应连接即可恢复其优先级。

2026-10-02 在实际 Ash 配置中确认该情况：`provider/list` 将 BigModel Coding Plan 标为选中，Start Plan 为已就绪但未选中；Coding Plan 实际返回 HTTP 429、业务码 1113，含义为“余额不足或无可用资源包”，并非短时请求限流。通过 `account/logout` 单独断开 Coding Plan 后，Start Plan 成为选中连接，ZCode 凭据文件未变。使用相同 `glm-5.3-flash` 模型和 `max` 推理强度，真实 App Server 的普通回复、`read_file` 往返和多轮记忆三轮均成功。
