# ChatGPT 订阅账户

Ash 提供两条独立的 ChatGPT 订阅连接。同一模型厂商仍为 `openai`，连接身份决定凭据所有者、请求目标和目录范围。安装 Codex 不会禁止用户选择 Ash 独立授权。

| 连接 | 用途 | 凭据所有者 | 请求目标 |
| --- | --- | --- | --- |
| `chatgpt-subscription` | 复用本机已有且有效的 Codex 登录 | Codex；Ash 产品入口始终只读 | `https://chatgpt.com/backend-api/codex/responses` |
| `chatgpt-plan` | 使用 ChatGPT 独立授权 Ash，无需安装 Codex | Ash profile 的 SecretStore | `https://api.openai.com/v1/responses` |
| `openai` | OpenAI Platform API key | Ash 的 API key 存储 | Platform API |

两种订阅授权不能交换 token 或只替换 base URL。它们都由 Ash Core 执行 Agent loop，不启动 Codex Agent。独立授权的公共接口见[官方模型与推理文档](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 职责与修改入口

连接选择和请求绑定主要由 `ash-model-provider` 负责，凭据隔离由 `ash-chatgpt` 负责。这里选择的是同一模型厂商的登录连接，不改变已选定的模型或 Agent Role。

| Crate | 职责 | 修改入口 |
| --- | --- | --- |
| `ash-model-provider-info` | 定义连接身份、接入约束和自动选择的优先顺序 | [`connection.rs`](../../ash-rs/model-provider-info/src/connection.rs) 的 `connection_priority` |
| `ash-model-provider` | 比较可用连接并选择请求路径；固定模型的连接与账号，检查请求前后的身份，禁止失败后跨连接切换；按连接与账号划分目录范围 | [`provider.rs`](../../ash-rs/model-provider/src/provider.rs) 的 `ModelProviderRuntime::preferred_connections` 和账号校验；[`catalog`](../../ash-rs/model-provider/src/catalog.rs) |
| `ash-chatgpt` | 只读复用 Codex 凭据，或维护 Ash 独立授权的注册、token、刷新锁和回调生命周期；两套凭据互不读写 | 本机复用的 [`oauth.rs`](../../ash-rs/chatgpt/src/oauth.rs)；独立授权的 [`plan.rs`](../../ash-rs/chatgpt/src/plan.rs) |
| `ash-login` | 统一登录、取消、登出、账户状态与通知，按连接分发给对应登录驱动 | [`service.rs`](../../ash-rs/login/src/service.rs) |
| `ash-app-server` | 组装两个登录驱动及模型运行时，暴露账户与连接 RPC；连接列表使用同一优先级定义 | [`local.rs`](../../ash-rs/app-server/src/local.rs)；[`provider_operations.rs`](../../ash-rs/app-server/src/server/provider_operations.rs) |

调整默认顺序时修改 `ash-model-provider-info`，调整可用性判断或绑定行为时修改 `ash-model-provider`，调整认证存储、刷新或登出隔离时修改 `ash-chatgpt`。

## 优先级与请求绑定

自动选择只比较当前可用的连接，顺序为本机 Codex 登录、Ash 独立登录、已配置的 Platform API key。安装探测不参与选择；过期、损坏、已断开或被拒绝的本机凭据不会阻止独立入口使用。凭据可用只证明本地认证状态，远端模型和套餐权限由实际请求确认。

调用方显式传入连接配置时，按该连接构建模型，不再应用自动优先级。模型运行时固定连接及账号身份；新登录、目录刷新和优先级变化只影响后来创建的绑定。每次请求既检查当前账号，也检查与实际 token 同时解析出的账号，拒绝切换账号的竞态。一次请求的 401、429、网络或流式失败都不能切换到另一条连接或 API key。

目录范围包含连接及账号身份，独立入口不读取 Codex 的模型缓存。发现开始后的账号切换使结果失效，不能把另一注册的模型写入原范围。两条连接可以并行使用；如果上游将它们计入同一订阅额度，客户端隔离不产生额外额度。

## 本机 Codex 登录

路径以运行 Ash 后端的主机为准。优先使用 `CODEX_HOME`，显式目录必须已存在并解析为规范路径；未设置时使用 `~/.codex`。不自动查找仓库中的 `.codex`，不修改 `config.toml`。

按 Codex 的 `cli_auth_credentials_store` 读取既有存储：`file` 读取 `auth.json`，`keyring` 读取 `Codex Auth` 条目，`auto` 在钥匙串没有条目时读取文件。钥匙串访问失败报告错误，不能转向其他账号或旧存储。加密 secrets 后端和仅进程内认证仍明确报告不支持。

只读加载不反序列化 refresh token。遵循 Codex 的 `auth_mode`、旧记录模式判定、登录方式和 workspace 限制；已有 API key 不当成订阅凭据。损坏记录不当成缺失。

本机入口不创建、刷新、替换或删除 Codex 凭据。缺失、过期或失效时，登录控制面返回 `AccountExternalLoginRequired`，需在 Codex 完成登录。重新连接已有有效凭据立即完成，不打开新的 OAuth 流。断开只保存 Ash profile 中该连接的停用标志，不影响 Codex，也不改变 `chatgpt-plan`。

每次模型请求读取当前外部凭据。明确 HTTP 401 且未交付模型事件时，最多重读一次；只有同一用户和 workspace 的外部 token 已更新才允许重试。Ash 不刷新共享 token，已开始的流不重放。账户额度查询同样使用只读身份，并拒绝返回换账号后的迟到结果。

底层显式的 Ash 管理模式保留 Codex 格式认证兼容性测试；产品的本机复用入口不选择该模式，也不因安装状态改变凭据所有者。

## Ash 独立授权

`ChatGptPlanBrowser` 通过 Sign in with ChatGPT 动态注册取得独立 `client_id`，请求身份权限及 `resource.invoke`、`chatgpt.tokens.use.direct`。PKCE、state、nonce 和经过签名验证的 ID token 绑定本次授权。回调使用随机 loopback 端口，不占用 Codex 的固定回调端口。

一个 profile 保留自己的 agent host ID；账号映射由 issuer、已签发 client ID 和验证后的 subject 确定，不能按 email 合并不同工作区注册。token 与注册保存在 `provider/chatgpt-plan/registrations-v1`，刷新使用 profile 自己的 `chatgpt-plan.lock`。这条路径不读写 Codex home 或 `Codex Auth` 条目。

同一 profile 的多实例通过锁串行刷新：锁后重新读取当前 token，成功后保存替换 refresh token。遵守 `earliest_refresh_at`；明确终止的 grant 错误清除相应 session，暂时失败保留原记录。刷新身份必须与原注册相同。

取消后的授权结果不能保存。回调线程只保留网络操作资源；profile 后端退出会取消授权并释放监听，不保留凭据所有者。成功登录和登出推进持久选择版本；在另一实例登录或登出之后到达的旧回调不能重新激活账号。登出只撤销该 Ash 注册并清除对应 token，保留 host ID 和注册映射供下次登录。远端撤销失败仍清除本地凭据并报告未确认，不操作 Codex 连接。

独立授权只向公共 Responses 发送 bearer token，要求 `store=false`、`stream=true`。模型目录从同一账号的公共 `models` 接口读取，保持服务端顺序。认证及刷新合同见[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[token 参考](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)。完整浏览器登录和真实推理尚未在本次变更中实连验收；双入口 UI 也不属于本次后端隔离修改。

## 验证

合成凭据测试覆盖双入口同时可用时的优先级、显式连接、模型绑定后的优先级变化、解析 token 时的换账号竞态、401 不跨连接重试、目录范围隔离、多实例单次刷新、取消、后端退出释放回调、迟到回调以及 Codex 文件保持不变。

使用 `just verify ash-chatgpt` 和 `just verify ash-model-provider` 验证所属包。App Server 登录方法变化须运行 `just generate-protocol`、协议测试、生成 TypeScript 严格检查和受影响客户端检查。

所有真实模型测试固定使用 `gpt-5.6-luna`、`reasoning.effort=low`，不得刷新真实 Codex 凭据。默认测试不调用用户真实账户；已有只读验收入口为 `just test ash-chatgpt live_codex_usage_is_read_only -- --ignored --nocapture` 与 `just test ash-tui live_usage_command_through_local_app_server -- --ignored --nocapture`。原 Codex 格式实现的历史验收见[认证兼容验收](../../ash-rs/docs/changes/chatgpt-auth/verification.md)。
