# 登录与账户系统

> 物理位置：`ash-rs/login/`
> Rust crate：`ash_login`
> 当前状态：多 Provider 控制面、App Server RPC、ChatGPT/Kimi/xAI 订阅认证与本地模型执行已实现；zAI Coding Plan 通过密钥与专用端点接入
> ChatGPT 订阅适配器：[`chatgpt-subscription.md`](chatgpt-subscription.md)
> Kimi OAuth owner：`ash-rs/kimi/`
> xAI OAuth owner：`ash-rs/xai/`
> Provider runtime：[`model-provider.md`](model-provider.md)
> Secret persistence：[`secrets.md`](secrets.md)

## 快速理解

登录系统是面向用户的多账户控制面，不是通用 OAuth 实现。当前 `LoginService` 按 provider 注册 driver，拥有稳定 login ID、取消、完成、provider-scoped 登出和 revisioned account collection；ChatGPT、Kimi、xAI 的设备授权与凭据生命周期分别由 `ash-chatgpt`、`ash-kimi`、`ash-xai` 处理。zAI Coding Plan 使用 API key，不进入这套账户登录流程。

| 用户动作或凭据类型 | 由谁处理 | Ash 登录系统能看到什么 |
| --- | --- | --- |
| ChatGPT 设备码登录 | 本机 `ash-chatgpt` | 授权地址、一次性用户码和脱敏账户状态；首次 token 保存为 Codex 兼容 auth.json；有 Codex 时只读复用，无 Codex 时由 Ash 维护 |
| Kimi 设备码登录 | 本机 `ash-kimi` | 授权地址、一次性用户码和脱敏账户状态；凭据由 Kimi 适配器保存到 profile SecretStore |
| xAI 设备码登录 | 本机 `ash-xai` | 授权地址、一次性用户码和脱敏账户状态；Ash 登录凭据保存在 profile SecretStore，没有 Ash 凭据时可只读使用宿主 Grok 登录文件 |
| 登出、取消或切换账户 | 登录控制面协调，供应商适配器执行 | 稳定状态和脱敏结果 |
| 没有受支持订阅 OAuth 的供应商 API key | 对应模型凭据领域 | 不属于交互式登录，也不是 OAuth 失败后的降级 |
| AWS 凭据链、Google ADC、Azure 托管身份 | 对应供应商运行时 | 不包装成通用 OAuth |
| access token、refresh token、cookie | 精确供应商适配器 | 不进入 Ash RPC、日志或遥测 |

### 订阅入口与 API 入口

Ash Code 的“配置 → 提供商”把订阅接入和开发者 API 分组展示。名称用于帮助用户选对凭据与服务端点，不代表 Ash 已核实账户购买的具体套餐、额度或服务权限。

| 订阅区名称 | API 区名称 | 稳定供应商 ID | 订阅区的接入方式 |
| --- | --- | --- | --- |
| ChatGPT | OpenAI | `openai` | ChatGPT 设备码登录，使用独立的订阅服务与 OAuth 凭据 |
| Kimi | Kimi | `kimi` | Kimi 设备码登录，使用 Kimi Coding API |
| Super Grok | xAI | `xai` | xAI 设备码登录，使用 Grok 订阅代理 |
| BigModel | zAI | `zai` | 保存 zAI API key，并启用 Coding Plan 专用端点；这是订阅连接设置，不是 OAuth 登录 |

Google 目前只在 API 区显示为 `Google`。API 区的 `OpenAI`、`xAI` 等名称不追加“API 密钥”，但进入后仍按各供应商的凭据要求录入密钥。列表名称和 `openai`、`kimi`、`xai`、`zai` 等 ID 各司其职；改名不会迁移模型引用、账户或已保存的密钥。

BigModel 的本地状态只表示密钥已保存、Coding Plan 端点已启用；它不验证上游套餐资格。标准 zAI API 与 Coding Plan 使用同一个供应商 ID 和密钥配置，所选端点决定接入方式。ChatGPT、Kimi 和 Super Grok 的 OAuth 凭据不能当作开发者 API key；一次订阅请求失败不会在同一请求中改走 API。运行时选择见[供应商凭据边界](model-provider.md#6-供应商凭据边界)。

## 1. 结论

`ash-login` 是用户可见的身份登录控制面。它统一表达开始、取消、完成、登出、账户切换和
reauthentication-required 状态；它不把不同 Provider 的 credential 协议伪装成一套通用 OAuth
实现。

当前实现是 provider-neutral control plane：`InteractiveLoginDriver` 声明自己的 stable provider ID，接收 service-owned `LoginId`，返回 browser/device-code 挑战或立即连接成功，以及脱敏账户摘要。App Server 已暴露 `account/read`、`account/login/start`、`account/login/cancel`、带 provider 参数的 `account/logout`，并主动发布 `account/login/completed` 与 `account/updated`；`account/read` 返回 `accounts[]`，所以 ChatGPT、Kimi 和 xAI 可以同时登录。

产品边界按认证能力划分：ChatGPT、Kimi、xAI 的订阅接入通过 `ash-login` 暴露交互式账户登录；开发者 API 通过模型凭据领域接受 API key。两种凭据可以同时保存；订阅账户就绪时，该供应商的模型列表与文本请求优先使用订阅。订阅不可用时才使用已保存的 API key，不会在一次失败的订阅请求中改走 API。BigModel 使用 zAI 密钥和 Coding Plan 端点，由提供商配置决定接入方式，不产生 `ash-login` 账户。

本地默认组合安装 ChatGPT、Kimi 和 xAI 三个登录适配器。它们各自使用对应的设备授权流程，在本机交换或刷新 token；ChatGPT 使用 Codex 兼容的本地登录存储，Kimi 和 xAI 的 Ash 登录凭据保存在 profile SecretStore，xAI 在没有 Ash 凭据时还能只读使用宿主 Grok 登录文件。它们只向控制面提供脱敏账户信息。

默认目录中的 `openai/gpt-5.6-sol` 等订阅模型显式标记 `runtime = chatgpt_subscription`，`kimi/kimi-k2.7-code` 标记 `runtime = kimi_code`。`ModelRef` 始终使用供应商 ID；当前账户状态决定有效接入方式。桌面端的固定模型列表不因登录或填入 API key 增减条目；TUI `/model` 只显示当前连接发现或同账户缓存观察到的模型。订阅切换后，TUI 的可选条目会随目录变化；已选择的准确模型是否能请求成功由调用时的接线和认证决定。
App Server 读取到已就绪的 ChatGPT 账户时登记 `openai` 供应商，供 TUI 读取该账户的发现目录。Ash 首次读取订阅目录时，若 Codex 有本地模型缓存，会通过 Codex 的本地 `model/list` 校验当前账户并转换可见条目；否则由 Ash 使用当前登录读取 ChatGPT 目录。转换后的模型信息存入 Ash profile 的 `cache/models/openai.json`，同一文件内按账户和接入方式隔离。xAI 写入 `xai.json`，Kimi Code 写入 `kimi.json`；这些文件都按供应商和账户 scope 管理。旧配置的 `xai-subscription` 模型引用迁为 `xai`；OpenAI 与 Kimi 的原有模型引用保持供应商 ID 不变。

Kimi wire contract 以 [Kimi CLI 的官方 OAuth 实现](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py) 为主依据，并与 [CLIProxyAPI 的 Kimi adapter](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/kimi/kimi.go) 交叉验证。Ash 请求使用真实 `User-Agent: Ash/*` 与 `X-Msh-Platform: Ash`，不伪装成 Kimi CLI 或 CPA。

Desktop 的 Models 设置页已接入这条控制面：ChatGPT 与 Kimi 使用独立账户卡；主进程用系统浏览器打开验证页并把一次性 user code 写入剪贴板，Renderer 只显示 challenge 和脱敏完成状态。一个 provider 暂时不可用时，`LoginService` 仍返回其他 provider 的账户；已有但读取失败的账户会投影为 `Unavailable`。

## 2. 所有权

`ash-login` 拥有：

- redacted account/session projection；
- login request 的生命周期和稳定 `LoginId`；
- begin/cancel/logout/account-changed/reauthentication-required 的状态转换；
- UI/CLI/App Server 所需的授权 URL、device code、进度和稳定错误的安全投影；
- 对 provider-specific interactive login adapter 的最小 consumer-owned port。

`ash-login` 不拥有：

- OAuth authorize/token/revoke HTTP codec；
- PKCE、state、callback listener、refresh token 或 cookie；
- API key、AWS SigV4、Google ADC 等非交互凭据的 materialization；
- `SecretStore` backend 或 token 的序列化；
- 模型 endpoint、模型请求、retry、SSE 或 telemetry；
- Provider 选择和模型执行。

## 3. 与 ChatGPT 订阅的关系

```text
Ash Desktop / CLI / TUI
             │ account/login/*
             ▼
ash-app-server
             ▼
ash-login
             │ InteractiveLoginDriver
             ▼
ash-chatgpt
             │ Codex 兼容凭据 / 登录与按管理模式续期
             ▼
ChatGPT subscription
```

授权 URL 和一次性 device code 可以回传给 UI；access token、refresh token、authorization code 和 SecretStore bytes 都不能进入 Ash App Server RPC、desktop IPC、日志或 telemetry。

## 4. 最小公共边界

当前公共 trait 保持 consumer-owned，并要求 driver 保留 service 分配的 exact `LoginId`：

```rust
/// Starts and observes one provider-owned interactive account login.
///
/// Implementations keep provider credentials private. They may return only
/// redacted UI instructions and must make cancellation idempotent for one login.
pub trait InteractiveLoginDriver: Send + Sync {
    fn provider_id(&self) -> &'static str;
    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError>;
    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError>;
    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError>;
    fn logout(&self, account: &AccountRef) -> Result<(), LoginError>;
}
```

`BeginLogin` 是 tagged result，例如 `Browser { authorization_url }` 或
`DeviceCode { verification_url, user_code }`，而不是多个可混淆的 `Option` 字段。完成事件只携带
success/failure 与 redacted account snapshot。

不要在第一版预建“万能 OAuth driver”：resource/audience、dynamic client registration、device code、
workspace selection 和 consent semantics 不能由一个宽泛 DTO 正确覆盖。新增 Provider 时先定义其
正式能力和专用 adapter，再决定是否能复用此控制面。

## 5. 依赖方向

```text
ash-app-server ──▶ ash-login
ash-chatgpt ──▶ ash-login / ash-secrets / ash-client
ash-kimi ──▶ ash-login / ash-secrets / ash-client
ash-xai ──▶ ash-login / ash-secrets / ash-client
ash-model-provider ──▶ ash-chatgpt     # consumes fresh ChatGPT API targets
ash-model-provider ──▶ ash-kimi        # consumes fresh Kimi API targets
ash-model-provider ──▶ ash-xai         # consumes fresh xAI subscription targets

ash-login -/-> ash-secrets
ash-login -/-> ash-api / ash-client / ash-http-client
```

`ash-app-server` 把 ChatGPT、Kimi 和 xAI 适配器注入同一个 login service。ChatGPT 的认证存储为 Codex 用户目录，profile SecretStore 只记录断开状态；Kimi 和 xAI 的凭据由各自适配器管理。适配器只提供当前有效的认证目标，由本地 model-provider/TurnExecutor 执行。用户点击登录不会隐式替换 Session 模型。

## 6. 固定决策

1. `ash-login` 是登录控制面，不是 credential manager 或 OAuth protocol crate。
2. ChatGPT 订阅读取 Codex 凭据和固定 Responses 目标；缺失时设备码登录创建兼容文件；无 Codex 时 Ash 负责续期和失效后的重新登录，有 Codex 时只读复用。
3. Kimi 订阅使用本机 device OAuth、SecretStore 与 Kimi Coding API；`ash-kimi` 是 token lifecycle 的唯一 owner。
4. Super Grok 使用 xAI device OAuth 和订阅代理；`ash-xai` 持有凭据生命周期。BigModel 的密钥与 Coding Plan 端点配置不进入 `ash-login`，也不伪装成 OAuth 账户。
5. Secret persistence 仍是各 credential owner 对 `ash-secrets` 的直接依赖；login service 不读取
   secret bytes。
6. API key 的录入可以由 App Server 的 settings command 触发，但它不是 OAuth login，不能进入 `LoginMethod`、由 `ash-login` 持有或作为登录失败后的降级。
