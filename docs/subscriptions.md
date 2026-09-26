# 订阅计划接入与额度

Ash Code 的订阅区目前提供 ChatGPT、Kimi、Super Grok 和 BigModel 四种接入方式。本页说明它们分别使用什么凭据、能否查询账户额度，以及 `/usage` 何时刷新。入口名称不表示 Ash 已核实用户购买的具体套餐或上游服务权限；登录控制面见[登录与账户系统](login.md)，模型请求如何选择接入方式见[模型调用系统](model-provider.md#6-供应商凭据边界)。

## 当前支持范围

| 订阅区入口 | 身份与凭据 | 模型接入 | `/usage` |
| --- | --- | --- | --- |
| ChatGPT | `chatgpt-subscription` 账户；复用或维护 Codex 兼容登录 | `openai` 的 ChatGPT 订阅 Responses 服务 | 套餐、额度窗口、点数 |
| Kimi | `kimi-subscription` 账户；Ash 设备码登录和 profile SecretStore | `kimi` 的 Kimi Coding API | 尚未提供账户额度查询 |
| Super Grok | `xai-subscription` 账户；Ash 设备码登录，或只读使用已有 Grok 登录 | `xai` 的 Grok 订阅代理 | 套餐、使用比例、周期和余额 |
| BigModel | zAI 密钥和 Coding Plan 端点设置；不产生登录账户 | `zai` 的 Coding Plan 端点 | 尚未提供账户额度查询 |

订阅账户与开发者 API 使用各自的凭据和计费路径。ChatGPT、Kimi、Super Grok 的已就绪订阅优先用于该供应商的模型目录和文本请求；订阅不可用时，后续请求可以使用已保存的 API 配置，但已经开始的一次订阅请求不会中途改走 API。BigModel 使用 zAI 密钥选择 Coding Plan 端点；本地“已启用”只表示配置完成，不证明上游套餐资格。稳定供应商 ID、入口名称及账户 ID 的区别见[订阅入口与 API 入口](login.md#订阅入口与-api-入口)。

## 账户额度与刷新

`account/rateLimits/read` 当前只支持 ChatGPT 和 Super Grok，按 `{ provider, accountId }` 查询指定账户；接口字段、身份检查和错误见 [App Server 账号接口](ash-app-server-api.md#11-account-与登录)。ChatGPT 返回额度窗口的已使用比例、UTC 重置时间和点数；Super Grok 返回上游周期、使用比例和余额。两者的字段含义不同，界面分别展示。Kimi 和 BigModel 尚未接入这个额度接口，不会出现在 `/usage` 中。

每次运行 `/usage` 都读取当前已登录账户，并为每个就绪的 ChatGPT 或 Super Grok 账户查询一次额度。面板中的页签切换和重绘只使用这次查询的结果；关闭后再次运行 `/usage` 才会重新查询。当前没有定时刷新，也不读取或保存本地额度缓存文件。Codex 兼容的 `auth.json` 只用于认证，不提供额度数据。

这个命令由用户主动打开，请求次数取决于打开次数，因此保持即时查询，不为它增加本地额度缓存。若以后提供常驻额度显示，再由账户侧维护按账户区分、带更新时间的共享数据，并确定刷新时机；本地保存的上次结果只能作为带时间标记的旧值展示，不能当作当前余额。

## ChatGPT：Codex 兼容登录

Ash 与 Codex 使用兼容的 ChatGPT 认证存储。检测到 Codex 时只读复用；本机没有可发现的 Codex 安装时，由 Ash 维护登录。模型请求、Thread、Turn、工具和 Agent Loop 仍由 Ash 持有，不启动 Codex Agent 进程。

### 职责

| 所有者 | 职责 |
| --- | --- |
| `ash-chatgpt` | 选择凭据管理者；只读复用，或在无 Codex 时登录、刷新并维护兼容文件 |
| `ash-login` | 登录、立即连接成功、取消、账户状态和通知 |
| `ash-model-provider` | 使用当前 access token 调用固定的 ChatGPT 订阅 Responses 服务 |
| Ash profile SecretStore | 只保存是否断开此连接；不保存 ChatGPT token 副本 |

订阅和 OpenAI Platform API key 使用独立的凭据与计费路径，不能互相转换或在失败后切换。

### 存储与首次登录

路径以运行 Ash 后端的主机为准。优先使用 `CODEX_HOME`，与 Codex 一样要求显式指定的目录已存在，并解析其规范路径；未设置时使用用户主目录的 `~/.codex`，允许它在首次登录前不存在。不会自动查找仓库中的 `.codex`。不修改现有 `config.toml`。只读模式保持认证文件原样；Ash 管理模式会受校验地更新认证记录。

按照 Codex 的 `cli_auth_credentials_store` 选择读取位置：默认 `file` 读取 `auth.json`；`keyring` 读取既有的 `Codex Auth` 条目；`auto` 在钥匙串没有条目时读取文件。钥匙串访问失败必须报告错误，不转向另一个可能过期或属于其他账户的存储。

只读加载只保留 access token、身份与有效期，不反序列化 refresh token。认证模式遵循 Codex 的显式 `auth_mode` 及旧文件模式判定；已有 API key 等其他认证模式不会被当成 ChatGPT 订阅。用户配置的登录方式和 workspace 限制仍须匹配。

凭据完全缺失时，用户可从 `/config → Providers → ChatGPT subscription` 发起设备码登录。Ash Code 收到登录链接后自动尝试打开本机浏览器；打开失败时仍显示链接和代码。成功后创建以下 Codex 结构：

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<ID token>",
    "access_token": "<access token>",
    "refresh_token": "<refresh token>",
    "account_id": "<account ID>"
  },
  "last_refresh": "<RFC 3339 UTC timestamp>"
}
```

首次授权得到的 refresh token 按 Codex 格式保存。只读复用时不使用它；Ash 管理时用它续期，并保存服务端返回的新值。文件以 0600 权限创建，通过原子、不覆盖的提交方式发布；登录期间若 Codex 已创建文件，则停止写入。取消和后端退出阻止迟到的授权结果写文件。

当前支持普通文件与直接钥匙串读取。Codex 的加密 secrets 后端和仅进程内认证明确报告不支持，不生成替代文件。配置要求仅使用钥匙串且其中没有凭据时，首次登录需由 Codex 完成。

### 使用、断开与重新连接

每次模型请求重新读取当前凭据；`account/read` 重新观察账户存储。迟到的读取不会覆盖该供应商后来完成的登录、登出、读取或账户更新。只读模式不刷新；Ash 管理模式在需要时刷新。损坏记录不当成缺失，不改用 API key。

复用模式断开只保存 Ash profile 的停用标志，Codex 仍可正常使用原账户。自管模式登出会清除所维护的当前账户认证，下一次可在 Ash 重新登录。重新连接已有有效凭据返回 `connected`，发布账户完成通知，不打开浏览器；缺失或 Ash 管理的凭据永久失效、用户再次登录时，返回设备码挑战。重新登录完成前保留旧记录，完成时校验它未被其他写入替换。

Codex 管理的凭据过期时，TUI 提示先在 Codex 登录，再返回 Ash 重新连接。Ash 不接管这次续期；登录接口的稳定错误见 [App Server 账号接口](ash-app-server-api.md#11-account-与登录)。

不改变 Codex 的文件并不等于模型调用没有副作用：请求仍消耗同一账户的订阅额度。

### 无 Codex 时的维护

生产模式从 PATH、常见 macOS 应用位置及 VS Code OpenAI 扩展查找 Codex 可执行文件，只检查文件，不启动 Codex。后续检测到安装后，不再启动新的刷新。测试通过显式管理模式隔离安装状态。

维护规则对齐 Codex AuthManager：

- access token 到期前约 5 分钟刷新；不能取得到期时间（包括不透明 access token）时，按 `last_refresh` 超过 8 天判断。
- 使用相同 OAuth token endpoint、client ID 和 refresh_token grant；刷新响应未返回的 ID/access/refresh token 保留原值，成功后更新 `last_refresh`。
- 暂时失败不丢弃仍有效的 access token；永久失效绑定当前记录缓存，停止反复刷新，账户显示需要重新登录。用户可直接在 Ash 完成重新登录。

同一 Codex home 的多个 Ash 实例通过 `ash-auth.lock` 串行更新。锁后重新读取；发布前再次校验记录和存储位置；文件通过临时文件原子替换，直接钥匙串也校验当前记录再写入。刷新保留未知字段，不把 Ash 管理字段写进 auth.json。

只有明确的 HTTP 401，且没有交付任何模型事件时，才进行一次重读/刷新与模型重试；已接受流中的错误不触发重放。请求绑定凭据中的用户 ID 与工作区 ID，恢复前后必须同时匹配；同一工作区内换用户也会停止重试。缺少任一身份字段时不能发起已认证请求或刷新。刷新返回新 ID token 时也必须保持原身份，第二次拒绝后停止自动恢复。

Codex 不使用 Ash 的锁，因此不能把安装探测与写入前校验描述为跨产品原子互斥。刷新已开始时会完成受校验的持久化；已观察到外部修改则停止覆盖，后续采用新记录。

### 对齐与验证

兼容参照为 `../codex` 提交 `d3ee328ee6af47ba540a489bb590cb96acbdd8ba`：

- `codex-rs/login/src/auth/storage.rs`、`auth/manager.rs`：存储路径、模式和结构；
- `codex-rs/login/src/token_data.rs`：token 字段与身份信息；
- `codex-rs/login/src/device_code_auth.rs`、`server.rs`：设备授权、交换与首次存储。

模型请求保留 Ash 的来源标识。开源实现兼容性不代表接口具有独立的稳定性承诺；升级需验证存储、登录、取消、错误分类和流式响应。

**本功能所有真实模型测试固定使用 `gpt-5.6-luna`、`reasoning.effort=low`，禁止改用其他模型、默认思考强度或刷新真实凭据。** 首次创建和故障测试使用隔离目录与合成 token；用官方 Codex CLI 验证生成文件可读，不能用真实登录覆盖用户账户。

本次 ChatGPT 认证实现、命令和结果见[认证兼容验收](../ash-rs/docs/changes/chatgpt-auth/verification.md)。账号额度查询已通过 `account/rateLimits/read` 提供；缺失数据保留“未提供”。丰富响应项和完整流式断线恢复仍属于后续能力。

额度查询的真实账号验证不调用模型：运行 `just test ash-chatgpt live_codex_usage_is_read_only -- --ignored --nocapture` 验证只读认证与后端接口，运行 `just test ash-tui live_usage_command_through_local_app_server -- --ignored --nocapture` 验证 `/usage` 到本地 App Server 的完整链路。后者要求已安装 Codex CLI 与现有文件凭据，两项测试都检查源 `auth.json` 未改变；正常测试默认忽略真实账号调用。

参考：[官方认证文档](https://developers.openai.com/codex/auth)、[OpenAI 工程师对第三方客户端的说明](https://github.com/openai/codex/discussions/8338)。

### ChatGPT 当前状态与待完成项

以下保留订阅服务其余能力的现状；认证维护的本次验收见上文链接。

| 能力 | 状态 | 完成门 |
| --- | --- | --- |
| OAuth 与 Responses 目标 | 进行中 | 对真实服务做版本漂移探测；登录或响应合约不兼容时安全失败并给出可行动错误，绝不改用 Platform API key。 |
| 丰富响应项 | 尚未完成 | 把订阅 Responses 支持的响应项映射为统一的持久化 Item 与通知；重连后只从统一状态重建，Desktop 不依赖供应商 DTO。 |
| 图片输入 | 已实现 | 继续通过工作区附件授权、MIME、字节与像素边界进入受控的模型输入。 |
| 敏感交互输入 | 进行中 | 按 [`secrets.md`](secrets.md#8-交互式敏感输入) 的一次性交付边界响应 `isSecret` 请求，不进入普通 transcript、Thread Item、错误、Debug 或观测数据。 |
| 账户摘要与限流状态 | 部分具备 | 已提供账户摘要、账号额度接口与 TUI `/usage` 即时查询；尚无后台限流观察。额度仅用于展示，不门禁静态模型目录，真实失败仍归属准确 Turn。 |
| 登录与流式故障矩阵 | 尚未完成 | 覆盖 device poll、外部凭据轮换、401、429、流截断、取消和恢复；token 不泄露，不确定的模型调用结果不重放，所有等待都有终态。 |

升级或发布这条路径前，至少运行登录、只读凭据更新、流式、重连、错误分类和脱敏测试。任何线上字段无法映射为统一 Item 时必须明确失败或标记未支持，不能静默丢弃。

## Kimi Code

`ash-kimi` 持有设备码授权、凭据续期和登出；token 保存在 Ash profile SecretStore，不进入账户 RPC。模型请求使用固定的 Kimi Coding API，账户 provider 为 `kimi-subscription`，模型引用仍使用 `kimi`。当前账户摘要不提供具体套餐，`account/rateLimits/read` 也不支持 Kimi。实现和凭据约定见 [`ash-kimi` README](../ash-rs/kimi/README.md)。

## Super Grok

`ash-xai` 持有设备码授权和 Ash 登录凭据；若没有 Ash 凭据，可以只读使用后端主机已有的 `~/.grok/auth.json` access token，不复制或刷新 Grok 文件中的 refresh token。账户 provider 为 `xai-subscription`，模型引用仍使用 `xai`。`account/read` 获取实时账户和套餐资料，`account/rateLimits/read` 获取当前订阅使用量、周期和余额；`/usage` 与 ChatGPT 分页展示。实现和凭据约定见 [`ash-xai` README](../ash-rs/xai/README.md)。

## BigModel Coding Plan

BigModel 使用已保存的 zAI 密钥和 Coding Plan 专用端点，不经过 `ash-login` 的设备码流程，也不产生可供 `/usage` 查询的订阅账户。标准 zAI API 与 Coding Plan 保留同一个 `zai` 供应商 ID；端点设置决定使用哪条服务路径。当前只验证本地密钥和端点配置是否齐备，实际套餐权限由上游请求判定。接入规则见[供应商凭据边界](model-provider.md#6-供应商凭据边界)。
