# Backend client

- 封装 OpenAI/Codex 后端业务 HTTP API，与模型协议和 Ash 自有服务分开。
- 查询账号、个人统计、额度、重置次数、支出限制和用量报表。
- 读取云端配置、用户设置、工作区消息与云任务；支持创建云任务。
- 查询任务和回合费用；保留原始金额精度、数据缺失和不完整状态。
- 显式选择 `/api/codex` 或 `/wham` 路由，使用调用方提供的当前账号认证。
- 复用 `ash-client` 和 `ash-http-client`；不读取凭据、不刷新 token、不维护登录状态。
- 错误仅保留分类与 HTTP 状态，不暴露地址、认证头或响应正文；支持调用方取消。
- 生产 transport 必须拒绝重定向；Ash 默认 HTTP 配置满足此要求。

## 公开接口

以下接口对应 Codex `backend-client` 的业务 HTTP 合约。路径相对于显式选择的路由前缀；API key 费用查询使用单独的目标地址。

| 能力 | `BackendClient` 方法 | HTTP 合约 |
| --- | --- | --- |
| 账号与工作区 | `read_accounts` | `GET accounts/check`，支持列表与账号映射两种响应 |
| 个人统计与 token 历史 | `read_account_profile` | `GET profiles/me` |
| 额度与完整策略 | `read_rate_limits`、`read_rate_limit_status` | `GET usage` |
| Reserve 能力声明 | `read_rate_limits_with_reserve` | `GET usage`，附带 `x-openai-codex-luna-reserve: 1` |
| 重置券列表 | `list_reset_credits` | `GET rate-limit-reset-credits` |
| 兑换重置券 | `consume_reset_credit` | `POST rate-limit-reset-credits/consume` |
| 通知管理员 | `send_credit_nudge` | `POST accounts/send_add_credits_nudge_email` |
| 云端配置与约束 | `read_config_bundle` | `GET config/bundle` |
| 用户设置 | `read_user_settings` | `GET settings/user`，禁止使用缓存 |
| 工作区消息 | `list_workspace_messages` | `GET workspace-messages`，禁止保存缓存 |
| 云任务分页 | `list_tasks` | `GET tasks/list`，支持筛选、环境与游标 |
| 云任务详情 | `read_task` | `GET tasks/{id}`，保留任务元数据与状态，提供文本、差异和错误提取 |
| 同轮尝试 | `list_sibling_turns` | `GET tasks/{id}/turns/{turn}/sibling_turns`，保留尝试创建时间 |
| 创建云任务 | `create_task` | `POST tasks`，调用方提供任务 JSON 对象 |
| 线程费用估算 | `read_thread_usage` | `POST usage/thread_usage/query` |
| 任务额度占比与余额扣费 | `read_task_usage` | `POST usage/thread_usage/query_v2` |
| ChatGPT 回合费用 | `query_chatgpt_turn_costs` | `POST usage/thread-estimates/query`，包含已结算响应 ID |
| API key 回合费用 | `query_api_key_turn_costs` | `POST /v1/analytics/codex/turn-costs` |
| 历史套餐额度 | `read_plan_limit_history` | `GET usage/plan_limit_history?days=7` |
| 账号报表 | `read_analytics` | 根据 `AnalyticsReport` 选择下表的类型化报表 |

| `AnalyticsReport` | 路径 | 附加查询条件 |
| --- | --- | --- |
| `Usage` | `usage/daily-token-usage-breakdown` | 起止日期，按日分组 |
| `EnterpriseTokens` | `usage/daily-workspace-user-token-usage-breakdown` | 按模型拆分，包含 `codex` 与 `work` |
| `WorkspaceCredits` | `usage/daily-workspace-user-token-usage-breakdown` | 起止日期，按日分组 |
| `Credits` | `usage/credit-usage-events` | 服务端不接受日期筛选 |
| `EnterpriseCredits` | `usage/daily-workspace-user-credit-usage` | 起止日期，调用方指定拆分维度 |
| `Messages` | `analytics/daily-workspace-usage-counts` | 当前工作区用户，按日分组 |
| `Plugins` | `analytics/daily-plugin-usage-metrics` | 当前工作区用户，指定数量 |
| `Skills` | `analytics/daily-skill-usage-metrics` | 当前工作区用户，指定数量 |

## 调用约定

- 每次操作传入 `CancellationToken`；认证目标由调用方提前解析。`chatgpt` 继续负责 token 刷新、401 恢复与账号变化检查。
- `read_rate_limits` 保持原有返回类型。`read_rate_limit_status` 额外返回用户身份、可用重置次数、支出限制、限制原因与服务端提示。
- 只有真正支持 Reserve 的消费方才调用 `read_rate_limits_with_reserve`；被动额度查询使用普通入口。
- 兑换使用 `ResetCreditSelection::Available` 或 `Id`。调用方负责用户授权并保存 `redeem_request_id`；结果不确定时继续使用原 ID。所有请求均采用 `RetryPolicy::never()`。
- 创建任务、兑换和发送邮件的取消只表示本地停止等待，不能证明服务端未执行；客户端不会自动重放写入。
- API key 费用查询需单独构建 `BackendClient`，目标例如 `https://api.chatgpt.com`，并提供该目标的 API key、组织和项目请求头。客户端使用该目标的原始 origin，不猜测主机或转发另一个账号的认证。
- 路径中的任务 ID 与查询参数分别编码；空路径段和 `.`、`..` 在发送前拒绝。
- 云任务详情必须包含有效 `task` 元数据，且返回 ID 必须等于请求 ID。标题、环境、创建与更新时间、归档状态和关联 PR 由 `TaskMetadata` 保留；顶层与任务内的 `task_status_display` 分别保留，不互相覆盖。
- 线程用量每批 1–100 个不同 ID；任务用量每批最多 100 个任务、合计 1,000 个根与后代 ID，任务范围不能重叠。响应里的重复 ID、未请求 ID 和错配回合均报 `InvalidResponse`。
- 缺失金额、额度、统计和设置保持为空；不推导零用量、允许状态或当前套餐。整数微单位和十进制金额字符串保留原精度。
- 任务扣费只接受最多 128 字节的十进制字符串，可带正负号和 `i32` 范围的指数；不转换为浮点数。任务额度占比只接受有限数字，支持 `serde_json/arbitrary_precision`，不截断超过 100% 的值。
- 历史套餐接口的 HTTP 404 表示报表不可用，返回 `None`；其他接口不会吞掉 HTTP 错误。
- 此 crate 提供 HTTP 能力。当前产品已有调用方是 `chatgpt` 的账号额度查询；新增云任务、统计和写入能力尚未增加 UI 或 App Server RPC 入口。

## 实现与验证

- `client.rs` 统一后端 URL、请求头、业务 JSON 和错误脱敏；取消令牌传给 `ash-client` 执行，`lib.rs` 仅保留公开导出。
- `account.rs`、`usage.rs`、`config.rs`、`tasks.rs`、`costs.rs`、`analytics.rs` 分别拥有相应业务接口；`analytics_types.rs` 保存报表响应结构。
- 业务测试按所属模块组织，共用 `test_support.rs` 中的请求记录器；原 `business_tests.rs` 的断言已迁入各业务专项测试和 `client_tests.rs`。
- `transport_tests.rs` 贯穿 `BackendClient → AshClient → UreqHttpClient`，验证业务路由、认证、JSON、写入不重发和后端错误映射。
- 传输重定向、超时与原始响应读取由 `http-client` 验证；取消与重试执行由 `ash-client` 验证。两个下层 crate 的测试使用通用请求，不依赖后端业务类型。
- HTTPS 测试使用独立 CA、随机回环端口和直接连接，不修改系统信任或代理环境；不访问真实账号、不兑换真实额度、不发送邮件。
- 业务固定响应位于 [`tests/fixtures`](tests/fixtures/README.md)；HTTPS 服务和测试证书由 [`http-test-support`](../http-test-support/README.md) 提供，只通过 `dev-dependencies` 引入。Cargo 与 Bazel 使用同一份资源。
- 验证命令：`just check ash-backend-client`、`just test ash-backend-client`、`just rust-warnings ash-backend-client`。
- 小数解析配置回归：`just test ash-backend-client --features serde_json/arbitrary_precision`。
- 现有消费方回归：`just check ash-chatgpt`、`just test ash-chatgpt account::tests`、`just rust-warnings ash-chatgpt`。

| 专项测试 | 主要覆盖 | 单独运行 |
| --- | --- | --- |
| `account_tests.rs` | 账号排序与身份、统计缺失与零值、调用记录、通知邮件 | `just test ash-backend-client account::tests` |
| `usage_tests.rs` | 用量窗口、独立允许状态、支出策略、重置券结果与请求 ID | `just test ash-backend-client usage::tests` |
| `config_tests.rs` | 配置层次、约束片段、设置布尔值、消息时间与缓存头 | `just test ash-backend-client config::tests` |
| `tasks_tests.rs` | 分页与编码、任务身份与元数据、固定成功/失败响应、文本与差异提取 | `just test ash-backend-client tasks::tests` |
| `costs_tests.rs` | 批量边界、线程/回合归属、十进制精度、结算与缺失数据 | `just test ash-backend-client costs::tests` |
| `analytics_tests.rs` | 各报表真实数据结构、日期校验、负值扣费、插件/技能统计、历史额度 | `just test ash-backend-client analytics::tests` |
| `client_tests.rs` | 全部业务请求的双路由、认证、取消、错误脱敏与禁止重试约定 | `just test ash-backend-client client::tests` |
| `transport_tests.rs` | 本地 HTTPS 实际调用链 | `just test ash-backend-client transport_tests` |
