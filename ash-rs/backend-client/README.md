# Backend client

- 封装各供应商的后台业务 HTTP API，按供应商模块组织路由和响应类型。
- `chatgpt` 提供账号、额度、账单、配置、统计与云任务接口。
- `xai` 提供订阅模型目录、账号、访问设置、订阅额度、余额和用量历史查询。
- 使用调用方提供的当前认证；凭据存储、刷新与账号生命周期由认证 crate 负责。
- 共享 URL 校验、JSON 请求、取消传递和脱敏错误，复用 `ash-client` 与 `ash-http-client`。
- 模型生成与流式协议由 `model-provider` 和 `ash-api` 负责。
- 订阅接入支持账号与用量查询，以及已有重置卡的查询和使用；不提供充值、购卡、充值提醒或付款入口。

## 模块与依赖

| 模块 | 公开入口 | 负责内容 |
| --- | --- | --- |
| `chatgpt` | `chatgpt::Client`、`chatgpt::RouteStyle`、供应商响应类型 | ChatGPT `/wham`、Codex `/api/codex` 和 API key 费用路由 |
| `xai` | `xai::Client`、供应商响应类型 | Grok 订阅后台路由、账号、模型与账单 |
| crate 根 | `RequestError` | 不包含认证头或响应正文的请求错误 |

- `chatgpt`、`xai` 认证 crate 依赖本 crate；本 crate 不依赖登录、凭据存储或模型运行时。
- 各供应商客户端独立接收 `OperationClient` 与已解析的 `ResolvedApiTarget`；不同供应商不共享认证状态。
- 生产 transport 必须拒绝重定向；Ash 默认 HTTP 配置满足此要求。
- 新供应商在本 crate 内增加模块，只有真实接口需要时才增加子文件；后台请求不抽象成统一套餐或云任务模型。
- 原根级 `BackendClient`、`RouteStyle` 和 ChatGPT 响应类型已迁到 `chatgpt`，调用方直接使用新路径。

## ChatGPT 接口

以下接口对应 Codex `backend-client` 的业务 HTTP 合约。路径相对于显式选择的路由前缀；API key 费用查询使用单独的目标地址。

| 能力 | `chatgpt::Client` 方法 | HTTP 合约 |
| --- | --- | --- |
| 账号与工作区 | `read_accounts` | `GET accounts/check`，支持列表与账号映射两种响应 |
| 个人统计与 token 历史 | `read_account_profile` | `GET profiles/me` |
| 额度与完整策略 | `read_rate_limits`、`read_rate_limit_status` | `GET usage` |
| Reserve 能力声明 | `read_rate_limits_with_reserve` | `GET usage`，附带 `x-openai-codex-luna-reserve: 1` |
| 已有重置卡 | `list_reset_credits` | `GET rate-limit-reset-credits` |
| 使用重置卡 | `consume_reset_credit` | `POST rate-limit-reset-credits/consume` |
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

## xAI 接口

| 方法 | HTTP 合约 | 返回值 |
| --- | --- | --- |
| `xai::Client::read_models` | `GET /v1/models-v2` | `Vec<xai::CatalogModel>` |
| `read_account` | `GET /v1/user?include=subscription` | `xai::Account`，包含实时套餐、团队和数据保留设置 |
| `read_settings` | `GET /v1/settings` | `xai::Settings`，包含访问资格和计费开关 |
| `read_billing` | `GET /v1/billing?format=credits` | `Option<xai::Billing>`，包含用量百分比、周期、余额和历史 |

- `xai::BASE_URL` 指向 `https://cli-chat-proxy.grok.com/v1`；调用方提供该目标的当前认证与版本头。
- 目录只返回可见的 Responses 模型，保留请求模型 ID、显示名称、上下文窗口和推理档位；缺失元数据保持为空。
- 服务端返回的 `baseUrl`、凭据或路由覆盖值不参与请求目标解析。
- `ash-xai::XaiOAuth::models` 负责账号检查及一次 HTTP 401 恢复，再委托此客户端读取目录。
- 403、426、429 和其他 HTTP 错误保留状态；后台客户端不刷新认证，也不自动重发。
- 按官方 Grok Build `4247f661689354b831191f11eeeac8424993fe3d` 的 `manager/enrichment.rs`、`subscription_check.rs`、`remote/client.rs` 和 `extensions/billing.rs` 对照接口；使用当前 credits 合约，不请求旧账单格式。
- 用量百分比保留小数和超过 100 的值；金额保留整数 USD 分，不转换为浮点数。proto3 明确规定的 `Cent {}` 表示零；缺失金额对象、周期或额度仍为 `None`。
- 设置仅保留账号访问与用量信息；Grok 自身功能开关不会改变 Ash 的行为。
- `ash-xai::XaiOAuth::refresh_account/read_subscription` 负责当前账号检查、逐次查询取消和一次 401 恢复；从最新凭据合并资料，避免覆盖刚轮换的 token。
- Grok 远程会话同步、分享、网页工作区和技能管理不属于本次订阅账号接入。

## 调用约定

- 每次操作传入 `CancellationToken`；认证目标由调用方提前解析。各供应商的认证 crate 负责 token 刷新、401 恢复与账号变化检查。
- `read_rate_limits` 保持原有返回类型。`read_rate_limit_status` 额外返回用户身份、可用重置卡数量、支出限制与限制原因。
- 使用重置卡只消耗账号已有权益，调用方须取得本次使用的授权。通过 `ResetCreditSelection::Id` 指定卡，或用 `Available` 交给服务端选择；每次使用保留独立的 `redeem_request_id`，结果不确定时沿用原 ID，客户端不自动重试。
- 重置卡查询和使用目前由 `backend-client::chatgpt` 提供，尚无 App Server RPC 或界面入口；普通额度查询不会自动使用重置卡。
- 只有真正支持 Reserve 的消费方才调用 `read_rate_limits_with_reserve`；被动额度查询使用普通入口。
- 创建任务或使用重置卡后的取消只表示本地停止等待，不能证明服务端未执行；客户端不会自动重放写入。
- API key 费用查询需单独构建 `chatgpt::Client`，目标例如 `https://api.chatgpt.com`，并提供该目标的 API key、组织和项目请求头。客户端使用该目标的原始 origin，不猜测主机或转发另一个账号的认证。
- 路径中的任务 ID 与查询参数分别编码；空路径段和 `.`、`..` 在发送前拒绝。
- 云任务详情必须包含有效 `task` 元数据，且返回 ID 必须等于请求 ID。标题、环境、创建与更新时间、归档状态和关联 PR 由 `TaskMetadata` 保留；顶层与任务内的 `task_status_display` 分别保留，不互相覆盖。
- 线程用量每批 1–100 个不同 ID；任务用量每批最多 100 个任务、合计 1,000 个根与后代 ID，任务范围不能重叠。响应里的重复 ID、未请求 ID 和错配回合均报 `InvalidResponse`。
- 缺失金额、额度、统计和设置保持为空；不推导零用量、允许状态或当前套餐。整数微单位和十进制金额字符串保留原精度。
- 任务扣费只接受最多 128 字节的十进制字符串，可带正负号和 `i32` 范围的指数；不转换为浮点数。任务额度占比只接受有限数字，支持 `serde_json/arbitrary_precision`，不截断超过 100% 的值。
- 历史套餐接口的 HTTP 404 表示报表不可用，返回 `None`；其他接口不会吞掉 HTTP 错误。
- 此 crate 提供 HTTP 能力。当前产品已有调用方是 `chatgpt` 的账号额度查询和 `xai` 的订阅模型、账号与额度查询；新增云任务、统计和写入能力尚未增加 UI 或 App Server RPC 入口。

## 实现与验证

- 根级 `client.rs` 统一 URL、认证头传递、JSON 编解码和错误脱敏；取消令牌交给 `ash-client` 执行。供应商路由留在各自模块。
- ChatGPT 的业务文件和测试已由 `src/*.rs` 迁至 `src/chatgpt/`；`chatgpt.rs` 汇总公开接口。
- `xai/models.rs` 接管原 `ash-xai/src/catalog.rs` 的 HTTP 请求和解析；原 `catalog_tests.rs` 覆盖迁至 `xai/models_tests.rs`，认证恢复测试仍在 `ash-xai`。
- `transport_tests.rs` 贯穿 `chatgpt::Client / xai::Client → AshClient → UreqHttpClient`，验证业务路由、认证、JSON、任务创建不重发和后端错误映射。
- 传输重定向、超时与原始响应读取由 `http-client` 验证；取消与重试执行由 `ash-client` 验证。两个下层 crate 的测试使用通用请求，不依赖后端业务类型。
- HTTPS 测试使用独立 CA、随机回环端口和直接连接，不修改系统信任或代理环境；不访问真实账号。
- 业务固定响应位于 [`tests/fixtures`](tests/fixtures/README.md)；HTTPS 服务和测试证书由 [`http-test-support`](../http-test-support/README.md) 提供，只通过 `dev-dependencies` 引入。Cargo 与 Bazel 使用同一份资源。
- 验证命令：`just check ash-backend-client`、`just test ash-backend-client`、`just rust-warnings ash-backend-client`。
- 小数解析配置回归：`just test ash-backend-client --features serde_json/arbitrary_precision`。
- 消费方回归：`just check ash-chatgpt -p ash-xai -p ash-model-provider`、`just test ash-chatgpt account::tests`、`just test ash-xai`、`just test ash-model-provider xai_tests`。

| 专项测试 | 主要覆盖 | 单独运行 |
| --- | --- | --- |
| `chatgpt/account_tests.rs` | 账号排序与身份、统计缺失与零值、调用记录 | `just test ash-backend-client chatgpt::account::tests` |
| `chatgpt/usage_tests.rs` | 用量窗口、独立允许状态、支出策略、重置卡列表与使用结果 | `just test ash-backend-client chatgpt::usage::tests` |
| `chatgpt/config_tests.rs` | 配置层次、约束片段、设置布尔值、消息时间与缓存头 | `just test ash-backend-client chatgpt::config::tests` |
| `chatgpt/tasks_tests.rs` | 分页与编码、任务身份与元数据、固定成功/失败响应、文本与差异提取 | `just test ash-backend-client chatgpt::tasks::tests` |
| `chatgpt/costs_tests.rs` | 批量边界、线程/回合归属、十进制精度、结算与缺失数据 | `just test ash-backend-client chatgpt::costs::tests` |
| `chatgpt/analytics_tests.rs` | 各报表真实数据结构、日期校验、负值扣费、插件/技能统计、历史额度 | `just test ash-backend-client chatgpt::analytics::tests` |
| `chatgpt/client_tests.rs` | 全部业务请求的双路由、认证、取消、错误脱敏与禁止重试约定 | `just test ash-backend-client chatgpt::client::tests` |
| `transport_tests.rs` | 本地 HTTPS 实际调用链 | `just test ash-backend-client transport_tests` |
| `xai/models_tests.rs` | 目录筛选与元数据解析 | `just test ash-backend-client xai::models::tests` |

- xAI 业务接口验证：`just test ash-backend-client xai::`；认证与资料生命周期：`just test ash-xai`。
